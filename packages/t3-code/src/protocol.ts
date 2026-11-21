import type { Binding, Failure, ModelOption, Mutation, OptimizerDto, Receipt, RunDetail, Snapshot, TaskDetail } from "../../../src/app/api.js";

export const FRAME_LIMIT = 512 * 1024;
export interface AdoptedRun { binding: Binding; runId: string; version: number }
export interface SettingsFields {
  maxMessages: number;
  historyMaxChars: number;
  projectContext: boolean;
  instructions: "first" | "always" | "off";
  directoryTree: boolean;
  directoryReferences: boolean;
  skillMetadata: boolean;
  maxOutputTokens: number;
  timeoutMs: number;
  maxDraftChars: number;
  systemPrompt: string;
}

export interface DesktopSettings {
  version: string;
  fields: SettingsFields;
  optimizer: OptimizerDto;
  models: ModelOption[];
  writable: boolean;
}

export type DesktopCall =
  | { method: "open"; text: string; adopted?: AdoptedRun }
  | { method: "snapshot"; binding: Binding; all: boolean }
  | { method: "task"; binding: Binding; id: string }
  | { method: "run"; binding: Binding; id: string }
  | { method: "mutate"; binding: Binding; mutation: Extract<Mutation, { method: "startRun" | "stopRun" }> }
  | { method: "settings"; binding: Binding }
  | { method: "saveSettings"; binding: Binding; version: string; fields: Partial<SettingsFields> }
  | { method: "saveOptimizer"; binding: Binding; version: string; model: Pick<ModelOption, "provider" | "id">; thinking: OptimizerDto["thinking"] };

export type DesktopReply =
  | { kind: "open"; snapshot: Snapshot; taskId?: string; runId?: string; warning?: string }
  | { kind: "snapshot"; value: Snapshot }
  | { kind: "task"; value: TaskDetail }
  | { kind: "run"; value: RunDetail }
  | { kind: "receipt"; value: Receipt }
  | { kind: "settings"; value: DesktopSettings; saved?: boolean }
  | Failure
  | { kind: "unavailable"; message: string };

export type { Binding, RunDetail, Snapshot, TaskDetail } from "../../../src/app/api.js";
