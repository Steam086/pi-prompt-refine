/** Platform-independent, JSON-safe application contracts. No internal request types. */
export interface Binding { runtimeId: string; sessionId: string; lifecycleEpoch: number }
export interface ModelIdentity { provider: string; id: string }
export type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface MutationMeta { binding: Binding; clientLeaseId: string; operationId: string }
export type FailureCode = "invalid-input" | "not-ready" | "binding-stale" | "not-found" | "task-version" |
  "optimizer-version" | "operation-id-reused" | "empty" | "too-long" | "no-model" | "model-unavailable" |
  "not-editable" | "background-unavailable" | "journal-capacity" | "send-pending" | "lease-expired" |
  "ledger-capacity" | "internal";
export type Failure = { kind: "conflict" | "rejected" | "error"; code: FailureCode };
export type Reply<T> = { kind: "ok"; value: T; revision: number } | Failure;
export interface Availability { enabled: boolean; reason?: FailureCode }
export interface UsageDto {
  input?: number; output?: number; cacheRead?: number; cacheWrite?: number; reasoning?: number; totalTokens?: number;
  cost?: { total: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  subscription?: boolean;
}
export interface TaskSummary {
  id: string; version: number; roundId?: number; displayNumber: number; archived: boolean;
  excerpt: string; runIds: string[]; backgroundAvailable: boolean;
  actions: { edit: Availability; start: Availability; copy: Availability; discard: Availability };
}
export interface RunSummary {
  id: string; taskId: string; version: number; displayNumber: number;
  kind: "refine" | "revise" | "edit";
  status: "queued" | "generating" | "generated" | "error" | "cancelled" | "interrupted";
  model: ModelIdentity; thinking?: Thinking; createdAt: number; elapsedSeconds?: number;
  archived: boolean; hasOutput: boolean; usage?: UsageDto; diagnostic?: string;
  actions: { stop: Availability };
}
export interface TaskDetail extends TaskSummary { text: string; initialInstruction?: string; selectedNames: string[] }
export interface RunDetail extends RunSummary {
  original: string; text?: string; initialInstruction?: string;
  revisionInstruction?: string; previousResult?: string; backgroundAvailable: boolean;
  budget?: { status: "ok" | "trimmed" | "blocked"; inputTokens: number; outputTokens: number; contextWindow: number };
}
export interface ModelOption extends ModelIdentity { name: string; thinkingLevels: Thinking[]; favorite: boolean }
export interface OptimizerDto {
  version: number; model?: ModelIdentity; thinking: Thinking | "inherit";
  persistence: "persisted" | "pending" | "failed" | "blocked";
}
export interface Snapshot {
  binding: Binding; revision: number; roundId?: number; tasks: TaskSummary[]; runs: RunSummary[];
  optimizer: OptimizerDto; maxDraftChars: number;
  capabilities: { drafts: true; runs: true; editor: false; send: false };
  storage: {
    state: "disabled" | "no-session-file" | "unavailable" | "empty" | "saving" | "saved" | "load-error" | "save-error" | "cleared" | "clear-error";
    savedCount: number; omittedCount: number; memoryOnlyCount: number;
  };
}
export interface Lease { id: string; expiresAt: number }
export interface Hello { binding: Binding; protocolVersion: 1; lease: Lease; revision: number }
export type Query = { method: "snapshot"; scope: "current" | "all" } |
  { method: "task"; taskId: string } | { method: "run"; runId: string } | { method: "models" } |
  { method: "operation"; clientLeaseId: string; operationId: string };
export type Mutation =
  | { method: "createDraft" | "captureDraft"; text: string }
  | { method: "updateDraft"; taskId: string; expectedVersion: number; text: string }
  | { method: "copyToCurrent"; taskId: string; expectedVersion: number }
  | { method: "discardDraft"; taskId: string; expectedVersion: number }
  | { method: "startRun"; taskId: string; expectedVersion: number; model?: ModelIdentity; thinking?: Thinking }
  | { method: "optimizeText"; text: string; model?: ModelIdentity; thinking?: Thinking }
  | { method: "stopRun"; runId: string }
  | { method: "setDefaultOptimizer"; expectedVersion: number; model: ModelIdentity; thinking: Thinking | "inherit" };
export type Receipt = { outcome: "captured" | "updated" | "removed" | "copied"; taskId: string; version: number } |
  { outcome: "started" | "queued" | "duplicate"; taskId: string | null; runId: string | null } |
  { outcome: "cancelled" | "already-terminal"; runId: string } |
  { outcome: "configured"; optimizer: OptimizerDto };
export type OperationStatus = { status: "not-seen" | "expired" | "pending" } |
  { status: "completed"; result: Reply<Receipt> };
export type QueryValue = Snapshot | TaskDetail | RunDetail | ModelOption[] | OperationStatus;
export interface Invalidation { binding: Binding; revision: number }
export interface ApplicationApi {
  /** Read-only adapter guard, not a wire command. Also guards every paged output read. */
  isCurrentBinding(binding: Binding): boolean;
  hello(clientId: string, resumeLease?: string): Reply<Hello>;
  query(binding: Binding, query: Query): Reply<QueryValue>;
  execute(meta: MutationMeta, mutation: Mutation): Promise<Reply<Receipt>>;
  subscribe(binding: Binding, listener: (event: Invalidation) => void): () => void;
}
