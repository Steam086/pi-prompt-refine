import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { configPath, loadConfig, saveConfig } from "../config.js";
import { REFINE_SYSTEM_PROMPT } from "../context.js";
import { BackgroundStatus, renderBackgroundStatus } from "../background-status.js";
import { RefineController } from "../controller.js";
import type { ControllerState } from "../request-types.js";
import type { TaskPanelPosition } from "../task-panel.js";
import { BUILTIN_PREFERENCES, PreferenceStore } from "../preference-store.js";
import { STATUS_KEY } from "./contracts.js";
import { createCompletion } from "./completion.js";
import { createContextJobs } from "./context-jobs.js";
import { createModelSelection } from "./model-selection.js";
import { createEditorActions } from "./editor-actions.js";
import { createLifecycle } from "./lifecycle.js";
import { SessionPreferences } from "./session-preferences.js";
import { createRequestFlows } from "./request-flows.js";
import { createWorkspaceHost } from "./workspace-host.js";
import { createWorkspaceActions } from "./workspace-actions.js";
import { createCommands } from "./commands.js";
import { createApplication } from "./application.js";
import { createApplicationEvents } from "./events.js";
import { createModelService } from "./model-service.js";
import { createConfigService } from "./config-service.js";
import { createTuiOperations } from "../adapters/tui-operations.js";
import { createRpcSlash } from "../adapters/rpc-slash.js";
import type { ModelIdentity, Thinking } from "./api.js";

