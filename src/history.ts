import type { Candidate, RefineRequestInput } from "./request-types.js";
import type { TokenUsage } from "./usage.js";
import type { BudgetReport } from "./budget.js";
import type { SelectedPreference } from "./revision-preferences.js";
import { immutable } from "./immutable.js";

export interface RefineRecord {
  id: number;
  taskId: number;
  kind: "refine" | "revise" | "edit";
  parentId?: number;
  createdAt: number;
  input: RefineRequestInput;
  /** Keep the common original even if the earliest completed call is evicted. */
  originalInput?: RefineRequestInput;
  status: "unsent" | "queued" | "generating" | "generated" | "error" | "cancelled" | "interrupted";
  archivedAt?: number;
  appliedAt?: number;
  error?: string;
  candidate?: Candidate;
  elapsedSeconds?: number;
  usage?: TokenUsage;
  acceptedAt?: number;
  sentAt?: number;
}

/** Detached fields used to browse tasks. Execution background can be much larger than the visible text. */
export interface TaskDisplayRecord extends Omit<RefineRecord, "input" | "originalInput" | "candidate"> {
  input: Pick<RefineRequestInput, "draft" | "model" | "thinkingLevel" | "roundId" | "contextUnavailable" |
    "editingInstruction" | "budget"> & {
    revision?: Pick<NonNullable<RefineRequestInput["revision"]>, "instruction" | "previousCandidate">;
    preferences?: Pick<SelectedPreference, "name">[];
    projectDiagnostics?: { warnings: string[] };
    project?: { snapshot: { warnings: string[] } };
  };
  candidate?: Pick<Candidate, "text" | "additional">;
}

/** Bounded runtime journal; history-store persists only a minimal projection. Never model context. */
export class RefineHistory {
  private sequence = 0;
  private records: RefineRecord[] = [];
  private taskVersions = new Map<number, number>();
  private runVersions = new Map<number, number>();
  private displayRecords?: { sessionId: string; records: readonly TaskDisplayRecord[] };
  private readonly displayRows = new WeakMap<RefineRecord, TaskDisplayRecord>();
  taskVersion(id: number): number { return this.taskVersions.get(id) ?? 1; }
  runVersion(id: number): number { return this.runVersions.get(id) ?? 1; }
  private touchTask(id: number): void { this.taskVersions.set(id, this.taskVersion(id) + 1); }
  private touchRun(record: RefineRecord): void {
    this.runVersions.set(record.id, this.runVersion(record.id) + 1);
    this.invalidateDisplay(record);
  }
  private invalidateDisplay(record?: RefineRecord): void {
    this.displayRecords = undefined;
    if (record) this.displayRows.delete(record);
  }
  private pruneVersions(): void {
    const tasks = new Set(this.records.map((record) => record.taskId));
    const runs = new Set(this.records.map((record) => record.id));
    for (const id of this.taskVersions.keys()) if (!tasks.has(id)) this.taskVersions.delete(id);
    for (const id of this.runVersions.keys()) if (!runs.has(id)) this.runVersions.delete(id);
  }
  constructor(private readonly limit = 100) {}

  restore(records: RefineRecord[]): void {
    this.records = structuredClone(records.slice(-this.limit));
    this.invalidateDisplay();
    this.taskVersions.clear();
    this.runVersions.clear();
    this.sequence = Math.max(this.sequence, ...this.records.map((record) => record.id));
  }

  canStart(): boolean {
    return this.records.length < this.limit || this.records.some((record) => !["unsent", "queued", "generating"].includes(record.status));
  }

  start(taskId: number, input: RefineRequestInput, parentId?: number, kind: RefineRecord["kind"] = input.revision ? "revise" : "refine", status: RefineRecord["status"] = "generating"): number {
    const source = this.records.find((record) => record.taskId === taskId && record.input.sessionId === input.sessionId);
    const originalInput = source?.originalInput ?? structuredClone(source?.input ?? input);
    if (this.records.length >= this.limit) {
      const index = this.records.findIndex((record) => !["unsent", "queued", "generating"].includes(record.status));
      if (index < 0) throw new Error("Request journal is full; pending work is never evicted.");
      this.records.splice(index, 1);
    }
    const id = ++this.sequence;
    const freshInput = structuredClone(input);
    if (kind !== "edit") {
      delete freshInput.budget;
      delete freshInput.sentInput;
    }
    this.records.push({ id, taskId, input: freshInput, originalInput, parentId, kind, createdAt: Date.now(), status });
    this.invalidateDisplay();
    this.pruneVersions();
    return id;
  }

