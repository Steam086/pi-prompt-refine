import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRef, ProjectContextConfig } from "./config.js";
import type { BudgetReport } from "./budget.js";
import type { HistorySnapshot, RevisionInput } from "./context.js";
import type { TokenUsage } from "./usage.js";
import type { ProjectSnapshot } from "./project-context.js";
import type { SelectedPreference } from "./revision-preferences.js";

interface RequestProjectContext { cwd: string; snapshot: ProjectSnapshot; revisionSnapshot?: ProjectSnapshot; config?: ProjectContextConfig }
export type RefinePhase = "idle" | "generating" | "ready" | "error";
export type RefineStopReason = "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred" | "pending" | "budget";
export interface RefineRequestInput {
  draft: string;
  revision?: RevisionInput;
  /** Per-original editing requirements, separate from the untouched task and round policy. */
  editingInstruction?: string;
  /** Frozen selected bodies and identities; never resolved against the library at launch. */
  preferences?: SelectedPreference[];
  model: ModelRef;
  thinkingLevel?: ModelThinkingLevel;
  generateTitle?: boolean;
  sessionId: string;
  branchLeafId: string | null;
  history: HistorySnapshot;
  systemPrompt: string;
  /** Full frozen input before per-model budget pruning (reusable by other models). */
  preparedInput?: string;
  /** Exact serialized input after budget pruning; absent if preflight blocked. */
  sentInput?: string;
  budget?: BudgetReport;
  project?: RequestProjectContext;
  projectDiagnostics?: { warnings: string[]; referencedDirectoryCount: number };
  roundId?: number;
  /** Restored minimal history has no reusable request background. Never execute it. */
  contextUnavailable?: boolean;
}
export interface RefineRequest extends RefineRequestInput {
  requestId: number;
  generation: number;
  recordId: number;
}
export interface RefineCompletion {
  usage?: TokenUsage;
  title?: string;
  invalidOutput?: boolean;
  text: string;
  stopReason: RefineStopReason;
}
export interface Candidate extends RefineRequestInput {
  recordId?: number;
  elapsedSeconds?: number;
  usage?: TokenUsage;
  title?: string;
  requestId: number;
  version: number;
  generation: number;
  text: string;
}
export interface CandidateToken { requestId: number; version: number; generation: number; sessionId: string }
export interface RestoreSnapshot { id: number; generation: number; sessionId: string; before: string; applied: string }
export interface RestoreToken { id: number; generation: number; sessionId: string }
export interface RequestSource { draft: string; revisionInstruction?: string }
export interface ControllerState {
  elapsedSeconds?: number;
  usage?: TokenUsage;
  phase: RefinePhase;
  requestId: number;
  recordId?: number;
  model?: ModelRef;
  thinkingLevel?: ModelThinkingLevel;
  error?: "timeout" | "failed" | "empty" | "truncated" | "tool-call" | "invalid-output" | "budget";
  budget?: BudgetReport;
  pendingSend: boolean;
  runningCount?: number;
  queuedCount?: number;
}
export interface Scheduler { setTimeout(callback: () => void, delayMs: number): unknown; clearTimeout(handle: unknown): void }
export interface RefineControllerOptions {
  complete(request: RefineRequest, signal: AbortSignal): Promise<RefineCompletion>;
  timeoutMs: number;
  maxDraftChars: number;
  maxOutputChars?: number;
  maxConcurrent?: number;
  scheduler?: Scheduler;
  onState(state: ControllerState): void;
  onAccepted?(candidate: Candidate): void;
}
export type TriggerResult =
  | { kind: "started"; requestId: number }
  | { kind: "captured"; recordId: number }
  | { kind: "duplicate" | "ready" | "empty" | "too-long" | "no-model" | "stale-source" | "busy" };
