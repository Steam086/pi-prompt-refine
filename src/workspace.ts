import { parseKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { PreviewPanel } from "./preview.js";
import { panelFrame, panelLayout } from "./panel-layout.js";
import { alignedKeyHints, fittingKeyHints } from "./key-hints.js";
import { PromptInput } from "./prompt-input.js";
import { sanitizeTerminalText } from "./presentation.js";

interface WorkspaceActions {
  context(): boolean[];
  contextEnabled(): boolean;
  optimizer?(): { model: string; thinking: string; thinkingEnabled: boolean };
  chooseModel?(context: boolean[]): void;
  editSystemPrompt?(context: boolean[]): void;
  cycleThinking?(): Promise<string>;
  saveContext(selected: boolean[]): Promise<string>;
  /** Undefined means the request was accepted; errors stay beside the retained input. */
  submit(text: string): string | undefined;
  /** Captures one actionable candidate; the callback rejects stale targets. */
  revision?(): { key: string; submit(text: string): string | undefined } | undefined;
}

/** One custom UI lifetime: internal navigation never restores the host editor/card. */
export class RefineWorkspace implements Component, Focusable {
  private mode: "main" | "context" | "input" = "main";
  private hasFocus = false;
  private selected: boolean[] = [];
  private original: boolean[] = [];
  private cursor = 0;
  private saving = false;
  private disposed = false;
  private inputError = "";
  private settingsNotice = "";
  private beforeInput = "";
  private readonly input: PromptInput;
  private readonly revisionInput: PromptInput;
  private inputKind: "draft" | "revision" = "draft";
  private revisionTarget?: { key: string; submit(text: string): string | undefined };

  private get activeInput(): PromptInput { return this.inputKind === "revision" ? this.revisionInput : this.input; }

  constructor(
    private readonly panel: PreviewPanel,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keys: KeybindingsManager,
    private readonly actions: WorkspaceActions,
  ) {
    const makeInput = () => new PromptInput(tui, {
      borderColor: (text) => theme.fg("borderMuted", text),
      selectList: {
        selectedPrefix: (text) => theme.fg("accent", text), selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text), scrollInfo: (text) => theme.fg("muted", text),
        noMatch: (text) => theme.fg("warning", text),
      },
    });
    this.input = makeInput();
    this.revisionInput = makeInput();
    for (const input of [this.input, this.revisionInput]) {
      input.editor.onSubmit = () => {
        const text = this.beforeInput;
        const error = input === this.input ? this.actions.submit(text)
          : this.revisionTarget ? this.revisionTarget.submit(text) : "No current result to revise.";
        if (error) {
          input.editor.setText(text);
          this.inputError = error;
        } else {
          // Keep feedback for a failed request; a new candidate key clears it on entry.
          if (input === this.revisionInput) input.editor.setText(text);
          this.inputError = "";
          this.switchMode("main");
        }
      };
    }
  }

  get focused(): boolean { return this.hasFocus; }
  set focused(value: boolean) {
    this.hasFocus = value;
    this.input.editor.focused = value && this.mode === "input" && this.inputKind === "draft";
    this.revisionInput.editor.focused = value && this.mode === "input" && this.inputKind === "revision";
  }

  dispose(): void { this.disposed = true; this.focused = false; }
  invalidate(): void { this.panel.invalidate(); this.input.editor.invalidate(); this.revisionInput.editor.invalidate(); }

  private switchMode(mode: "main" | "context" | "input"): void {
    this.mode = mode;
    this.focused = this.hasFocus;
    this.tui.requestRender();
  }

  openSettings(selected = this.actions.context(), cursor = this.cursor): void {
    this.original = this.actions.context();
    this.selected = [...selected];
    this.cursor = cursor;
    this.settingsNotice = "";
    this.switchMode("context");
  }

  private cycleThinking(): void {
    if (!this.actions.cycleThinking || !this.actions.optimizer?.().thinkingEnabled) return;
    this.saving = true;
    void this.actions.cycleThinking().then((notice) => { this.settingsNotice = notice; })
      .catch(() => { this.settingsNotice = "Could not save thinking level."; })
      .finally(() => { this.saving = false; if (!this.disposed) this.tui.requestRender(); });
    this.tui.requestRender();
  }

  /** Returns false only for main-page keys handled by the extension's guarded actions. */
  handleInput(data: string): boolean {
    if (this.disposed) return true;
    const key = parseKey(data);
    if (this.mode === "input") {
      if (this.keys.matches(data, "tui.select.cancel") || key === "ctrl+\\") {
        this.switchMode("main"); // Keep unsubmitted text until this workspace closes.
      } else {
        this.beforeInput = this.activeInput.editor.getExpandedText();
        this.inputError = "";
        this.activeInput.editor.handleInput(data);
        this.tui.requestRender();
      }
      return true;
    }
    if (this.mode === "context") {
      if (this.saving) return true;
      if (key === "left" || key === "q" || key === "ctrl+\\" || this.keys.matches(data, "tui.select.cancel")) {
        this.switchMode("main");
      } else if (key === "ctrl+s") {
        this.saving = true;
        this.tui.requestRender();
        void this.actions.saveContext([...this.selected]).then((notice) => {
          if (this.disposed) return;
          this.panel.setNotice(notice);
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
      } else if (this.keys.matches(data, "tui.input.submit") || key === "space" || (key === "right" && this.cursor >= 3)) {
        if (this.cursor < 3) {
          this.selected[this.cursor] = !this.selected[this.cursor];
          this.settingsNotice = "";
          this.tui.requestRender();
        } else if (this.cursor === 3) this.actions.chooseModel?.([...this.selected]);
        else if (this.cursor === 5) this.actions.editSystemPrompt?.([...this.selected]);
        else this.cycleThinking();
      } else {
        const count = this.actions.optimizer ? (this.actions.editSystemPrompt ? 6 : 5) : 3;
        if (this.keys.matches(data, "tui.select.up")) this.cursor = (this.cursor + count - 1) % count;
        else if (this.keys.matches(data, "tui.select.down")) this.cursor = (this.cursor + 1) % count;
        this.tui.requestRender();
      }
      return true;
    }
    if (key === "right") {
      this.openSettings();
      return true;
    }
    if (key?.toLowerCase() === "f") {
      const target = this.actions.revision?.();
      if (target) {
        if (target.key !== this.revisionTarget?.key) this.revisionInput.editor.setText("");
        this.revisionTarget = target;
        this.inputKind = "revision";
        this.inputError = "";
        this.switchMode("input");
      }
      return true;
    }
    if (key?.toLowerCase() === "i") {
      this.inputKind = "draft";
      this.inputError = "";
      this.switchMode("input");
      return true;
    }
    return false;
  }

  render(width: number): string[] {
    if (width < 1) return [];
    const tabItems = ([ ["main", "Prompt refine"], ["context", "Settings"] ] as const).map(([mode, label]) => {
      const active = this.mode === mode;
      // Keep tab positions stable while making Settings discoverable without a footer hint.
      const navigation = mode === "context" ? this.theme.fg("muted", this.mode === "main" ? "→ " : "  ") : "";
      return navigation + (active
        ? this.theme.fg("accent", this.theme.underline(this.theme.bold(label)))
        : this.theme.fg("muted", label));
    });
    const fullTabs = tabItems.join("   ");
    const tabs = visibleWidth(fullTabs) <= panelLayout(width, this.tui.terminal.rows).innerWidth
      ? fullTabs : tabItems[this.mode === "context" ? 1 : 0];
    if (this.mode === "main") return this.panel.render(width, tabs);
    const layout = panelLayout(width, this.tui.terminal.rows);
    const { innerWidth, bodyHeight } = layout;
    const { theme } = this;
    let body: string[];
    let header: string[];
    let footer: string[];
    if (this.mode === "input") {
      const cursor = this.activeInput.editor.getCursor();
      const revising = this.inputKind === "revision";
      const action = revising ? "Revise" : "Refine";
      header = [theme.fg("accent", theme.bold(revising ? "Revise current result" : "Input")),
        theme.fg(this.inputError ? "warning" : "muted", sanitizeTerminalText(this.inputError || (revising
          ? "Describe changes · Original task kept · Not sent"
          : `Line ${cursor.line + 1} · Not sent to main agent`)))];
      body = this.activeInput.render(innerWidth, bodyHeight);
      footer = alignedKeyHints(innerWidth < 30
        ? [[["↵", action], ["⇧↵", "NL"]], [["Esc", "Back"]]]
        : [[["Enter", action], ["Shift+Enter", "Newline"]], [["Esc", "Back"]]], innerWidth, theme);
      if (layout.footerHeight === 1) footer = [fittingKeyHints([["Esc", "Back"], ["↵", action]], innerWidth, theme)];
      if (this.inputError && layout.headerHeight < 2 && layout.footerHeight > 1) footer[1] = theme.fg("warning", sanitizeTerminalText(this.inputError));
    } else {
      const dirty = this.selected.some((value, i) => value !== this.original[i]);
      const notice = [this.saving ? "Saving..." : this.settingsNotice, dirty ? "Unsaved context changes" : ""].filter(Boolean).join(" · ");
      const status = theme.fg(dirty ? "warning" : "muted", sanitizeTerminalText(notice));
      // Short screens have only one header row; never scroll save feedback out of view.
      header = [layout.headerHeight === 1 && notice ? status : tabs, status];
      const optimizer = this.actions.optimizer?.();
      const rows: string[] = [theme.bold("Context")];
      let focusStart = 0;
      let focusEnd = 0;
      const hint = (text: string, color: "muted" | "warning" = "muted") => {
        const inset = innerWidth >= 4 ? 2 : 0;
        rows.push(...wrapTextWithAnsi(sanitizeTerminalText(text), innerWidth - inset)
          .map((line) => " ".repeat(inset) + theme.fg(color, line)));
      };
      const add = (index: number, text: string, value?: string, affordance = "", disabled = false) => {
        const active = index === this.cursor;
        if (active) focusStart = rows.length;
        const label = sanitizeTerminalText(text);
        const content = value === undefined
          ? theme.fg("text", label)
          : `${theme.fg(disabled ? "dim" : "muted", `${label}:`)} ${theme.fg(disabled ? "dim" : "text", sanitizeTerminalText(value))}`;
        const suffix = affordance && !disabled ? ` ${affordance}` : "";
        const available = Math.max(1, innerWidth - 2 - visibleWidth(suffix));
        const line = truncateToWidth(content, available, "…");
        const rendered = truncateToWidth(`${theme.fg("accent", active ? "› " : "  ")}${line}${theme.fg("muted", suffix)}`, innerWidth, "");
        rows.push(active ? theme.bg("selectedBg", rendered + " ".repeat(Math.max(0, innerWidth - visibleWidth(rendered)))) : rendered);
        // Keep a truncated value beside its focused row, including in short viewports.
        if (active && value !== undefined && visibleWidth(content) > available) hint(`${label}: ${value}`);
        if (active) focusEnd = rows.length;
      };
      // Keep explanations with their owners, not in a selection-dependent block
      // after both sections. Only section boundaries introduce an empty row.
      hint("Manual save · Next refinement only");
      [
        ["Include project instructions", "Use rules supplied by Pi (e.g. AGENTS.md)."],
        ["Directory tree", "Default tree only; @directory references are separate."],
        ["Skill metadata", "Include skill descriptions; never run skills."],
      ].forEach(([label, description], i) => {
        add(i, `[${this.selected[i] ? "x" : " "}] ${label}`);
        hint(description!);
        if (i === this.cursor) focusEnd = rows.length;
      });
      if (!this.actions.contextEnabled()) hint("Disabled by projectContext.enabled=false", "warning");
      if (optimizer) {
        rows.push("", theme.bold("Optimizer"));
        add(3, "Model", optimizer.model, "›");
        add(4, "Thinking", optimizer.thinking, "↻", !optimizer.thinkingEnabled);
        if (this.actions.editSystemPrompt) add(5, "Optimization prompt", "Edit…", "›");
      }
      const start = Math.min(focusStart, Math.max(0, focusEnd - bodyHeight));
      body = rows.slice(start, start + bodyHeight);
      const action = this.cursor === 3 ? "Choose" : this.cursor === 4 ? (optimizer?.thinkingEnabled ? "Cycle" : "Unavailable") : this.cursor === 5 ? "Edit" : "Toggle";
      // Saving has a fixed key and an explicit scope, independent of row focus.
      footer = [
        fittingKeyHints(innerWidth < 30
          ? [["^S", "Context"], ["↵", action]]
          : [["Ctrl+S", "Save context"], ["Enter", action], ...(this.cursor < 3 ? [["Space", "Toggle"] as const] : [])], innerWidth, theme),
        fittingKeyHints([["Esc", dirty ? (innerWidth >= 30 ? "Discard context changes" : "Discard context") : "Back"], ["↑↓", "Select"]], innerWidth, theme),
      ];
      if (layout.footerHeight === 1) footer = [fittingKeyHints([["^S", "Context"], ["Esc", dirty ? "Discard context" : "Back"], ["↵", action]], innerWidth, theme)];
    }
    return panelFrame(layout, header, body, footer, (text) => theme.fg("borderMuted", text));
  }
}
