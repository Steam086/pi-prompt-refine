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
  optimizer?(): { model: string; thinking: string };
  chooseModel?(context: boolean[]): void;
  editSystemPrompt?(context: boolean[]): void;
  cycleThinking?(): Promise<string>;
  saveContext(selected: boolean[]): Promise<string>;
  /** Undefined means the request was accepted; errors stay beside the retained input. */
  submit(text: string): string | undefined;
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

  constructor(
    private readonly panel: PreviewPanel,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keys: KeybindingsManager,
    private readonly actions: WorkspaceActions,
  ) {
    this.input = new PromptInput(tui, {
      borderColor: (text) => theme.fg("borderMuted", text),
      selectList: {
        selectedPrefix: (text) => theme.fg("accent", text), selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text), scrollInfo: (text) => theme.fg("muted", text),
        noMatch: (text) => theme.fg("warning", text),
      },
    });
    this.input.editor.onSubmit = () => {
      const text = this.beforeInput;
      const error = this.actions.submit(text);
      if (error) {
        this.input.editor.setText(text);
        this.inputError = error;
      } else {
        this.inputError = "";
        this.switchMode("main");
      }
    };
  }

  get focused(): boolean { return this.hasFocus; }
  set focused(value: boolean) {
    this.hasFocus = value;
    this.input.editor.focused = value && this.mode === "input";
  }

  dispose(): void { this.disposed = true; this.focused = false; }
  invalidate(): void { this.panel.invalidate(); this.input.editor.invalidate(); }

  private switchMode(mode: "main" | "context" | "input"): void {
    this.mode = mode;
    this.focused = this.hasFocus;
    this.tui.requestRender();
  }

  openSettings(selected = this.actions.context(), cursor = this.cursor): void {
    this.original = this.actions.context();
    this.selected = [...selected];
    this.cursor = cursor;
    this.switchMode("context");
  }

  private cycleThinking(): void {
    if (!this.actions.cycleThinking) return;
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
        this.beforeInput = this.input.editor.getExpandedText();
        this.inputError = "";
        this.input.editor.handleInput(data);
        this.tui.requestRender();
      }
      return true;
    }
    if (this.mode === "context") {
      if (this.saving) return true;
      if (key === "left" || key === "q" || key === "ctrl+\\" || this.keys.matches(data, "tui.select.cancel")) {
        this.switchMode("main");
      } else if (this.actions.optimizer && this.keys.matches(data, "app.thinking.cycle")) {
        this.cycleThinking();
      } else if (this.cursor >= 3 && (this.keys.matches(data, "tui.input.submit") || key === "space" || key === "right")) {
        if (this.cursor === 3) this.actions.chooseModel?.([...this.selected]);
        else if (this.cursor === 5) this.actions.editSystemPrompt?.([...this.selected]);
        else this.cycleThinking();
      } else if (this.keys.matches(data, "tui.input.submit")) {
        this.saving = true;
        this.tui.requestRender();
        void this.actions.saveContext([...this.selected]).then((notice) => {
          if (this.disposed) return;
          this.panel.setNotice(notice);
          this.switchMode("main");
        }).catch(() => {
          if (this.disposed) return;
          this.panel.setNotice("Could not save context. Check configuration.");
          this.switchMode("main");
        }).finally(() => {
          this.saving = false;
          if (!this.disposed) this.tui.requestRender();
        });
      } else {
        const count = this.actions.optimizer ? (this.actions.editSystemPrompt ? 6 : 5) : 3;
        if (this.keys.matches(data, "tui.select.up")) this.cursor = (this.cursor + count - 1) % count;
        else if (this.keys.matches(data, "tui.select.down")) this.cursor = (this.cursor + 1) % count;
        else if (key === "space" && this.cursor < 3) this.selected[this.cursor] = !this.selected[this.cursor];
        this.tui.requestRender();
      }
      return true;
    }
    if (key === "right") {
      this.openSettings();
      return true;
    }
    if (key?.toLowerCase() === "i") {
      this.switchMode("input");
      return true;
    }
    return false;
  }

  render(width: number): string[] {
    if (width < 1) return [];
    const tabItems = ([ ["main", "Prompt refine"], ["context", "Settings"] ] as const).map(([mode, label]) => {
      const active = this.mode === mode;
      const text = `${active ? "›" : " "} ${label}`;
      return active
        ? this.theme.bg("selectedBg", this.theme.fg("accent", this.theme.bold(text)))
        : this.theme.fg("muted", text);
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
      const cursor = this.input.editor.getCursor();
      header = [theme.fg("accent", theme.bold("Input")),
        theme.fg(this.inputError ? "warning" : "muted", sanitizeTerminalText(this.inputError || `Line ${cursor.line + 1} · Not sent to main agent`))];
      body = this.input.render(innerWidth, bodyHeight);
      footer = alignedKeyHints(innerWidth < 30
        ? [[["↵", "Refine"], ["⇧↵", "NL"]], [["Esc", "Back"]]]
        : [[["Enter", "Refine"], ["Shift+Enter", "Newline"]], [["Esc", "Back"]]], innerWidth, theme);
      if (layout.footerHeight === 1) footer = [fittingKeyHints([["Esc", "Back"], ["↵", "Refine"]], innerWidth, theme)];
      if (this.inputError && layout.headerHeight < 2 && layout.footerHeight > 1) footer[1] = theme.fg("warning", sanitizeTerminalText(this.inputError));
    } else {
      const dirty = this.selected.some((value, i) => value !== this.original[i]);
      const notice = [this.saving ? "Saving..." : this.settingsNotice, dirty ? "Unsaved changes" : ""].filter(Boolean).join(" · ");
      header = [tabs, theme.fg(dirty ? "warning" : "muted", sanitizeTerminalText(notice))];
      const optimizer = this.actions.optimizer?.();
      const rows: string[] = [theme.fg("muted", "Context")];
      let focusStart = 0;
      let focusEnd = 0;
      let detail = "";
      const hint = (text: string, color: "muted" | "warning" = "muted") => {
        const inset = innerWidth >= 4 ? 2 : 0;
        rows.push(...wrapTextWithAnsi(sanitizeTerminalText(text), innerWidth - inset)
          .map((line) => " ".repeat(inset) + theme.fg(color, line)));
      };
      const add = (index: number, text: string, value?: string) => {
        const active = index === this.cursor;
        if (active) focusStart = rows.length;
        const label = sanitizeTerminalText(text);
        const content = value === undefined
          ? theme.fg("text", label)
          : `${theme.fg("muted", `${label}:`)} ${theme.fg("text", sanitizeTerminalText(value))}`;
        // One row per option; reveal full values only when the selected row truncates.
        if (active && value !== undefined && visibleWidth(content) > innerWidth - 2) detail = `${label}: ${value}`;
        const line = truncateToWidth(content, Math.max(1, innerWidth - 2), "…");
        const rendered = `${theme.fg("accent", active ? "› " : "  ")}${line}`;
        rows.push(active ? theme.bg("selectedBg", rendered) : rendered);
        if (active) focusEnd = rows.length;
      };
      // Keep explanations with their owners, not in a selection-dependent block
      // after both sections. Only section boundaries introduce an empty row.
      [
        ["AGENTS.md", "Loaded project instructions."],
        ["tree", "Default tree; explicit @dirs unchanged."],
        ["skills", "Skill metadata; no automatic invocation."],
      ].forEach(([label, description], i) => {
        add(i, `[${this.selected[i] ? "x" : " "}] ${label}`);
        hint(description!);
      });
      if (!this.actions.contextEnabled()) hint("Disabled by projectContext.enabled=false", "warning");
      if (optimizer) {
        rows.push("", theme.fg("muted", "Optimizer"));
        add(3, "Model", optimizer.model);
        add(4, "Thinking", optimizer.thinking);
        if (this.actions.editSystemPrompt) add(5, "Optimization prompt");
        hint("Optimizer only · Main session unchanged");
        if (detail) hint(detail);
      }
      if (notice && layout.headerHeight < 2) rows.push(theme.fg(dirty ? "warning" : "muted", sanitizeTerminalText(notice)));
      const start = Math.min(focusStart, Math.max(0, focusEnd - bodyHeight));
      body = rows.slice(start, start + bodyHeight);
      const action = this.cursor === 3 ? "Choose" : this.cursor === 4 ? "Cycle" : this.cursor === 5 ? "Edit" : "Save";
      footer = alignedKeyHints(innerWidth < 30
        ? [[["↵", this.cursor >= 3 ? "Change" : "Save"], ...(this.cursor < 3 ? [["␣", "Toggle"] as const] : [])], [["←", "Back"], ["↑↓", "Select"]]]
        : [[["Enter", action], ...(this.cursor < 3 ? [["Space", "Toggle"] as const] : [])],
          [["↑↓", "Select"], ["←/Esc", innerWidth < 50 ? "Back" : "Back (discard)"]]], innerWidth, theme);
      if (layout.footerHeight === 1) footer = [fittingKeyHints([["↵", this.cursor >= 3 ? "Change" : "Save"], ["←", "Back"]], innerWidth, theme)];
    }
    return panelFrame(layout, header, body, footer, (text) => theme.fg("borderMuted", text));
  }
}
