import type { Candidate, RefineRequestInput } from "./request-types.js";
import type { TokenUsage } from "./usage.js";
import type { BudgetReport } from "./budget.js";
import type { SelectedPreference } from "./revision-preferences.js";

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

/** Bounded runtime journal; history-store persists only a minimal projection. Never model context. */
export class RefineHistory {
  private sequence = 0;
  private records: RefineRecord[] = [];
  private taskVersions = new Map<number, number>();
  private runVersions = new Map<number, number>();
  taskVersion(id: number): number { return this.taskVersions.get(id) ?? 1; }
  runVersion(id: number): number { return this.runVersions.get(id) ?? 1; }
  private touchTask(id: number): void { this.taskVersions.set(id, this.taskVersion(id) + 1); }
  private touchRun(id: number): void { this.runVersions.set(id, this.runVersion(id) + 1); }
  private pruneVersions(): void {
    const tasks = new Set(this.records.map((record) => record.taskId));
    const runs = new Set(this.records.map((record) => record.id));
    for (const id of this.taskVersions.keys()) if (!tasks.has(id)) this.taskVersions.delete(id);
    for (const id of this.runVersions.keys()) if (!runs.has(id)) this.runVersions.delete(id);
  }
  constructor(private readonly limit = 100) {}

  restore(records: RefineRecord[]): void {
    this.records = structuredClone(records.slice(-this.limit));
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
    this.pruneVersions();
    return id;
  }

  has(sessionId: string): boolean { return this.records.some((record) => record.input.sessionId === sessionId); }

  get(id: number, sessionId: string): RefineRecord | undefined {
    const record = this.records.find((item) => item.id === id && item.input.sessionId === sessionId);
    return record ? structuredClone(record) : undefined;
  }

  archive(sessionId: string, roundId: number): void {
    const changedTasks = new Set<number>();
    for (const record of this.records) {
      if (record.input.sessionId === sessionId && record.input.roundId === roundId && record.archivedAt === undefined) {
        record.archivedAt = Date.now();
        changedTasks.add(record.taskId);
        this.touchRun(record.id);
      }
    }
    for (const id of changedTasks) this.touchTask(id);
  }

  setModel(id: number, model: RefineRequestInput["model"], thinkingLevel: RefineRequestInput["thinkingLevel"]): void {
    const record = this.records.find((item) => item.id === id);
    if (record?.status === "unsent") { record.input.model = { ...model }; record.input.thinkingLevel = thinkingLevel; }
  }

  editDraft(id: number, draft: string): void {
    const record = this.records.find((item) => item.id === id);
    if (record?.status !== "unsent") return;
    this.touchTask(record.taskId);
    this.touchRun(record.id);
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
    this.touchRun(record.id);
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
    this.pruneVersions();
  }

  removeDraft(id: number): void {
    this.records = this.records.filter((record) => record.id !== id || record.status !== "unsent");
    this.pruneVersions();
  }

  update(id: number, patch: Partial<Pick<RefineRecord, "status" | "error" | "candidate" | "usage" | "elapsedSeconds" | "acceptedAt" | "sentAt" | "archivedAt" | "appliedAt">>): void {
    const record = this.records.find((item) => item.id === id);
    if (record) {
      if ((record.status === "unsent" && patch.status !== undefined && patch.status !== "unsent") ||
        (patch.archivedAt !== undefined && patch.archivedAt !== record.archivedAt)) this.touchTask(record.taskId);
      this.touchRun(id);
      Object.assign(record, structuredClone(patch));
    }
  }

  captureInput(id: number, preparedInput: string, diagnostics?: RefineRequestInput["projectDiagnostics"]): void {
    const record = this.records.find((item) => item.id === id);
    if (record) {
      record.input.preparedInput = preparedInput;
      if (diagnostics) record.input.projectDiagnostics = structuredClone(diagnostics);
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
    this.touchRun(id);
    record.input.budget = structuredClone(budget);
    record.input.sentInput = sentInput;
  }

  list(sessionId: string, taskId?: number): RefineRecord[] {
    return structuredClone(this.records.filter((record) => record.input.sessionId === sessionId && (taskId === undefined || record.taskId === taskId)));
  }
}
