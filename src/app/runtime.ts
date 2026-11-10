import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { configPath, loadConfig, saveConfig, type RefineConfig } from "../config.js";
import { BackgroundStatus, renderBackgroundStatus } from "../background-status.js";
import { RefineController } from "../controller.js";
import type { ControllerState } from "../request-types.js";
import type { TaskPanelPosition } from "../task-panel.js";
import { PreferenceStore } from "../preference-store.js";
import { STATUS_KEY } from "./contracts.js";
import { createCompletion } from "./completion.js";
import { createContextJobs } from "./context-jobs.js";
import { createModelSelection } from "./model-selection.js";
import { createEditorActions } from "./editor-actions.js";
import { createLifecycle } from "./lifecycle.js";
import { createRequestFlows } from "./request-flows.js";
import { createWorkspaceHost } from "./workspace-host.js";
import { createWorkspaceActions } from "./workspace-actions.js";
import { createCommands } from "./commands.js";

/** Composes bounded services; request execution, UI hosting and session state have separate owners. */
export async function createRefineApplication(pi: Pick<ExtensionAPI, "sendUserMessage" | "getSessionName" | "setSessionName">) {
  const filePath = configPath(getAgentDir());
  const loaded = await loadConfig(filePath);
  const config: RefineConfig = loaded.config;
  const configWritable = loaded.warnings.length === 0;
  let currentUiContext: ExtensionContext | undefined;
  let completionContext: ExtensionContext | undefined;
  let saveQueue: Promise<void> = Promise.resolve();
  let generatingRequestId: number | undefined;
  let progressTimer: ReturnType<typeof setInterval> | undefined;
  const backgroundStatus = new BackgroundStatus();
  const taskPositions = new Map<string, TaskPanelPosition>();
  const usagePositions = new Map<string, TaskPanelPosition>();
  const preferenceStores = new Map<string, PreferenceStore>();
  const preferenceRepository = (ctx: ExtensionContext) => {
    let store = preferenceStores.get(ctx.cwd);
    if (!store) { store = new PreferenceStore(getAgentDir(), ctx.cwd); preferenceStores.set(ctx.cwd, store); }
    return store;
  };
  const openHint = config.shortcuts.view ?? config.shortcuts.optimize ?? "/refine view";
  const setCompletionContext = (ctx: ExtensionContext) => { completionContext = ctx; };
  const presentation = () => updatePresentation(controller.getState());
  const controller = new RefineController({
    get timeoutMs() { return config.timeoutMs; },
    get maxDraftChars() { return config.maxDraftChars; },
    get maxOutputChars() { return Math.max(config.maxDraftChars, config.maxOutputTokens * 32); },
    onState: (state) => {
      lifecycle.saveHistory();
      updatePresentation(state);
    },
    onAccepted: (candidate) => lifecycle.applySessionTitle(candidate),
    complete: (request, signal) => complete(request, signal),
  }, config.model);

  const contextJobs = createContextJobs(() => controller.getHistory());
  const complete = createCompletion({
    config, getContext: () => completionContext, getSessionId: () => controller.getSessionId(),
    directorySnapshot: contextJobs.directorySnapshot,
    capturePreparedInput: (...args) => controller.capturePreparedInput(...args),
    captureBudget: (...args) => controller.captureBudget(...args),
    reportProject: (...args) => requests.reportProject(...args), notify, notifyIfSameSession,
  });
  const lifecycle = createLifecycle({
    controller, config, loaded, getUiContext: () => currentUiContext,
    setUiContext: (ctx) => { currentUiContext = ctx; },
    clearCompletionContext: () => { completionContext = undefined; },
    closePreview: () => host.close(), refreshPreview: () => host.refresh(),
    clearContextJobs: contextJobs.clear,
    preferenceRepository,
    getSessionName: () => pi.getSessionName(), setSessionName: (name) => pi.setSessionName(name), notify,
  });
  const models = createModelSelection({
    controller, config, useContext, setCompletionContext, persistConfig,
    optimizationError: (...args) => requests.optimizationError(...args),
    taskPositions, usagePositions, notify, notifyCurrent, notifyIfSameSession,
  });
  const requests = createRequestFlows({
    controller, config, useContext, setCompletionContext,
    canNameSession: lifecycle.canNameSession, modelSwitchBlocked: models.modelSwitchBlocked,
    showPreview: (ctx) => host.showPreview(ctx), updatePresentation: presentation, notify, notifyCurrent,
    defaultPreferences: (ctx) => preferenceRepository(ctx).getDefaultPreferences(),
  });
  const editor = createEditorActions({
    controller, config, useContext, sendUserMessage: (...args) => pi.sendUserMessage(...args), notify, notifyIfSameSession,
  });
  const workspaceActions = createWorkspaceActions({
    controller, config, setCompletionContext, persistConfig, historyStorage: lifecycle.historyStorage,
    optimizationError: requests.optimizationError, draftInput: requests.draftInput,
    triggerOptimize: requests.triggerOptimize, reviseCandidate: requests.reviseCandidate,
    registeredModels: models.registeredModels, rememberThinking: models.rememberThinking, notify, preferenceRepository,
  });
  const host = createWorkspaceHost({
    controller, config, openHint, taskPositions, usagePositions, useContext,
    canNameSession: lifecycle.canNameSession,
    updatePresentation: presentation,
    acknowledge: (sessionId) => { backgroundStatus.update(sessionId, controller.getHistory(), true, openHint); },
    workspaceActions, editor, models, requests, notify, notifyCurrent,
  });
  const commands = createCommands({
    controller, taskPositions, useContext, host, requests, models, editor,
    clearHistory: lifecycle.clearHistory, notify,
  });

  function updatePresentation(state: ControllerState): void {
    if (!state.runningCount && !state.queuedCount) {
      if (progressTimer) clearInterval(progressTimer);
      progressTimer = undefined;
      generatingRequestId = undefined;
    } else if (generatingRequestId !== state.requestId) {
      if (progressTimer) clearInterval(progressTimer);
      generatingRequestId = state.requestId;
      progressTimer = setInterval(() => updatePresentation(controller.getState()), 1_000);
      progressTimer.unref?.();
    }
    const ctx = currentUiContext;
    if (ctx?.mode !== "tui") return;
    const status = backgroundStatus.update(controller.getSessionId() ?? "", controller.getHistory(), host.isOpen(), openHint);
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setWidget(STATUS_KEY, host.isInteracting() || host.isOpen() || !status ? undefined : (_tui, theme) => ({
      render: (width) => renderBackgroundStatus(status, width, theme),
      invalidate() {},
    }), { placement: "aboveEditor" });
    if (state.phase === "idle" && !state.runningCount && !state.queuedCount) {
      requests.clearContext();
      if (controller.hasWorkspaceContent()) host.refresh();
      else host.close("idle");
    } else host.refresh();
  }

  function useContext(ctx: ExtensionContext): void {
    currentUiContext = ctx;
    controller.ensureSession(ctx.sessionManager.getSessionId());
  }

  function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
    if (ctx.hasUI) ctx.ui.notify(message, type);
  }

  function notifyCurrent(message: string, type: "info" | "warning" | "error" = "info"): void {
    const ctx = currentUiContext;
    if (ctx?.mode === "tui") notify(ctx, message, type);
  }

  function notifyIfSameSession(sessionId: string, message: string): void {
    if (controller.getSessionId() === sessionId) notifyCurrent(message, "warning");
  }

  async function persistConfig(ctx: ExtensionContext): Promise<boolean> {
    if (!configWritable) {
      notify(ctx, "The configuration file contains errors and was not overwritten. This setting is only effective for the current process. Fix the configuration and /reload.", "warning");
      return false;
    }
    const snapshot = structuredClone(config);
    const write = saveQueue.then(() => saveConfig(filePath, snapshot));
    saveQueue = write.catch(() => undefined);
    try {
      await write;
      return true;
    } catch {
      notifyCurrent("This setting is effective now, but writing prompt-refine.json failed; it was not persisted.", "warning");
      return false;
    }
  }

  return {
    shortcuts: config.shortcuts,
    ...commands,
    input(ctx: ExtensionContext, text: string, source: string, streamingBehavior?: "steer" | "followUp") {
      useContext(ctx);
      controller.onSubmittedInput(text, source, streamingBehavior);
    },
    messageStarted(message: unknown, ctx: ExtensionContext) {
      useContext(ctx);
      const text = userMessageText(message);
      if (typeof message === "object" && message !== null && "role" in message && message.role === "user") controller.onMessageStarted(text);
    },
    lifecycle,
  };
}

function userMessageText(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null || !("role" in message) || message.role !== "user" || !("content" in message)) return undefined;
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content
    .filter((block): block is { type: "text"; text: string } =>
      typeof block === "object" && block !== null && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}
