import { parseKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { PreviewPanel } from "./preview.js";
import { alignedHints, fittingHints, panelFrame, panelLayout } from "./panel-layout.js";
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
      const text = `${active ? "›" : " "}[${label}]`;
      return active
        ? this.theme.bg("selectedBg", this.theme.fg("text", this.theme.bold(text)))
        : this.theme.fg("muted", text);
    });
    const fullTabs = tabItems.join(" ");
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
      header = [theme.fg("accent", theme.bold("Input · Prompt Refine")),
        theme.fg(this.inputError ? "warning" : "muted", sanitizeTerminalText(this.inputError || `Prompt · Line ${cursor.line + 1} · Not sent to main agent`))];
      body = this.input.render(innerWidth, bodyHeight);
      footer = innerWidth < 30
        ? ["↵ Refine ⇧↵ NL", "Esc Back"]
        : alignedHints([["Enter Refine", "Shift+Enter Newline"],
          ["Esc Back", "Draft kept on Back"]], innerWidth);
      if (layout.footerHeight === 1) footer = [fittingHints(["Esc Back", "↵ Refine"], innerWidth)];
      if (this.inputError && layout.headerHeight < 2 && layout.footerHeight > 1) footer[1] = theme.fg("warning", sanitizeTerminalText(this.inputError));
    } else {
      const dirty = this.selected.some((value, i) => value !== this.original[i]);
      header = [tabs,
        theme.fg(dirty ? "warning" : "muted", this.saving ? "Saving..." : dirty ? "Unsaved changes · Enter Save" : "Next refinement only · Enter Save")];
      const items = ["AGENTS.md", "tree", "skills"].map((label, i) => {
        const text = `${i === this.cursor ? "›" : " "} [${this.selected[i] ? "x" : " "}] ${label}`;
        return theme.fg(i === this.cursor ? "accent" : "text", i === this.cursor ? theme.bold(text) : text);
      });
      const description = ["Project instructions; retains first-prompt rules.", "Default tree; explicit @dirs unchanged.", "Available skills; no automatic skill invocation."][this.cursor] ?? "";
      body = [...items, "", ...wrapTextWithAnsi(description, innerWidth).map((text) => theme.fg("muted", text)),
        ...(!this.actions.contextEnabled() ? [theme.fg("warning", "Disabled by projectContext.enabled=false")] : [])];
      if (bodyHeight < items.length) body = items.slice(Math.max(0, this.cursor - bodyHeight + 1));
      footer = innerWidth < 30
        ? ["↵ Save ␣ Toggle", "← Discard ↑↓"]
        : alignedHints([["Enter Save", "Space Toggle"],
          ["←/q/Esc Back (discard)", "↑↓ Select"]], innerWidth);
      if (this.actions.optimizer) {
        const optimizer = this.actions.optimizer();
        const rows: string[] = [];
        let focusStart = 0;
        let focusEnd = 0;
        const add = (index: number, text: string, value?: string) => {
          if (index === this.cursor) focusStart = rows.length;
          const active = index === this.cursor;
          // Keep option anchors stable: long model identifiers belong in details,
          // not in variable-height navigation rows.
          const label = sanitizeTerminalText(text);
          const content = value === undefined
            ? theme.fg("text", active ? theme.bold(label) : label)
            : `${theme.fg("muted", `${label}:`)} ${theme.fg("text", active ? theme.bold(sanitizeTerminalText(value)) : sanitizeTerminalText(value))}`;
          const line = truncateToWidth(content, Math.max(1, innerWidth - 2), "…");
          const rendered = `${theme.fg("accent", active ? "› " : "  ")}${line}`;
          rows.push(active ? theme.bg("selectedBg", rendered) : rendered);
          if (active) focusEnd = rows.length;
        };
        rows.push(theme.fg("accent", theme.bold("Context · Enter Save")));
        ["AGENTS.md", "tree", "skills"].forEach((label, i) => add(i, `[${this.selected[i] ? "x" : " "}] ${label}`));
        rows.push("", theme.fg("accent", theme.bold("Optimizer")));
        add(3, "Model", optimizer.model);
        add(4, "Thinking", optimizer.thinking);
        if (this.actions.editSystemPrompt) add(5, "Optimization prompt", "View / Edit");
        rows.push("", ...wrapTextWithAnsi("Only used by Prompt Refine; does not change the main session model or its thinking settings", innerWidth).map((line) => theme.fg("muted", line)));
        const detail = this.cursor === 3 ? `Model: ${optimizer.model}` : this.cursor === 4 ? `Thinking: ${optimizer.thinking}` : description;
        if (detail) rows.push(...wrapTextWithAnsi(sanitizeTerminalText(detail), innerWidth).map((line) => theme.fg("muted", line)));
        if (!this.actions.contextEnabled()) rows.push(theme.fg("warning", "Disabled by projectContext.enabled=false"));
        if (this.settingsNotice) rows.push(...wrapTextWithAnsi(this.settingsNotice, innerWidth).map((line) => theme.fg("warning", line)));
        const start = Math.min(focusStart, Math.max(0, focusEnd - bodyHeight));
        body = rows.slice(start, start + bodyHeight);
        const action = this.cursor === 3 ? "Enter Choose model" : this.cursor === 4 ? "Enter Cycle thinking" : this.cursor === 5 ? "Enter Edit prompt" : "Enter Save context";
        header[1] = theme.fg(dirty ? "warning" : "muted", this.saving ? "Saving..." : this.settingsNotice || (dirty ? "Unsaved context changes" : "Prompt Refine settings"));
        footer = innerWidth < 30
          ? alignedHints([[this.cursor >= 3 ? "↵ Change" : "↵ Save", "␣"], ["← Back", "↑↓"]], innerWidth)
          : alignedHints([[action, this.cursor < 3 ? "Space Toggle" : "Space/→ Change"],
            ["↑↓ Select", innerWidth < 50 ? "←/Esc Back" : "←/Esc Back (discard context)"]], innerWidth);
        if (layout.footerHeight === 1) footer = [fittingHints([this.cursor >= 3 ? "↵ Change" : "↵ Save", "← Back"], innerWidth)];
      } else if (layout.footerHeight === 1) footer = [fittingHints(["← Discard", "↵ Save"], innerWidth)];
    }
    return panelFrame(layout, header, body, footer, (text) => theme.fg("borderMuted", text));
  }
}