/** Composes bounded services; request execution, UI hosting and session state have separate owners. */
export async function createRefineApplication(pi: Pick<ExtensionAPI, "sendUserMessage" | "getSessionName" | "setSessionName">) {
  const filePath = configPath(getAgentDir());
  const loaded = await loadConfig(filePath);
  let currentUiContext: ExtensionContext | undefined;
  let completionContext: ExtensionContext | undefined;
  let lifecycleSequence = 0;
  let optimizerRequestAttempted = false;
  const events = createApplicationEvents();
  const configuration = createConfigService(loaded.config, {
    defaultSystemPrompt: REFINE_SYSTEM_PROMPT,
    write: loaded.warnings.length ? undefined : (snapshot) => saveConfig(filePath, snapshot),
    changed: () => events.changed(),
    unsaved: (reason) => {
      if (reason === "failed") {
        notifyCurrent("This setting is effective now, but writing prompt-refine.json failed; it was not persisted.", "warning");
      } else if (currentUiContext) {
        notify(currentUiContext, "The configuration file contains errors and was not overwritten. This setting is only effective for the current process. Fix the configuration and /reload.", "warning");
      }
    },
  });
  const readConfig = configuration.read;
  const config = readConfig();
  let generatingRequestId: number | undefined;
  let progressTimer: ReturnType<typeof setInterval> | undefined;
  const backgroundStatus = new BackgroundStatus();
  const taskPositions = new Map<string, TaskPanelPosition>();
  const usagePositions = new Map<string, TaskPanelPosition>();
  const preferenceStores = new Map<string, PreferenceStore>();
  const sessionPreferences = new SessionPreferences();
  const preferenceRepository = (ctx: ExtensionContext) => {
    let store = preferenceStores.get(ctx.cwd);
    if (!store) { store = new PreferenceStore(getAgentDir(), ctx.cwd, BUILTIN_PREFERENCES); preferenceStores.set(ctx.cwd, store); }
    return store;
  };
  const openHint = config.shortcuts.view ?? config.shortcuts.optimize ?? "/refine view";
  const setCompletionContext = (ctx: ExtensionContext) => { completionContext = ctx; };
  const presentation = () => updatePresentation(controller.getState());
  const controller: RefineController = new RefineController({
    get timeoutMs() { return readConfig().timeoutMs; },
    get maxDraftChars() { return readConfig().maxDraftChars; },
    get maxOutputChars() {
      const { maxDraftChars, maxOutputTokens } = readConfig();
      return Math.max(maxDraftChars, maxOutputTokens * 32);
    },
    onState: () => {
      lifecycle.saveHistory();
      events.changed(true);
    },
    onAccepted: (candidate) => lifecycle.applySessionTitle(candidate),
    complete: (request, signal) => complete(request, signal),
  }, config.model);

  const contextJobs = createContextJobs(() => controller.getHistory());
  const complete = createCompletion<ExtensionContext>({
    readConfig, getContext: () => completionContext, getSessionId: () => controller.getSessionId(),
    directorySnapshot: contextJobs.directorySnapshot,
    capturePreparedInput: (...args) => controller.capturePreparedInput(...args),
    captureBudget: (...args) => controller.captureBudget(...args),
    onOptimizerRequest: () => { optimizerRequestAttempted = true; },
    reportProject: (...args) => requests.reportProject(...args), notify, notifyIfSameSession,
  });
  const lifecycle = createLifecycle({
    controller, config, loaded, getUiContext: () => currentUiContext,
    setUiContext: (ctx) => { currentUiContext = ctx; completionContext = ctx; },
    clearCompletionContext: () => { completionContext = undefined; },
    closePreview: () => host.close(), refreshPreview: () => { events.changed(); host.refresh(); },
    clearContextJobs: contextJobs.clear,
    preferenceRepository,
    getSessionName: () => pi.getSessionName(), setSessionName: (name) => pi.setSessionName(name), notify,
  });
  const models = createModelSelection({
    controller, readConfig, useContext, setCompletionContext, saveOptimizer,
    rememberComparisonThinking: configuration.rememberComparisonThinking,
    startOriginal: (id, model, thinking, version) => operations.start(id, model, thinking, version),
    taskVersion: (id) => operations.version(id), optimizerVersion: () => modelService.optimizer().version,
    optimizationError: (...args) => requests.optimizationError(...args),
    taskPositions, usagePositions, notify, notifyCurrent, notifyIfSameSession,
  });
  const requests = createRequestFlows({
    controller, readConfig, useContext, setCompletionContext,
    canNameSession: lifecycle.canNameSession, modelSwitchBlocked: models.modelSwitchBlocked,
    showPreview: (ctx) => host.showPreview(ctx), updatePresentation: presentation, notify, notifyCurrent,
    initialPreferences: (ctx) => preferenceRepository(ctx).getDefaultPreferences(sessionPreferences.overrides(ctx.sessionManager.getSessionId())),
  });
  function executionContext(): ExtensionContext {
    if (!completionContext || completionContext.sessionManager.getSessionId() !== controller.getSessionId()) {
      throw new Error("No current execution binding");
    }
    return completionContext;
  }
  const modelService = createModelService({
    controller, config: configuration,
    available: () => executionContext().modelRegistry.getAvailable(),
    sessionThinking: () => executionContext().thinkingLevel,
  });
  const application = createApplication({
    controller, events, models: modelService, maxDraftChars: () => readConfig().maxDraftChars,
    input: { capture: (text, choice) => requests.captureOriginalInput(executionContext(), text, choice) },
    storage: { summary: () => {
      const status = lifecycle.historyStorage(executionContext(), controller.getSessionId()!);
      return { state: status.state, savedCount: status.savedIds.length, omittedCount: status.omittedIds.length,
        memoryOnlyCount: status.memoryOnlyIds.length };
    } },
  });
  const operations = createTuiOperations(application.local, controller);
  async function saveOptimizer(model: ModelIdentity, thinking: Thinking | "inherit", expectedVersion = modelService.optimizer().version): Promise<boolean> {
    const result = application.local({ method: "setDefaultOptimizer", expectedVersion, model, thinking });
    if (result.kind !== "ok") { notifyCurrent(`Optimizer not changed (${result.code}).`, "warning"); return false; }
    return modelService.settled();
  }
  const editor = createEditorActions({
    controller, readConfig, useContext, sendUserMessage: (...args) => pi.sendUserMessage(...args), notify, notifyIfSameSession,
  });
  const showOptimizerQuota = () => !optimizerRequestAttempted && !!controller.getModel();
  const workspaceActions = createWorkspaceActions({
    controller, readConfig, settings: configuration, setCompletionContext, historyStorage: lifecycle.historyStorage,
    optimizationError: requests.optimizationError, operations, saveOptimizer,
    triggerOptimize: requests.triggerOptimize, reviseCandidate: requests.reviseCandidate,
    registeredModels: models.registeredModels, showOptimizerQuota,
    notify, preferenceRepository, sessionPreferences,
  });
  const host = createWorkspaceHost({
    controller, readConfig, openHint, taskPositions, usagePositions, useContext,
    canNameSession: lifecycle.canNameSession,
    updatePresentation: presentation,
    acknowledge: (sessionId) => { backgroundStatus.update(sessionId, controller.getHistory(), true, openHint); },
    workspaceActions, editor, models, requests, notify, notifyCurrent,
  });
  const rpc = createRpcSlash({
    api: application.api, currentBinding: application.currentBinding,
    optimize: (binding, text, ctx) => {
      setCompletionContext(ctx);
      return application.local({ method: "optimizeText", text }, binding);
    },
  });
  const commands = createCommands({
    controller, taskPositions, useContext, host, requests, models, editor,
    rpcCommand: rpc.command, clearHistory: lifecycle.clearHistory, showOptimizerQuota, notify,
  });
  function invalidateBinding(): void {
    rpc.clearTracking();
    application.invalidate();
  }

  events.subscribe(() => updatePresentation(controller.getState()), true);

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

  return {
    shortcuts: config.shortcuts,
    ...commands,
    setRpcPromptActive: rpc.setHostPromptActive,
    rpcHostSettled: rpc.hostSettled,
    input(ctx: ExtensionContext, text: string, source: string, streamingBehavior?: "steer" | "followUp") {
      useContext(ctx);
      controller.onSubmittedInput(text, source, streamingBehavior);
    },
    messageStarted(message: unknown, ctx: ExtensionContext) {
      useContext(ctx);
      const text = userMessageText(message);
      if (typeof message === "object" && message !== null && "role" in message && message.role === "user") controller.onMessageStarted(text);
    },
    api: application.api,
    lifecycle: {
      ...lifecycle,
      async start(event: { reason: string }, ctx: ExtensionContext) {
        const sequence = ++lifecycleSequence;
        invalidateBinding();
        await lifecycle.start(event, ctx);
        if (sequence === lifecycleSequence) application.bind(ctx.sessionManager.getSessionId());
      },
      beforeTransition(ctx: ExtensionContext) {
        lifecycleSequence++;
        invalidateBinding();
        lifecycle.beforeTransition(ctx);
      },
      tree(ctx: ExtensionContext) {
        lifecycleSequence++;
        invalidateBinding();
        lifecycle.tree(ctx);
        application.bind(ctx.sessionManager.getSessionId());
      },
      async shutdown(ctx: ExtensionContext) {
        lifecycleSequence++;
        invalidateBinding();
        await Promise.all([lifecycle.shutdown(ctx), configuration.flush()]);
        if (progressTimer) clearInterval(progressTimer);
        progressTimer = undefined;
        events.clear();
      },
    },
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