  has(sessionId: string): boolean { return this.records.some((record) => record.input.sessionId === sessionId); }

  findDraft(sessionId: string, draft: string, lastCapturedId?: number): Pick<RefineRecord, "id" | "taskId" | "status"> | undefined {
    const record = this.records.find((record) => record.input.sessionId === sessionId && record.input.draft === draft &&
      (record.archivedAt === undefined || record.id === lastCapturedId));
    return record && { id: record.id, taskId: record.taskId, status: record.status };
  }

  get(id: number, sessionId: string): RefineRecord | undefined {
    const record = this.records.find((item) => item.id === id && item.input.sessionId === sessionId);
    return record ? structuredClone(record) : undefined;
  }

  getOriginal(id: number, sessionId: string): RefineRecord | undefined {
    const record = this.records.find((item) => item.id === id && item.input.sessionId === sessionId);
    if (!record) return undefined;
    const source = this.records.find((item) =>
      item.input.sessionId === sessionId && item.taskId === record.taskId && !item.input.revision) ?? record;
    return structuredClone({ ...source, input: source.originalInput ?? source.input });
  }

  archive(sessionId: string, roundId: number): void {
    const changedTasks = new Set<number>();
    for (const record of this.records) {
      if (record.input.sessionId === sessionId && record.input.roundId === roundId && record.archivedAt === undefined) {
        record.archivedAt = Date.now();
        changedTasks.add(record.taskId);
        this.touchRun(record);
      }
    }
    for (const id of changedTasks) this.touchTask(id);
  }

  setModel(id: number, model: RefineRequestInput["model"], thinkingLevel: RefineRequestInput["thinkingLevel"]): void {
    const record = this.records.find((item) => item.id === id);
    if (record?.status === "unsent") {
      record.input.model = { ...model }; record.input.thinkingLevel = thinkingLevel;
      this.invalidateDisplay(record);
    }
  }

  editDraft(id: number, draft: string): void {
    const record = this.records.find((item) => item.id === id);
    if (record?.status !== "unsent") return;
    this.touchTask(record.taskId);
    this.touchRun(record);
    record.input.draft = draft;
    record.originalInput = { ...structuredClone(record.input), draft };
    delete record.input.preparedInput;
    delete record.input.projectDiagnostics;
    delete record.originalInput.preparedInput;
    delete record.originalInput.projectDiagnostics;
  }

  setDraftPreferences(id: number, selected: readonly SelectedPreference[], instruction: string): void {
    const record = this.records.find((item) => item.id === id);
    if (record?.status !== "unsent") return;
    this.touchTask(record.taskId);
    this.touchRun(record);
    record.input.preferences = structuredClone([...selected]);
    record.input.editingInstruction = instruction || undefined;
    delete record.input.preparedInput;
    delete record.input.projectDiagnostics;
    delete record.input.budget;
    delete record.input.sentInput;
    record.originalInput = structuredClone(record.input);
  }

  remove(ids: ReadonlySet<number>, sessionId: string): void {
    this.records = this.records.filter((record) => record.input.sessionId !== sessionId || !ids.has(record.id));
    this.invalidateDisplay();
    this.pruneVersions();
  }

  removeDraft(id: number): void {
    this.records = this.records.filter((record) => record.id !== id || record.status !== "unsent");
    this.invalidateDisplay();
    this.pruneVersions();
  }

  update(id: number, patch: Partial<Pick<RefineRecord, "status" | "error" | "candidate" | "usage" | "elapsedSeconds" | "acceptedAt" | "sentAt" | "archivedAt" | "appliedAt">>): void {
    const record = this.records.find((item) => item.id === id);
    if (record) {
      if ((record.status === "unsent" && patch.status !== undefined && patch.status !== "unsent") ||
        (patch.archivedAt !== undefined && patch.archivedAt !== record.archivedAt)) this.touchTask(record.taskId);
      this.touchRun(record);
      Object.assign(record, structuredClone(patch));
    }
  }

