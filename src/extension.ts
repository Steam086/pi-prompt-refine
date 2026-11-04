import { Container, parseKey, SelectList, Text, truncateToWidth, type KeyId, type SelectItem } from "@earendil-works/pi-tui";
import { clampThinkingLevel, getSupportedThinkingLevels, type Api, type Model, type ModelThinkingLevel, type UserMessage } from "@earendil-works/pi-ai";
import { DynamicBorder, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  configPath,
  modelKey,
  saveConfig,
  type ModelRef,
  type RefineConfig,
  type ShortcutAction,
  loadConfig,
} from "./config.js";
import { buildRefineInput, buildRefineSystemPrompt, parseRefineOutput, selectHistory, REFINE_SYSTEM_PROMPT, type HistorySnapshot } from "./context.js";
import { budgetRequest } from "./budget.js";
import { BackgroundStatus, renderBackgroundStatus } from "./background-status.js";
import { renderModelChoices } from "./model-picker.js";
import { formatKeyHint, type KeyHint } from "./key-hints.js";
import { RefineWorkspace, type ContextSettings } from "./workspace.js";
import { PreferenceStore } from "./preference-store.js";
import { PreviewPanel, type PreviewOptions } from "./preview.js";
import { RefineController, type Candidate, type CandidateToken, type ControllerState, type RefineRequest, type RefineRequestInput, type TriggerResult } from "./controller.js";
import type { TaskPanelPosition } from "./task-panel.js";

import { readRunUsage, truncatedOutputHint } from "./usage.js";
import { HistoryStore, historyPath } from "./history-store.js";
import { assembleProjectContext, captureProjectContext, collectDirectoryContext, type TreeSnapshot } from "./project-context.js";

const STATUS_KEY = "prompt-refine";
const RESTORED_CONTEXT_HINT = "Background was not saved. Press i in the task list to copy the original into the current round before running.";

type PreviewAction = "accept" | "edit" | "send" | "dismiss" | "restore" | "close" | "optimize" | "model" | "run-model" | "cycle" | "system-prompt";

function sameModel(model: ModelRef, ref: ModelRef): boolean {
  return model.provider === ref.provider && model.id === ref.id;
}

function modelRef(model: Model<Api>): ModelRef {
  return { provider: model.provider, id: model.id };
}

function displayModel(model: ModelRef): string {
  return `${model.provider}/${model.id}`;
}

function effectiveThinkingLevel(model: Model<Api>, override: ModelThinkingLevel | undefined, sessionLevel: ModelThinkingLevel | undefined): ModelThinkingLevel {
  return clampThinkingLevel(model, override ?? sessionLevel ?? "medium");
}

function thinkingSource(override: ModelThinkingLevel | undefined, sessionLevel: ModelThinkingLevel | undefined): string {
  if (override !== undefined) return "Extension setting";
  return sessionLevel === undefined ? "Default (medium)" : "Inherited from current session";
}

