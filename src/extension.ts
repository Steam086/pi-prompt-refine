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
import { renderSummary } from "./presentation.js";
import { renderModelChoices } from "./model-picker.js";
import { formatKeyHint, type KeyHint } from "./key-hints.js";
import { RefineWorkspace } from "./workspace.js";
import { PreviewPanel, type PreviewOptions } from "./preview.js";
import { RefineController, type Candidate, type CandidateToken, type ControllerState, type RefineRequest } from "./controller.js";

import { readTokenUsage } from "./usage.js";
import { assembleProjectContext, captureProjectContext, collectDirectoryContext } from "./project-context.js";

const STATUS_KEY = "prompt-refine";

type PreviewAction = "accept" | "edit" | "send" | "dismiss" | "restore" | "close" | "optimize" | "model" | "cycle" | "system-prompt";

function sameModel(model: Model<Api>, ref: ModelRef): boolean {
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
    case "timeout": return "Refine: timed out. Retry.";
    case "empty": return "Refine: no prompt returned. Retry.";
    case "truncated": return "Refine: incomplete output. Retry.";
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
  // Session-wide, not branch/workflow state. Rebuilt from Pi metadata on resume/reload.
  const namedSessions = new Set<string>();
  const openHint = config.shortcuts.view ?? config.shortcuts.optimize ?? "/refine view";

  const controller = new RefineController({
    timeoutMs: config.timeoutMs,
    maxDraftChars: config.maxDraftChars,
    maxOutputChars: Math.max(config.maxDraftChars, config.maxOutputTokens * 32),
    onState: (state) => updatePresentation(state),
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
      if (request.project) {
        // History gates only the default tree; explicit @directories are independent.
        const tree = await collectDirectoryContext(
          request.project.cwd, request.draft, config.projectContext, !request.history.text, signal,
        );
        if (signal.aborted) throw new Error("Context collection cancelled");
        const project = assembleProjectContext(request.project.snapshot, tree, config.projectContext);
        projectText = project.text;
        if (controller.getState().requestId === request.requestId && controller.getGeneration() === request.generation) {
          projectWarnings = project.warnings;
          if (tree.referencedDirectoryCount && project.text.includes("REFERENCED DIRECTORY:")) {
            projectLabel += ` · @dirs ${tree.referencedDirectoryCount}`;
          }
          if (projectWarnings.length) notify(ctx, projectWarnings.join("\n"), "warning");
          updatePresentation(controller.getState());
        }
      }

      const userMessage: UserMessage = {
        role: "user",
        content: [{ type: "text", text: buildRefineInput(request.draft, request.history, projectText) }],
        timestamp: Date.now(),
      };
      const response = await ctx.modelRegistry.streamSimple(
        model,
        { systemPrompt, messages: [userMessage], tools: [] },
        {
          signal,
          maxTokens: Math.min(config.maxOutputTokens, model.maxTokens),
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
        usage: readTokenUsage(response.usage),
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

  function contextLabel(): string {
    if (!historySnapshot) return "Context: not captured";
    const warning = projectWarnings.length ? `⚠${projectWarnings.length} · ` : "";
    const history = !historySnapshot.messageCount
      ? (projectLabel ? "No history" : "Draft only")
      : `${historySnapshot.messageCount} msgs · ${historySnapshot.characterCount} char · ${historySnapshot.latestAssistantIncluded ? "assistant" : "no assistant"}${historySnapshot.truncated ? " · trimmed" : ""}`;
    const completeness = historySnapshot.status === "disabled_by_policy"
      ? " · history off"
      : `${historySnapshot.omittedMessageCount ? ` · ${historySnapshot.omittedMessageCount} omitted` : ""}${historySnapshot.excerptedMessageCount ? ` · ${historySnapshot.excerptedMessageCount} excerpted` : ""}`;
    return `${warning}${history}${completeness}${projectLabel ? ` · ${projectLabel}` : ""}`;
  }

  function updatePresentation(state: ControllerState): void {
    if (state.phase !== "generating") {
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
    ctx.ui.setStatus(STATUS_KEY, undefined);
    if (state.phase === "idle") {
      historySnapshot = undefined;
      projectLabel = "";
      projectWarnings = [];
      ctx.ui.setWidget(STATUS_KEY, undefined);
      closePreview?.();
    } else {
      const candidateText = controller.getCandidate()?.text;
      ctx.ui.setWidget(STATUS_KEY, interacting || closePreview ? undefined : (_tui, theme) => ({
        render: (width) => renderSummary({
          state, candidateText, contextLabel: contextLabel(), openHint,
          elapsedSeconds: state.elapsedSeconds ?? 0,
          errorLabel: errorStatus(state),
        }, width, theme),
        invalidate() {},
      }), { placement: "aboveEditor" });
      refreshPreview?.();
    }
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

  function registeredModels(ctx: ExtensionContext): Model<Api>[] {
    return ctx.modelRegistry.getAvailable();
  }

  async function selectModel(ctx: ExtensionContext): Promise<void> {
    useContext(ctx);
    if (ctx.mode !== "tui") {
      notify(ctx, "Optimizer model selection is only available in TUI mode.", "warning");
      return;
    }

    const available = registeredModels(ctx);
    if (available.length === 0) {
      notify(ctx, "No authorized text-generation models are available. Configure a model and authentication in Pi first.", "warning");
      return;
    }

    const startGeneration = controller.getGeneration();
    const startSessionId = ctx.sessionManager.getSessionId();
    const selection = await ctx.ui.custom<{ modelKey: string; thinkingLevel?: ModelThinkingLevel; thinkingTouched: boolean } | undefined>((tui, theme, keybindings, done) => {
      let query = "";
      let list: SelectList;
      let thinkingStatus: Text;
      let thinkingOverride = config.thinkingLevel;
      let thinkingTouched = false;
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
        const level = effectiveThinkingLevel(model, thinkingOverride, ctx.thinkingLevel);
        return `Thinking level: ${level} · ${thinkingSource(thinkingOverride, ctx.thinkingLevel)}`;
      };
      const selectedDetails = (model: Model<Api> | undefined): string => {
        if (!model) return theme.fg("muted", statusFor(model));
        return [
          theme.fg("muted", "Selected model"),
          theme.fg("text", model.name),
          theme.fg("muted", displayModel(modelRef(model))),
          theme.fg("text", statusFor(model)),
        ].join("\n");
      };
      const updateThinkingStatus = (model?: Model<Api>) => {
        thinkingStatus?.setText(selectedDetails(model ?? highlightedModel()));
      };
      const rebuild = () => {
        container.clear();
        container.addChild(new DynamicBorder((text) => theme.fg("borderMuted", text)));
        container.addChild(new Text(theme.fg("accent", theme.bold("Choose optimizer model")), 1, 0));
        container.addChild(new Text(theme.fg("muted", "Optimizer only · Main session unchanged"), 1, 0));
        container.addChild(new Text(`${theme.fg("muted", "Search:")} ${query ? theme.fg("text", query) : theme.fg("muted", "provider/model, name, or thinking")}`, 1, 1));
        const items = modelPickerItems(available, query, controller.getModel());
        list = new SelectList(items, Math.min(10, Math.max(1, items.length)), {
          selectedPrefix: (text) => theme.fg("accent", text),
          selectedText: (text) => theme.fg("accent", text),
          description: (text) => theme.fg("muted", text),
          scrollInfo: (text) => theme.fg("dim", text),
          noMatch: (text) => theme.fg("warning", text),
        });
        const currentModel = controller.getModel();
        const currentIndex = items.findIndex((item) => item.value === (currentModel ? displayModel(currentModel) : ""));
        if (currentIndex >= 0) list.setSelectedIndex(currentIndex);
        list.onSelect = (item) => done({ modelKey: item.value, thinkingLevel: thinkingOverride, thinkingTouched });
        list.onCancel = () => done(undefined);
        list.onSelectionChange = (item) => {
          updateThinkingStatus(highlightedModel(item.value));
          tui.requestRender();
        };
        container.addChild({
          render: (width) => renderModelChoices(items, list.getSelectedItem()?.value, width, tui.terminal.rows, theme),
          invalidate: () => list.invalidate(),
        });
        container.addChild(new DynamicBorder((text) => theme.fg("borderMuted", text)));
        thinkingStatus = new Text(selectedDetails(highlightedModel()), 1, 0);
        container.addChild(thinkingStatus);
        const hints: KeyHint[] = [["↑↓", "Select"],
          ...(cycleThinkingKeys ? [[cycleThinkingKeys, "Thinking"] as KeyHint] : []),
          ["Enter", "Confirm"], ["Esc", "Cancel"]];
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
            const current = effectiveThinkingLevel(model, thinkingOverride, ctx.thinkingLevel);
            const currentIndex = levels.indexOf(current);
            thinkingOverride = levels[(currentIndex + 1 + levels.length) % levels.length];
            thinkingTouched = true;
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
    if (controller.getGeneration() !== startGeneration || controller.getSessionId() !== startSessionId) {
      notifyIfSameSession(startSessionId, "The session or result changed while the model picker was open; the previous selection was not applied.");
      return;
    }
    const model = available.find((candidate) => displayModel(modelRef(candidate)) === selection.modelKey);
    if (!model) {
      notify(ctx, "The selected model is no longer available; reopen the model picker.", "warning");
      return;
    }

    const selected = modelRef(model);
    let changed = controller.setModel(selected);
    if (changed) config.model = selected;
    if (selection.thinkingTouched && selection.thinkingLevel !== undefined) {
      config.thinkingLevel = selection.thinkingLevel;
      changed = true;
    }
    if (!changed) {
      const level = effectiveThinkingLevel(model, config.thinkingLevel, ctx.thinkingLevel);
      notify(ctx, `${displayModel(selected)} is already the current optimizer model; thinking level: ${level} (${thinkingSource(config.thinkingLevel, ctx.thinkingLevel)}).`, "info");
      return;
    }
    await persistConfig(ctx);
    const level = effectiveThinkingLevel(model, config.thinkingLevel, ctx.thinkingLevel);
    const source = thinkingSource(config.thinkingLevel, ctx.thinkingLevel);
    const thinking = getSupportedThinkingLevels(model).length === 1 ? "not supported by this model" : `${level} (${source})`;
    notifyCurrent(`Optimizer model set to ${displayModel(selected)}; thinking level: ${thinking}; main session unchanged.`, "info");
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
      "Use the edited instructions for future refinements and save them to prompt-refine.json? Existing results and running requests are unchanged. The fixed refiner role, JSON output contract and session title rules are added automatically.");
    if (!confirmed || !isCurrent()) return;
    config.systemPrompt = edited;
    const persisted = await persistConfig(ctx);
    notify(ctx, persisted ? "Optimization prompt saved · Next refinement only." : "Optimization prompt applied · Not persisted.");
  }

  async function cycleModel(ctx: ExtensionContext): Promise<void> {
    useContext(ctx);
    if (ctx.mode !== "tui") {
      notify(ctx, "Favorite model cycling is only available in TUI mode.", "warning");
      return;
    }
    const available = registeredModels(ctx);
    const byKey = new Map(available.map((model) => [displayModel(modelRef(model)), model]));
    const usable = config.favorites.filter((favorite) => byKey.has(displayModel(favorite)));
    if (usable.length === 0) {
      notify(ctx, "No available text-generation models are in favorites; edit the favorites list in prompt-refine.json.", "warning");
      return;
    }
    const current = controller.getModel();
    const currentIndex = usable.findIndex((favorite) => modelKey(favorite) === (current ? modelKey(current) : ""));
    const next = usable[(currentIndex + 1) % usable.length];
    if (!next) return;
    if (!controller.setModel(next)) {
      notify(ctx, `Favorites contain only the current model ${displayModel(next)}.`, "info");
      return;
    }
    config.model = { ...next };
    await persistConfig(ctx);
    notifyCurrent(`Optimizer model switched to ${displayModel(next)}; the main session model is unchanged.`, "info");
  }

  function optimizationError(ctx: ExtensionContext, draft: string): string | undefined {
    if (!draft.trim()) return "The editor is empty; no refinement request was sent.";
    if (draft.length > config.maxDraftChars) return `The draft exceeds ${config.maxDraftChars} characters; no request was sent, and the existing result was kept.`;
    const selected = controller.getModel();
    if (!selected) return "No optimizer model is configured; use /refine model to select a text-generation model first.";
    if (!ctx.modelRegistry.find(selected.provider, selected.id) || !ctx.modelRegistry.getAvailable().some((candidate) => sameModel(candidate, selected))) {
      return `Optimizer model is missing or unavailable: ${displayModel(selected)}; no automatic model switch was made.`;
    }
    return undefined;
  }

  function triggerOptimize(ctx: ExtensionContext, force = false, suppliedDraft?: string, keepEditor = false): void {
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
    const followUp = branch.some((entry) => entry.type === "message" &&
      (entry.message.role === "user" || entry.message.role === "assistant"));
    const history = selectHistory(
      branch,
      config.context.maxMessages,
      config.context.maxChars,
    );
    const previousContext = { historySnapshot, projectLabel, projectWarnings };
    historySnapshot = history;
    const project = config.projectContext.enabled ? captureProjectContext(ctx, config.projectContext, draft, followUp) : undefined;
    projectLabel = project ? `${project.instructionCount} rules · ${project.skillCount} skills${config.projectContext.tree.enabled && !history.text ? " · tree" : ""}` : "";
    projectWarnings = project?.warnings ?? [];
    const generateTitle = canNameSession(ctx);
    const result = controller.trigger({
      draft,
      model: selected,
      thinkingLevel: effectiveThinkingLevel(model, config.thinkingLevel, ctx.thinkingLevel),
      generateTitle,
      systemPrompt: buildRefineSystemPrompt(generateTitle, config.systemPrompt),
      sessionId: ctx.sessionManager.getSessionId(),
      branchLeafId: ctx.sessionManager.getLeafId(),
      history,
      ...(project ? { project: { cwd: ctx.cwd, snapshot: project } } : {}),
    }, { force });
    if (result.kind !== "started") {
      ({ historySnapshot, projectLabel, projectWarnings } = previousContext);
    }
    if (result.kind === "empty") notify(ctx, "The editor is empty; no refinement request was sent.", "info");
    else if (result.kind === "too-long") notify(ctx, `The draft exceeds ${config.maxDraftChars} characters; no request was sent. Shorten it and try again.`, "warning");
    else if (result.kind === "duplicate" || result.kind === "ready") {
      void showPreview(ctx).catch(() => notifyCurrent("Could not open the refinement panel; the main draft was not changed.", "warning"));
    }
    else if (result.kind === "started") {
      // A synchronously completed adapter is still handled without opening any UI.
    }
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

  async function showPreview(ctx: ExtensionContext): Promise<void> {
    if (interacting || ctx.mode !== "tui") return;
    interacting = true;
    ctx.ui.setFooter(() => ({ render: () => [], invalidate() {} }));
    try { await showPreviewContent(ctx); }
    finally {
      interacting = false;
      ctx.ui.setFooter(undefined);
      updatePresentation(controller.getState());
    }
  }

  async function showPreviewContent(ctx: ExtensionContext, settingsContext?: boolean[], settingsCursor = 3): Promise<void> {
    useContext(ctx);
    if (ctx.mode !== "tui") {
      notify(ctx, "Preview requires TUI mode.", "warning");
      return;
    }
    if (closePreview) return; // One user-opened panel; never stack dialogs on repeated shortcuts.
    const sessionId = controller.getSessionId();
    type Selection = { action: PreviewAction; generation: number; token?: CandidateToken; settingsContext?: boolean[] };
    let selection: Selection | undefined;
    try {
      selection = await ctx.ui.custom<Selection | undefined>((tui, theme, keybindings, done) => {
        let displayedToken: CandidateToken | undefined;
        const snapshot = (): PreviewOptions => {
          const state = controller.getState();
          const candidate = controller.getCandidate();
          const accepted = state.phase === "idle" ? controller.getAccepted() : undefined;
          const displayed = candidate ?? accepted;
          displayedToken = controller.getCandidateToken();
          return {
            state: { ...state, usage: displayed?.usage ?? state.usage, model: displayed?.model ?? state.model ?? controller.getModel() },
            candidateText: displayed?.text,
            sessionTitle: candidate?.title && canNameSession(ctx) ? candidate.title : undefined,
            draft: displayed?.draft,
            accepted: accepted ? { editorChanged: ctx.ui.getEditorText() !== accepted.text } : undefined,
            draftChanged: !!candidate && ctx.ui.getEditorText() !== candidate.draft,
            canRestore: !!controller.getRestore(),
            contextLabel: accepted ? "Accepted snapshot · no model call" : contextLabel(), openHint,
            elapsedSeconds: displayed?.elapsedSeconds ?? state.elapsedSeconds ?? 0,
            errorLabel: errorStatus(state),
          };
        };
        const panel = new PreviewPanel(snapshot(), theme, () => tui.terminal.rows, () => tui.requestRender());
        let closed = false;
        const workspace = new RefineWorkspace(panel, tui, theme, keybindings, {
          context: () => [config.projectContext.instructionsEnabled, config.projectContext.tree.enabled, config.projectContext.skillsEnabled],
          contextEnabled: () => config.projectContext.enabled,
          optimizer: () => {
            const ref = controller.getModel();
            const model = registeredModels(ctx).find((candidate) => ref && sameModel(candidate, ref));
            return {
              model: ref ? displayModel(ref) : "Not configured",
              thinking: model ? `${effectiveThinkingLevel(model, config.thinkingLevel, ctx.thinkingLevel)} · ${thinkingSource(config.thinkingLevel, ctx.thinkingLevel)}` : "Choose a model first",
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
            return await persistConfig(ctx) ? "Thinking level saved" : "Thinking applied · Not persisted; check configuration";
          },
          saveContext: async (selected) => {
            if (closed || ctx.sessionManager.getSessionId() !== sessionId) return "Session changed; settings not saved.";
            config.projectContext.instructionsEnabled = selected[0]!;
            config.projectContext.tree.enabled = selected[1]!;
            config.projectContext.skillsEnabled = selected[2]!;
            return await persistConfig(ctx) ? "Context saved · Next refinement only" : "Context applied · Not persisted; check configuration";
          },
          submit: (text) => {
            if (closed || ctx.sessionManager.getSessionId() !== sessionId) return "Session changed; no request sent.";
            const error = optimizationError(ctx, text);
            if (error) return error;
            triggerOptimize(ctx, true, text, true);
            return undefined;
          },
        });
        const finish = (value?: Selection) => {
          if (closed) return;
          closed = true;
          workspace.dispose();
          refreshPreview = undefined;
          closePreview = undefined;
          done(value);
        };
        if (settingsContext) workspace.openSettings(settingsContext, settingsCursor);
        closePreview = () => finish();
        refreshPreview = () => {
          if (closed) return;
          panel.update(snapshot());
          tui.requestRender();
        };
        // The full panel replaces the passive card; never show the same result twice.
        ctx.ui.setWidget(STATUS_KEY, undefined);
        return {
          get focused() { return workspace.focused; },
          set focused(value: boolean) { workspace.focused = value; },
          render: (width) => workspace.render(width),
          invalidate: () => workspace.invalidate(),
          handleInput(data) {
            if (workspace.handleInput(data)) return;
            const navigationKey = parseKey(data);
            if (navigationKey === "left") return;
            if (keybindings.matches(data, "tui.select.cancel") || navigationKey === "ctrl+\\") { finish(); return; }
            if (keybindings.matches(data, "tui.input.submit")) return;
            if (keybindings.matches(data, "tui.editor.cursorUp")) panel.scrollBy(-1);
            else if (keybindings.matches(data, "tui.editor.cursorDown")) panel.scrollBy(1);
            else if (keybindings.matches(data, "tui.editor.pageUp")) panel.page(-1);
            else if (keybindings.matches(data, "tui.editor.pageDown")) panel.page(1);
            else {
              const key = parseKey(data)?.toLocaleLowerCase();
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
    else if (action === "model") {
      await selectModel(ctx);
      if (selection.settingsContext && ctx.sessionManager.getSessionId() === sessionId) {
        await showPreviewContent(ctx, selection.settingsContext);
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
      else if (action === "edit") await editCandidate(ctx, token);
      else if (action === "send") sendCandidate(ctx, token);
    }
  }

  const actions: Record<ShortcutAction, (ctx: ExtensionContext) => void | Promise<void>> = {
    optimize: (ctx) => {
      if (ctx.mode !== "tui") return triggerOptimize(ctx);
      if (interacting) return;
      useContext(ctx);
      if (controller.shouldOpenPanel() || !controller.getModel() || !ctx.ui.getEditorText().trim()) return showPreview(ctx);
      triggerOptimize(ctx);
    },
    view: (ctx) => showPreview(ctx),
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
    description: "Prompt Refine: /refine <text> or optimize [text], view, cancel, model, cycle, restore",
    handler: async (args, ctx) => {
      const text = args.trim();
      const action = text.toLocaleLowerCase();
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
      // Only exact bare subcommands are reserved. Preserve prompt case and
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
  pi.on("before_agent_start", (event, ctx) => {
    useContext(ctx);
    const text = event.messageType === "user" ? event.prompt : userMessageText(event.message);
    controller.onMessageStarted(text);
  });
  pi.on("session_start", (_event, ctx) => {
    currentUiContext = ctx;
    // Include abandoned branches: session names are session-wide. A later explicit
    // clear must not re-enable automatic naming after a resume or /reload either.
    if (ctx.sessionManager.getEntries().some((entry) => entry.type === "session_info" && entry.name?.trim())) {
      namedSessions.add(ctx.sessionManager.getSessionId());
    }
    canNameSession(ctx);
    controller.setSession(ctx.sessionManager.getSessionId());
    for (const warning of loaded.warnings) notify(ctx, warning, "warning");
    if (loaded.shortcutsMigrated) notify(ctx, "Prompt Refine legacy default shortcuts were migrated to Control+\\; the original configuration file was not rewritten, and custom shortcuts are unchanged.", "info");
  });
  pi.on("session_before_tree", (_event, ctx) => {
    currentUiContext = ctx;
    controller.invalidateLifecycle(true);
    currentUiContext = undefined;
  });
  pi.on("session_tree", (_event, ctx) => {
    currentUiContext = ctx;
    controller.invalidateLifecycle(true);
  });
  pi.on("session_before_switch", (_event, ctx) => {
    currentUiContext = ctx;
    controller.invalidateLifecycle(true);
    currentUiContext = undefined;
  });
  pi.on("session_before_fork", (_event, ctx) => {
    currentUiContext = ctx;
    controller.invalidateLifecycle(true);
    currentUiContext = undefined;
  });
  pi.on("session_shutdown", (_event, ctx) => {
    currentUiContext = ctx;
    controller.invalidateLifecycle(true);
    currentUiContext = undefined;
    completionContext = undefined;
  });
}
