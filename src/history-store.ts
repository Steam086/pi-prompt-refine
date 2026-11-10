import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { RefineRecord } from "./history.js";
import type { RefineRequestInput } from "./request-types.js";
import { selectHistory } from "./context.js";
import { readRunUsage, type TokenUsage } from "./usage.js";

export const HISTORY_LIMIT = 100;
export const HISTORY_MAX_BYTES = 2 * 1024 * 1024;
export const historyPath = (sessionFile: string): string => `${sessionFile}.prompt-refine.json`;

export interface HistoryStorageStatus {
  state: "disabled" | "no-session-file" | "unavailable" | "empty" | "saving" | "saved" | "load-error" | "save-error" | "cleared" | "clear-error";
  path?: string;
  savedIds: number[];
  memoryOnlyIds: number[];
  omittedIds: number[];
}

/** Deliberately not a serialized RefineRequestInput/Candidate: background stays in RAM. */
interface SavedRecord {
  id: number;
  taskId: number;
  roundId?: number;
  parentId?: number;
  kind: RefineRecord["kind"];
  status: RefineRecord["status"];
  createdAt: number;
  archivedAt?: number;
  acceptedAt?: number;
  sentAt?: number;
  elapsedSeconds?: number;
  draft: string;
  originalDraft?: string;
  result?: string;
  instruction?: string;
  editingInstruction?: string;
  model: { provider: string; id: string };
  thinkingLevel?: RefineRequestInput["thinkingLevel"];
  usage?: TokenUsage;
  error?: string;
}
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const number = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown): value is string => typeof value === "string" && value.length <= HISTORY_MAX_BYTES;
const statuses: RefineRecord["status"][] = ["unsent", "queued", "generating", "generated", "error", "cancelled", "interrupted"];
const kinds: RefineRecord["kind"][] = ["refine", "revise", "edit"];
const thinking = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const errors = ["timeout", "failed", "empty", "truncated", "tool-call", "invalid-output", "budget"];

function savedUsage(value: unknown): TokenUsage | undefined {
  if (!object(value)) return undefined;
  return readRunUsage(value, { hasPricing: true, subscription: typeof value.subscription === "boolean" ? value.subscription : undefined });
}

function project(record: RefineRecord): SavedRecord {
  return {
    id: record.id, taskId: record.taskId, roundId: record.input.roundId, parentId: record.parentId,
    kind: record.kind, status: record.status, createdAt: record.createdAt, archivedAt: record.archivedAt,
    acceptedAt: record.acceptedAt, sentAt: record.sentAt,
    // Do not rewrite on progress ticks or save unsubmitted draft edits.
    elapsedSeconds: ["generating", "queued"].includes(record.status) ? undefined : record.elapsedSeconds,
    draft: record.input.draft, originalDraft: record.originalInput?.draft,
    result: record.candidate?.text, instruction: record.input.revision?.instruction,
    editingInstruction: record.input.editingInstruction,
    model: { provider: record.input.model.provider, id: record.input.model.id }, thinkingLevel: record.input.thinkingLevel,
    usage: savedUsage(record.usage), error: errors.includes(record.error ?? "") ? record.error : undefined,
  };
}

/** Invalid entries are rejected, never cast into executable requests. Unknown fields are discarded. */
function parseRecord(value: unknown): SavedRecord | undefined {
  if (!object(value) || !number(value.id) || value.id === 0 || !number(value.taskId) || value.taskId === 0 ||
    !number(value.createdAt) || !text(value.draft) || !object(value.model) ||
    typeof value.model.provider !== "string" || !value.model.provider || value.model.provider.length > 128 ||
    typeof value.model.id !== "string" || !value.model.id || value.model.id.length > 256 ||
    !kinds.includes(value.kind as SavedRecord["kind"]) || !statuses.includes(value.status as SavedRecord["status"])) return undefined;
  for (const key of ["roundId", "parentId", "archivedAt", "acceptedAt", "sentAt", "elapsedSeconds"] as const) {
    if (value[key] !== undefined && !number(value[key])) return undefined;
  }
  for (const key of ["id", "taskId", "roundId", "parentId"] as const) if (typeof value[key] === "number" && value[key] > 1_000_000_000) return undefined;
  for (const key of ["originalDraft", "result", "instruction", "editingInstruction"] as const) if (value[key] !== undefined && !text(value[key])) return undefined;
  if (value.thinkingLevel !== undefined && !thinking.includes(value.thinkingLevel as string)) return undefined;
  return {
    id: value.id, taskId: value.taskId, createdAt: value.createdAt, draft: value.draft,
    model: { provider: value.model.provider, id: value.model.id },
    kind: value.kind as SavedRecord["kind"], status: value.status as SavedRecord["status"],
    ...Object.fromEntries(["roundId", "parentId", "archivedAt", "acceptedAt", "sentAt", "elapsedSeconds", "originalDraft", "result", "instruction", "editingInstruction", "thinkingLevel"]
      .filter((key) => value[key] !== undefined).map((key) => [key, value[key]])),
    usage: savedUsage(value.usage), error: errors.includes(value.error as string) ? value.error as string : undefined,
  };
}

