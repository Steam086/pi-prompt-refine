import { parseKey, SelectList, type SelectItem } from "@earendil-works/pi-tui";
import { clampThinkingLevel, getSupportedThinkingLevels, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { modelKey, type ModelRef, type RefineConfig } from "../config.js";
import { REFINE_SYSTEM_PROMPT } from "../context.js";
import { renderOverlayModelPicker } from "../model-picker.js";
import { REFINE_OVERLAY_OPTIONS } from "../workspace-overlay.js";
import type { RefineController } from "../controller.js";
import type { TaskPanelPosition } from "../task-panel.js";
import { RESTORED_CONTEXT_HINT, type ModelPickerPresenter, type Notify, type NotifyCurrent, type NotifyIfSameSession } from "./contracts.js";

export function sameModel(model: ModelRef, ref: ModelRef): boolean {
  return model.provider === ref.provider && model.id === ref.id;
}

export function modelRef(model: Model<Api>): ModelRef {
  return { provider: model.provider, id: model.id };
}

export function displayModel(model: ModelRef): string {
  return `${model.provider}/${model.id}`;
}

export function effectiveThinkingLevel(model: Model<Api>, override: ModelThinkingLevel | undefined, sessionLevel: ModelThinkingLevel | undefined): ModelThinkingLevel {
  return clampThinkingLevel(model, override ?? sessionLevel ?? "medium");
}

export function thinkingSource(override: ModelThinkingLevel | undefined, sessionLevel: ModelThinkingLevel | undefined): string {
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


interface ModelSelectionDependencies {
  controller: Pick<RefineController,
    "getGeneration" | "getHistory" | "getModel" | "getOriginalRecord" | "getRecord" | "getSessionId" |
    "getState" | "getTaskModels" | "runOriginal" | "setModel">;
  config: Pick<RefineConfig, "model" | "modelThinkingLevels" | "thinkingLevel" | "favorites" | "systemPrompt">;
  useContext(ctx: ExtensionContext): void;
  setCompletionContext(ctx: ExtensionContext): void;
  persistConfig(ctx: ExtensionContext): Promise<boolean>;
  optimizationError(ctx: ExtensionContext, draft: string, selected?: ModelRef): string | undefined;
  taskPositions: Map<string, TaskPanelPosition>;
  usagePositions: Map<string, TaskPanelPosition>;
  notify: Notify;
  notifyCurrent: NotifyCurrent;
  notifyIfSameSession: NotifyIfSameSession;
}

export function createModelSelection({ controller, config, useContext, setCompletionContext,
  persistConfig, optimizationError, taskPositions, usagePositions, notify, notifyCurrent,
  notifyIfSameSession }: ModelSelectionDependencies) {
  const recentRunModels = new Map<string, string[]>();
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

  async function selectModel(ctx: ExtensionContext, runId?: number, runUsage = false,
    present: ModelPickerPresenter = (factory) => ctx.ui.custom(factory, { overlay: true, overlayOptions: REFINE_OVERLAY_OPTIONS })): Promise<void> {
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
    const selection = await present((tui, theme, keybindings, done) => {
      let query = "";
      let list: SelectList;
      let items: SelectItem[] = [];
      // Edits belong to individual models and stay local until confirmation.
      const thinkingEdits = new Map<string, ModelThinkingLevel>();
      const thinkingOverride = (model: ModelRef): ModelThinkingLevel | undefined =>
        thinkingEdits.get(modelKey(model)) ?? config.modelThinkingLevels[modelKey(model)] ??
        baseline?.input.thinkingLevel ?? config.thinkingLevel;
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
      const rebuild = () => {
        items = modelPickerItems(available, query, controller.getModel()).map((item) => ({
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
        list.onSelectionChange = () => tui.requestRender();
      };
      rebuild();

      return {
        render: (width) => {
          const retained = source ? controller.getHistory().filter((record) => record.taskId === source.taskId && record.status !== "unsent") : [];
          return renderOverlayModelPicker({
            items: items.map((item) => {
              if (!source) return item;
              const runs = retained.filter((record) => displayModel(record.input.model) === item.value);
              const running = runs.find((record) => record.status === "generating" || record.status === "queued");
              const latest = running ?? runs.at(-1);
              const status = latest ? ({ generating: "Running", queued: "Queued", generated: "Done", error: "Failed", cancelled: "Cancelled", interrupted: "Interrupted", unsent: "Unsent" })[latest.status] : "";
              const favorite = config.favorites.some((model) => displayModel(model) === item.value);
              return { ...item, description: [item.description, status, recent.includes(item.value) ? "Recent" : favorite ? "Favorite" : ""].filter(Boolean).join(" · ") };
            }),
            selectedKey: list.getSelectedItem()?.value,
            title: source ? "Run original with another model" : "Choose optimizer model",
            subtitle: source ? "Same original and conversation context · Default model unchanged" : "Optimizer only · Main session unchanged",
            query, thinkingStatus: statusFor(highlightedModel()), thinkingKeys: cycleThinkingKeys, run: !!source,
          }, width, tui.terminal.rows, theme);
        },
        invalidate: () => list.invalidate(),
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
      setCompletionContext(ctx);
      const thinking = effectiveThinkingLevel(model, selection.thinkingLevel, ctx.thinkingLevel);
      const result = controller.runOriginal(runId!, modelRef(model), thinking);
      if (result.kind === "started" || result.kind === "duplicate") {
        recentRunModels.set(startSessionId, [selection.modelKey, ...recent.filter((key) => key !== selection.modelKey)].slice(0, 12));
        if (result.kind === "duplicate") {
          const existing = controller.getHistory().find((record) => record.taskId === source.taskId && sameModel(model, record.input.model) &&
            record.input.thinkingLevel === thinking && !record.input.revision && ["queued", "generating"].includes(record.status));
          if (existing) {
            const positions = runUsage ? usagePositions : taskPositions;
            const position = positions.get(startSessionId) ?? {};
            Object.assign(position, { selectedId: existing.id, selectedTaskId: undefined, scroll: 0 });
            positions.set(startSessionId, position);
          }
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

  return { selectModel, editSystemPrompt, cycleModel, modelSwitchBlocked, registeredModels, rememberThinking };
}
