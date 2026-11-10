import { stripVTControlCharacters } from "node:util";
import { parseKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type KeybindingsManager } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { panelFrame, panelTabs, workspaceTabs, type PanelLayoutProvider } from "../panel-layout.js";
import { alignedKeyHints, fittingKeyHints, type KeyHint } from "../key-hints.js";
import type { PromptInput } from "../prompt-input.js";
import { sanitizeTerminalText } from "../presentation.js";
import { DEFAULT_CONFIG } from "../config.js";
import { NUMBER_SETTINGS, numberSettingValue, settingsDirty, type ContextSettings, type NumberSettingSpec } from "../settings.js";

const instructionModes = ["first", "always", "off"] as const;
const instructionLabels = { first: "First request only", always: "Always", off: "Off" };
const instructionSummaries = { first: "Include rules on the first request", always: "Include rules in every request", off: "Exclude project rules" };
const instructionDescriptions = {
  first: "Pi rules (e.g. AGENTS.md): first request per task; omitted from Revise.",
  always: "Include Pi rules (e.g. AGENTS.md) in every refinement and Revise request.",
  off: "Do not include Pi rules (e.g. AGENTS.md) in refinement requests.",
};

export interface SettingsResult { message: string; persisted: boolean }

export interface SettingsPageActions {
  context(): ContextSettings;
  contextEnabled(): boolean;
  optimizer?(): { model: string; thinking: string; thinkingEnabled: boolean };
  chooseModel?(context: ContextSettings): void;
  editSystemPrompt?(context: ContextSettings): void;
  cycleThinking?(): Promise<SettingsResult>;
  saveContext(selected: ContextSettings): Promise<SettingsResult>;
  close(message?: string): void;
}

/** Settings owns its draft and caches; navigation and page lifetime belong to the workspace. */
export class SettingsPage {
  private selected: ContextSettings = { instructions: "always", tree: false, skills: false };
  private original: ContextSettings = { ...this.selected };
  private cursor = 0;
  private settingsScrollTop = 0;
  private groupCursors = [0, 3, 12];
  private numberInput?: { spec: NumberSettingSpec; input: PromptInput; error: string };
  private settingsOptimizer?: ReturnType<NonNullable<SettingsPageActions["optimizer"]>>;
  private settingsContextEnabled = true;
  private settingsCacheKey = "";
  private settingsFrames = new Map<string, { lines: string[]; scrollTop: number }>();
  private saving = false;
  private disposed = false;
  private hasFocus = false;
  private settingsNotice = "";
  private settingsFailed = false;
  constructor(
    private readonly theme: Theme,
    private readonly keys: KeybindingsManager,
    private readonly actions: SettingsPageActions,
    private readonly makeInput: () => PromptInput,
    private readonly layout: PanelLayoutProvider,
    private readonly tui: { requestRender(): void },
  ) {}
  get busy(): boolean { return this.saving; }
  get editingNumber(): boolean { return !!this.numberInput; }
  set focused(value: boolean) {
    this.hasFocus = value;
    if (this.numberInput) this.numberInput.input.editor.focused = value;
  }
  dispose(): void { this.disposed = true; this.focused = false; }
  invalidate(): void { this.settingsFrames.clear(); }
  refreshSettings(): void {
    this.settingsOptimizer = this.actions.optimizer?.();
    this.settingsContextEnabled = this.actions.contextEnabled();
    this.numberInput?.input.editor.invalidate();
  }
  open(selected = this.actions.context(), cursor = this.cursor): void {
    this.original = this.actions.context();
    this.selected = { ...selected };
    this.numberInput = undefined;
    this.cursor = this.settingsGroups.flatMap((group) => group.rows).includes(cursor) ? cursor : 0;
    this.groupCursors[this.settingsGroups[this.settingsGroup]!.memory] = this.cursor;
    this.settingsScrollTop = 0;
    this.settingsNotice = "";
    this.settingsFailed = false;
    this.refreshSettings();
  }

  private get settingsGroups(): { label: string; rows: number[]; memory: number }[] {
    return [
      { label: "Context", rows: [0, 1, 2, 6, 7, 8, 9], memory: 0 },
      ...(this.actions.optimizer ? [{ label: "Optimizer", rows: [3, 4, ...(this.actions.editSystemPrompt ? [5] : []), 10, 11], memory: 1 }] : []),
      { label: "Advanced", rows: [12], memory: 2 },
    ];
  }

  private get settingsGroup(): number {
    return this.settingsGroups.findIndex((group) => group.rows.includes(this.cursor));
  }