/** Availability/authentication is owned by Pi; this only searches and labels its chat models. */
export function modelPickerItems(models: Model<Api>[], query: string, selected?: ModelRef): SelectItem[] {
  const normalized = query.trim().toLocaleLowerCase();
  return models
    .filter((model) => {
      const capabilities = model.reasoning ? "thinking reasoning 思考 推理" : "";
      const searchable = `${model.provider}/${model.id} ${model.name} ${capabilities}`.toLocaleLowerCase();
      return !normalized || searchable.includes(normalized);
    })
    .map((model) => {
      const identity = displayModel(modelRef(model));
      const isSelected = selected && sameModel(model, selected);
      return {
        value: identity,
        label: `${identity}${model.reasoning ? " [thinking]" : ""}${isSelected ? " (current)" : ""}`,
        description: model.name,
      };
    });
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

function errorStatus(state: ControllerState): string {
  switch (state.error) {
    case "budget": return `⚠ ${state.budget?.message ?? "Request does not fit the model budget. Draft unchanged."}`;
    case "timeout": return "Refine: timed out. Retry.";
    case "empty": return "Refine: no prompt returned. Retry.";
    case "truncated": return `Refine: ${truncatedOutputHint(state.usage)}`;
    case "tool-call": return "Refine: unexpected tool call. Retry.";
    case "invalid-output": return "Refine: invalid output. Retry.";
    default: return "Refine: request failed. Check model/network.";
  }
}

export default async function promptRefineExtension(pi: ExtensionAPI): Promise<void> {
  const filePath = configPath(getAgentDir());
  const loaded = await loadConfig(filePath);
  let config: RefineConfig = loaded.config;
  const configWritable = loaded.warnings.length === 0;
  let currentUiContext: ExtensionContext | undefined;
  let completionContext: ExtensionContext | undefined;
  let saveQueue: Promise<void> = Promise.resolve();
  let historySnapshot: HistorySnapshot | undefined;
  let projectLabel = "";
  let projectWarnings: string[] = [];
  let generatingRequestId: number | undefined;
  let progressTimer: ReturnType<typeof setInterval> | undefined;
  let refreshPreview: (() => void) | undefined;
  let closePreview: (() => void) | undefined;
  let interacting = false;
  const backgroundStatus = new BackgroundStatus();
  let historyStore: HistoryStore | undefined;
  let historyEpoch = 0;
  // Session-wide, not branch/workflow state. Rebuilt from Pi metadata on resume/reload.
  const namedSessions = new Set<string>();
  const previewPositions = new Map<string, number>();
  // Extension-runtime memory only; never coupled to candidate/request invalidation.
  const inputDrafts = new Map<string, string>();
  const taskPositions = new Map<string, TaskPanelPosition>();
  const recentRunModels = new Map<string, string[]>();
  const usagePositions = new Map<string, TaskPanelPosition>();
  // Shared collection is independent of any one model's cancellation signal.
  const contextJobs = new Map<string, { abort: AbortController; promise: Promise<TreeSnapshot>; settled: boolean }>();
  function directorySnapshot(key: string, collect: (signal: AbortSignal) => Promise<TreeSnapshot>): Promise<TreeSnapshot> {
    const existing = contextJobs.get(key);
    if (existing) return existing.promise;
    if (contextJobs.size >= 200) {
      const retained = new Set(controller.getHistory().flatMap(({ input }) => {
        const prefix = JSON.stringify([input.sessionId, input.roundId]) + ":";
        const source = input.revision ? `${input.draft}\n${input.revision.instruction}` : input.draft;
        return [prefix + "base", prefix + JSON.stringify(source)];
      }));
      for (const [jobKey, job] of contextJobs) {
        if (job.settled && !retained.has(jobKey)) contextJobs.delete(jobKey);
      }
    }
    const abort = new AbortController();
    const job = { abort, settled: false, promise: collect(abort.signal) };
    void job.promise.then(() => { job.settled = true; }, () => { job.settled = true; });
    contextJobs.set(key, job);
    return job.promise;
  }
  function clearContextJobs(): void {
    for (const job of contextJobs.values()) job.abort.abort();
    contextJobs.clear();
  }
  const openHint = config.shortcuts.view ?? config.shortcuts.optimize ?? "/refine view";

  const controller = new RefineController({
    timeoutMs: config.timeoutMs,
    maxDraftChars: config.maxDraftChars,
    maxOutputChars: Math.max(config.maxDraftChars, config.maxOutputTokens * 32),
    onState: (state) => {
      if (config.historyPersistence && historyStore && historyStore.sessionId === controller.getSessionId()) historyStore.save(controller.getHistory());
      updatePresentation(state);
    },
    onAccepted: applySessionTitle,
    complete: async (request: RefineRequest, signal) => {
      const ctx = completionContext;
      if (!ctx || ctx.mode !== "tui") throw new Error("TUI context unavailable");
      const model = ctx.modelRegistry.find(request.model.provider, request.model.id);
      if (!model) throw new Error(`Unknown model ${displayModel(request.model)}`);
      const available = ctx.modelRegistry.getAvailable().some((candidate) => sameModel(candidate, request.model));
      if (!available) throw new Error(`Model is not currently available: ${displayModel(request.model)}`);

      const systemPrompt = request.systemPrompt;
      let projectText = "";
      let diagnostics = request.projectDiagnostics;
      const projectConfig = structuredClone(request.project?.config ?? config.projectContext);
      if (request.project && request.preparedInput === undefined) {
        // History gates only the default tree; explicit @directories are independent.
        const project = request.project;
        const roundKey = JSON.stringify([request.sessionId, request.roundId]);
        const source = request.revision ? `${request.draft}\n${request.revision.instruction}` : request.draft;
        // Reserve fixed shares so a frozen default tree and prompt-specific references
        // cannot double the configured per-request listing budgets. Both scopes run
        // under the same wall-clock collection deadline (in parallel).
        const sharedTreeBudget = !request.history.text && projectConfig.tree.enabled && projectConfig.referencedDirectories.enabled;
        const directoryConfig = sharedTreeBudget ? { ...projectConfig, tree: { ...projectConfig.tree,
          maxChars: Math.max(0, Math.floor((projectConfig.tree.maxChars - 2) / 2)),
          maxEntries: Math.floor(projectConfig.tree.maxEntries / 2),
          maxScannedEntries: Math.floor(projectConfig.tree.maxScannedEntries / 2),
        } } : projectConfig;
        const [base, references] = await Promise.all([
          directorySnapshot(`${roundKey}:base`, (sharedSignal) => collectDirectoryContext(project.cwd, "", directoryConfig, !request.history.text, sharedSignal)),
          directorySnapshot(`${roundKey}:${JSON.stringify(source)}`, (sharedSignal) => collectDirectoryContext(project.cwd, source, directoryConfig, false, sharedSignal)),
        ]);
        const tree: TreeSnapshot = { text: [base.text, references.text].filter(Boolean).join("\n\n"),
          warnings: [...new Set([...base.warnings, ...references.warnings])], referencedDirectoryCount: references.referencedDirectoryCount };
        if (signal.aborted) throw new Error("Context collection cancelled");
        const assembled = assembleProjectContext(request.project.snapshot, tree, projectConfig);
        projectText = assembled.text;
        diagnostics = { warnings: assembled.warnings, referencedDirectoryCount: assembled.text.includes("REFERENCED DIRECTORY:") ? tree.referencedDirectoryCount ?? 0 : 0 };
        if (controller.getState().requestId === request.requestId && controller.getGeneration() === request.generation) {
          projectWarnings = assembled.warnings;
          if (tree.referencedDirectoryCount && assembled.text.includes("REFERENCED DIRECTORY:")) {
            projectLabel += ` · @dirs ${tree.referencedDirectoryCount}`;
          }
          if (projectWarnings.length) notify(ctx, projectWarnings.join("\n"), "warning");
          updatePresentation(controller.getState());
        }
      }

      const preparedInput = request.preparedInput ?? buildRefineInput(request.draft, request.history, projectText, request.revision);
      if (signal.aborted) throw new Error("Request cancelled");
      controller.capturePreparedInput(request.requestId, request.generation, preparedInput, diagnostics);
      const budget = budgetRequest(systemPrompt, preparedInput, model, config.maxOutputTokens, request.thinkingLevel);
      const blocked = budget.report.status === "blocked";
      controller.captureBudget(request.requestId, request.generation, budget.report, blocked ? undefined : budget.input);
      if (budget.report.message && controller.getSessionId() === request.sessionId && !signal.aborted) {
        notify(ctx, `⚠ Refine #${request.recordId}: ${budget.report.message}`, "warning");
      }
      if (blocked) return { text: "", stopReason: "budget" };
      if (signal.aborted) throw new Error("Request cancelled");
      const userMessage: UserMessage = {
        role: "user",
        content: [{ type: "text", text: budget.input }],
        timestamp: Date.now(),
      };
      const usageOptions = {
        hasPricing: [model.cost?.input, model.cost?.output, model.cost?.cacheRead, model.cost?.cacheWrite].some((rate) => typeof rate === "number" && rate > 0),
        subscription: ctx.modelRegistry.isUsingOAuth(model),
      };
      const response = await ctx.modelRegistry.streamSimple(
        model,
        { systemPrompt, messages: [userMessage], tools: [] },
        {
          signal,
          maxTokens: budget.maxTokens,
          ...(budget.thinkingBudgets ? { thinkingBudgets: budget.thinkingBudgets } : {}),
          ...(request.thinkingLevel && request.thinkingLevel !== "off" ? { reasoning: request.thinkingLevel } : {}),
        },
      ).result();
      const text = response.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      const stopReason = response.content.some((block) => block.type === "toolCall") ? "toolUse" : response.stopReason;
      const parsed = stopReason === "stop" ? parseRefineOutput(text) : undefined;
      return {
        text: parsed?.text ?? "",
        title: request.generateTitle ? parsed?.title : undefined,
        invalidOutput: stopReason === "stop" && !parsed,
        stopReason,
        usage: readRunUsage(response.usage, usageOptions),
      };
    },
  }, config.model);

  function canNameSession(ctx: ExtensionContext): boolean {
    const sessionId = ctx.sessionManager.getSessionId();
    if (pi.getSessionName()?.trim()) namedSessions.add(sessionId);
    return !namedSessions.has(sessionId);
  }

  function applySessionTitle(candidate: Candidate): void {
    const ctx = currentUiContext;
    if (!ctx || !candidate.title || candidate.sessionId !== ctx.sessionManager.getSessionId() ||
      candidate.sessionId !== controller.getSessionId() || !canNameSession(ctx)) return;
    try {
      // Rechecked at commit time; never overwrite a name set while the model/UI was waiting.
      pi.setSessionName(candidate.title);
      namedSessions.add(candidate.sessionId);
    } catch {
      notify(ctx, "Prompt accepted, but session naming failed. Existing name kept.", "warning");
    }
  }

  function contextLabel(source?: RefineRequestInput): string {
    const snapshot = source?.history ?? historySnapshot;
    if (!snapshot) return "Context: not captured";
    if (source?.budget?.status === "blocked") return "⚠ Budget blocked · no model request";
    if (source?.budget?.status === "trimmed") {
      return `⚠ Budget reduced · ${snapshot.messageCount - source.budget.removedMessages} msgs · input est. ${source.budget.inputTokens} tokens`;
    }
    const project = source ? (source.project ? `${source.project.snapshot.instructionCount} rules · ${source.project.snapshot.skillCount} skills${source.project.config?.tree.enabled && !source.history.text ? " · tree" : ""}${source.projectDiagnostics?.referencedDirectoryCount ? ` · @dirs ${source.projectDiagnostics.referencedDirectoryCount}` : ""}` : "") : projectLabel;
    const warnings = source ? source.projectDiagnostics?.warnings ?? source.project?.snapshot.warnings ?? [] : projectWarnings;
    const warning = warnings.length ? `⚠${warnings.length} · ` : "";
    const history = !snapshot.messageCount
      ? (project ? "No history" : "Draft only")
      : `${snapshot.messageCount} msgs · ${snapshot.characterCount} char · ${snapshot.latestAssistantIncluded ? "assistant" : "no assistant"}${snapshot.truncated ? " · trimmed" : ""}`;
    const completeness = snapshot.status === "disabled_by_policy"
      ? " · history off"
      : `${snapshot.omittedMessageCount ? ` · ${snapshot.omittedMessageCount} omitted` : ""}${snapshot.excerptedMessageCount ? ` · ${snapshot.excerptedMessageCount} excerpted` : ""}`;
    return `${warning}${history}${completeness}${project ? ` · ${project}` : ""}`;
  }

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
    const status = backgroundStatus.update(controller.getSessionId() ?? "", controller.getHistory(), !!closePreview, openHint);
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setWidget(STATUS_KEY, interacting || closePreview || !status ? undefined : (_tui, theme) => ({
      render: (width) => renderBackgroundStatus(status, width, theme),
      invalidate() {},
    }), { placement: "aboveEditor" });
    if (state.phase === "idle" && !state.runningCount && !state.queuedCount) {
      historySnapshot = undefined;
      projectLabel = "";
      projectWarnings = [];
      if (controller.hasWorkspaceContent()) refreshPreview?.();
      else closePreview?.();
    } else refreshPreview?.();
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

  function rememberThinking(model: ModelRef, level: ModelThinkingLevel): boolean {
    const key = modelKey(model);
    if (config.modelThinkingLevels[key] === level) return false;
    config.modelThinkingLevels[key] = level;
    return true;
  }

  // Preserve legacy/default-model settings before switching away for the first time.
  function rememberCurrentThinking(ctx: ExtensionContext): void {
    const current = controller.getModel();
    const model = current && ctx.modelRegistry.find(current.provider, current.id);
    if (model && config.modelThinkingLevels[modelKey(model)] === undefined) {
      rememberThinking(model, effectiveThinkingLevel(model, config.thinkingLevel, ctx.thinkingLevel));
    }
  }

  function registeredModels(ctx: ExtensionContext): Model<Api>[] {
    return ctx.modelRegistry.getAvailable();
  }

  async function selectModel(ctx: ExtensionContext, runId?: number, runUsage = false): Promise<void> {
    useContext(ctx);
    if (ctx.mode !== "tui") {
      notify(ctx, "Optimizer model selection is only available in TUI mode.", "warning");
      return;
    }

    if (modelSwitchBlocked(ctx)) return;
    const source = runId === undefined ? undefined : controller.getOriginalRecord(runId);
    const baseline = runId === undefined ? undefined : controller.getRecord(runId);
    if (runId !== undefined && !source) return;
    if (source?.input.contextUnavailable) { notify(ctx, RESTORED_CONTEXT_HINT, "info"); return; }
    const taskRecords = source ? controller.getHistory().filter((record) => record.taskId === source.taskId) : [];
    const taskModels = source ? taskRecords.map((record) => modelKey(record.input.model)) : controller.getTaskModels().map(modelKey);
    const recent = recentRunModels.get(ctx.sessionManager.getSessionId()) ?? [];
    const available = registeredModels(ctx).slice().sort((a, b) => {
      const rank = (model: ModelRef) => source
        ? (baseline && sameModel(model, baseline.input.model) ? 1000 : recent.includes(modelKey(model)) ? recent.indexOf(modelKey(model))
          : config.favorites.some((favorite) => modelKey(favorite) === modelKey(model)) ? 100 : 200)
        : taskModels.includes(modelKey(model)) ? 0 : config.favorites.some((favorite) => modelKey(favorite) === modelKey(model)) ? 1 : 2;
      return rank(a) - rank(b);
    });
    if (available.length === 0) {
      notify(ctx, "No authorized text-generation models are available. Configure a model and authentication in Pi first.", "warning");
      return;
    }

    const startGeneration = controller.getGeneration();
    const startSessionId = ctx.sessionManager.getSessionId();
    const startBranch = ctx.sessionManager.getLeafId();
    const selection = await ctx.ui.custom<{ modelKey: string; thinkingLevel?: ModelThinkingLevel } | undefined>((tui, theme, keybindings, done) => {
      let query = "";
      let list: SelectList;
      let thinkingStatus: Text;
      // Edits belong to individual models and stay local until confirmation.
      const thinkingEdits = new Map<string, ModelThinkingLevel>();
      const thinkingOverride = (model: ModelRef): ModelThinkingLevel | undefined =>
        thinkingEdits.get(modelKey(model)) ?? config.modelThinkingLevels[modelKey(model)] ??
        baseline?.input.thinkingLevel ?? config.thinkingLevel;
      const container = new Container();
      const cycleThinkingKeys = keybindings.getKeys("app.thinking.cycle")
        .map((key) => key.split("+").map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join("+"))
        .join("/");
      const highlightedModel = (key = list?.getSelectedItem()?.value): Model<Api> | undefined =>
        available.find((candidate) => displayModel(modelRef(candidate)) === key);
      const statusFor = (model: Model<Api> | undefined): string => {
        if (!model) return "Thinking level: no model selected";
        const levels = getSupportedThinkingLevels(model);
        if (levels.length === 1 && levels[0] === "off") return "Thinking level: not supported by this model";
        const override = thinkingOverride(model);
        const level = effectiveThinkingLevel(model, override, ctx.thinkingLevel);
        const source = !thinkingEdits.has(modelKey(model)) && config.modelThinkingLevels[modelKey(model)] !== undefined
          ? "Last used for this model" : thinkingSource(override, ctx.thinkingLevel);
        return `Thinking level: ${level} · ${source}`;
      };
      const selectedDetails = (model: Model<Api> | undefined): string => {
        if (!model) return theme.fg("muted", statusFor(model));
        return [
          theme.fg("muted", "Selected model"),
          theme.fg("text", theme.bold(model.name)),
          theme.fg("muted", displayModel(modelRef(model))),
          theme.fg("text", theme.bold(statusFor(model))),
        ].join("\n");
      };
      const updateThinkingStatus = (model?: Model<Api>) => {
        thinkingStatus?.setText(selectedDetails(model ?? highlightedModel()));
      };
      const rebuild = () => {
        container.clear();
        container.addChild(new DynamicBorder((text) => theme.fg("borderMuted", text)));
        container.addChild(new Text(theme.fg("accent", theme.bold(source ? "Run original with another model" : "Choose optimizer model")), 1, 0));
        container.addChild(new Text(theme.fg("muted", source ? "Same original and conversation context · Default model unchanged" : "Optimizer only · Main session unchanged"), 1, 0));
        container.addChild(new Text(`${theme.fg("muted", "Search:")} ${query ? theme.fg("text", query) : theme.fg("muted", "provider/model, name, or thinking")}`, 1, 1));
        const items = modelPickerItems(available, query, controller.getModel()).map((item) => ({
          ...item, description: `${taskModels.includes(item.value) ? "This task · " : ""}${item.description ?? ""}`,
        }));
        list = new SelectList(items, Math.min(10, Math.max(1, items.length)), {
          selectedPrefix: (text) => theme.fg("accent", text),
          selectedText: (text) => theme.fg("accent", text),
          description: (text) => theme.fg("muted", text),
          scrollInfo: (text) => theme.fg("dim", text),
          noMatch: (text) => theme.fg("warning", text),
        });
        const currentModel = controller.getModel();
        const currentIndex = items.findIndex((item) => item.value === (currentModel ? displayModel(currentModel) : ""));
        if (!source && currentIndex >= 0) list.setSelectedIndex(currentIndex);
        list.onSelect = (item) => {
          const model = highlightedModel(item.value);
          if (model) done({ modelKey: item.value, thinkingLevel: thinkingOverride(model) });
        };
        list.onCancel = () => done(undefined);
        list.onSelectionChange = (item) => {
          updateThinkingStatus(highlightedModel(item.value));
          tui.requestRender();
        };
        container.addChild({
          render: (width) => {
            const retained = source ? controller.getHistory().filter((record) => record.taskId === source.taskId && record.status !== "unsent") : [];
            return renderModelChoices(items.map((item) => {
              if (!source) return item;
              const runs = retained.filter((record) => displayModel(record.input.model) === item.value);
              const running = runs.find((record) => record.status === "generating" || record.status === "queued");
              const latest = running ?? runs.at(-1);
              const status = latest ? ({ generating: "Running", queued: "Queued", generated: "Done", error: "Failed", cancelled: "Cancelled", interrupted: "Interrupted", unsent: "Unsent" })[latest.status] : "";
              const favorite = config.favorites.some((model) => displayModel(model) === item.value);
              return { ...item, description: [item.description, status, recent.includes(item.value) ? "Recent" : favorite ? "Favorite" : ""].filter(Boolean).join(" · ") };
            }), list.getSelectedItem()?.value, width, tui.terminal.rows, theme);
          },
          invalidate: () => list.invalidate(),
        });
        container.addChild(new DynamicBorder((text) => theme.fg("borderMuted", text)));
        thinkingStatus = new Text(selectedDetails(highlightedModel()), 1, 0);
        container.addChild(thinkingStatus);
        const hints: KeyHint[] = [["↑↓", "Select"],
          ...(cycleThinkingKeys ? [[cycleThinkingKeys, "Thinking"] as KeyHint] : []),
          ["Enter", source ? "Run" : "Confirm"], ["Esc", "Cancel"]];
        container.addChild(new Text(hints.map((hint) => formatKeyHint(hint, theme)).join(" · "), 1, 0));
        container.addChild(new DynamicBorder((text) => theme.fg("borderMuted", text)));
      };
      rebuild();

      return {
        render: (width) => width < 1 ? [] : container.render(width),
        invalidate: () => container.invalidate(),
        handleInput(data) {
          if (keybindings.matches(data, "tui.select.cancel")) {
            done(undefined);
            return;
          }
          if (keybindings.matches(data, "app.thinking.cycle")) {
            const model = highlightedModel();
            if (!model) return;
            const levels = getSupportedThinkingLevels(model);
            if (levels.length <= 1) return;
            const current = effectiveThinkingLevel(model, thinkingOverride(model), ctx.thinkingLevel);
            const currentIndex = levels.indexOf(current);
            thinkingEdits.set(modelKey(model), levels[(currentIndex + 1 + levels.length) % levels.length]!);
            updateThinkingStatus(model);
            tui.requestRender();
            return;
          }
          if (keybindings.matches(data, "tui.select.up") || keybindings.matches(data, "tui.select.down") || keybindings.matches(data, "tui.select.confirm")) {
            list.handleInput(data);
            tui.requestRender();
            return;
          }
          if (keybindings.matches(data, "tui.editor.deleteCharBackward")) {
            query = query.slice(0, -1);
            rebuild();
            tui.requestRender();
            return;
          }
          const printable = parseKey(data);
          if (printable && printable.length === 1 && printable >= " ") {
            query += printable;
            rebuild();
            tui.requestRender();
          }
        },
      };
    });

    if (!selection) return;
    if ((!source && controller.getGeneration() !== startGeneration) || controller.getSessionId() !== startSessionId ||
      ctx.sessionManager.getSessionId() !== startSessionId || ctx.sessionManager.getLeafId() !== startBranch) {
      notifyIfSameSession(startSessionId, "The session or result changed while the model picker was open; the previous selection was not applied.");
      return;
    }
    const model = registeredModels(ctx).find((candidate) => displayModel(modelRef(candidate)) === selection.modelKey);
    if (!model || !ctx.modelRegistry.find(model.provider, model.id)) {
      notify(ctx, "The selected model is no longer available; reopen the model picker.", "warning");
      return;
    }

    if (modelSwitchBlocked(ctx)) return;
    if (source) {
      const current = controller.getOriginalRecord(runId!);
      if (!current || current.input.draft !== source.input.draft) return;
      const error = optimizationError(ctx, source.input.draft, modelRef(model));
      if (error) { notify(ctx, error, "warning"); return; }
      completionContext = ctx;
      const thinking = effectiveThinkingLevel(model, selection.thinkingLevel, ctx.thinkingLevel);
      const result = controller.runOriginal(runId!, modelRef(model), thinking);
      if (result.kind === "started" || result.kind === "duplicate") {
        recentRunModels.set(startSessionId, [selection.modelKey, ...recent.filter((key) => key !== selection.modelKey)].slice(0, 12));
        if (result.kind === "duplicate") {
          const existing = controller.getHistory().find((record) => record.taskId === source.taskId && sameModel(model, record.input.model) &&
            record.input.thinkingLevel === thinking && !record.input.revision && ["queued", "generating"].includes(record.status));
          if (existing) (runUsage ? usagePositions : taskPositions).set(startSessionId, { selectedId: existing.id });
          notify(ctx, "This model is already running for the original prompt.", "info");
        }
        if (rememberThinking(model, thinking)) await persistConfig(ctx);
      } else notify(ctx, `Request not started (${result.kind}); existing work kept.`, "warning");
      return;
    }
    const firstSelection = !controller.getModel();
    const selected = modelRef(model);
    if (!config.model || !sameModel(config.model, selected)) rememberCurrentThinking(ctx);
    let changed = controller.setModel(selected);
    if (changed) config.model = selected;
    if (selection.thinkingLevel !== undefined && selection.thinkingLevel !== config.thinkingLevel) {
      config.thinkingLevel = selection.thinkingLevel;
      changed = true;
    }
    changed = rememberThinking(model, effectiveThinkingLevel(model, selection.thinkingLevel, ctx.thinkingLevel)) || changed;
    if (!changed) {
      const level = effectiveThinkingLevel(model, config.thinkingLevel, ctx.thinkingLevel);
      notify(ctx, `${displayModel(selected)} is already the current optimizer model; thinking level: ${level} (${thinkingSource(config.thinkingLevel, ctx.thinkingLevel)}).`, "info");
      return;
    }
    const persisted = await persistConfig(ctx);
    const level = effectiveThinkingLevel(model, config.thinkingLevel, ctx.thinkingLevel);
    const levelSource = thinkingSource(config.thinkingLevel, ctx.thinkingLevel);
    const thinking = getSupportedThinkingLevels(model).length === 1 ? "not supported by this model" : `${level} (${levelSource})`;
    const current = controller.getModel();
    if (controller.getSessionId() === startSessionId && ctx.sessionManager.getSessionId() === startSessionId && current?.provider === selected.provider && current.id === selected.id) {
      notifyCurrent(`Optimizer model set to ${displayModel(selected)}${persisted ? "" : " (current process only; not saved)"}; thinking level: ${thinking}; main session unchanged.${firstSelection ? " Use /refine <text> to start." : ""}`, "info");
    }
  }

  async function editSystemPrompt(ctx: ExtensionContext): Promise<void> {
    const original = config.systemPrompt ?? REFINE_SYSTEM_PROMPT;
    const sessionId = controller.getSessionId();
    const generation = controller.getGeneration();
    const isCurrent = () => controller.getSessionId() === sessionId &&
      controller.getGeneration() === generation && (config.systemPrompt ?? REFINE_SYSTEM_PROMPT) === original;
    const edited = await ctx.ui.editor("Optimization prompt · Edit (cancel keeps original)", original);
    if (edited === undefined || edited === original || !isCurrent()) return;
    if (!edited.trim()) {
      notify(ctx, "Optimization prompt cannot be empty. Original kept.", "warning");
      return;
    }
    const confirmed = await ctx.ui.confirm("Apply optimization prompt changes?",
      "Use the edited instructions for the next round and save them to prompt-refine.json? Existing results and running requests are unchanged. The fixed refiner role, JSON output contract and session title rules are added automatically.");
    if (!confirmed || !isCurrent()) return;
    config.systemPrompt = edited;
    const persisted = await persistConfig(ctx);
    notify(ctx, persisted ? "Optimization prompt saved · Applies to next round." : "Optimization prompt applied · Not persisted.");
  }

  function modelSwitchBlocked(ctx: ExtensionContext): boolean {
    const state = controller.getState();
    if (!state.pendingSend) return false;
    notify(ctx, "Wait for Pi send acknowledgement before switching results or models.", "info");
    return true;
  }

  async function cycleModel(ctx: ExtensionContext): Promise<void> {
    useContext(ctx);
    if (ctx.mode !== "tui") {
      notify(ctx, "Favorite model cycling is only available in TUI mode.", "warning");
      return;
    }
    if (modelSwitchBlocked(ctx)) return;
    const available = new Set(registeredModels(ctx).map(modelKey));
    const refs = [...controller.getTaskModels(), ...config.favorites.filter((favorite) => available.has(modelKey(favorite))),
      ...(controller.getModel() ? [controller.getModel()!] : [])];
    const usable = [...new Map(refs.map((ref) => [modelKey(ref), ref])).values()];
    if (usable.length < 2) {
      notify(ctx, "Use m to choose another model; c cycles this task's models and favorites.", "info");
      return;
    }
    const current = controller.getModel();
    const currentIndex = usable.findIndex((favorite) => modelKey(favorite) === (current ? modelKey(current) : ""));
    const next = usable[(currentIndex + 1) % usable.length];
    if (!next) return;
    rememberCurrentThinking(ctx);
    if (!controller.setModel(next)) {
      notify(ctx, `Favorites contain only the current model ${displayModel(next)}.`, "info");
      return;
    }
    config.model = { ...next };
    config.thinkingLevel = config.modelThinkingLevels[modelKey(next)] ?? config.thinkingLevel;
    await persistConfig(ctx);
    notifyCurrent(`Optimizer model switched to ${displayModel(next)}; the main session model is unchanged.`, "info");
  }

  function optimizationError(ctx: ExtensionContext, draft: string, selected = controller.getModel()): string | undefined {
    if (!draft.trim()) return "The editor is empty; no refinement request was sent.";
    if (draft.length > config.maxDraftChars) return `The draft exceeds ${config.maxDraftChars} characters; no request was sent, and the existing result was kept.`;
    if (!selected) return "No optimizer model is configured; use /refine model to select a text-generation model first.";
    if (!ctx.modelRegistry.find(selected.provider, selected.id) || !ctx.modelRegistry.getAvailable().some((candidate) => sameModel(candidate, selected))) {
      return `Optimizer model is missing or unavailable: ${displayModel(selected)}; no request was sent, and the existing result was kept.`;
    }
    return undefined;
  }

  function draftInput(ctx: ExtensionContext, draft: string): RefineRequestInput {
    const history = selectHistory(ctx.sessionManager.getBranch(), config.context.maxMessages, config.context.maxChars);
    const project = config.projectContext.enabled ? captureProjectContext(ctx, config.projectContext, draft) : undefined;
    const generateTitle = canNameSession(ctx);
    return {
      draft, model: controller.getModel() ?? { provider: "", id: "" },
      generateTitle, systemPrompt: buildRefineSystemPrompt(generateTitle, config.systemPrompt),
      sessionId: ctx.sessionManager.getSessionId(), branchLeafId: ctx.sessionManager.getLeafId(), history,
      ...(project ? { project: { cwd: ctx.cwd, snapshot: project,
        revisionSnapshot: captureProjectContext(ctx, config.projectContext, draft, true), config: structuredClone(config.projectContext) } } : {}),
    };
  }

  function triggerOptimize(ctx: ExtensionContext, force = false, suppliedDraft?: string, keepEditor = false, captureOnly = false): TriggerResult | undefined {
    useContext(ctx);
    if (ctx.mode !== "tui") {
      notify(ctx, "Background prompt refinement is only available in TUI mode; no model request was sent.", "warning");
      return;
    }
    const draft = suppliedDraft ?? ctx.ui.getEditorText();
    // Pi clears the editor on slash-command submission. Keep the supplied source
    // available for retry/accept/restore, but never overwrite another draft.
    if (!keepEditor && suppliedDraft !== undefined && !ctx.ui.getEditorText()) ctx.ui.setEditorText(draft);
    const error = optimizationError(ctx, draft);
    if (error) {
      notify(ctx, error, draft.trim() ? "warning" : "info");
      return;
    }
    const selected = controller.getModel()!;
    const model = ctx.modelRegistry.find(selected.provider, selected.id)!;

    completionContext = ctx;
    const branch = ctx.sessionManager.getBranch();
    const history = selectHistory(
      branch,
      config.context.maxMessages,
      config.context.maxChars,
    );
    const previousContext = { historySnapshot, projectLabel, projectWarnings };
    historySnapshot = history;
    const project = config.projectContext.enabled ? captureProjectContext(ctx, config.projectContext, draft) : undefined;
    projectLabel = project ? `${project.instructionCount} rules · ${project.skillCount} skills${config.projectContext.tree.enabled && !history.text ? " · tree" : ""}` : "";
    projectWarnings = project?.warnings ?? [];
    const generateTitle = canNameSession(ctx);
    const input = {
      draft,
      model: selected,
      thinkingLevel: effectiveThinkingLevel(model, config.thinkingLevel, ctx.thinkingLevel),
      generateTitle,
      systemPrompt: buildRefineSystemPrompt(generateTitle, config.systemPrompt),
      sessionId: ctx.sessionManager.getSessionId(),
      branchLeafId: ctx.sessionManager.getLeafId(),
      history,
      ...(project ? { project: { cwd: ctx.cwd, snapshot: project,
        revisionSnapshot: captureProjectContext(ctx, config.projectContext, draft, true), config: structuredClone(config.projectContext) } } : {}),
    };
    const result = captureOnly ? controller.capture(input) : controller.trigger(input, { force });
    if (result.kind !== "started") {
      ({ historySnapshot, projectLabel, projectWarnings } = previousContext);
    }
    if (result.kind === "empty") notify(ctx, "The editor is empty; no refinement request was sent.", "info");
    else if (result.kind === "too-long") notify(ctx, `The draft exceeds ${config.maxDraftChars} characters; no request was sent. Shorten it and try again.`, "warning");
    else if (result.kind === "duplicate" || result.kind === "ready") {
      void showPreview(ctx).catch(() => notifyCurrent("Could not open the refinement panel; the main draft was not changed.", "warning"));
    }
    else if (result.kind === "busy") notify(ctx, "Work is pending or the 100-entry journal is full. Existing work kept.", "warning");
    return result;
  }

  function generateSameInput(ctx: ExtensionContext): void {
    useContext(ctx);
    if (modelSwitchBlocked(ctx)) return;
    const input = controller.getTaskInput();
    if (!input) {
      notify(ctx, "No frozen input is available. Use r to refine the current editor first.", "info");
      return;
    }
    if (input.contextUnavailable) { notify(ctx, RESTORED_CONTEXT_HINT, "info"); return; }
    if (input.sessionId !== ctx.sessionManager.getSessionId()) {
      notify(ctx, "The session branch changed; use r to capture a new input.", "warning");
      return;
    }
    const error = optimizationError(ctx, input.draft);
    if (error) { notify(ctx, error, "warning"); return; }
    const selected = controller.getModel()!;
    const model = ctx.modelRegistry.find(selected.provider, selected.id)!;
    completionContext = ctx;
    historySnapshot = input.history;
    projectLabel = "Frozen input";
    projectWarnings = [];
    const result = controller.trigger({ ...input, model: selected,
      thinkingLevel: effectiveThinkingLevel(model, config.thinkingLevel, ctx.thinkingLevel),
    }, { force: true, sameTask: true });
    if (result.kind !== "started") notify(ctx, "Same-input generation was not started; current results kept.", "warning");
  }

  async function confirmCurrentDraft(ctx: ExtensionContext, currentDraft: string, purpose: string): Promise<boolean> {
    return ctx.ui.confirm(
      purpose,
      `Replace the main editor? Current draft:\n---\n${currentDraft}\n---\n\nCancelled if the draft or session changes during confirmation.`,
    );
  }

  function acceptCandidate(ctx: ExtensionContext, token: CandidateToken): void {
    useContext(ctx);
    if (!controller.isCandidateCurrent(token)) return;
    const candidate = controller.getCandidate();
    if (!candidate) return;
    const currentDraft = ctx.ui.getEditorText();
    let confirmedOverwrite = false;
    if (currentDraft !== candidate.draft) {
      void confirmCurrentDraft(ctx, currentDraft, "Draft changed").then((confirmed) => {
        if (!confirmed) return;
        if (!controller.isCandidateCurrent(token) || ctx.ui.getEditorText() !== currentDraft) {
          notifyIfSameSession(token.sessionId, "Draft, candidate or session changed. Editor unchanged.");
          return;
        }
        const applied = controller.acceptCandidate(token, currentDraft, true, (text) => ctx.ui.setEditorText(text));
        if (applied) {
          notify(ctx, "Accepted into editor, not sent. Shortcut views; r refines again.", "info");
        }
      }).catch(() => notifyIfSameSession(token.sessionId, "Confirmation incomplete. Editor unchanged."));
      return;
    }
    confirmedOverwrite = true;
    if (!controller.isCandidateCurrent(token) || ctx.ui.getEditorText() !== currentDraft) return;
    const applied = controller.acceptCandidate(token, currentDraft, confirmedOverwrite, (text) => ctx.ui.setEditorText(text));
    if (applied) {
      notify(ctx, "Accepted into editor, not sent. Shortcut views; r refines again.", "info");
    }
  }

  async function editCandidate(ctx: ExtensionContext, token: CandidateToken): Promise<void> {
    if (!controller.isCandidateCurrent(token)) return;
    const candidate = controller.getCandidate();
    if (!candidate) return;
    const edited = await ctx.ui.editor("Edit candidate (cancel keeps original)", candidate.text);
    if (edited === undefined) return;
    if (!controller.isCandidateCurrent(token)) {
      notifyIfSameSession(token.sessionId, "Candidate or session changed. Edits not applied.");
      return;
    }
    if (edited.length > Math.max(config.maxDraftChars, config.maxOutputTokens * 32)) {
      notify(ctx, "Edit too long. Candidate unchanged.", "warning");
      return;
    }
    if (!controller.updateCandidate(token, edited)) {
      notify(ctx, "Empty edit or stale candidate. Candidate unchanged.", "warning");
      return;
    }
    notify(ctx, "Candidate updated. Editor unchanged.", "info");
  }

  async function restoreDraft(ctx: ExtensionContext): Promise<void> {
    useContext(ctx);
    if (ctx.mode !== "tui") {
      notify(ctx, "Restore requires TUI mode.", "warning");
      return;
    }
    const token = controller.getRestoreToken();
    const snapshot = controller.getRestore();
    if (!token || !snapshot) {
      notify(ctx, "Nothing to restore.", "info");
      return;
    }
    const currentDraft = ctx.ui.getEditorText();
    let confirmedOverwrite = false;
    if (currentDraft !== snapshot.applied) {
      const confirmed = await confirmCurrentDraft(ctx, currentDraft, "Editor changed since acceptance");
      if (!confirmed) return;
      if (!controller.isRestoreCurrent(token) || ctx.ui.getEditorText() !== currentDraft) {
        notifyIfSameSession(token.sessionId, "Draft or session changed. Restore cancelled.");
        return;
      }
      confirmedOverwrite = true;
    }
    if (!controller.isRestoreCurrent(token) || ctx.ui.getEditorText() !== currentDraft) return;
    if (controller.restoreDraft(token, currentDraft, confirmedOverwrite, (text) => ctx.ui.setEditorText(text))) {
      notify(ctx, "Draft restored, not sent.", "info");
    }
  }

  function sendCandidate(ctx: ExtensionContext, token: CandidateToken): void {
    useContext(ctx);
    if (ctx.mode !== "tui" || !controller.isCandidateCurrent(token)) return;
    const candidate = controller.getCandidate();
    if (!candidate) return;
    const send = controller.beginSend(token);
    if (!send) {
      notify(ctx, "Send already pending. Not resubmitted.", "warning");
      return;
    }
    try {
      const busy = !ctx.isIdle();
      if (busy) pi.sendUserMessage(send.text, { deliverAs: "followUp" });
      else pi.sendUserMessage(send.text);
      notify(ctx, busy
        ? "Queued as Pi follow-up. Editor draft kept."
        : "Sent to Pi. Editor draft kept.", "info");
    } catch {
      controller.failSend(send.requestId);
      notify(ctx, "Pi rejected the send. Candidate kept; retry.", "error");
    }
  }

  async function showPreview(ctx: ExtensionContext, initialPage?: "usage", resultView = false): Promise<void> {
    if (interacting || ctx.mode !== "tui") return;
    interacting = true;
    ctx.ui.setFooter(() => ({ render: () => [], invalidate() {} }));
    try { await showPreviewContent(ctx, undefined, 3, initialPage, resultView); }
    finally {
      interacting = false;
      ctx.ui.setFooter(undefined);
      updatePresentation(controller.getState());
    }
  }

  function reviseCandidate(ctx: ExtensionContext, token: CandidateToken, instruction: string): string | undefined {
    if (!controller.isCandidateCurrent(token) || controller.getState().pendingSend) return "The result changed or is being sent. Reopen Revise for the current result.";
    if (!instruction.trim()) return "Enter revision instructions; the current result is unchanged.";
    if (instruction.length > config.maxDraftChars) return `Revision instructions exceed ${config.maxDraftChars} characters; the current result is unchanged.`;
    const source = controller.getCandidate()!;
    if (source.contextUnavailable) return RESTORED_CONTEXT_HINT;
    const error = optimizationError(ctx, source.draft, source.model);
    if (error) return error;
    const model = ctx.modelRegistry.find(source.model.provider, source.model.id)!;
    const generateTitle = source.generateTitle;
    const project = source.project?.revisionSnapshot ?? source.project?.snapshot;
    const previousContext = { historySnapshot, projectLabel, projectWarnings };
    historySnapshot = source.history;
    projectLabel = project ? `${project.instructionCount} rules · ${project.skillCount} skills${config.projectContext.tree.enabled && !source.history.text ? " · tree" : ""}` : "";
    projectWarnings = project?.warnings ?? [];
    completionContext = ctx;
    const result = controller.trigger({
      draft: source.draft,
      revision: { previousCandidate: source.text, instruction },
      model: source.model,
      thinkingLevel: effectiveThinkingLevel(model, config.thinkingLevel, ctx.thinkingLevel),
      generateTitle,
      systemPrompt: source.systemPrompt,
      roundId: source.roundId,
      sessionId: source.sessionId,
      branchLeafId: source.branchLeafId,
      history: source.history,
      ...(source.project ? { project: { ...source.project, snapshot: project! } } : {}),
    }, { force: true, revisionToken: token });
    if (result.kind !== "started") {
      ({ historySnapshot, projectLabel, projectWarnings } = previousContext);
      return "Could not revise this result. Reopen Revise; the current draft was not changed.";
    }
    return undefined;
  }

  async function showPreviewContent(ctx: ExtensionContext, settingsContext?: ContextSettings, settingsCursor = 3, initialPage?: "usage", resultView = false): Promise<void> {
    useContext(ctx);
    if (ctx.mode !== "tui") {
      notify(ctx, "Preview requires TUI mode.", "warning");
      return;
    }
    if (closePreview) return; // One user-opened panel; never stack dialogs on repeated shortcuts.
    const sessionId = ctx.sessionManager.getSessionId();
    type Selection = { action: PreviewAction; generation: number; token?: CandidateToken; recordId?: number; settingsContext?: ContextSettings; returnUsage?: boolean };
    let selection: Selection | undefined;
    try {
      selection = await ctx.ui.custom<Selection | undefined>((tui, theme, keybindings, done) => {
        let displayedToken: CandidateToken | undefined;
        const snapshot = (): PreviewOptions => {
          const state = controller.getState();
          const candidate = controller.getCandidate();
          const accepted = state.phase === "idle" ? controller.getViewedAccepted() : undefined;
          const displayed = candidate ?? accepted;
          const source = controller.getRequestSource();
          // A failed revision may keep an older candidate. Its details must describe
          // that displayed result, not the instructions of the failed request.
          const revision = displayed ? displayed.revision : controller.getDisplayedInput()?.revision;
          const draft = displayed?.draft ?? source?.draft;
          const model = displayed?.model ?? state.model ?? controller.getModel();
          const registeredModel = model && registeredModels(ctx).find((candidate) => sameModel(candidate, model));
          // Saved results and in-flight requests must not inherit later setting changes.
          const thinkingLevel = displayed ? displayed.thinkingLevel
            : state.phase === "generating" || state.phase === "error" ? state.thinkingLevel
            : registeredModel ? effectiveThinkingLevel(registeredModel, config.thinkingLevel, ctx.thinkingLevel) : undefined;
          displayedToken = controller.getCandidateToken();
          return {
            state: { ...state, usage: state.phase === "error" ? state.usage : displayed?.usage ?? state.usage, model },
            candidateText: displayed?.text,
            sessionTitle: candidate?.title && canNameSession(ctx) ? candidate.title : undefined,
            draft,
            revisionInstruction: displayed ? revision?.instruction : source?.revisionInstruction,
            previousCandidate: revision?.previousCandidate,
            accepted: accepted ? { editorChanged: ctx.ui.getEditorText() !== accepted.text } : undefined,
            draftChanged: draft !== undefined && ctx.ui.getEditorText() !== draft,
            canRestore: !!controller.getRestore(),
            contextLabel: accepted ? "Accepted snapshot · no model call" : contextLabel(controller.getDisplayedInput()), openHint,
            elapsedSeconds: (state.phase === "error" ? state.elapsedSeconds : displayed?.elapsedSeconds ?? state.elapsedSeconds) ?? 0,
            errorLabel: errorStatus(state),
            navigation: controller.getCandidatePosition(),
            viewKey: (displayed?.recordId ?? state.recordId) ? `record-${displayed?.recordId ?? state.recordId}` : `idle-${controller.getModel()?.id ?? "none"}`,
            thinkingLevel,
            contextUnavailable: displayed?.contextUnavailable,
          };
        };
        const panel = new PreviewPanel(snapshot(), theme, () => tui.terminal.rows, () => tui.requestRender(), previewPositions);
        let closed = false;
        const position = taskPositions.get(sessionId) ?? {};
        taskPositions.set(sessionId, position);
        const usagePosition = usagePositions.get(sessionId) ?? {};
        usagePositions.set(sessionId, usagePosition);
        const runRecord = (id: number, retry = false) => {
          if (closed || ctx.sessionManager.getSessionId() !== sessionId) return;
          const record = controller.getRecord(id);
          if (!record) return;
          if (record.input.contextUnavailable) { notify(ctx, RESTORED_CONTEXT_HINT, "info"); return; }
          const error = optimizationError(ctx, record.input.draft);
          if (error) { notify(ctx, error, "warning"); return; }
          const selected = controller.getModel()!;
          const model = ctx.modelRegistry.find(selected.provider, selected.id)!;
          completionContext = ctx;
          const thinking = effectiveThinkingLevel(model, config.thinkingLevel, ctx.thinkingLevel);
          const result = retry && record.status !== "unsent" ? controller.runOriginal(id, selected, thinking) : controller.startRecord(id, selected, thinking);
          if (result.kind !== "started") notify(ctx, `Request not started (${result.kind}); existing work kept.`, "info");
        };
        const workspace = new RefineWorkspace(panel, tui, theme, keybindings, {
          preferences: { repository: new PreferenceStore(getAgentDir(), ctx.cwd), key: config.preferencesKey, maxChars: config.maxDraftChars },
          original: (id) => {
            if (closed || ctx.sessionManager.getSessionId() !== sessionId) return undefined;
            const source = id === undefined ? undefined : controller.getOriginalRecord(id);
            if (id !== undefined && !source) return undefined;
            const inPlace = source?.status === "unsent" && source.archivedAt === undefined;
            const text = source?.input.draft ?? "";
            const created = inPlace ? undefined : controller.createDraft(draftInput(ctx, text));
            if (!inPlace && created?.kind !== "captured") {
              notify(ctx, `Could not create draft (${created?.kind}); existing work kept.`, "warning");
              return undefined;
            }
            const targetId = inPlace ? source.id : (created as Extract<TriggerResult, { kind: "captured" }>).recordId;
            const target = controller.getRecord(targetId)!;
            const targetPosition = workspace.isUsage() ? usagePosition : position;
            const previousPosition = { ...targetPosition };
            Object.assign(targetPosition, { selectedId: targetId, selectedTaskId: target.taskId, scroll: 0 });
            return {
              text,
              save: (value) => {
                if (closed || ctx.sessionManager.getSessionId() !== sessionId || controller.getSessionId() !== sessionId) return "Session changed; draft not saved.";
                if (value.length > config.maxDraftChars) return `The draft exceeds ${config.maxDraftChars} characters.`;
                return controller.updateDraft(targetId, text, value) ? undefined : "The draft or conversation context changed; cancel and reopen to edit a new copy.";
              },
              cancel: () => {
                if (!inPlace && controller.getSessionId() === sessionId) controller.removeDraft(targetId);
                Object.assign(targetPosition, previousPosition);
                targetPosition.selectedTaskId = previousPosition.selectedTaskId;
                targetPosition.selectedId = previousPosition.selectedId;
              },
            };
          },
          inputCaptureOnly: () => controller.hasWorkspaceContent(),
          inputDraft: {
            text: inputDrafts.get(sessionId) ?? "",
            save: (text) => {
              if (closed || ctx.sessionManager.getSessionId() !== sessionId) return;
              if (text) inputDrafts.set(sessionId, text);
              else inputDrafts.delete(sessionId);
            },
          },
          history: () => controller.getHistory(),
          taskPosition: position,
          usagePosition,
          tasks: {
            records: () => controller.getHistory(),
            launchModel: () => controller.getModel() ? displayModel(controller.getModel()!) : "No model",
            appliedId: () => controller.getAppliedRecordId(),
            activate: (id) => {
              const record = controller.getRecord(id);
              if (record?.status === "unsent") { runRecord(id); return false; }
              return controller.applyResult(id);
            },
            run: (id) => runRecord(id, true),
            stop: (id) => controller.stopRequest(id),
            deleteRecords: (ids) => !closed && ctx.sessionManager.getSessionId() === sessionId && controller.deleteRecords(ids),
            chooseModel: (id) => finish({ action: "run-model", recordId: id, generation: controller.getGeneration() }),
            accept: (id) => {
              if (controller.applyResult(id)) finish({ action: "accept", generation: controller.getGeneration(), token: controller.getCandidateToken() });
            },
          },
          context: () => ({
            instructions: !config.projectContext.instructionsEnabled ? "off" : config.projectContext.instructionsOnFollowUp ? "always" : "first",
            tree: config.projectContext.tree.enabled,
            skills: config.projectContext.skillsEnabled,
          }),
          contextEnabled: () => config.projectContext.enabled,
          optimizer: () => {
            const ref = controller.getModel();
            const model = registeredModels(ctx).find((candidate) => ref && sameModel(candidate, ref));
            const thinkingEnabled = !!model && getSupportedThinkingLevels(model).length > 1;
            return {
              model: ref ? displayModel(ref) : "Not configured",
              thinking: !model ? "Unavailable — select an available model first"
                : !thinkingEnabled ? "Unavailable — fixed for this model"
                : `${effectiveThinkingLevel(model, config.thinkingLevel, ctx.thinkingLevel)} · ${thinkingSource(config.thinkingLevel, ctx.thinkingLevel)}`,
              thinkingEnabled,
            };
          },
          chooseModel: (context) => finish({ action: "model", generation: controller.getGeneration(), settingsContext: context }),
          editSystemPrompt: (context) => finish({ action: "system-prompt", generation: controller.getGeneration(), settingsContext: context }),
          cycleThinking: async () => {
            if (closed || ctx.sessionManager.getSessionId() !== sessionId) return "Session changed; settings not saved.";
            const ref = controller.getModel();
            const model = registeredModels(ctx).find((candidate) => ref && sameModel(candidate, ref));
            if (!model) return "Choose an available model first.";
            const levels = getSupportedThinkingLevels(model);
            if (levels.length <= 1) return "Thinking level is fixed for this model.";
            const current = effectiveThinkingLevel(model, config.thinkingLevel, ctx.thinkingLevel);
            config.thinkingLevel = levels[(levels.indexOf(current) + 1) % levels.length];
            rememberThinking(model, config.thinkingLevel!);
            return await persistConfig(ctx) ? "Thinking level saved" : "Thinking applied · Not persisted; check configuration";
          },
          saveContext: async (selected) => {
            if (closed || ctx.sessionManager.getSessionId() !== sessionId) return "Session changed; settings not saved.";
            config.projectContext.instructionsEnabled = selected.instructions !== "off";
            // Off leaves the saved follow-up preference intact.
            if (selected.instructions !== "off") config.projectContext.instructionsOnFollowUp = selected.instructions === "always";
            config.projectContext.tree.enabled = selected.tree;
            config.projectContext.skillsEnabled = selected.skills;
            return await persistConfig(ctx) ? "Context saved · Applies to next round" : "Context applied · Not persisted; check configuration";
          },
          revision: (id) => {
            const source = id === undefined ? controller.getCandidate() : controller.getRecord(id)?.candidate;
            if (source?.contextUnavailable) { notify(ctx, RESTORED_CONTEXT_HINT, "info"); return undefined; }
            if (id !== undefined && !controller.applyResult(id)) return undefined;
            const token = controller.getCandidateToken();
            if (!token || controller.getState().pendingSend) return undefined;
            return {
              // Failure rebases generation but keeps this source identity; retain its feedback.
              key: `${token.sessionId}:${controller.getCandidate()?.recordId ?? token.requestId}`,
              label: `${displayModel(controller.getCandidate()!.model)} · Run #${controller.getCandidate()!.recordId ?? "?"}`,
              submit: (text: string) => {
                if (closed || ctx.sessionManager.getSessionId() !== sessionId) return "Session changed; no request sent.";
                return reviseCandidate(ctx, token, text);
              },
            };
          },
          submit: (text) => {
            if (closed || ctx.sessionManager.getSessionId() !== sessionId) return "Session changed; no request sent.";
            const error = optimizationError(ctx, text);
            if (error) return error;
            const result = triggerOptimize(ctx, true, text, true, controller.hasWorkspaceContent());
            return result && ["started", "captured", "duplicate", "ready"].includes(result.kind) ? undefined : "Could not add input; existing work kept.";
          },
        });
        const finish = (value?: Selection) => {
          if (closed) return;
          closed = true;
          panel.rememberPosition();
          workspace.dispose();
          refreshPreview = undefined;
          closePreview = undefined;
          done(value ? { ...value, returnUsage: workspace.isUsage() } : undefined);
        };
        if (settingsContext) workspace.openSettings(settingsContext, settingsCursor);
        if (initialPage) workspace.openUsage();
        else if (resultView) workspace.openResult();
        closePreview = () => finish();
        refreshPreview = () => {
          if (closed) return;
          panel.update(snapshot());
          workspace.refreshSettings();
          tui.requestRender();
        };
        // Opening the workspace acknowledges completed requests and hides the background status.
        backgroundStatus.update(sessionId, controller.getHistory(), true, openHint);
        ctx.ui.setStatus(STATUS_KEY, undefined);
        ctx.ui.setWidget(STATUS_KEY, undefined);
        return {
          get focused() { return workspace.focused; },
          set focused(value: boolean) { workspace.focused = value; },
          render: (width) => workspace.render(width),
          invalidate: () => workspace.invalidate(),
          handleInput(data) {
            if (workspace.handleInput(data)) return;
            const navigationKey = parseKey(data);
            if (keybindings.matches(data, "tui.select.cancel") || navigationKey === "ctrl+\\") { finish(); return; }
            if (keybindings.matches(data, "tui.input.submit")) return;
            if (keybindings.matches(data, "tui.editor.cursorUp")) panel.scrollBy(-1);
            else if (keybindings.matches(data, "tui.editor.cursorDown")) panel.scrollBy(1);
            else if (keybindings.matches(data, "tui.editor.pageUp")) panel.page(-1);
            else if (keybindings.matches(data, "tui.editor.pageDown")) panel.page(1);
            else {
              const key = parseKey(data)?.toLocaleLowerCase();
              if (key === "[" || key === "]") {
                if (!modelSwitchBlocked(ctx)) controller.cycleCandidate(key === "[" ? -1 : 1);
                return;
              }
              if ((key === "x" || key === "d") && controller.getState().phase === "generating") {
                controller.stopRequest();
                return;
              }
              if (key === "g") { generateSameInput(ctx); workspace.openTasks(); return; }
              if (key === "c") {
                void cycleModel(ctx).catch(() => notifyCurrent("Could not switch optimizer model.", "warning"));
                return;
              }
              if (key === "o" || key === "?" || key === "v") {
                if (key === "o") panel.toggleOriginal();
                else if (key === "?") panel.toggleHelp();
                else panel.toggleSource();
                tui.requestRender();
                return;
              }
              const keys: Record<string, PreviewAction> = {
                a: "accept", e: "edit", s: "send", x: "dismiss", d: "dismiss", z: "restore",
                r: "optimize", m: "model", c: "cycle", q: "close",
              };
              const action = key ? keys[key] : undefined;
              if (action) {
                if (["accept", "edit", "send"].includes(action) && !displayedToken) return;
                finish({ action, generation: controller.getGeneration(), token: displayedToken });
                return;
              }
            }
            tui.requestRender();
          },
        };
      });
    } finally {
      refreshPreview = undefined;
      closePreview = undefined;
      updatePresentation(controller.getState());
    }
    if (!selection || selection.action === "close") return;
    if (controller.getSessionId() !== sessionId || controller.getGeneration() !== selection.generation) return;
    const { action, token } = selection;
    if (action === "dismiss") controller.cancelAndDismiss();
    else if (action === "restore") await restoreDraft(ctx);
    else if (action === "run-model" && selection.recordId !== undefined) {
      await selectModel(ctx, selection.recordId, selection.returnUsage);
      if (ctx.sessionManager.getSessionId() === sessionId && controller.getSessionId() === sessionId) {
        await showPreviewContent(ctx, undefined, 3, selection.returnUsage ? "usage" : undefined);
      }
    }
    else if (action === "model") {
      await selectModel(ctx);
      if (ctx.sessionManager.getSessionId() === sessionId) {
        await showPreviewContent(ctx, selection.settingsContext, 3, selection.returnUsage ? "usage" : undefined);
      }
    }
    else if (action === "system-prompt") {
      await editSystemPrompt(ctx);
      if (selection.settingsContext && ctx.sessionManager.getSessionId() === sessionId) {
        await showPreviewContent(ctx, selection.settingsContext, 5);
      }
    }
    else if (action === "cycle") await cycleModel(ctx);
    else if (action === "optimize") {
      triggerOptimize(ctx, true);
    } else if (token && controller.isCandidateCurrent(token)) {
      if (action === "accept") acceptCandidate(ctx, token);
      else if (action === "edit") {
        await editCandidate(ctx, token);
        if (ctx.sessionManager.getSessionId() === sessionId &&
          controller.getSessionId() === sessionId && controller.getGeneration() === selection.generation) {
          await showPreviewContent(ctx, undefined, 3, undefined, true);
        }
      }
      else if (action === "send") sendCandidate(ctx, token);
    }
  }

  const actions: Record<ShortcutAction, (ctx: ExtensionContext) => void | Promise<void>> = {
    optimize: (ctx) => {
      if (ctx.mode !== "tui") { triggerOptimize(ctx); return; }
      if (interacting) return;
      useContext(ctx);
      const draft = ctx.ui.getEditorText();
      if (!controller.getModel() || !draft.trim()) return showPreview(ctx);
      if (controller.hasWorkspaceContent()) {
        const knownDraft = controller.hasCapturedDraft(draft);
        const captured = !knownDraft ? triggerOptimize(ctx, false, draft, true, true) : undefined;
        const records = controller.getHistory();
        const position = taskPositions.get(ctx.sessionManager.getSessionId());
        const selected = records.find((record) => position?.selectedTaskId !== undefined
          ? record.taskId === position.selectedTaskId
          : record.id === (position?.selectedId ?? controller.getAppliedRecordId()));
        // Opening with an editor draft is an explicit navigation intent. Background
        // updates still preserve selection; a newly captured prompt must not inherit it.
        let target = captured?.kind === "captured" ? records.find((record) => record.id === captured.recordId) : undefined;
        let original = true;
        if (!target && knownDraft) {
          let matching = records.filter((record) => record.input.draft === draft);
          if (!matching.length) {
            matching = records.filter((record) => record.candidate?.text === draft && (record.acceptedAt !== undefined || record.sentAt !== undefined));
            original = false;
          }
          const current = matching.filter((record) => record.archivedAt === undefined);
          if (current.length) matching = current;
          if (!matching.some((record) => original ? record.taskId === selected?.taskId : record.id === selected?.id && position?.selectedTaskId === undefined)) {
            target = matching.at(-1);
          }
        }
        if (target) taskPositions.set(ctx.sessionManager.getSessionId(), {
          ...position, selectedId: target.id, selectedTaskId: original ? target.taskId : undefined, scroll: 0,
          scrolls: { ...position?.scrolls, [`${original ? "task" : "run"}-${original ? target.taskId : target.id}`]: 0 },
        });
        return showPreview(ctx);
      }
      triggerOptimize(ctx);
    },
    view: (ctx) => showPreview(ctx, undefined, true),
    dismiss: (ctx) => {
      useContext(ctx);
      controller.cancelAndDismiss();
      notify(ctx, "Refinement cancelled. Editor unchanged.", "info");
    },
    selectModel: (ctx) => selectModel(ctx),
    cycleModel: (ctx) => cycleModel(ctx),
    restore: (ctx) => restoreDraft(ctx),
  };

  for (const [action, shortcut] of Object.entries(config.shortcuts) as [ShortcutAction, KeyId | null][]) {
    if (shortcut === null) continue;
    pi.registerShortcut(shortcut, {
      description: `Prompt Refine: ${action}`,
      handler: (ctx) => actions[action](ctx),
    });
  }

  pi.registerCommand("refine", {
    description: "Prompt Refine: /refine <text> or optimize [text], view, history, history clear, usage, cancel, model, cycle, restore",
    handler: async (args, ctx) => {
      const text = args.trim();
      const action = text.toLocaleLowerCase();
      if (action === "history clear") {
        const file = ctx.sessionManager.getSessionFile();
        if (!file) { notify(ctx, "This session has no saved history file.", "info"); return; }
        if (!ctx.hasUI) { notify(ctx, "Clearing history requires confirmation in interactive mode.", "warning"); return; }
        const sessionId = ctx.sessionManager.getSessionId();
        const epoch = historyEpoch;
        if (!await ctx.ui.confirm("Clear saved Refine history?", "Delete this session's Refine sidecar only. In-memory records stay visible; saving pauses until reload. Pi conversation is unchanged.")) return;
        if (epoch !== historyEpoch || sessionId !== controller.getSessionId()) return;
        historyStore ??= new HistoryStore(historyPath(file), sessionId, (message) => notify(ctx, message, "warning"));
        try {
          await historyStore.clear();
          if (epoch !== historyEpoch) return;
          notify(ctx, "Saved Refine history cleared. Saving paused until reload; in-memory records and Pi conversation unchanged.", "info");
        } catch { if (epoch === historyEpoch) notify(ctx, "Could not delete saved Refine history. Saving is paused; check file permissions.", "warning"); }
        return;
      }
      if (action === "history" || action === "usage") {
        await showPreview(ctx, "usage");
        return;
      }
      const mapping: Record<string, ShortcutAction> = {
        optimize: "optimize",
        view: "view",
        cancel: "dismiss",
        dismiss: "dismiss",
        model: "selectModel",
        cycle: "cycleModel",
        restore: "restore",
      };
      if (!action) {
        await showPreview(ctx);
        return;
      }
      // Only exact subcommands are reserved. Preserve prompt case and
      // internal whitespace; `optimize <text>` disambiguates reserved words.
      const explicitDraft = /^optimize\s+([\s\S]+)$/i.exec(text)?.[1];
      const selectedAction = Object.hasOwn(mapping, action) ? mapping[action] : undefined;
      if (explicitDraft !== undefined || !selectedAction) {
        triggerOptimize(ctx, true, explicitDraft ?? text);
        return;
      }
      if (selectedAction === "optimize") triggerOptimize(ctx, true);
      else await actions[selectedAction](ctx);
    },
  });

  pi.on("input", (event, ctx) => {
    useContext(ctx);
    controller.onSubmittedInput(event.text, event.source, event.streamingBehavior);
  });
  pi.on("message_start", (event, ctx) => {
    useContext(ctx);
    if (event.message.role === "user") controller.onMessageStarted(userMessageText(event.message));
  });
  // before_agent_start and input are preflight hooks; only message_start commits a round boundary.
  pi.on("session_start", async (event, ctx) => {
    const epoch = ++historyEpoch;
    const previousStore = historyStore;
    historyStore = undefined;
    currentUiContext = ctx;
    // Include abandoned branches: session names are session-wide. A later explicit
    // clear must not re-enable automatic naming after a resume or /reload either.
    if (ctx.sessionManager.getEntries().some((entry) => entry.type === "session_info" && entry.name?.trim())) {
      namedSessions.add(ctx.sessionManager.getSessionId());
    }
    canNameSession(ctx);
    controller.setSession(ctx.sessionManager.getSessionId());
    if (previousStore) await previousStore.flush();
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (config.historyPersistence && sessionFile) {
      const store = new HistoryStore(historyPath(sessionFile), ctx.sessionManager.getSessionId(), (message) => {
        if (store.sessionId === controller.getSessionId()) notify(ctx, message, "warning");
      });
      const records = await store.load();
      if (epoch !== historyEpoch) return;
      controller.restoreHistory(records);
      historyStore = store;
      if (records.length) notify(ctx, `Restored ${records.length} Refine runs · background not saved · /refine history`, "info");
    }
    for (const warning of loaded.warnings) notify(ctx, warning, "warning");
    if (loaded.shortcutsMigrated) notify(ctx, "Prompt Refine legacy default shortcuts were migrated to Control+\\; the original configuration file was not rewritten, and custom shortcuts are unchanged.", "info");
    if (ctx.mode === "tui" && event.reason === "startup") {
      const key = config.shortcuts.optimize?.replace(/ctrl/g, "Ctrl").replace(/\+/g, " + ");
      const setup = controller.getModel() ? "" : " No optimizer model selected; use /refine model.";
      notify(ctx, `Prompt Refine: Use ${key ?? "/refine optimize"} to refine your prompt.${setup}${config.historyPersistence && sessionFile ? " Minimal prompt/result history is saved beside this session; no full background. Disable with historyPersistence=false." : ""}`);
    }
  });
  pi.on("session_before_tree", (_event, ctx) => {
    currentUiContext = ctx;
    closePreview?.();
    controller.invalidateLifecycle(true);
    currentUiContext = undefined;
  });
  pi.on("session_tree", (_event, ctx) => {
    currentUiContext = ctx;
    controller.invalidateLifecycle(true);
  });
  pi.on("session_before_switch", (_event, ctx) => {
    currentUiContext = ctx;
    closePreview?.();
    controller.invalidateLifecycle(true);
    currentUiContext = undefined;
  });
  pi.on("session_before_fork", (_event, ctx) => {
    currentUiContext = ctx;
    closePreview?.();
    controller.invalidateLifecycle(true);
    currentUiContext = undefined;
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    historyEpoch++;
    currentUiContext = ctx;
    closePreview?.();
    controller.invalidateLifecycle(true);
    currentUiContext = undefined;
    completionContext = undefined;
    clearContextJobs();
    const store = historyStore;
    historyStore = undefined;
    await store?.flush();
  });
}
