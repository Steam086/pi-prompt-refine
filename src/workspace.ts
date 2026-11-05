import { stripVTControlCharacters } from "node:util";
import { matchesKey, parseKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type KeybindingsManager, type KeyId, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { PreviewPanel } from "./preview.js";
import { panelFrame, panelLayout, panelTabs, workspaceTabs, WORKSPACE_PAGES, type WorkspacePage } from "./panel-layout.js";
import { alignedKeyHints, fittingKeyHints, type KeyHint } from "./key-hints.js";
import { PromptInput } from "./prompt-input.js";
import { sanitizeTerminalText } from "./presentation.js";
import { TaskPanel, type TaskPanelActions, type TaskPanelPosition } from "./task-panel.js";
import type { RefineRecord } from "./history.js";
import { PreferencePanel } from "./preference-panel.js";
import { composeRevision, type PreferenceRepository, type RevisionDraft, type SelectedPreference } from "./revision-preferences.js";
import { canonicalShortcut } from "./config.js";

export interface ContextSettings {
  instructions: "first" | "always" | "off";
  tree: boolean;
  skills: boolean;
}

const instructionModes = ["first", "always", "off"] as const;
const instructionLabels = { first: "First request only", always: "Always", off: "Off" };
const instructionSummaries = { first: "Include rules on the first request", always: "Include rules in every request", off: "Exclude project rules" };
const instructionDescriptions = {
  first: "Pi rules (e.g. AGENTS.md): first request per task; omitted from Revise.",
  always: "Include Pi rules (e.g. AGENTS.md) in every refinement and Revise request.",
  off: "Do not include Pi rules (e.g. AGENTS.md) in refinement requests.",
};

interface WorkspaceActions {
  preferences?: { repository: PreferenceRepository; key: KeyId | null; maxChars: number };
  original?(id?: number): { text: string; save(text: string): string | undefined; cancel(): void } | undefined;
  /** Session-owned text, independent of request snapshots and revision feedback. */
  inputDraft?: { text: string; save(text: string): void };
  inputCaptureOnly?(): boolean;
  history?(): RefineRecord[];
  tasks?: TaskPanelActions;
  taskPosition?: TaskPanelPosition;
  usagePosition?: TaskPanelPosition;
  context(): ContextSettings;
  contextEnabled(): boolean;
  optimizer?(): { model: string; thinking: string; thinkingEnabled: boolean };
  chooseModel?(context: ContextSettings): void;
  editSystemPrompt?(context: ContextSettings): void;
  cycleThinking?(): Promise<string>;
  saveContext(selected: ContextSettings): Promise<string>;
  /** Undefined means the request was accepted; errors stay beside the retained input. */
  submit(text: string): string | undefined;
  /** Captures one actionable candidate; the callback rejects stale targets. */
  revision?(id?: number): { key: string; label?: string; submit(text: string): string | undefined } | undefined;
}

/** One custom UI lifetime: internal navigation never restores the host editor/card. */
export class RefineWorkspace implements Component, Focusable {
  private mode: "main" | "result" | "context" | "input" | "usage" = "main";
  private historyPanel?: TaskPanel;
  private taskPanel?: TaskPanel;
  private returnToTasks = false;
  private inputReturnMode: "main" | "result" | "usage" = "main";
  private settingsInitialized = false;
  private hasFocus = false;
  private selected: ContextSettings = { instructions: "always", tree: false, skills: false };
  private original: ContextSettings = { ...this.selected };
  private cursor = 0;
  private settingsScrollTop = 0;
  private groupCursors = [0, 3];
  private settingsOptimizer?: ReturnType<NonNullable<WorkspaceActions["optimizer"]>>;
  private settingsContextEnabled = true;
  private settingsCacheKey = "";
  private settingsFrames = new Map<string, { lines: string[]; scrollTop: number }>();
  private saving = false;
  private disposed = false;
  private inputError = "";
  private settingsNotice = "";
  private beforeInput = "";
  private readonly input: PromptInput;
  private revisionInput: PromptInput;
  private readonly originalInput: PromptInput;
  private originalTarget?: ReturnType<NonNullable<WorkspaceActions["original"]>>;
  private inputKind: "draft" | "revision" | "original" = "draft";
  private revisionTarget?: ReturnType<NonNullable<WorkspaceActions["revision"]>>;
  private readonly revisionDrafts = new Map<string, RevisionDraft>();
  private revisionSelected: SelectedPreference[] = [];
  private preferencePanel?: PreferencePanel;
  private revisionExpanded = false;
  private revisionFocus: "input" | "preferences" | "requirements" = "input";
  private reviewingRequirements = false;
  private requirementsScroll = 0;
  private requirementsCache?: { text: string; width: number; lines: string[] };
  private revisionSource?: { render(width: number): string[] };
  private preferencesKey?: KeyId | null;
  private preferencesKeyNotice = "";

  private get activeInput(): PromptInput { return this.inputKind === "original" ? this.originalInput : this.inputKind === "revision" ? this.revisionInput : this.input; }

  constructor(
    private readonly panel: PreviewPanel,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keys: KeybindingsManager,
    private readonly actions: WorkspaceActions,
  ) {
    this.preferencesKey = actions.preferences?.key;
    if (this.preferencesKey && Object.values(keys.getResolvedBindings()).some((binding) =>
      (Array.isArray(binding) ? binding : [binding]).some((key) => key && canonicalShortcut(key) === canonicalShortcut(this.preferencesKey!)))) {
      this.preferencesKey = null;
      this.preferencesKeyNotice = "Preferences key conflicts with Pi bindings; use Tab then Enter. ";
    }
    if (actions.tasks) {
      const taskActions: TaskPanelActions = { ...actions.tasks, revise: (id) => this.openRevision(id),
        editOriginal: (id) => this.openOriginal(id), activate: (id) => {
        const applied = actions.tasks!.activate(id);
        if (applied) this.showApplied(id);
        return applied;
      } };
      this.taskPanel = new TaskPanel(taskActions, theme, () => tui.terminal.rows, keys, false, actions.taskPosition);
    }
    this.input = this.makeInput();
    this.input.editor.setText(actions.inputDraft?.text ?? "");
    this.revisionInput = this.makeInput();
    this.originalInput = this.makeInput();
    for (const input of [this.input, this.originalInput]) {
      input.editor.onSubmit = () => {
        const text = this.beforeInput;
        const error = input === this.originalInput ? (this.originalTarget ? this.originalTarget.save(text) : "Original prompt changed; reopen the editor.")
          : this.actions.submit(text);
        // Native Editor clears on submit. Submission reads our draft; it never consumes it.
        input.editor.setText(text);
        if (error) {
          this.inputError = error;
        } else {
          this.inputError = "";
          if (input === this.originalInput) { this.originalTarget = undefined; this.switchMode(this.inputReturnMode); }
          else this.switchMode("main");
        }
      };
    }
  }

  private makeInput(): PromptInput {
    const theme = this.theme;
    return new PromptInput(this.tui, {
      borderColor: (text) => theme.fg("borderMuted", text),
      selectList: {
        selectedPrefix: (text) => theme.fg("accent", text), selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text), scrollInfo: (text) => theme.fg("muted", text),
        noMatch: (text) => theme.fg("warning", text),
      },
    });
  }

  get focused(): boolean { return this.hasFocus; }
  set focused(value: boolean) {
    this.hasFocus = value;
    this.input.editor.focused = value && this.mode === "input" && this.inputKind === "draft";
    this.revisionInput.editor.focused = value && !this.preferencePanel && !this.reviewingRequirements && this.revisionFocus === "input" && this.mode === "input" && this.inputKind === "revision";
    this.originalInput.editor.focused = value && this.mode === "input" && this.inputKind === "original";
    if (this.preferencePanel) this.preferencePanel.focused = value;
  }

  private openRevision(id?: number): void {
    const target = this.actions.revision?.(id);
    if (!target) {
      const notice = "Result unavailable or send pending; reopen an actionable result to revise.";
      this.panel.setNotice(notice); this.taskPanel?.setNotice(notice); this.historyPanel?.setNotice(notice);
      this.tui.requestRender();
      return;
    }
    const draft = this.revisionDrafts.get(target.key);
    if (target.key !== this.revisionTarget?.key) {
      // Undo must not resurrect another candidate's feedback. Child pages keep this instance.
      this.revisionInput.editor.focused = false;
      this.revisionInput = this.makeInput();
      this.revisionInput.editor.setText(draft?.freeText ?? "");
    }
    this.revisionTarget = target;
    this.revisionSelected = structuredClone(draft?.selected ?? []);
    this.inputKind = "revision";
    this.inputReturnMode = this.mode === "usage" ? "usage" : this.mode === "result" ? "result" : "main";
    this.revisionSource = this.inputReturnMode === "usage" ? this.historyPanel?.snapshot()
      : this.inputReturnMode === "main" ? this.taskPanel?.snapshot() ?? this.panel.snapshot() : this.panel.snapshot();
    this.inputError = "";
    this.revisionExpanded = false;
    this.revisionFocus = "input";
    this.reviewingRequirements = false;
    this.switchMode("input");
  }

  private rememberRevision(): void {
    if (!this.revisionTarget) return;
    this.revisionDrafts.set(this.revisionTarget.key, { freeText: this.revisionInput.editor.getExpandedText(), selected: structuredClone(this.revisionSelected) });
    if (this.revisionDrafts.size > 100) this.revisionDrafts.delete(this.revisionDrafts.keys().next().value!);
  }

  private openPreferences(): void {
    const options = this.actions.preferences;
    if (!options || !this.revisionTarget || this.preferencePanel) return;
    this.rememberRevision();
    this.preferencePanel = new PreferencePanel(this.tui, this.theme, this.keys, options.repository,
      this.revisionSelected, this.revisionInput.editor.getExpandedText(), options.maxChars, (selected) => {
        this.preferencePanel?.dispose(); this.preferencePanel = undefined;
        if (selected) { this.revisionSelected = selected; this.rememberRevision(); }
        this.revisionFocus = "input";
        this.focused = this.hasFocus;
        if (!this.disposed) this.tui.requestRender();
      });
    this.focused = this.hasFocus;
    this.tui.requestRender();
  }

  private openOriginal(id?: number): void {
    const target = this.actions.original?.(id);
    if (!target) return;
    (this.mode === "usage" ? this.historyPanel : this.taskPanel)?.openList();
    this.originalTarget = target;
    this.originalInput.editor.setText(target.text);
    this.inputKind = "original";
    this.inputReturnMode = this.mode === "usage" ? "usage" : "main";
    this.inputError = "";
    this.switchMode("input");
  }

  dispose(): void { this.disposed = true; this.preferencePanel?.dispose(); this.originalTarget?.cancel(); this.originalTarget = undefined; this.focused = false; }
  invalidate(): void {
    this.panel.invalidate();
    this.historyPanel?.invalidate();
    this.taskPanel?.invalidate();
    this.input.editor.invalidate();
    this.revisionInput.editor.invalidate();
    this.originalInput.editor.invalidate();
    this.preferencePanel?.invalidate();
    this.settingsFrames.clear();
    this.refreshSettings();
  }

  /** Called by host state refreshes; arrow navigation never queries the model registry. */
  refreshSettings(): void {
    if (this.mode !== "context") return;
    this.settingsOptimizer = this.actions.optimizer?.();
    this.settingsContextEnabled = this.actions.contextEnabled();
  }

  private switchMode(mode: "main" | "result" | "context" | "input" | "usage"): void {
    this.mode = mode;
    this.focused = this.hasFocus;
    this.tui.requestRender();
  }

  openUsage(): void {
    const actions = this.actions.tasks;
    this.historyPanel = new TaskPanel({
      ...actions,
      records: () => this.actions.history?.() ?? [],
      appliedId: () => actions?.appliedId(),
      activate: (id) => {
        const applied = actions?.activate(id) ?? false;
        if (applied) this.showApplied(id);
        return applied;
      },
      run: (id) => actions?.run(id), stop: (id) => actions?.stop(id), launchModel: () => actions?.launchModel?.() ?? "No model",
      editOriginal: (id) => this.openOriginal(id),
      revise: (id) => this.openRevision(id),
    }, this.theme, () => this.tui.terminal.rows, this.keys, true, this.actions.usagePosition);
    this.switchMode("usage");
  }

  private showApplied(id: number): void {
    this.taskPanel?.openList();
    this.historyPanel?.openList();
    if (this.actions.taskPosition) {
      this.actions.taskPosition.selectedId = id;
      this.actions.taskPosition.selectedTaskId = undefined;
      this.actions.taskPosition.scroll = 0;
    }
    this.openResult(true);
  }

  isUsage(): boolean { return this.mode === "usage"; }
  openTasks(): void { this.taskPanel?.openList(); this.switchMode("main"); }

  openResult(fromTasks = false): void { this.returnToTasks = fromTasks; this.switchMode("result"); }

  private navigatePage(direction: number): void {
    const page: WorkspacePage = this.mode === "context" ? "Settings" : this.mode === "usage" ? "Usage" : "Preview";
    const next = WORKSPACE_PAGES[(WORKSPACE_PAGES.indexOf(page) + direction + WORKSPACE_PAGES.length) % WORKSPACE_PAGES.length];
    if (next === "Settings") {
      if (!this.settingsInitialized) this.openSettings();
      else { this.switchMode("context"); this.refreshSettings(); }
    } else if (next === "Preview") this.switchMode("main");
    else this.openUsage();
  }

  openSettings(selected = this.actions.context(), cursor = this.cursor): void {
    this.settingsInitialized = true;
    this.original = this.actions.context();
    this.selected = { ...selected };
    const count = this.actions.optimizer ? (this.actions.editSystemPrompt ? 6 : 5) : 3;
    this.cursor = Math.max(0, Math.min(cursor, count - 1));
    this.groupCursors[this.cursor < 3 ? 0 : 1] = this.cursor;
    this.settingsScrollTop = 0;
    this.settingsNotice = "";
    this.switchMode("context");
    this.refreshSettings();
  }

  private switchSettingsGroup(): void {
    if (!this.settingsOptimizer) return;
    const group = this.cursor < 3 ? 0 : 1;
    this.groupCursors[group] = this.cursor;
    this.cursor = this.groupCursors[1 - group]!;
    this.settingsScrollTop = 0;
    this.tui.requestRender();
  }

  private cycleThinking(): void {
    if (!this.actions.cycleThinking || !this.settingsOptimizer?.thinkingEnabled) return;
    this.saving = true;
    void this.actions.cycleThinking().then((notice) => { this.settingsNotice = notice; })
      .catch(() => { this.settingsNotice = "Could not save thinking level."; })
      .finally(() => {
        this.saving = false;
        if (!this.disposed) { this.refreshSettings(); this.tui.requestRender(); }
      });
    this.tui.requestRender();
  }

  /** Returns false only for main-page keys handled by the extension's guarded actions. */
  handleInput(data: string): boolean {
    if (this.disposed) return true;
    if (this.preferencePanel) { this.preferencePanel.handleInput(data); return true; }
    const key = parseKey(data);
    if (this.mode === "input") {
      if (this.inputKind === "revision" && this.reviewingRequirements) {
        if (this.keys.matches(data, "tui.select.cancel") || key === "ctrl+\\") {
          this.reviewingRequirements = false; this.revisionFocus = "input"; this.focused = this.hasFocus;
        } else if (key === "up" || key === "down" || key === "pageup" || key === "pagedown") {
          const delta = key === "up" ? -1 : key === "down" ? 1 : (key === "pageup" ? -1 : 1) * Math.max(1, this.tui.terminal.rows - 8);
          this.requirementsScroll = Math.max(0, this.requirementsScroll + delta);
        }
        this.tui.requestRender(); return true;
      }
      if (this.inputKind === "revision" && (key === "tab" || key === "shift+tab")) {
        const controls = this.actions.preferences ? ["input", "preferences", "requirements"] as const : ["input", "requirements"] as const;
        const index = controls.findIndex((control) => control === this.revisionFocus);
        this.revisionFocus = controls[(index + (key === "tab" ? 1 : controls.length - 1)) % controls.length]!;
        this.focused = this.hasFocus; this.tui.requestRender(); return true;
      }
      if (this.inputKind === "revision" && this.revisionFocus !== "input" && this.keys.matches(data, "tui.select.confirm")) {
        if (this.revisionFocus === "preferences") this.openPreferences();
        else { this.reviewingRequirements = true; this.requirementsScroll = 0; this.focused = this.hasFocus; }
        this.tui.requestRender(); return true;
      }
      if (this.inputKind === "revision" && this.preferencesKey && matchesKey(data, this.preferencesKey)) {
        this.openPreferences(); return true;
      }
      if (this.inputKind === "revision" && key === "ctrl+e") {
        this.revisionExpanded = !this.revisionExpanded;
        this.tui.requestRender();
        return true;
      }
      if (this.keys.matches(data, "tui.select.cancel") || key === "ctrl+\\") {
        if (this.inputKind === "revision") this.rememberRevision();
        this.originalTarget?.cancel();
        this.originalTarget = undefined;
        this.switchMode(this.inputReturnMode); // Back never discards the independent input draft.
      } else {
        this.beforeInput = this.activeInput.editor.getExpandedText();
        this.inputError = "";
        const input = this.activeInput;
        if (this.inputKind === "revision" && key === "ctrl+s") {
          const requirements = composeRevision(this.revisionSelected, this.beforeInput);
          const error = !requirements.trim() ? "Select preferences or enter additional requirements before submitting."
            : this.revisionTarget?.submit(requirements);
          this.inputError = this.revisionTarget ? error ?? "" : "No current result to revise.";
          if (!this.inputError) this.switchMode("result");
        }
        else if (this.inputKind === "revision" && this.revisionFocus === "input" && this.keys.matches(data, "tui.input.submit")) input.editor.insertTextAtCursor("\n");
        else if (this.inputKind !== "revision" || this.revisionFocus === "input") input.editor.handleInput(data);
        // Observe the final expanded value, not Editor's transient empty onSubmit value
        // or collapsed paste markers. Cursor movement and request refreshes do not save.
        const text = input.editor.getExpandedText();
        if (input === this.input && text !== this.beforeInput) this.actions.inputDraft?.save(text);
        if (input === this.revisionInput && this.revisionTarget) {
          this.rememberRevision();
        }
        this.tui.requestRender();
      }
      return true;
    }
    const activeTasks = this.mode === "main" ? this.taskPanel : this.mode === "usage" ? this.historyPanel : undefined;
    if (activeTasks?.isConfirmingDelete()) {
      activeTasks.handleInput(data);
      this.tui.requestRender();
      return true;
    }
    // Input/Revise owns cursor keys. Settings visits its adjacent group before
    // leaving the page; arrows at the outer group boundaries still change pages.
    if (this.saving) return true;
    if (key === "left" || key === "right") {
      if (this.mode === "context" && this.settingsOptimizer &&
        (key === "right" ? this.cursor < 3 : this.cursor >= 3)) {
        this.switchSettingsGroup();
      } else this.navigatePage(key === "left" ? -1 : 1);
      return true;
    }
    if (this.mode === "usage" || (this.mode === "main" && this.taskPanel)) {
      if ((this.mode === "usage" ? this.historyPanel : this.taskPanel)?.handleInput(data)) {
        this.tui.requestRender();
        return true;
      }
      if (this.mode === "usage" && (key === "q" || key === "ctrl+\\" || this.keys.matches(data, "tui.select.cancel"))) {
        this.switchMode("main");
        return true;
      }
    }
    if (this.mode === "result" && this.returnToTasks && (key === "q" || this.keys.matches(data, "tui.select.cancel"))) {
      this.switchMode("main");
      return true;
    }
    if (this.mode === "context") {
      if (key === "q" || key === "ctrl+\\" || this.keys.matches(data, "tui.select.cancel")) {
        this.settingsInitialized = false;
        this.switchMode("main");
      } else if (key === "tab") {
        this.switchSettingsGroup();
      } else if (key === "ctrl+s") {
        this.saving = true;
        this.tui.requestRender();
        void this.actions.saveContext({ ...this.selected }).then((notice) => {
          if (this.disposed) return;
          this.panel.setNotice(notice);
          this.taskPanel?.setNotice(notice);
          this.settingsInitialized = false;
          this.switchMode("main");
        }).catch(() => {
          if (this.disposed) return;
          this.settingsNotice = "Could not save context. Retry with Ctrl+S.";
        }).finally(() => {
          this.saving = false;
          if (!this.disposed) this.tui.requestRender();
        });
      } else if (this.actions.optimizer && this.keys.matches(data, "app.thinking.cycle")) {
        this.cycleThinking();
      } else if (this.keys.matches(data, "tui.input.submit") || key === "space") {
        if (this.cursor < 3) {
          if (this.cursor === 0) {
            this.selected.instructions = instructionModes[(instructionModes.indexOf(this.selected.instructions) + 1) % instructionModes.length]!;
          } else {
            const field = this.cursor === 1 ? "tree" : "skills";
            this.selected[field] = !this.selected[field];
          }
          this.settingsNotice = "";
          this.tui.requestRender();
        } else if (this.cursor === 3) this.actions.chooseModel?.({ ...this.selected });
        else if (this.cursor === 5) this.actions.editSystemPrompt?.({ ...this.selected });
        else this.cycleThinking();
      } else {
        const start = this.cursor < 3 ? 0 : 3;
        const count = start === 0 || this.actions.editSystemPrompt ? 3 : 2;
        if (this.keys.matches(data, "tui.select.up")) this.cursor = start + (this.cursor - start + count - 1) % count;
        else if (this.keys.matches(data, "tui.select.down")) this.cursor = start + (this.cursor - start + 1) % count;
        else return true;
        this.tui.requestRender();
      }
      return true;
    }
    if (key?.toLowerCase() === "f") {
      this.openRevision();
      return true;
    }
    if (key?.toLowerCase() === "p") {
      this.panel.setNotice("Press f to revise, then open Preferences with Alt+P or Tab.");
      this.tui.requestRender();
      return true;
    }
    if (key?.toLowerCase() === "i") {
      this.inputKind = "draft";
      this.inputReturnMode = this.mode === "result" ? "result" : "main";
      this.inputError = "";
      this.switchMode("input");
      return true;
    }
    return false;
  }

  private renderRequirements(width: number): string[] {
    const layout = panelLayout(width, this.tui.terminal.rows);
    const text = composeRevision(this.revisionSelected, this.revisionInput.editor.getExpandedText());
    if (this.requirementsCache?.text !== text || this.requirementsCache.width !== layout.innerWidth) {
      this.requirementsCache = { text, width: layout.innerWidth,
        lines: text.split("\n").flatMap((line) => wrapTextWithAnsi(sanitizeTerminalText(line), layout.innerWidth)) };
    }
    this.requirementsScroll = Math.min(this.requirementsScroll, Math.max(0, this.requirementsCache.lines.length - layout.bodyHeight));
    return panelFrame(layout, [this.theme.fg("text", this.theme.bold("Full revision requirements")),
      this.theme.fg("muted", `${text.length} chars · Preference snapshots + additional requirements · Not sent`)],
      this.requirementsCache.lines.slice(this.requirementsScroll, this.requirementsScroll + layout.bodyHeight).map((line) => this.theme.fg("text", line)),
      alignedKeyHints([[["Esc", "Back"]], [["↑↓ / PgUp/PgDn", "Scroll"]]], layout.innerWidth, this.theme),
      (line) => this.theme.fg("borderMuted", line));
  }

  private renderRevision(width: number): string[] {
    const layout = panelLayout(width, this.tui.terminal.rows);
    const { theme } = this;
    const inline = !this.revisionExpanded && layout.bodyHeight >= 12 && layout.innerWidth >= 36;
    const editorHeight = inline ? Math.min(5, Math.max(3, this.revisionInput.editor.getText().split("\n").length)) : layout.bodyHeight;
    const title = `${layout.innerWidth < 64 && this.revisionTarget?.label ? "Revise" : "Revise current result"}${this.revisionTarget?.label ? ` · ${this.revisionTarget.label}` : ""}`;
    const selected = this.revisionSelected.length ? `${this.revisionSelected.length} · ${this.revisionSelected.map((item) => item.name + (item.body !== item.sourceBody ? "*" : "")).join(", ")}` : "None";
    const status = this.inputError || `${this.preferencesKeyNotice}Not sent · Selected snapshots + additional requirements${this.revisionSelected.some((item) => item.body !== item.sourceBody) ? " · * Edited for this revision only" : ""}`;
    const control = (label: string, active: boolean) => active ? theme.bg("selectedBg", theme.fg("text", theme.bold(`› ${label}`))) : theme.fg("muted", label);
    const controls = [control(sanitizeTerminalText(`Preferences: ${selected}`), this.revisionFocus === "preferences"),
      control("Review full requirements", this.revisionFocus === "requirements"),
      control("Additional requirements:", this.revisionFocus === "input")];
    const header = [theme.fg("text", theme.bold(sanitizeTerminalText(title))), theme.fg(this.inputError ? "warning" : "muted", sanitizeTerminalText(status))];
    const footer = alignedKeyHints([
      [["Ctrl+S", "Revise"], ["Enter", "Newline"], ...(this.preferencesKey ? [[this.preferencesKey.toUpperCase(), "Preferences"] as const] : [])],
      [["Esc", "Back"], ["Tab", "Focus"], ["Ctrl+E", inline ? "Expand" : "Collapse"]],
    ], layout.innerWidth, theme);
    if (layout.footerHeight === 1) footer[0] = fittingKeyHints([["Esc", "Back"], ["^S", "Revise"], ["Tab", "Focus"]], layout.innerWidth, theme);
    if (this.revisionFocus !== "input") footer[0] = fittingKeyHints([
      ...(layout.footerHeight === 1 ? [["Esc", "Back"] as const] : []),
      ["Enter", this.revisionFocus === "preferences" ? "Preferences" : "Review"], ["Tab", "Focus"], ["Ctrl+S", "Revise"]], layout.innerWidth, theme);
    const visibleControls = layout.bodyHeight <= 1 && this.revisionFocus === "input" ? [] : layout.bodyHeight >= 5 ? controls : [control(sanitizeTerminalText(this.revisionFocus === "preferences" ? `Preferences: ${selected}` : this.revisionFocus === "requirements" ? "Review full requirements" : `Additional requirements · Preferences: ${selected}`), true)];
    const editor = this.revisionInput.render(layout.innerWidth, Math.max(1, inline ? editorHeight : layout.bodyHeight - visibleControls.length));
    if (!inline) return panelFrame(layout, header, [...visibleControls, ...editor], footer, (text) => theme.fg("borderMuted", text));
    // Keep the source panel's viewport/scroll unchanged; only cover its lower rows.
    // Browsing shortcuts are suspended while the editor owns focus.
    const source = this.revisionSource?.render(width);
    const pad = (line: string) => " ".repeat(layout.inset) + truncateToWidth(line, layout.innerWidth, "");
    const bottom = [theme.fg("borderMuted", "─".repeat(layout.innerWidth)), ...header,
      ...visibleControls, ...Array.from({ length: editorHeight }, (_, i) => editor[i] ?? ""),
      ...footer.slice(0, layout.footerHeight)].map(pad);
    return [...(source ?? []).slice(0, layout.height - bottom.length), ...bottom];
  }

  render(width: number): string[] {
    if (width < 1) return [];
    if (this.preferencePanel) return this.preferencePanel.render(width);
    if (this.mode === "input" && this.inputKind === "revision") return this.reviewingRequirements ? this.renderRequirements(width) : this.renderRevision(width);
    if (this.mode === "result") return this.panel.render(width);
    if (this.mode === "main") return this.taskPanel?.render(width, () => this.panel.render(width)) ?? this.panel.render(width);
    if (this.mode === "usage") return this.historyPanel?.render(width) ?? [];
    const layout = panelLayout(width, this.tui.terminal.rows);
    const { innerWidth, bodyHeight } = layout;
    const { theme } = this;
    let frameKey = "";
    if (this.mode === "context") {
      const cacheKey = JSON.stringify([width, layout.height, this.selected, this.original, this.settingsOptimizer,
        this.settingsContextEnabled, this.saving, this.settingsNotice]);
      if (cacheKey !== this.settingsCacheKey) {
        this.settingsFrames.clear();
        this.settingsCacheKey = cacheKey;
      }
      frameKey = `${this.cursor}:${this.settingsScrollTop}`;
      const cached = this.settingsFrames.get(frameKey);
      if (cached) { this.settingsScrollTop = cached.scrollTop; return cached.lines; }
    }
    let body: string[];
    let header: string[];
    let footer: string[];
    if (this.mode === "input") {
      const cursor = this.activeInput.editor.getCursor();
      const action = this.inputKind === "original" ? "Save" : this.actions.inputCaptureOnly?.() ? "Add unsent" : "Refine";
      header = [theme.fg("text", theme.bold(this.inputKind === "original" ? "Edit original prompt" : "Input")),
        theme.fg(this.inputError ? "warning" : "muted", sanitizeTerminalText(this.inputError || (this.inputKind === "original"
          ? `Line ${cursor.line + 1} · Save only · Enter on the list to run` : `Line ${cursor.line + 1} · Not sent to main agent`)))];
      body = this.activeInput.render(innerWidth, bodyHeight);
      footer = alignedKeyHints(innerWidth < 30
        ? [[["↵", action], ["⇧↵", "NL"]], [["Esc", "Back"]]]
        : [[["Enter", action], ["Shift+Enter", "Newline"]], [["Esc", "Back"]]], innerWidth, theme);
      if (layout.footerHeight === 1) footer = [fittingKeyHints([["Esc", "Back"], ["↵", action]], innerWidth, theme)];
      if (this.inputError && layout.headerHeight < 2 && layout.footerHeight > 1) footer[1] = theme.fg("warning", sanitizeTerminalText(this.inputError));
    } else {
      const dirty = this.selected.instructions !== this.original.instructions || this.selected.tree !== this.original.tree || this.selected.skills !== this.original.skills;
      const notice = [this.saving ? "Saving..." : this.settingsNotice, dirty ? "Unsaved context changes" : ""].filter(Boolean).join(" · ");
      const optimizer = this.settingsOptimizer;
      const group = this.cursor < 3 ? "Context" : "Optimizer";
      const status = theme.fg(dirty ? "warning" : "muted", sanitizeTerminalText(notice || "Applies to future requests"));
      header = [layout.headerHeight === 1 && notice ? status : theme.fg("text", theme.bold("Settings")), status];
      const navigation = workspaceTabs(layout, "Settings", theme);
      const contentHeight = bodyHeight - navigation.length;
      // Keep top-level navigation fixed; the subordinate group strip is compact.
      const rows = panelTabs({ ...layout, bodyHeight: Math.min(7, contentHeight) }, optimizer ? ["Context", "Optimizer"] : ["Context"], this.cursor < 3 ? 0 : 1, theme);
      let focusStart = 0;
      let focusEnd = 0;
      let focusedDetail = "";
      const columns = innerWidth >= 56;
      const descriptions = innerWidth >= 76;
      const labelWidth = 22;
      const valueWidth = descriptions ? Math.min(32, Math.floor(innerWidth * 0.32)) : innerWidth - labelWidth - 4;
      // Clip plain text before styling: ANSI resets from truncation would break the row background.
      const clip = (value: string, width: number) => stripVTControlCharacters(truncateToWidth(value, width, "…"));
      const cell = (value: string, width: number) => {
        const text = clip(value, width);
        return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
      };
      const add = (index: number, label: string, value: string, description: string, affordance = "", disabled = false) => {
        const active = index === this.cursor;
        label = sanitizeTerminalText(label);
        value = sanitizeTerminalText(value);
        description = sanitizeTerminalText(description);
        const suffix = affordance && !disabled && innerWidth >= 20 ? ` ${affordance}` : "";
        const labelColor = disabled ? "dim" : "text";
        const valueColor = disabled ? "dim" : active ? "text" : "muted";
        let content: string;
        if (columns) {
          content = theme.fg(labelColor, active ? theme.bold(cell(label, labelWidth)) : cell(label, labelWidth)) + "  "
            + theme.fg(valueColor, cell(clip(value, valueWidth - visibleWidth(suffix)) + suffix, valueWidth));
          if (descriptions) content += "  " + theme.fg(disabled ? "dim" : active ? "text" : "muted", clip(description, innerWidth - labelWidth - valueWidth - 6));
        } else {
          const compactLabel = index === 0 ? "Rules" : index === 5 ? "Prompt" : label;
          const name = innerWidth < 32 ? compactLabel : label;
          const compactValue = index === 0 && this.selected.instructions === "first" ? (innerWidth < 20 ? "First" : "First only") : value;
          const available = Math.max(1, innerWidth - 2 - visibleWidth(suffix));
          content = theme.fg(disabled ? "dim" : active ? "text" : "muted", clip(`${name}: ${compactValue}`, available) + suffix);
        }
        const rendered = innerWidth < 2 ? (active ? "›" : " ") : theme.fg("text", active ? "› " : "  ") + content;
        if (active) {
          focusStart = rows.length;
          // Full values remain available when the table truncates them.
          focusedDetail = index >= 3 ? `${label}: ${value} · ${description}` : description;
        }
        rows.push(active ? theme.bg("selectedBg", rendered + " ".repeat(Math.max(0, innerWidth - visibleWidth(rendered)))) : rendered);
        if (active) focusEnd = rows.length;
      };
      if (group === "Context") {
        add(0, "Project instructions", instructionLabels[this.selected.instructions], instructionSummaries[this.selected.instructions], "›");
        if (this.cursor === 0) focusedDetail = instructionDescriptions[this.selected.instructions];
        add(1, "Directory tree", this.selected.tree ? "[x] On" : "[ ] Off", "Include the default directory tree");
        if (this.cursor === 1) focusedDetail = "Default tree only; @directory references are separate.";
        add(2, "Skill metadata", this.selected.skills ? "[x] On" : "[ ] Off", "Include skill names and descriptions");
        if (this.cursor === 2) focusedDetail = "Include skill descriptions; never run skills.";
        if (!this.settingsContextEnabled) rows.push(theme.fg("warning", "Disabled by projectContext.enabled=false"));
      } else if (optimizer) {
        add(3, "Model", optimizer.model, "Choose the prompt refinement model", "›");
        add(4, "Thinking", optimizer.thinking, "Set refinement reasoning effort", "›", !optimizer.thinkingEnabled);
        if (this.actions.editSystemPrompt) add(5, "Optimization prompt", "Edit", "Edit prompt rewriting instructions", "›");
      }
      const detailHeight = contentHeight >= 12 ? 2 : contentHeight >= 3 ? 1 : 0;
      const listHeight = contentHeight - detailHeight;
      const maxStart = Math.max(0, rows.length - listHeight);
      let start = Math.min(this.settingsScrollTop, maxStart);
      if (focusStart < start) start = focusStart;
      else if (focusEnd > start + listHeight) start = Math.min(focusStart, focusEnd - listHeight);
      this.settingsScrollTop = Math.max(0, Math.min(start, maxStart));
      body = [...navigation, ...Array.from({ length: listHeight }, (_, i) => rows[this.settingsScrollTop + i] ?? "")];
      // Wide tables already explain each option inline. Stable group notes and
      // controls leave only the old/new focus rows to repaint on up/down.
      const details = group === "Context" && descriptions && detailHeight === 2
        ? [instructionDescriptions[this.selected.instructions], "Tree: default only; @directory is separate. Skills: metadata only."]
        : wrapTextWithAnsi(sanitizeTerminalText(focusedDetail), innerWidth);
      body.push(...details.slice(0, detailHeight).map((line, i) => theme.fg("muted",
        i === detailHeight - 1 && details.length > detailHeight ? truncateToWidth(line + "…", innerWidth, "…") : line)));
      const action = this.cursor === 4 && !optimizer?.thinkingEnabled ? "Unavailable" : "Change";
      // Saving has a fixed key and an explicit scope, independent of row focus.
      const primary: KeyHint[] = innerWidth < 30
        ? [["^S", "Context"], ["↵", action]]
        : [["Ctrl+S", "Save context"], ["Enter", action], ...(this.cursor < 3 ? [["Space", action] as const] : [])];
      const secondary: KeyHint[] = [["Esc", dirty ? (innerWidth >= 30 ? "Discard context changes" : "Discard context") : "Back"], ...(optimizer ? [["Tab", "Group"] as const] : []),
        ["←", optimizer && this.cursor >= 3 ? "Context" : "Usage"], ["→", optimizer && this.cursor < 3 ? "Optimizer" : "Preview"], ["↑↓", "Select"]];
      // Share column stops with Tasks/Preview; retain independent compact rows
      // so the longer save/discard labels do not crowd out narrow-screen hints.
      footer = innerWidth < 30
        ? [fittingKeyHints(primary, innerWidth, theme), fittingKeyHints(secondary, innerWidth, theme)]
        : alignedKeyHints([primary, secondary], innerWidth, theme);
      if (layout.footerHeight === 1) footer = [fittingKeyHints([["^S", "Context"], ["Esc", dirty ? "Discard context" : "Back"], ["↵", action]], innerWidth, theme)];
    }
    const lines = panelFrame(layout, header, body, footer, (text) => theme.fg("borderMuted", text));
    if (this.mode === "context") {
      if (this.settingsFrames.size >= 12) this.settingsFrames.clear();
      this.settingsFrames.set(frameKey, { lines, scrollTop: this.settingsScrollTop });
    }
    return lines;
  }
}