function restore(saved: SavedRecord, sessionId: string): RefineRecord {
  const input: RefineRequestInput = {
    draft: saved.draft, model: saved.model, thinkingLevel: saved.thinkingLevel, sessionId,
    roundId: saved.roundId, branchLeafId: null, history: selectHistory([], 0, 0), systemPrompt: "", contextUnavailable: true,
    ...(saved.editingInstruction !== undefined ? { editingInstruction: saved.editingInstruction } : {}),
    ...(saved.instruction !== undefined ? { revision: { instruction: saved.instruction, previousCandidate: "" } } : {}),
  };
  return {
    id: saved.id, taskId: saved.taskId, parentId: saved.parentId, kind: saved.kind, createdAt: saved.createdAt,
    status: ["queued", "generating"].includes(saved.status) ? "interrupted" : saved.status,
    archivedAt: saved.archivedAt ?? saved.createdAt, acceptedAt: saved.acceptedAt, sentAt: saved.sentAt,
    elapsedSeconds: saved.elapsedSeconds, usage: saved.usage, error: saved.error, input,
    originalInput: { ...input, draft: saved.originalDraft ?? saved.draft, revision: undefined },
    ...(saved.result !== undefined ? { candidate: { ...input, text: saved.result, recordId: saved.id, requestId: saved.id,
      version: 0, generation: 0, usage: saved.usage, elapsedSeconds: saved.elapsedSeconds } } : {}),
  };
}

export function encodeHistory(records: RefineRecord[], sessionId: string): { content: string; omitted: number; savedIds: number[] } {
  const saved: string[] = [];
  const savedIds: number[] = [];
  const eligible = records.filter((record) => record.input.sessionId === sessionId && record.status !== "unsent");
  let omitted = 0;
  const prefix = `${JSON.stringify({ version: 1, sessionId }).slice(0, -1)},"records":[`;
  let bytes = Buffer.byteLength(prefix) + 3; // ]}\n
  // Serialize each record once; repeated whole-snapshot encoding stalls large-history UI actions.
  // Keep complete newest records; never silently truncate text that may be accepted later.
  for (const record of eligible.slice().sort((a, b) => b.id - a.id)) {
    if (saved.length >= HISTORY_LIMIT) { omitted++; continue; }
    const entry = JSON.stringify(project(record));
    const size = Buffer.byteLength(entry) + (saved.length ? 1 : 0);
    if (bytes + size > HISTORY_MAX_BYTES) { omitted++; continue; }
    saved.unshift(entry);
    savedIds.unshift(record.id);
    bytes += size;
  }
  return { content: `${prefix}${saved.join(",")}]}` + "\n", omitted, savedIds };
}

export function decodeHistory(content: string, sessionId: string): RefineRecord[] {
  if (Buffer.byteLength(content) > HISTORY_MAX_BYTES) throw new Error("History exceeds size limit");
  const value: unknown = JSON.parse(content);
  if (!object(value) || value.version !== 1 || value.sessionId !== sessionId || !Array.isArray(value.records) || value.records.length > HISTORY_LIMIT) {
    throw new Error("Unsupported history or different session");
  }
  const ids = new Set<number>();
  return value.records.map((item) => {
    const record = parseRecord(item);
    if (!record || ids.has(record.id)) throw new Error("Invalid history record");
    ids.add(record.id);
    return restore(record, sessionId);
  });
}

/** One runtime/session writer. Coalesce snapshots, serialize atomic writes, never touch Pi's leaf. */
export class HistoryStore {
  private pending?: string;
  private last?: string;
  private writing?: Promise<void>;
  private enabled = true;
  private paused?: "load-error" | "save-error" | "cleared" | "clear-error";
  private savedIds: number[] = [];
  private savedRecords = new Map<number, SavedRecord>();
  private pendingIds: number[] = [];
  private omittedIds: number[] = [];
  private warned = new Set<string>();
  constructor(readonly path: string, readonly sessionId: string, private readonly warn: (message: string) => void,
    private readonly changed: () => void = () => {}) {}

