import type { Candidate, RefineRequestInput } from "./controller.js";
import type { TokenUsage } from "./usage.js";

export interface RefineRecord {
  id: number;
  taskId: number;
  kind: "refine" | "revise" | "edit";
  parentId?: number;
  createdAt: number;
  input: RefineRequestInput;
  status: "generating" | "generated" | "error" | "cancelled";
  error?: string;
  candidate?: Candidate;
  elapsedSeconds?: number;
  usage?: TokenUsage;
  acceptedAt?: number;
  sentAt?: number;
}

/** Runtime-only journal shared by candidate navigation, History and Usage. Never model context. */
export class RefineHistory {
  private sequence = 0;
  private records: RefineRecord[] = [];
  constructor(private readonly limit = 100) {}

  start(taskId: number, input: RefineRequestInput, parentId?: number, kind: RefineRecord["kind"] = input.revision ? "revise" : "refine"): number {
    const id = ++this.sequence;
    this.records.push({ id, taskId, input: structuredClone(input), parentId, kind, createdAt: Date.now(), status: "generating" });
    if (this.records.length > this.limit) this.records.splice(0, this.records.length - this.limit);
    return id;
  }

  update(id: number, patch: Partial<Pick<RefineRecord, "status" | "error" | "candidate" | "usage" | "elapsedSeconds" | "acceptedAt" | "sentAt">>): void {
    const record = this.records.find((item) => item.id === id);
    if (record) Object.assign(record, structuredClone(patch));
  }

  captureInput(id: number, preparedInput: string): void {
    const record = this.records.find((item) => item.id === id);
    if (record) record.input.preparedInput = preparedInput;
  }

  list(sessionId: string, taskId?: number): RefineRecord[] {
    return structuredClone(this.records.filter((record) => record.input.sessionId === sessionId && (taskId === undefined || record.taskId === taskId)));
  }
}
