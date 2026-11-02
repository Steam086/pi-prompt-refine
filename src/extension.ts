import { Container, parseKey, SelectList, Text, type KeyId, type SelectItem } from "@earendil-works/pi-tui";
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
import { buildRefineInput, buildRefineSystemPrompt, parseRefineOutput, selectHistory, type HistorySnapshot } from "./context.js";
import { READING_WIDTH, renderSummary } from "./presentation.js";
import { PreviewPanel, type PreviewOptions } from "./preview.js";
import { RefineController, type Candidate, type CandidateToken, type ControllerState, type RefineRequest } from "./controller.js";

import { readTokenUsage } from "./usage.js";
import { assembleProjectContext, captureProjectContext, collectDirectoryContext } from "./project-context.js";

const STATUS_KEY = "prompt-refine";

type PreviewAction = "accept" | "edit" | "send" | "dismiss" | "restore" | "close" | "optimize" | "model" | "cycle";

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
  if (override !== undefined) return "扩展设置";
  return sessionLevel === undefined ? "默认 medium" : "继承当前 session";
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
        label: `${identity}${model.reasoning ? " [thinking]" : ""}${isSelected ? " (当前)" : ""}`,
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

function formatStatus(state: ControllerState, viewShortcut: string, accepted?: Candidate): string | undefined {
  const time = `${state.elapsedSeconds ?? 0}s`;
  if (state.phase === "generating") return `Refine · working · ${time}`;
  if (state.phase === "ready") return state.pendingSend
    ? `Refine · send pending · ${time} · draft kept`
    : `Refine · done · ${time} · ${viewShortcut} view`;
  if (state.phase === "error") return `${errorStatus(state)} · ${time}`;
  if (accepted) return `Refine · accepted · ${accepted.elapsedSeconds ?? 0}s · ${viewShortcut} view`;
  return undefined;
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

      let projectText = "";
      if (request.project) {
        // History gates only the default tree; explicit @directories are independent.
        const tree = await collectDirectoryContext(
          request.project.cwd, request.draft, config.projectContext, !request.historyText, signal,
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
        content: [{ type: "text", text: buildRefineInput(request.draft, {
          text: request.historyText,
          messageCount: 0,
          characterCount: request.historyText.length,
        }, projectText) }],
        timestamp: Date.now(),
      };
      const response = await ctx.modelRegistry.streamSimple(
        model,
        { systemPrompt: buildRefineSystemPrompt(!!request.generateTitle), messages: [userMessage], tools: [] },
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
      : `${historySnapshot.messageCount} msgs/${historySnapshot.characterCount} ch · ${historySnapshot.latestAssistantIncluded ? "asst" : "no asst"}${historySnapshot.truncated ? " · trimmed" : ""}`;
    return `${warning}${history}${projectLabel ? ` · ${projectLabel}` : ""}`;
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
    ctx.ui.setStatus(STATUS_KEY, formatStatus(state, openHint, controller.getAccepted()));
    if (state.phase === "idle") {
      historySnapshot = undefined;
      projectLabel = "";
      projectWarnings = [];
      ctx.ui.setWidget(STATUS_KEY, undefined);
      closePreview?.();
    } else {
      const candidateText = controller.getCandidate()?.text;
      ctx.ui.setWidget(STATUS_KEY, closePreview ? undefined : (_tui, theme) => ({
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

  async function persistConfig(ctx: ExtensionContext): Promise<void> {
    if (!configWritable) {
      notify(ctx, "配置文件有错误，未覆盖原文件；本次模型选择仅在当前进程有效。请先修复配置并 /reload。", "warning");
      return;
    }
    const snapshot = structuredClone(config);
    const write = saveQueue.then(() => saveConfig(filePath, snapshot));
    saveQueue = write.catch(() => undefined);
    try {
      await write;
    } catch {
      notifyCurrent("模型选择本次有效，但写入 prompt-refine.json 失败，未能持久化。", "warning");
    }
  }

  function registeredModels(ctx: ExtensionContext): Model<Api>[] {
    return ctx.modelRegistry.getAvailable();
  }

  async function selectModel(ctx: ExtensionContext): Promise<void> {
    useContext(ctx);
    if (ctx.mode !== "tui") {
      notify(ctx, "优化模型选择仅在 TUI 模式可用。", "warning");
      return;
    }

    const available = registeredModels(ctx);
    if (available.length === 0) {
      notify(ctx, "当前没有可用于文本生成的已授权模型；请先在 Pi 中配置模型/认证。", "warning");
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
        if (!model) return "思考强度：未选中模型";
        const levels = getSupportedThinkingLevels(model);
        if (levels.length === 1 && levels[0] === "off") return "思考强度：此模型不支持";
        const level = effectiveThinkingLevel(model, thinkingOverride, ctx.thinkingLevel);
        return `思考强度：${level} · ${thinkingSource(thinkingOverride, ctx.thinkingLevel)}`;
      };
      const updateThinkingStatus = (model?: Model<Api>) => {
        thinkingStatus?.setText(theme.fg("muted", statusFor(model ?? highlightedModel())));
      };
      const rebuild = () => {
        container.clear();
        container.addChild(new DynamicBorder((text) => theme.fg("borderMuted", text)));
        container.addChild(new Text(theme.fg("accent", theme.bold("选择优化模型")), 1, 0));
        container.addChild(new Text(theme.fg("muted", "仅用于 Prompt Refine，不改变主会话模型或 thinking"), 1, 0));
        container.addChild(new Text(`搜索：${query || theme.fg("muted", "provider/model、名称或 thinking")}`, 1, 1));
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
        container.addChild(list);
        thinkingStatus = new Text(theme.fg("muted", statusFor(highlightedModel())), 1, 0);
        container.addChild(thinkingStatus);
        container.addChild(new Text(theme.fg("muted", `输入搜索 · ↑↓ 选择 · ${cycleThinkingKeys || "thinking-cycle 快捷键已禁用"} 调整思考强度 · Enter 确认 · Esc 取消`), 1, 0));
        container.addChild(new DynamicBorder((text) => theme.fg("borderMuted", text)));
      };
      rebuild();

      return {
        render: (width) => container.render(Math.min(width, READING_WIDTH)),
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
      notifyIfSameSession(startSessionId, "会话或结果在模型选择器打开期间已变化；未应用旧选择。");
      return;
    }
    const model = available.find((candidate) => displayModel(modelRef(candidate)) === selection.modelKey);
    if (!model) {
      notify(ctx, "所选模型已不可用；请重新打开模型选择器。", "warning");
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
      notify(ctx, `${displayModel(selected)} 已是当前优化模型；思考强度 ${level}（${thinkingSource(config.thinkingLevel, ctx.thinkingLevel)}）。`, "info");
      return;
    }
    await persistConfig(ctx);
    const level = effectiveThinkingLevel(model, config.thinkingLevel, ctx.thinkingLevel);
    const source = thinkingSource(config.thinkingLevel, ctx.thinkingLevel);
    const thinking = getSupportedThinkingLevels(model).length === 1 ? "模型不支持" : `${level}（${source}）`;
    notifyCurrent(`优化模型已设为 ${displayModel(selected)}；思考强度 ${thinking}；主会话未改变。`, "info");
  }

  async function cycleModel(ctx: ExtensionContext): Promise<void> {
    useContext(ctx);
    if (ctx.mode !== "tui") {
      notify(ctx, "常用优化模型循环仅在 TUI 模式可用。", "warning");
      return;
    }
    const available = registeredModels(ctx);
    const byKey = new Map(available.map((model) => [displayModel(modelRef(model)), model]));
    const usable = config.favorites.filter((favorite) => byKey.has(displayModel(favorite)));
    if (usable.length === 0) {
      notify(ctx, "收藏列表中没有当前可用的文本生成模型；请编辑 prompt-refine.json 的 favorites。", "warning");
      return;
    }
    const current = controller.getModel();
    const currentIndex = usable.findIndex((favorite) => modelKey(favorite) === (current ? modelKey(current) : ""));
    const next = usable[(currentIndex + 1) % usable.length];
    if (!next) return;
    if (!controller.setModel(next)) {
      notify(ctx, `收藏循环仅找到当前模型 ${displayModel(next)}。`, "info");
      return;
    }
    config.model = { ...next };
    await persistConfig(ctx);
    notifyCurrent(`优化模型已切换为 ${displayModel(next)}；主会话模型未改变。`, "info");
  }

  function triggerOptimize(ctx: ExtensionContext, force = false): void {
    useContext(ctx);
    if (ctx.mode !== "tui") {
      notify(ctx, "后台 Prompt 优化仅在 TUI 模式可用；未发送模型请求。", "warning");
      return;
    }
    const draft = ctx.ui.getEditorText();
    if (!draft.trim()) {
      notify(ctx, "输入框为空，没有发送优化请求。", "info");
      return;
    }
    if (draft.length > config.maxDraftChars) {
      notify(ctx, `草稿超过 ${config.maxDraftChars} 个字符；未发送请求，已有结果保留。`, "warning");
      return;
    }
    const selected = controller.getModel();
    if (!selected) {
      notify(ctx, "尚未配置优化模型；使用模型选择快捷键先选择一个文本生成模型。", "warning");
      return;
    }
    const model = ctx.modelRegistry.find(selected.provider, selected.id);
    const available = ctx.modelRegistry.getAvailable().some((candidate) => sameModel(candidate, selected));
    if (!model || !available) {
      notify(ctx, `已配置的优化模型 ${displayModel(selected)} 当前不存在或不可用；没有自动切换模型。`, "warning");
      return;
    }

    completionContext = ctx;
    const history = selectHistory(
      ctx.sessionManager.getBranch(),
      config.context.maxMessages,
      config.context.maxChars,
    );
    const previousContext = { historySnapshot, projectLabel, projectWarnings };
    historySnapshot = history;
    const project = config.projectContext.enabled ? captureProjectContext(ctx, config.projectContext, draft) : undefined;
    projectLabel = project ? `${project.instructionCount} rules/${project.skillCount} skills${config.projectContext.tree.enabled && !history.text ? " · tree" : ""}` : "";
    projectWarnings = project?.warnings ?? [];
    const result = controller.trigger({
      draft,
      model: selected,
      thinkingLevel: effectiveThinkingLevel(model, config.thinkingLevel, ctx.thinkingLevel),
      generateTitle: canNameSession(ctx),
      sessionId: ctx.sessionManager.getSessionId(),
      branchLeafId: ctx.sessionManager.getLeafId(),
      historyText: history.text,
      ...(project ? { project: { cwd: ctx.cwd, snapshot: project } } : {}),
    }, { force });
    if (result.kind !== "started") {
      ({ historySnapshot, projectLabel, projectWarnings } = previousContext);
    }
    if (result.kind === "empty") notify(ctx, "输入框为空，没有发送优化请求。", "info");
    else if (result.kind === "too-long") notify(ctx, `草稿超过 ${config.maxDraftChars} 个字符；未发送请求，请缩短后重试。`, "warning");
    else if (result.kind === "duplicate" || result.kind === "ready") {
      void showPreview(ctx).catch(() => notifyCurrent("优化面板未能打开；主草稿未修改。", "warning"));
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
    useContext(ctx);
    if (ctx.mode !== "tui") {
      notify(ctx, "Preview requires TUI mode.", "warning");
      return;
    }
    if (closePreview) return; // One user-opened panel; never stack dialogs on repeated shortcuts.
    const sessionId = controller.getSessionId();
    type Selection = { action: PreviewAction; generation: number; token?: CandidateToken };
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
        const finish = (value?: Selection) => {
          if (closed) return;
          closed = true;
          refreshPreview = undefined;
          closePreview = undefined;
          done(value);
        };
        closePreview = () => finish();
        refreshPreview = () => {
          if (closed) return;
          panel.update(snapshot());
          tui.requestRender();
        };
        // The full panel replaces the passive card; never show the same result twice.
        ctx.ui.setWidget(STATUS_KEY, undefined);
        return {
          render: (width) => panel.render(width),
          invalidate: () => panel.invalidate(),
          handleInput(data) {
            if (keybindings.matches(data, "tui.select.cancel")) { finish(); return; }
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
    else if (action === "model") await selectModel(ctx);
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
    description: "Prompt Refine: optimize, view, cancel, model, cycle, restore",
    handler: async (args, ctx) => {
      const action = args.trim().toLocaleLowerCase();
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
      const selectedAction = mapping[action];
      if (!selectedAction) {
        notify(ctx, "未知操作。可用：optimize、view、cancel、model、cycle、restore。", "warning");
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
    if (loaded.shortcutsMigrated) notify(ctx, "Prompt Refine 旧默认键位已迁移为 Control+\\；原配置文件未改写，自定义键位不受影响。", "info");
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
