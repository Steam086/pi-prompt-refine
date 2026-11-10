import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { CandidateToken } from "../request-types.js";
import type { ContextSettings } from "../workspace.js";

export const STATUS_KEY = "prompt-refine";
export const RESTORED_CONTEXT_HINT = "Background was not saved. Press i in the task list to copy the original into the current round before running.";
export type Notify = (ctx: ExtensionContext, message: string, type?: "info" | "warning" | "error") => void;
export type NotifyCurrent = (message: string, type?: "info" | "warning" | "error") => void;
export type NotifyIfSameSession = (sessionId: string, message: string) => void;
export type ModelSelection = { modelKey: string; thinkingLevel?: ModelThinkingLevel } | undefined;
export type ModelPickerPresenter = (factory: (tui: TUI, theme: Theme, keybindings: KeybindingsManager,
  done: (selection: ModelSelection) => void) => Component) => Promise<ModelSelection>;
export type PreviewAction = "accept" | "edit" | "send" | "dismiss" | "restore" | "close" | "optimize" | "model" | "cycle" | "system-prompt";
export type WorkspaceSelection = { action: PreviewAction; generation: number; token?: CandidateToken; settingsContext?: ContextSettings };