  getStatus(records: readonly RefineRecord[]): HistoryStorageStatus {
    const eligible = records.filter((record) => record.input.sessionId === this.sessionId && record.status !== "unsent");
    // A run ID alone cannot prove that its current result/accept/send state was saved.
    const memoryOnlyIds = eligible.filter((record) => {
      const saved = this.savedRecords.get(record.id);
      return !saved || Object.entries(project(record)).some(([key, value]) => JSON.stringify(value) !== JSON.stringify(saved[key as keyof SavedRecord]));
    }).map((record) => record.id);
    return { state: this.paused ?? (this.writing || this.pending !== undefined ? "saving" : this.last ? "saved" : "empty"),
      path: this.path, savedIds: [...this.savedIds], memoryOnlyIds, omittedIds: [...this.omittedIds] };
  }

  private remember(content: string): void {
    this.last = content;
    this.savedRecords = new Map((JSON.parse(content) as { records: unknown[] }).records.map((value) => {
      const record = parseRecord(value)!;
      return [record.id, record];
    }));
  }

  private warning(message: string): void {
    if (this.warned.has(message)) return;
    this.warned.add(message);
    this.warn(message);
  }

  async load(): Promise<RefineRecord[]> {
    try {
      const file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > HISTORY_MAX_BYTES) throw new Error("Not a bounded regular history file");
        const data = Buffer.alloc(HISTORY_MAX_BYTES + 1);
        let length = 0;
        while (length < data.length) {
          const { bytesRead } = await file.read(data, length, data.length - length, null);
          if (!bytesRead) break;
          length += bytesRead;
        }
        const content = data.subarray(0, length).toString("utf8");
        const records = decodeHistory(content, this.sessionId);
        this.remember(content);
        this.savedIds = records.map((record) => record.id);
        return records;
      } finally { await file.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      this.enabled = false;
      this.paused = "load-error";
      this.changed();
      this.warning("Prompt Refine history could not be loaded; saved file kept unchanged. Use /refine history clear to remove it.");
      return [];
    }
  }

  save(records: RefineRecord[]): void {
    if (!this.enabled) return;
    const { content, omitted, savedIds } = encodeHistory(records, this.sessionId);
    const kept = new Set(savedIds);
    this.omittedIds = records.filter((record) => record.input.sessionId === this.sessionId && record.status !== "unsent" && !kept.has(record.id)).map((record) => record.id);
    if (omitted) this.warning("Prompt Refine saved history limit reached (100 runs / 2 MiB); some records remain in memory only.");
    if ((!this.writing && content === this.last) || content === this.pending) return;
    // An untouched empty session should not create a sidecar.
    if (!this.last && records.every((record) => record.input.sessionId !== this.sessionId || record.status === "unsent")) return;
    this.pending = content;
    this.pendingIds = savedIds;
    this.start();
  }

  private start(): void {
    if (!this.writing && this.enabled && this.pending !== undefined) {
      this.writing = this.drain().finally(() => { this.writing = undefined; this.start(); this.changed(); });
      this.changed();
    }
  }

  private async drain(): Promise<void> {
    while (this.pending !== undefined && this.enabled) {
      const content = this.pending;
      const savedIds = this.pendingIds;
      this.pending = undefined;
      const temp = `${this.path}.${randomUUID()}.tmp`;
      try {
        const existing = await lstat(this.path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
        if (existing && !existing.isFile()) throw new Error("Not a regular history file");
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        await writeFile(temp, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
        await rename(temp, this.path);
        this.remember(content);
        this.savedIds = savedIds;
      } catch {
        this.pending = undefined;
        this.enabled = false;
        this.paused = "save-error";
        this.warning("Prompt Refine history save failed; current records remain in memory. Saving paused until reload.");
      } finally { await rm(temp, { force: true }).catch(() => undefined); }
    }
  }

  async flush(): Promise<void> { while (this.writing) await this.writing; }

  /** Pause this writer so old in-memory results cannot recreate a cleared file. */
  async clear(): Promise<void> {
    this.enabled = false;
    this.pending = undefined;
    await this.flush();
    try {
      await rm(this.path, { force: true });
      this.last = undefined;
      this.savedIds = [];
      this.savedRecords.clear();
      this.omittedIds = [];
      this.paused = "cleared";
    } catch (error) {
      this.paused = "clear-error";
      throw error;
    } finally { this.changed(); }
  }
}