  private switchSettingsGroup(direction = 1): void {
    const groups = this.settingsGroups;
    const current = this.settingsGroup;
    this.groupCursors[groups[current]!.memory] = this.cursor;
    const next = groups[(current + direction + groups.length) % groups.length]!;
    this.cursor = this.groupCursors[next.memory]!;
    this.settingsScrollTop = 0;
    this.tui.requestRender();
  }

  private editNumber(spec: NumberSettingSpec): void {
    const input = this.makeInput();
    input.editor.setText(String(numberSettingValue(this.selected, spec.field) / spec.scale));
    this.numberInput = { spec, input, error: "" };
    this.focused = this.hasFocus;
    this.tui.requestRender();
  }

  private handleNumberInput(data: string): void {
    const editor = this.numberInput!;
    const { spec, input } = editor;
    const key = parseKey(data);
    if (key === "escape" || key === "ctrl+\\" || this.keys.matches(data, "tui.select.cancel")) {
      input.editor.focused = false;
      this.numberInput = undefined;
      this.focused = this.hasFocus;
    } else if (key === "tab" || key === "shift+tab") {
      const value = Number(input.editor.getExpandedText());
      const index = spec.presets.indexOf(value);
      const next = index < 0 ? (key === "tab" ? 0 : spec.presets.length - 1)
        : (index + (key === "tab" ? 1 : spec.presets.length - 1)) % spec.presets.length;
      input.editor.setText(String(spec.presets[next]));
      editor.error = "";
    } else if (this.keys.matches(data, "tui.input.submit")) {
      const text = input.editor.getExpandedText().trim();
      const value = Number(text);
      if (!/^\d+(?:\.\d+)?$/.test(text) || !Number.isSafeInteger(value * spec.scale) || value < spec.min || value > spec.max) {
        editor.error = `Enter ${spec.min}–${spec.max} ${spec.unit}${spec.scale === 1 ? " (whole numbers)" : ""}.`;
      } else {
        this.selected[spec.field] = value * spec.scale;
        input.editor.focused = false;
        this.numberInput = undefined;
        this.settingsNotice = "";
        this.settingsFailed = false;
        this.focused = this.hasFocus;
      }
    } else if (key !== "ctrl+s") {
      editor.error = "";
      input.editor.handleInput(data);
      const text = input.editor.getExpandedText();
      const safe = sanitizeTerminalText(text);
      if (safe !== text) input.editor.setText(safe);
    }
    this.tui.requestRender();
  }

  private renderNumberInput(width: number): string[] {
    const { spec, input, error } = this.numberInput!;
    const layout = this.layout(width);
    const { innerWidth, bodyHeight } = layout;
    const theme = this.theme;
    const status = error || `${spec.min}–${spec.max} ${spec.unit} · Not saved until Ctrl+S in Settings`;
    const feedback = theme.fg(error ? "warning" : "muted", status);
    const navigation = workspaceTabs(layout, "Settings", theme);
    const height = Math.max(1, bodyHeight - navigation.length);
    const help = wrapTextWithAnsi(sanitizeTerminalText(spec.description), innerWidth);
    const presets = wrapTextWithAnsi(`Presets: ${spec.presets.join(" / ")}`, innerWidth);
    // Always reserve an editable row, even after a short/narrow resize.
    const notes = height >= 5 ? [...help, "", ...presets, ""].slice(0, height - 2) : [];
    const body = [...navigation, ...notes, ...input.render(innerWidth, Math.max(1, height - notes.length))];
    if (error && layout.headerHeight === 0) body[navigation.length] = feedback;
    const header = layout.headerHeight === 1 ? [error ? feedback : theme.fg("text", theme.bold(spec.label))]
      : [theme.fg("text", theme.bold(spec.label)), feedback];
    const hints: KeyHint[] = [["Esc", "Cancel"], ["Enter", "Apply"], ["Tab", "Preset"]];
    const footer = layout.footerHeight === 1 ? [fittingKeyHints(hints, innerWidth, theme)]
      : alignedKeyHints([hints.slice(0, 2), hints.slice(2)], innerWidth, theme);
    return panelFrame(layout, header, body, footer, (text) => theme.fg("borderMuted", text), { footerAfterBodyRows: navigation.length });
  }

  private cycleThinking(): void {
    if (!this.actions.cycleThinking || !this.settingsOptimizer?.thinkingEnabled) return;
    this.saving = true;
    this.settingsFailed = false;
    void this.actions.cycleThinking().then((result) => {
      if (this.disposed) return;
      this.settingsNotice = result.message;
      this.settingsFailed = !result.persisted;
    })
      .catch(() => { this.settingsNotice = "Could not save thinking level."; this.settingsFailed = true; })
      .finally(() => {
        this.saving = false;
        if (!this.disposed) { this.refreshSettings(); this.tui.requestRender(); }
      });
    this.tui.requestRender();
  }

