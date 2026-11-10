import { parseKey, type Component, type Focusable, type KeybindingsManager, type KeyId, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { PreviewPanel } from "./preview.js";
import { panelFrame, WORKSPACE_PAGES, type WorkspacePage } from "./panel-layout.js";
import { workspaceFrame, workspaceLayout, workspaceViewport } from "./workspace-overlay.js";
import { alignedKeyHints, fittingKeyHints } from "./key-hints.js";
import { PromptInput } from "./prompt-input.js";
import { sanitizeTerminalText } from "./presentation.js";
import { TaskPanel, type TaskPanelActions, type TaskPanelPosition } from "./task-panel.js";
import type { RefineRecord } from "./history.js";
import type { HistoryStorageStatus } from "./history-store.js";
import { PreferencePanel } from "./preference-panel.js";
import { InlinePreferences } from "./inline-preferences.js";
import type { PreferenceRepository, RevisionDraft, SelectedPreference } from "./revision-preferences.js";
import { canonicalShortcut } from "./config.js";
import type { ContextSettings } from "./settings.js";
import { SettingsPage, type SettingsResult } from "./ui/settings-page.js";
import { RevisePage } from "./ui/revise-page.js";
export type { SettingsResult } from "./ui/settings-page.js";
export type { ContextSettings } from "./settings.js";

interface WorkspaceActions {
  preferences?: { repository: PreferenceRepository; key: KeyId | null; maxChars: number };
  /** No save capability means library management with read-only adopted snapshots. */
  draftPreferences?(id?: number, original?: boolean): { selected: SelectedPreference[]; save?(selected: SelectedPreference[]): string | undefined } | undefined;
  original?(id?: number): { text: string; save(text: string): string | undefined; cancel(): void } | undefined;
  /** Session-owned text, independent of request snapshots and revision feedback. */
  inputDraft?: { text: string; save(text: string): void };
  inputCaptureOnly?(): boolean;
  history?(): RefineRecord[];
  historyStorage?(): HistoryStorageStatus;
  tasks?: TaskPanelActions;
  taskPosition?: TaskPanelPosition;
  usagePosition?: TaskPanelPosition;
  context(): ContextSettings;
  contextEnabled(): boolean;
  optimizer?(): { model: string; thinking: string; thinkingEnabled: boolean };
  chooseModel?(context: ContextSettings): void;
  editSystemPrompt?(context: ContextSettings): void;
  cycleThinking?(): Promise<SettingsResult>;
  saveContext(selected: ContextSettings): Promise<SettingsResult>;
  /** Undefined means the request was accepted; errors stay beside the retained input. */
  submit(text: string): string | undefined;
  /** Captures one actionable candidate; the callback rejects stale targets. */
  revision?(id?: number): { key: string; label?: string; submit(text: string): string | undefined } | undefined;
  /** Bounded in-memory drafts survive closing the overlay, never persisted to history. */
  revisionDrafts?: Map<string, RevisionDraft>;
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
  private readonly settings: SettingsPage;
  private readonly revise: RevisePage;
  private disposed = false;
  private inputError = "";
  private beforeInput = "";
  private readonly input: PromptInput;
  private readonly originalInput: PromptInput;
  private originalTarget?: ReturnType<NonNullable<WorkspaceActions["original"]>>;
  private inputKind: "draft" | "revision" | "original" = "draft";
  private preferencePanel?: PreferencePanel;
  private inlinePreferences?: InlinePreferences;
  private preferencesKey?: KeyId | null;
  private preferencesKeyNotice = "";
  private lastWidth?: number;
  private outerWidth?: number;
  private readonly layout = (width: number) => workspaceLayout(this.outerWidth ?? width + 2, this.tui.terminal.rows);

  private get activeInput(): PromptInput { return this.inputKind === "original" ? this.originalInput : this.input; }

  constructor(
    private readonly panel: PreviewPanel,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keys: KeybindingsManager,
    private readonly actions: WorkspaceActions,
  ) {
    this.panel.setLayoutProvider(this.layout);
    this.preferencesKey = actions.preferences?.key;
    if (this.preferencesKey && Object.values(keys.getResolvedBindings()).some((binding) =>
      (Array.isArray(binding) ? binding : [binding]).some((key) => key && canonicalShortcut(key) === canonicalShortcut(this.preferencesKey!)))) {
      this.preferencesKey = null;
      this.preferencesKeyNotice = "Preferences key conflicts with Pi bindings; use p in Tasks or Tab then Enter in Revise. ";
    }
    if (actions.tasks && actions.preferences && actions.draftPreferences) {
      this.inlinePreferences = new InlinePreferences(actions.preferences.repository,
        (id) => actions.draftPreferences!(id, true), theme, keys, () => { if (!this.disposed) this.tui.requestRender(); });
    }
    if (actions.tasks) {
      const taskActions: TaskPanelActions = { ...actions.tasks,
        inlinePreferences: this.inlinePreferences,
        preferences: actions.preferences ? (id, original) => this.openDraftPreferences(id, original) : undefined,
        preferencesKey: this.preferencesKey,
        revise: (id) => this.openRevision(id),
        editOriginal: (id) => this.openOriginal(id), activate: (id) => {
        const applied = actions.tasks!.activate(id);
        if (applied) this.showApplied(id);
        return applied;
      } };
      this.taskPanel = new TaskPanel(taskActions, theme, () => tui.terminal.rows, keys, false, actions.taskPosition, this.layout);
    }
    this.input = this.makeInput();
    this.input.editor.setText(actions.inputDraft?.text ?? "");
    this.settings = new SettingsPage(theme, keys, {
      context: () => actions.context(), contextEnabled: () => actions.contextEnabled(),
      get optimizer() { return actions.optimizer; },
      get chooseModel() { return actions.chooseModel; },
      get editSystemPrompt() { return actions.editSystemPrompt; },
      get cycleThinking() { return actions.cycleThinking; },
      saveContext: (selected) => actions.saveContext(selected),
      close: (message) => {
        if (message !== undefined) { this.panel.setNotice(message); this.taskPanel?.setNotice(message); }
        this.settingsInitialized = false;
        this.switchMode("main");
      },
    }, () => this.makeInput(), this.layout, tui);
    this.revise = new RevisePage(theme, keys, {
      get preferences() { return !!actions.preferences; }, preferencesKey: this.preferencesKey, preferencesKeyNotice: this.preferencesKeyNotice,
      openPreferences: () => this.openPreferences(), back: () => this.switchMode(this.inputReturnMode),
      submitted: () => this.switchMode("result"),
    }, actions.revisionDrafts ?? new Map(), () => this.makeInput(), this.layout, tui);
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
    this.input.editor.focused = value && !this.preferencePanel && this.mode === "input" && this.inputKind === "draft";
    this.revise.focused = value && !this.preferencePanel && this.mode === "input" && this.inputKind === "revision";
    this.originalInput.editor.focused = value && this.mode === "input" && this.inputKind === "original";
    this.settings.focused = value;
    if (this.preferencePanel) this.preferencePanel.focused = value;
    if (this.inlinePreferences) this.inlinePreferences.focused = value && !this.preferencePanel && this.mode === "main";
  }

  private openRevision(id?: number): void {
    const target = this.actions.revision?.(id);
    if (!target) {
      const notice = "Result unavailable or send pending; reopen an actionable result to revise.";
      this.panel.setNotice(notice); this.taskPanel?.setNotice(notice); this.historyPanel?.setNotice(notice);
      this.tui.requestRender();
      return;
    }
    this.inputKind = "revision";
    this.inputReturnMode = this.mode === "usage" ? "usage" : this.mode === "result" ? "result" : "main";
    const source = this.inputReturnMode === "usage" ? this.historyPanel?.snapshot(true)
      : this.inputReturnMode === "main" ? this.taskPanel?.snapshot(true) ?? this.panel.snapshot(true) : this.panel.snapshot(true);
    this.revise.open(target, source);
    this.switchMode("input");
  }

  private openPreferences(): void {
    const options = this.actions.preferences;
    if (!options || this.preferencePanel) return;
    const draft = this.revise.preferenceDraft();
    this.preferencePanel = new PreferencePanel(this.tui, this.theme, this.keys, options.repository,
      draft.selected, draft.freeText, options.maxChars, (selected) => {
        this.preferencePanel?.dispose(); this.preferencePanel = undefined;
        // Library writes are committed independently of bringing back selections.
        void this.inlinePreferences?.refresh();
        this.revise.bringBackPreferences(selected);
        this.focused = this.hasFocus;
        if (!this.disposed) this.tui.requestRender();
      }, "revise", this.layout);
    this.focused = this.hasFocus;
    this.tui.requestRender();
  }

  private openDraftPreferences(id?: number, original?: boolean): void {
    const options = this.actions.preferences;
    const target = this.actions.draftPreferences ? this.actions.draftPreferences(id, original) : { selected: [] };
    const parent = this.mode === "usage" ? this.historyPanel : this.taskPanel;
    if (!options || this.preferencePanel) return;
    if (!target) {
      parent?.setNotice("Preferences target changed; reopen Preferences.", "warning");
      return;
    }
    this.preferencePanel = new PreferencePanel(this.tui, this.theme, this.keys, options.repository,
      target.selected, "", options.maxChars, (selected) => {
        if (selected) {
          const error = target.save?.(selected);
          // Keep the child's working snapshots available on stale/over-limit failure.
          if (error) return error;
        }
        this.preferencePanel?.dispose(); this.preferencePanel = undefined;
        void this.inlinePreferences?.refresh();
        // The live per-original summary is the feedback; a sticky notice could
        // incorrectly advertise this selection after navigating to another task.
        if (selected) parent?.setNotice("", "muted");
        this.focused = this.hasFocus;
        if (!this.disposed) this.tui.requestRender();
      }, target.save ? "refine" : "manage", this.layout);
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

  dispose(): void { this.disposed = true; this.settings.dispose(); this.inlinePreferences?.dispose(); this.preferencePanel?.dispose(); this.originalTarget?.cancel(); this.originalTarget = undefined; this.focused = false; }
  invalidate(): void {
    this.panel.invalidate();
    this.historyPanel?.invalidate();
    this.taskPanel?.invalidate();
    this.input.editor.invalidate();
    this.revise.invalidate();
    this.originalInput.editor.invalidate();
    this.preferencePanel?.invalidate();
    this.inlinePreferences?.invalidate();
    this.settings.invalidate();
    this.refreshSettings();
  }

  /** Called by host state refreshes; arrow navigation never queries the model registry. */
  refreshSettings(): void {
    if (this.mode !== "context") return;
    this.settings.refreshSettings();
  }

  private switchMode(mode: "main" | "result" | "context" | "input" | "usage"): void {
    this.mode = mode;
    this.focused = this.hasFocus;
    this.tui.requestRender();
  }

  openUsage(target?: { id: number; original: boolean }): void {
    const actions = this.actions.tasks;
    const position = this.actions.usagePosition ?? {};
    if (target) {
      position.selectedId = target.id;
      position.selectedTaskId = target.original ? this.actions.history?.().find((record) => record.id === target.id)?.taskId : undefined;
      position.scroll = position.scrolls?.[target.original ? `task-${position.selectedTaskId}` : `run-${target.id}`] ?? 0;
    }
    this.historyPanel = new TaskPanel({
      ...actions,
      records: () => this.actions.history?.() ?? [],
      historyStorage: this.actions.historyStorage,
      appliedId: () => actions?.appliedId(),
      activate: (id) => {
        const applied = actions?.activate(id) ?? false;
        if (applied) this.showApplied(id);
        return applied;
      },
      run: (id) => actions?.run(id), stop: (id) => actions?.stop(id), launchModel: () => actions?.launchModel?.() ?? "No model",
      editOriginal: (id) => this.openOriginal(id),
      revise: (id) => this.openRevision(id),
      preferences: this.actions.preferences ? (id, original) => this.openDraftPreferences(id, original) : undefined,
      preferencesKey: this.preferencesKey,
    }, this.theme, () => this.tui.terminal.rows, this.keys, true, position, this.layout);
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
    else this.openUsage(this.mode === "main" ? this.taskPanel?.earlierTarget() : undefined);
  }

  openSettings(selected = this.actions.context(), cursor?: number): void {
    this.settingsInitialized = true;
    this.settings.open(selected, cursor);
    this.switchMode("context");
  }

  /** Returns false only for main-page keys handled by the extension's guarded actions. */
  handleInput(data: string): boolean {
    if (this.disposed) return true;
    if (this.preferencePanel) { this.preferencePanel.handleInput(data); return true; }
    if (this.settings.editingNumber) { this.settings.handleInput(data); return true; }
    const key = parseKey(data);
    if (this.mode === "input") {
      if (this.inputKind === "revision") return this.revise.handleInput(data, this.lastWidth);
      if (this.keys.matches(data, "tui.select.cancel") || key === "ctrl+\\") {
        this.originalTarget?.cancel();
        this.originalTarget = undefined;
        this.switchMode(this.inputReturnMode); // Back never discards the independent input draft.
      } else {
        this.beforeInput = this.activeInput.editor.getExpandedText();
        this.inputError = "";
        const input = this.activeInput;
        input.editor.handleInput(data);
        // Observe the final expanded value, not Editor's transient empty onSubmit value
        // or collapsed paste markers. Cursor movement and request refreshes do not save.
        const text = input.editor.getExpandedText();
        if (input === this.input && text !== this.beforeInput) this.actions.inputDraft?.save(text);
        this.tui.requestRender();
      }
      return true;
    }
    const activeTasks = this.mode === "main" ? this.taskPanel : this.mode === "usage" ? this.historyPanel : undefined;
    if (activeTasks?.ownsInput()) {
      activeTasks.handleInput(data);
      this.tui.requestRender();
      return true;
    }
    // Input/Revise owns cursor keys. Settings visits its adjacent group before
    // leaving the page; arrows at the outer group boundaries still change pages.
    if (this.settings.busy) return true;
    if (this.mode === "context" && this.settings.handleInput(data)) return true;
    if (key === "left" || key === "right") {
      this.navigatePage(key === "left" ? -1 : 1);
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

  render(width: number): string[] {
    if (width < 1) return [];
    this.outerWidth = width;
    const viewport = workspaceViewport(width, this.tui.terminal.rows);
    return workspaceFrame(width, this.tui.terminal.rows, this.renderContent(viewport.width), this.theme);
  }

  private renderContent(width: number): string[] {
    this.lastWidth = width;
    if (this.preferencePanel) return this.preferencePanel.render(width);
    if (this.mode === "context") return this.settings.render(width);
    if (this.mode === "input" && this.inputKind === "revision") return this.revise.render(width);
    if (this.mode === "result") return this.panel.render(width);
    if (this.mode === "main") return this.taskPanel?.render(width, () => this.panel.render(width)) ?? this.panel.render(width);
    if (this.mode === "usage") return this.historyPanel?.render(width) ?? [];
    const layout = this.layout(width);
    const { innerWidth, bodyHeight } = layout;
    const { theme } = this;
    let body: string[];
    let header: string[];
    let footer: string[];
    let footerAfterBodyRows: number | undefined;
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
      if (this.inputError && layout.headerHeight < 2) {
        const feedback = theme.fg("warning", sanitizeTerminalText(this.inputError));
        if (layout.headerHeight === 1) header[0] = feedback;
        else body = [feedback, ...body];
      }
    } else return [];
    const lines = panelFrame(layout, header, body, footer, (text) => theme.fg("borderMuted", text), { footerAfterBodyRows });
    return lines;
  }
}
