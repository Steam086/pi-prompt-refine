import type { Candidate, RefineRequestInput } from "./controller.js";
import type { TokenUsage } from "./usage.js";
import type { BudgetReport } from "./budget.js";

export interface RefineRecord {
  id: number;
  taskId: number;
  kind: "refine" | "revise" | "edit";
  parentId?: number;
  createdAt: number;
  input: RefineRequestInput;
  /** Keep the common original even if the earliest completed call is evicted. */
  originalInput?: RefineRequestInput;
  status: "unsent" | "queued" | "generating" | "generated" | "error" | "cancelled";
  archivedAt?: number;
  appliedAt?: number;
  error?: string;
  candidate?: Candidate;
  elapsedSeconds?: number;
  usage?: TokenUsage;
  acceptedAt?: number;
  sentAt?: number;
}

/** Runtime-only journal shared by the round workspace and unified Usage. Never model context. */
export class RefineHistory {
  private sequence = 0;
  private records: RefineRecord[] = [];
  constructor(private readonly limit = 100) {}

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
    return id;
  }

  has(sessionId: string): boolean { return this.records.some((record) => record.input.sessionId === sessionId); }

  get(id: number, sessionId: string): RefineRecord | undefined {
    const record = this.records.find((item) => item.id === id && item.input.sessionId === sessionId);
    return record ? structuredClone(record) : undefined;
  }

  archive(sessionId: string, roundId: number): void {
    for (const record of this.records) {
      if (record.input.sessionId === sessionId && record.input.roundId === roundId && record.archivedAt === undefined) record.archivedAt = Date.now();
    }
  }

  setModel(id: number, model: RefineRequestInput["model"], thinkingLevel: RefineRequestInput["thinkingLevel"]): void {
    const record = this.records.find((item) => item.id === id);
    if (record?.status === "unsent") { record.input.model = { ...model }; record.input.thinkingLevel = thinkingLevel; }
  }

  editDraft(id: number, draft: string): void {
    const record = this.records.find((item) => item.id === id);
    if (record?.status !== "unsent") return;
    record.input.draft = draft;
    record.originalInput = { ...structuredClone(record.input), draft };
    delete record.input.preparedInput;
    delete record.input.projectDiagnostics;
    delete record.originalInput.preparedInput;
    delete record.originalInput.projectDiagnostics;
  }

  removeDraft(id: number): void {
    this.records = this.records.filter((record) => record.id !== id || record.status !== "unsent");
  }

  update(id: number, patch: Partial<Pick<RefineRecord, "status" | "error" | "candidate" | "usage" | "elapsedSeconds" | "acceptedAt" | "sentAt" | "archivedAt" | "appliedAt">>): void {
    const record = this.records.find((item) => item.id === id);
    if (record) Object.assign(record, structuredClone(patch));
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
    record.input.budget = structuredClone(budget);
    record.input.sentInput = sentInput;
  }

  list(sessionId: string, taskId?: number): RefineRecord[] {
    return structuredClone(this.records.filter((record) => record.input.sessionId === sessionId && (taskId === undefined || record.taskId === taskId)));
  }
}