  /** False at an outer group boundary delegates page navigation to the workspace. */
  handleInput(data: string): boolean {
    if (this.numberInput) { this.handleNumberInput(data); return true; }
    if (this.saving) return true;
    const key = parseKey(data);
    if (key === "left" || key === "right") {
      if (key === "right" ? this.settingsGroup < this.settingsGroups.length - 1 : this.settingsGroup > 0) {
        this.switchSettingsGroup(key === "right" ? 1 : -1);
        return true;
      }
      return false;
    }
    if (key === "q" || key === "ctrl+\\" || this.keys.matches(data, "tui.select.cancel")) {
      this.actions.close();
    } else if (key === "tab") {
      this.switchSettingsGroup();
    } else if (key === "ctrl+s") {
      this.saving = true;
      this.settingsFailed = false;
      this.tui.requestRender();
      void this.actions.saveContext({ ...this.selected }).then((result) => {
        if (this.disposed) return;
        if (!result.persisted) {
          this.settingsNotice = result.message;
          this.settingsFailed = true;
          return;
        }
        this.actions.close(result.message);
      }).catch(() => {
        if (this.disposed) return;
        this.settingsNotice = "Could not save settings. Retry with Ctrl+S.";
        this.settingsFailed = true;
      }).finally(() => {
        this.saving = false;
        if (!this.disposed) this.tui.requestRender();
      });
    } else if (this.actions.optimizer && this.keys.matches(data, "app.thinking.cycle")) {
      this.cycleThinking();
    } else if (this.keys.matches(data, "tui.input.submit") || key === "space") {
      if (NUMBER_SETTINGS[this.cursor]) this.editNumber(NUMBER_SETTINGS[this.cursor]!);
      else if ([0, 1, 2, 6, 7].includes(this.cursor)) {
        if (this.cursor === 0) {
          this.selected.instructions = instructionModes[(instructionModes.indexOf(this.selected.instructions) + 1) % instructionModes.length]!;
        } else {
          const field = this.cursor === 1 ? "tree" : this.cursor === 2 ? "skills" : this.cursor === 6 ? "enabled" : "referencedDirectories";
          const current = this.selected[field] ?? (field === "enabled" ? this.settingsContextEnabled : DEFAULT_CONFIG.projectContext.referencedDirectories.enabled);
          this.selected[field] = !current;
        }
        this.settingsNotice = "";
        this.settingsFailed = false;
        this.tui.requestRender();
      } else if (this.cursor === 3) this.actions.chooseModel?.({ ...this.selected });
      else if (this.cursor === 5) this.actions.editSystemPrompt?.({ ...this.selected });
      else this.cycleThinking();
    } else {
      const rows = this.settingsGroups[this.settingsGroup]!.rows;
      const index = rows.indexOf(this.cursor);
      if (this.keys.matches(data, "tui.select.up")) this.cursor = rows[(index + rows.length - 1) % rows.length]!;
      else if (this.keys.matches(data, "tui.select.down")) this.cursor = rows[(index + 1) % rows.length]!;
      else return true;
      this.tui.requestRender();
    }
    return true;
  }
  render(width: number): string[] {
    if (this.numberInput) return this.renderNumberInput(width);
    const layout = this.layout(width);
    const { innerWidth, bodyHeight } = layout;
    const { theme } = this;
    const cacheKey = JSON.stringify([width, layout.height, this.selected, this.original, this.settingsOptimizer,
      this.settingsContextEnabled, this.saving, this.settingsNotice, this.settingsFailed]);
    if (cacheKey !== this.settingsCacheKey) {
      this.settingsFrames.clear();
      this.settingsCacheKey = cacheKey;
    }
    const frameKey = `${this.cursor}:${this.settingsScrollTop}`;
    const cached = this.settingsFrames.get(frameKey);
    if (cached) { this.settingsScrollTop = cached.scrollTop; return cached.lines; }
    let body: string[];
    let header: string[];
    let footer: string[];
    let footerAfterBodyRows: number | undefined;
    const dirty = settingsDirty(this.selected, this.original);
    const notice = [this.saving ? "Saving..." : this.settingsNotice, dirty ? "Unsaved settings changes" : ""].filter(Boolean).join(" · ");
    const optimizer = this.settingsOptimizer;
    const groups = this.settingsGroups;
    const group = groups[this.settingsGroup]!.label;
    const status = theme.fg(dirty || this.settingsFailed ? "warning" : "muted", sanitizeTerminalText(notice || "Applies to future requests"));
    header = [layout.headerHeight === 1 && notice ? status : theme.fg("text", theme.bold("Settings")), status];
    const navigation = workspaceTabs(layout, "Settings", theme);
    footerAfterBodyRows = navigation.length;
    const contentHeight = bodyHeight - navigation.length;
    // Keep top-level navigation fixed; the subordinate group strip is compact.
    const rows = panelTabs({ ...layout, bodyHeight: Math.min(7, contentHeight) }, groups.map((group) => group.label), this.settingsGroup, theme);
    let focusStart = 0;
    let focusEnd = 0;
    let focusedDetail = "";
    const columns = innerWidth >= 56;
    const descriptions = innerWidth >= 72;
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
      const enabled = this.selected.enabled ?? this.settingsContextEnabled;
      add(6, "Project context", enabled ? "[x] On" : "[ ] Off", "Include project rules, skills and directories");
      if (this.cursor === 6) focusedDetail = "Master switch for all project background; conversation history is independent. Applies to the next round.";
      add(7, "Directory references", (this.selected.referencedDirectories ?? DEFAULT_CONFIG.projectContext.referencedDirectories.enabled) ? "[x] On" : "[ ] Off", "Include explicit @directory listings");
      if (this.cursor === 7) focusedDetail = "Explicit @directory listings only; independent of the default tree. Applies to the next round.";
      if (!enabled) rows.push(theme.fg("warning", "Project context is off; rules, skills and directories are excluded."));
    } else if (group === "Optimizer" && optimizer) {
      add(3, "Model", optimizer.model, "Choose the prompt refinement model", "›");
      add(4, "Thinking", optimizer.thinking, "Set refinement reasoning effort", "›", !optimizer.thinkingEnabled);
      if (this.actions.editSystemPrompt) add(5, "Optimization prompt", "Edit", "Edit prompt rewriting instructions", "›");
    }
    for (const index of groups[this.settingsGroup]!.rows) {
      const spec = NUMBER_SETTINGS[index];
      if (!spec) continue;
      const value = numberSettingValue(this.selected, spec.field) / spec.scale;
      add(index, spec.label, value === 0 ? "Off" : `${value} ${spec.unit}`, spec.description, "›");
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
    const details = group === "Context" && this.cursor < 3 && descriptions && detailHeight === 2
      ? [instructionDescriptions[this.selected.instructions], "Tree: default only; @directory is separate. Skills: metadata only."]
      : wrapTextWithAnsi(sanitizeTerminalText(focusedDetail), innerWidth);
    body.push(...details.slice(0, detailHeight).map((line, i) => theme.fg("muted",
      i === detailHeight - 1 && details.length > detailHeight ? truncateToWidth(line + "…", innerWidth, "…") : line)));
    const action = this.cursor === 4 && !optimizer?.thinkingEnabled ? "Unavailable" : "Change";
    // Saving has a fixed key and an explicit scope, independent of row focus.
    const primary: KeyHint[] = innerWidth < 30
      ? [["^S", "Save"], ["↵", action]]
      : [["Ctrl+S", "Save settings"], ["Enter", action], ...(!NUMBER_SETTINGS[this.cursor] && this.settingsGroup === 0 ? [["Space", action] as const] : [])];
    const secondary: KeyHint[] = [["Esc", dirty ? (innerWidth >= 30 ? "Discard changes" : "Discard") : "Back"], ["Tab", "Group"],
      ["←", groups[this.settingsGroup - 1]?.label ?? "Usage"], ["→", groups[this.settingsGroup + 1]?.label ?? "Preview"], ["↑↓", "Select"]];
    // Share column stops with Tasks/Preview; retain independent compact rows
    // so the longer save/discard labels do not crowd out narrow-screen hints.
    footer = innerWidth < 30
      ? [fittingKeyHints(primary, innerWidth, theme), fittingKeyHints(secondary, innerWidth, theme)]
      : alignedKeyHints([primary, secondary], innerWidth, theme);
    if (layout.footerHeight === 1) footer = [fittingKeyHints([["Esc", dirty ? "Discard" : "Back"], ["^S", "Save"], ["↵", action]], innerWidth, theme)];
    const lines = panelFrame(layout, header, body, footer, (text) => theme.fg("borderMuted", text), { footerAfterBodyRows });
    if (this.settingsFrames.size >= 12) this.settingsFrames.clear();
    this.settingsFrames.set(frameKey, { lines, scrollTop: this.settingsScrollTop });
    return lines;
  }
}
