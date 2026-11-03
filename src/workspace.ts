import { stripVTControlCharacters } from "node:util";
import { parseKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { PreviewPanel } from "./preview.js";
import { panelFrame, panelLayout, panelTabs, workspaceTabs, WORKSPACE_PAGES, type WorkspacePage } from "./panel-layout.js";
import { alignedKeyHints, fittingKeyHints } from "./key-hints.js";
import { PromptInput } from "./prompt-input.js";
import { sanitizeTerminalText } from "./presentation.js";
import { HistoryPanel } from "./history-panel.js";
import type { RefineRecord } from "./history.js";

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
  history?(): RefineRecord[];
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
  revision?(): { key: string; submit(text: string): string | undefined } | undefined;
}

/** One custom UI lifetime: internal navigation never restores the host editor/card. */
export class RefineWorkspace implements Component, Focusable {
  private mode: "main" | "context" | "input" | "history" | "usage" = "main";
  private historyPanel?: HistoryPanel;
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
  invalidate(): void {
    this.panel.invalidate();
    this.historyPanel?.invalidate();
    this.input.editor.invalidate();
    this.revisionInput.editor.invalidate();
    this.settingsFrames.clear();
    this.refreshSettings();
  }

  /** Called by host state refreshes; arrow navigation never queries the model registry. */
  refreshSettings(): void {
    if (this.mode !== "context") return;
    this.settingsOptimizer = this.actions.optimizer?.();
    this.settingsContextEnabled = this.actions.contextEnabled();
  }

  private switchMode(mode: "main" | "context" | "input" | "history" | "usage"): void {
    this.mode = mode;
    this.focused = this.hasFocus;
    this.tui.requestRender();
  }

  openHistory(usage = false): void {
    this.historyPanel = new HistoryPanel(this.actions.history?.() ?? [], this.theme, () => this.tui.terminal.rows, this.keys, () => this.switchMode("main"), usage);
    this.switchMode(usage ? "usage" : "history");
  }

  private navigatePage(direction: number): void {
    const page: WorkspacePage = this.mode === "context" ? "Settings" : this.mode === "history" ? "History" : this.mode === "usage" ? "Usage" : "Preview";
    const next = WORKSPACE_PAGES[(WORKSPACE_PAGES.indexOf(page) + direction + WORKSPACE_PAGES.length) % WORKSPACE_PAGES.length];
    if (next === "Settings") {
      if (!this.settingsInitialized) this.openSettings();
      else { this.switchMode("context"); this.refreshSettings(); }
    } else if (next === "Preview") this.switchMode("main");
    else this.openHistory(next === "Usage");
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
    // Input/Revise owns cursor keys. All four top-level pages share these arrows.
    if (this.saving) return true;
    if (key === "left" || key === "right") {
      this.navigatePage(key === "left" ? -1 : 1);
      return true;
    }
    if (this.mode === "history" || this.mode === "usage") {
      this.historyPanel?.handleInput(data);
      this.tui.requestRender();
      return true;
    }
    if (this.mode === "context") {
      if (key === "q" || key === "ctrl+\\" || this.keys.matches(data, "tui.select.cancel")) {
        this.settingsInitialized = false;
        this.switchMode("main");
      } else if (key === "tab") {
        if (this.actions.optimizer) {
          const group = this.cursor < 3 ? 0 : 1;
          this.groupCursors[group] = this.cursor;
          this.cursor = this.groupCursors[1 - group]!;
          this.settingsScrollTop = 0;
          this.tui.requestRender();
        }
      } else if (key === "ctrl+s") {
        this.saving = true;
        this.tui.requestRender();
        void this.actions.saveContext({ ...this.selected }).then((notice) => {
          if (this.disposed) return;
          this.panel.setNotice(notice);
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
    if (this.mode === "main") return this.panel.render(width);
    if (this.mode === "history" || this.mode === "usage") return this.historyPanel?.render(width) ?? [];
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
      const revising = this.inputKind === "revision";
      const action = revising ? "Revise" : "Refine";
      header = [theme.fg("text", theme.bold(revising ? "Revise current result" : "Input")),
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
      const dirty = this.selected.instructions !== this.original.instructions || this.selected.tree !== this.original.tree || this.selected.skills !== this.original.skills;
      const notice = [this.saving ? "Saving..." : this.settingsNotice, dirty ? "Unsaved context changes" : ""].filter(Boolean).join(" · ");
      const optimizer = this.settingsOptimizer;
      const group = this.cursor < 3 ? "Context" : "Optimizer";
      const status = theme.fg(dirty ? "warning" : "muted", sanitizeTerminalText(notice || (group === "Context"
        ? "Ctrl+S to save · Applies to future requests" : "Changes save on confirmation · Applies to future requests")));
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
      footer = [
        fittingKeyHints(innerWidth < 30
          ? [["^S", "Context"], ["↵", action]]
          : [["Ctrl+S", "Save context"], ["Enter", action], ...(this.cursor < 3 ? [["Space", action] as const] : [])], innerWidth, theme),
        fittingKeyHints([["Esc", dirty ? (innerWidth >= 30 ? "Discard context changes" : "Discard context") : "Back"], ...(optimizer ? [["Tab", "Group"] as const] : []), ["←/→", "Page"], ["↑↓", "Select"]], innerWidth, theme),
      ];
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