  captureInput(id: number, preparedInput: string, diagnostics?: RefineRequestInput["projectDiagnostics"]): void {
    const record = this.records.find((item) => item.id === id);
    if (record) {
      record.input.preparedInput = preparedInput;
      if (diagnostics) {
        record.input.projectDiagnostics = structuredClone(diagnostics);
        this.invalidateDisplay(record);
      }
      if (!record.input.revision) {
        const originalInput = { ...record.originalInput ?? record.input, preparedInput,
          ...(diagnostics ? { projectDiagnostics: structuredClone(diagnostics) } : {}) };
        for (const sibling of this.records) {
          if (sibling.taskId === record.taskId && sibling.input.sessionId === record.input.sessionId) {
            sibling.originalInput = originalInput;
          }
        }
      }
    }
  }

  captureBudget(id: number, budget: BudgetReport, sentInput?: string): void {
    const record = this.records.find((item) => item.id === id);
    if (!record) return;
    this.touchRun(record);
    record.input.budget = structuredClone(budget);
    record.input.sentInput = sentInput;
  }

  listForDisplay(sessionId: string): TaskDisplayRecord[] {
    return structuredClone(this.displaySnapshot(sessionId).slice());
  }

  /** Shared by TUI views until display records change. The live clock is separate. */
  displaySnapshot(sessionId: string): readonly TaskDisplayRecord[] {
    if (this.displayRecords?.sessionId === sessionId) return this.displayRecords.records;
    const records = Object.freeze(this.records.filter((record) => record.input.sessionId === sessionId).map((record) => this.displayRow(record)));
    this.displayRecords = { sessionId, records };
    return records;
  }

  private displayRow(record: RefineRecord): TaskDisplayRecord {
    const cached = this.displayRows.get(record);
    if (cached) return cached;
    const { input, candidate, usage } = record;
    const warnings = input.projectDiagnostics?.warnings ?? input.project?.snapshot.warnings;
    const row = immutable<TaskDisplayRecord>({
      id: record.id, taskId: record.taskId, kind: record.kind, status: record.status, parentId: record.parentId,
      createdAt: record.createdAt, archivedAt: record.archivedAt, appliedAt: record.appliedAt,
      acceptedAt: record.acceptedAt, sentAt: record.sentAt, elapsedSeconds: record.elapsedSeconds, error: record.error,
      usage: usage && structuredClone(usage),
      candidate: candidate && { text: candidate.text, ...(candidate.additional ? { additional: structuredClone(candidate.additional) } : {}) },
      input: {
        draft: input.draft, model: { ...input.model }, thinkingLevel: input.thinkingLevel,
        roundId: input.roundId, contextUnavailable: input.contextUnavailable, editingInstruction: input.editingInstruction,
        revision: input.revision && { instruction: input.revision.instruction, previousCandidate: input.revision.previousCandidate },
        budget: input.budget && structuredClone(input.budget),
        preferences: input.preferences?.map(({ name }) => ({ name })),
        projectDiagnostics: warnings && { warnings: [...warnings] },
      },
    });
    this.displayRows.set(record, row);
    return row;
  }

  list(sessionId: string, taskId?: number): RefineRecord[] {
    return structuredClone(this.records.filter((record) => record.input.sessionId === sessionId && (taskId === undefined || record.taskId === taskId)));
  }
}

/** Shared ordering, independent of focus, completion order and the presentation clock. */
export function taskGroups<T extends { id: number; taskId: number; archivedAt?: number; input: { roundId?: number } }>(
  records: readonly T[], all = false,
): T[][] {
  const groups = new Map<number, T[]>();
  for (const record of records) {
    if (!all && record.archivedAt !== undefined) continue;
    const group = groups.get(record.taskId) ?? [];
    group.push(record);
    groups.set(record.taskId, group);
  }
  return [...groups.values()].sort((a, b) =>
    Number(a[0]!.archivedAt !== undefined) - Number(b[0]!.archivedAt !== undefined) ||
    (b[0]!.input.roundId ?? 0) - (a[0]!.input.roundId ?? 0) ||
    Math.max(...b.map((record) => record.id)) - Math.max(...a.map((record) => record.id)));
}
