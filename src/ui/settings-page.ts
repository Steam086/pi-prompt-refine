import { stripVTControlCharacters } from "node:util";
import { parseKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type KeybindingsManager } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { panelHeader, panelTabs, workspaceTabs, type PanelLayout, type PanelLayoutProvider } from "../panel-layout.js";
import { formatKeyHint, passiveHintLayout, type KeyHint } from "../key-hints.js";
import type { PromptInput } from "../prompt-input.js";
import { sanitizeTerminalText } from "../presentation.js";
import { DEFAULT_CONFIG } from "../config.js";
import { NUMBER_SETTINGS, numberSettingValue, settingsDirty, type ContextSettings, type NumberSettingSpec } from "../settings.js";
import { OptimizationPromptPage, type OptimizationPromptTarget } from "./optimization-prompt-page.js";

const instructionModes = ["first", "always", "off"] as const;
const instructionLabels = { first: "First request only", always: "Always", off: "Off" };
const instructionDescriptions = {
  first: "Pi rules (e.g. AGENTS.md): optimizer's first request per task, not Revise.",
  always: "Pi-loaded rules (e.g. AGENTS.md) may go to the optimizer, even in Revise.",
  off: "No Pi-loaded rules (e.g. AGENTS.md) are sent to the optimizer.",
};

export interface SettingsResult { message: string; persisted: boolean }
export interface SettingsOptimizer { model: string; thinking: string; thinkingEnabled: boolean; thinkingDetail?: string }

export interface SettingsPageActions {
  context(): ContextSettings;
  contextEnabled(): boolean;
  optimizer?(): SettingsOptimizer;
  chooseModel?(context: ContextSettings): void;
  editSystemPrompt?(): OptimizationPromptTarget | undefined;
  cycleThinking?(): Promise<SettingsResult>;
  saveContext(selected: ContextSettings): Promise<SettingsResult>;
  close(): void;
}

/** Settings owns its draft and caches; navigation and page lifetime belong to the workspace. */
export class SettingsPage {
  private selected: ContextSettings = { instructions: "always", tree: false, skills: false };
  private original: ContextSettings = { ...this.selected };
  private cursor = 0;
  private settingsScrollTop = 0;
  private groupCursors = [0, 3];
  private detailPage = 0;
  private detailPages = 1;
  private numberInput?: { spec: NumberSettingSpec; input: PromptInput; error: string };
  private optimizationPrompt?: OptimizationPromptPage;
  private settingsOptimizer?: SettingsOptimizer;
  private settingsContextEnabled = true;
  private settingsCacheKey = "";
  private settingsFrames = new Map<string, { lines: string[]; scrollTop: number; detailPages: number }>();
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
  get editingOptimizationPrompt(): boolean { return !!this.optimizationPrompt; }
  set focused(value: boolean) {
    this.hasFocus = value;
    if (this.numberInput) this.numberInput.input.editor.focused = value;
    if (this.optimizationPrompt) this.optimizationPrompt.focused = value;
  }
  dispose(): void {
    this.disposed = true;
    this.focused = false;
    this.optimizationPrompt?.dispose();
  }
  invalidate(): void { this.settingsFrames.clear(); this.optimizationPrompt?.invalidate(); }
  refreshSettings(): void {
    this.settingsOptimizer = this.actions.optimizer?.();
    this.settingsContextEnabled = this.actions.contextEnabled();
    this.numberInput?.input.editor.invalidate();
  }
  open(selected = this.actions.context(), cursor = this.cursor): void {
    this.original = this.actions.context();
    this.selected = { ...selected };
    this.numberInput = undefined;
    this.optimizationPrompt?.dispose();
    this.optimizationPrompt = undefined;
    this.cursor = this.settingsGroups.flatMap((group) => group.rows).includes(cursor) ? cursor : 0;
    this.groupCursors[this.settingsGroups[this.settingsGroup]!.memory] = this.cursor;
    this.settingsScrollTop = 0;
    this.detailPage = 0;
    this.settingsNotice = "";
    this.settingsFailed = false;
    this.refreshSettings();
  }

  private get settingsGroups(): { label: string; rows: number[]; memory: number }[] {
    const optimizer = !!this.actions.optimizer;
    return [
      { label: "Context", rows: [6, 0, 1, 2, 7, 8, 9, ...(optimizer ? [] : [12])], memory: 0 },
      ...(optimizer ? [{ label: "Optimizer", rows: [3, 4, ...(this.actions.editSystemPrompt ? [5] : []), 10, 11, 12], memory: 1 }] : []),
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
    this.detailPage = 0;
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

  /** Settings and its numeric editor share the same passive top shortcut strip. */
  private hintLayout(layout: PanelLayout, hints: KeyHint[], compact: KeyHint[]) {
    const tabs = workspaceTabs(layout, "Settings", this.theme);
    return { tabs, ...passiveHintLayout(layout, tabs.length, hints, compact, this.theme) };
  }

  private renderNumberInput(width: number): string[] {
    const { spec, input, error } = this.numberInput!;
    const hints: KeyHint[] = [["Esc", "Cancel"], ["Enter", "Stage"], ["Tab", "Preset"]];
    const { layout, tabs, footer } = this.hintLayout(this.layout(width), hints, [["Esc", "Cancel"], ["↵", "Stage"], ["Tab", "Preset"]]);
    const { innerWidth } = layout;
    const theme = this.theme;
    const status = error || `${spec.min}–${spec.max} ${spec.unit}`;
    const feedback = theme.fg(error ? "warning" : "muted", status);
    const header = layout.headerHeight === 1 && error ? [feedback]
      : [theme.fg("text", theme.bold(spec.label)), feedback];
    const chrome = panelHeader(layout, header, tabs, footer);
    const height = chrome.layout.bodyHeight;
    const body: string[] = error && !layout.headerHeight && height > 1 ? [feedback] : [];
    const prefix = innerWidth >= 12 ? "› " : "";
    // Show the field first, with a small viewport for wrapped or multiline paste.
    // PromptInput still owns the cursor and scroll position.
    const indent = " ".repeat(visibleWidth(prefix));
    const fieldWidth = innerWidth - visibleWidth(prefix);
    const field = input.render(fieldWidth, Math.min(3, height - body.length));
    body.push(...field.map((line, index) => theme.fg("muted", index === 0 ? prefix : indent)
      + theme.fg("text", line)));
    const save = wrapTextWithAnsi("Ctrl+S in Settings saves staged changes.", innerWidth);
    if (body.length + save.length <= height) {
      if (body.length + save.length + 2 <= height) body.push("");
      body.push(...save.map((line) => theme.fg("muted", line)));
      for (const note of [spec.description, `Presets: ${spec.presets.join(" / ")}`]) {
        const block = wrapTextWithAnsi(note, innerWidth);
        if (body.length + block.length <= height) body.push(...block.map((line) => theme.fg("muted", line)));
      }
    } else if (body.length < height) {
      const compact = theme.fg("muted", "Settings: ") + formatKeyHint(["^S", "Save"], theme, 1, "secondary-compact");
      if (visibleWidth(compact) <= innerWidth) body.push(compact);
    }
    return chrome.render(body, (text) => theme.fg("borderMuted", text));
  }

  private openOptimizationPrompt(): void {
    const target = this.actions.editSystemPrompt?.();
    if (!target) return;
    this.optimizationPrompt = new OptimizationPromptPage(this.theme, this.keys, this.makeInput(), target, (result) => {
      this.optimizationPrompt?.dispose();
      this.optimizationPrompt = undefined;
      if (result) {
        this.settingsNotice = result.message;
        this.settingsFailed = !result.persisted;
      }
    }, () => this.tui.requestRender());
    this.optimizationPrompt.focused = this.hasFocus;
    this.tui.requestRender();
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
    if (this.optimizationPrompt) { this.optimizationPrompt.handleInput(data); return true; }
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
      if (this.settingsGroups.length > 1) this.switchSettingsGroup();
    } else if (key === "pageUp" || key === "pageDown") {
      this.detailPage = Math.max(0, Math.min(this.detailPages - 1, this.detailPage + (key === "pageUp" ? -1 : 1)));
      this.tui.requestRender();
    } else if (key === "ctrl+s") {
      this.saving = true;
      this.settingsFailed = false;
      this.tui.requestRender();
      const saved = { ...this.selected };
      void this.actions.saveContext(saved).then((result) => {
        if (this.disposed) return;
        this.settingsNotice = result.message;
        this.settingsFailed = !result.persisted;
        if (result.persisted) this.original = saved;
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
      else if (this.cursor === 5) this.openOptimizationPrompt();
      else this.cycleThinking();
    } else {
      const rows = this.settingsGroups[this.settingsGroup]!.rows;
      const index = rows.indexOf(this.cursor);
      if (this.keys.matches(data, "tui.select.up")) this.cursor = rows[(index + rows.length - 1) % rows.length]!;
      else if (this.keys.matches(data, "tui.select.down")) this.cursor = rows[(index + 1) % rows.length]!;
      else return true;
      this.detailPage = 0;
      this.detailPages = 1;
      this.tui.requestRender();
    }
    return true;
  }
  render(width: number): string[] {
    if (this.optimizationPrompt) return this.optimizationPrompt.render(this.layout(width));
    if (this.numberInput) return this.renderNumberInput(width);
    const baseLayout = this.layout(width);
    const { innerWidth } = baseLayout;
    const { theme } = this;
    const cacheKey = JSON.stringify([width, baseLayout.height, this.selected, this.original, this.settingsOptimizer,
      this.settingsContextEnabled, this.saving, this.settingsNotice, this.settingsFailed]);
    if (cacheKey !== this.settingsCacheKey) {
      this.settingsFrames.clear();
      this.settingsCacheKey = cacheKey;
    }
    const frameKey = `${this.cursor}:${this.settingsScrollTop}:${this.detailPage}`;
    const cached = this.settingsFrames.get(frameKey);
    if (cached) {
      this.settingsScrollTop = cached.scrollTop;
      this.detailPages = cached.detailPages;
      return cached.lines;
    }
    const dirty = settingsDirty(this.selected, this.original);
    const message = sanitizeTerminalText(this.saving ? "Saving..." : this.settingsNotice);
    const notice = [message && theme.fg(this.settingsFailed ? "warning" : "muted", message),
      dirty && theme.fg("warning", "Unsaved settings changes")].filter(Boolean).join(theme.fg("muted", " · "));
    const optimizer = this.settingsOptimizer;
    const groups = this.settingsGroups;
    const group = groups[this.settingsGroup]!.label;
    const action = this.cursor === 4 ? (optimizer?.thinkingEnabled ? "Cycle" : undefined)
      : this.cursor === 3 ? "Choose" : this.cursor === 5 || NUMBER_SETTINGS[this.cursor] ? "Edit" : "Change";
    const enterHint = (key: string): KeyHint[] => action ? [[key, action]] : [];
    // Saving has a fixed key and an explicit scope, independent of row focus.
    const back: KeyHint = ["Esc", dirty ? "Discard" : "Back"];
    const groupHints: KeyHint[] = groups.length > 1 ? [["Tab", innerWidth >= 72 ? "Next group" : "Group"]] : [];
    const { layout, tabs, footer } = this.hintLayout(baseLayout,
      this.saving ? [] : [["Ctrl+S", "Save"], ...enterHint("Enter"), ...groupHints, back],
      this.saving ? [] : [back, ["^S", "Save"], ...enterHint("↵"), ...groupHints]);
    const timing = group === "Context" && this.cursor !== 12 ? "Context changes take effect next round" : "";
    const status = notice || theme.fg("muted", timing);
    const header = [layout.headerHeight === 1 && notice ? status : theme.fg("text", theme.bold("Settings")), status];
    const chrome = panelHeader(layout, header, tabs, footer);
    const contentHeight = chrome.layout.bodyHeight;
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
    const add = (index: number, label: string, value: string, description: string, affordance = "", dimmed = false,
      options: { detail?: string; shortLabel?: string; shortValue?: string } = {}) => {
      const active = index === this.cursor;
      label = sanitizeTerminalText(label);
      value = sanitizeTerminalText(value);
      description = sanitizeTerminalText(description);
      const suffix = affordance && innerWidth >= 20 ? ` ${affordance}` : "";
      const labelColor = dimmed ? "dim" : "text";
      const valueColor = dimmed ? "dim" : active || index === 3 ? "text" : "muted";
      const fitPriority = group === "Optimizer" || index === 12;
      const suffixWidth = visibleWidth(suffix);
      let content: string;
      let valueClipped: boolean;
      if (columns) {
        const summaryWidth = innerWidth - labelWidth - valueWidth - 6;
        const showSummary = descriptions && (!fitPriority || !!description && visibleWidth(description) <= summaryWidth);
        const modelWidth = visibleWidth(value) + suffixWidth;
        const nameWidth = index === 3 && modelWidth > innerWidth - labelWidth - 4 && modelWidth <= innerWidth - visibleWidth(label) - 4
          ? visibleWidth(label) : labelWidth;
        const width = fitPriority && !showSummary ? innerWidth - nameWidth - 4 : valueWidth;
        const shownValue = clip(value, width - suffixWidth);
        valueClipped = shownValue !== value;
        content = theme.fg(labelColor, active ? theme.bold(cell(label, nameWidth)) : cell(label, nameWidth)) + "  "
          + theme.fg(valueColor, cell(shownValue + suffix, width));
        if (showSummary) content += "  " + theme.fg(dimmed ? "dim" : "muted", clip(description, summaryWidth));
      } else {
        const available = Math.max(1, innerWidth - 2 - suffixWidth);
        const compactLabel = options.shortLabel ?? (index === 0 ? "Rules" : label);
        const line = (name: string, val: string) => val ? `${name}: ${val}` : name;
        const name = innerWidth < 32 || fitPriority && visibleWidth(line(label, value)) > available ? compactLabel : label;
        let compactValue = index === 0 && this.selected.instructions === "first"
          ? value.replace("First request only", innerWidth < 20 ? "First" : "First only") : value;
        if (options.shortValue && visibleWidth(line(name, compactValue)) > available) compactValue = options.shortValue;
        const text = clip(line(name, compactValue), available);
        valueClipped = text !== line(name, value);
        // Match wide rows: emphasize only the focused name, not its value or affordance.
        const nameText = clip(name, available);
        // Slice only at the end of the full, untruncated label; never inside a wide grapheme.
        const tail = nameText === name ? text.slice(name.length) : "";
        content = theme.fg(labelColor, active ? theme.bold(nameText) : nameText) + theme.fg(valueColor, tail + suffix);
      }
      const rendered = innerWidth < 2 ? (active ? "›" : " ") : theme.fg("text", active ? "› " : "  ") + content;
      if (active) {
        focusStart = rows.length;
        focusedDetail = fitPriority
          ? [valueClipped ? value : "", options.detail ?? description].filter(Boolean).join("\n")
          : description;
      }
      rows.push(active ? theme.bg("selectedBg", rendered + " ".repeat(Math.max(0, innerWidth - visibleWidth(rendered)))) : rendered);
      if (active) focusEnd = rows.length;
    };
    if (group === "Context") {
      const enabled = this.selected.enabled ?? this.settingsContextEnabled;
      const checkbox = (on: boolean) => on ? "[x] On" : "[ ] Off";
      // Inactive children remain editable; their choices take effect when project context is on.
      const projectValue = (value: string, on: boolean) => !enabled && on ? `${value} · inactive` : value;
      const projectCheckbox = (on: boolean) => !enabled && on ? "On · inactive" : checkbox(on);
      add(6, "Project context", checkbox(enabled), "Rules, skills and directories");
      if (this.cursor === 6) focusedDetail = enabled ? "Does not control conversation history." : "Child settings are kept but not applied.";
      const mode = this.selected.instructions;
      const ruleValue = mode === "first" && !enabled ? "First only" : instructionLabels[mode];
      add(0, "Project instructions", projectValue(ruleValue, mode !== "off"), "AGENTS.md and other Pi rules", "›", !enabled);
      if (this.cursor === 0) {
        const detail = enabled || mode === "off" ? instructionDescriptions[mode]
          : "Project context is off: no Pi-loaded rules (e.g. AGENTS.md) go to the optimizer.";
        focusedDetail = `${detail} Main agent unchanged.`;
      }
      add(1, "Directory tree", projectCheckbox(this.selected.tree), "Default tree without history", "", !enabled);
      if (this.cursor === 1) focusedDetail = "Only used if no history is included. @directory references are separate.";
      add(2, "Skill metadata", projectCheckbox(this.selected.skills), "Skill names and descriptions", "", !enabled);
      if (this.cursor === 2) focusedDetail = "Includes names and descriptions only; does not run skills.";
      const references = this.selected.referencedDirectories ?? DEFAULT_CONFIG.projectContext.referencedDirectories.enabled;
      add(7, "Directory references", projectCheckbox(references), "Names from @directory refs", "", !enabled);
      if (this.cursor === 7) focusedDetail = "Lists names only, not file contents. Separate from the default tree.";
      if (!enabled) rows.push(theme.fg("warning", "Project context is off. Conversation history is unaffected."));
    } else if (group === "Optimizer" && optimizer) {
      add(3, "Default model", optimizer.model, "", "›", false, { shortLabel: "Model",
        detail: optimizer.model === "Not configured" ? "Choose a model. Refine does not use the main agent's model." : "" });
      add(4, "Thinking", optimizer.thinking, "", optimizer.thinkingEnabled ? "›" : "", !optimizer.thinkingEnabled,
        { detail: optimizer.thinkingDetail });
      if (this.actions.editSystemPrompt) add(5, "Optimization prompt", "", "Applies next round", "›", false, {
        shortLabel: "Prompt", detail: "Refine's rewrite policy, not the main agent's prompt. Applies next round.",
      });
    }
    for (const index of groups[this.settingsGroup]!.rows) {
      const spec = NUMBER_SETTINGS[index];
      if (!spec) continue;
      const value = numberSettingValue(this.selected, spec.field) / spec.scale;
      add(index, spec.label, value === 0 ? "Off" : `${value} ${spec.unit}`, spec.summary ?? "", "›", false, {
        detail: spec.description, shortLabel: spec.shortLabel, shortValue: spec.shortUnit ? `${value}${spec.shortUnit}` : undefined,
      });
      if (this.cursor === index && index < 10) focusedDetail = spec.description;
    }
    const details = focusedDetail ? wrapTextWithAnsi(sanitizeTerminalText(focusedDetail), innerWidth) : [];
    const usualDetailHeight = contentHeight >= 12 ? 2 : contentHeight >= 3 ? 1 : 0;
    const fitDetails = group === "Optimizer" || this.cursor === 12;
    // In the shortest viewports, keep the selected row rather than spend a
    // detail or paging-hint row on its neighbors.
    const listReserve = contentHeight <= 3 ? 1 : Math.min(3, Math.ceil(contentHeight / 2));
    const detailCapacity = Math.max(0, contentHeight - listReserve);
    const detailHeight = fitDetails ? Math.min(details.length, detailCapacity) : usualDetailHeight;
    const paged = fitDetails && detailHeight > 0 && details.length > detailHeight;
    const pageHint = paged && detailHeight >= 2 && innerWidth >= 13;
    const detailSize = detailHeight - Number(pageHint);
    this.detailPages = paged ? Math.ceil(details.length / detailSize) : 1;
    this.detailPage = Math.min(this.detailPage, this.detailPages - 1);
    const listHeight = contentHeight - detailHeight;
    const maxStart = Math.max(0, rows.length - listHeight);
    let start = Math.min(this.settingsScrollTop, maxStart);
    if (focusStart < start) start = focusStart;
    else if (focusEnd > start + listHeight) start = Math.min(focusStart, focusEnd - listHeight);
    this.settingsScrollTop = Math.max(0, Math.min(start, maxStart));
    const body = rows.slice(this.settingsScrollTop, this.settingsScrollTop + listHeight);
    if (detailSize > 0 && details.length && body.length < listHeight) body.push("");
    const detailStart = this.detailPage * detailSize;
    body.push(...details.slice(detailStart, detailStart + detailSize).map((line, i) => theme.fg("muted",
      !fitDetails && i === detailSize - 1 && details.length > detailSize ? truncateToWidth(line + "…", innerWidth, "…") : line)));
    if (pageHint) {
      const hint = `PgUp/PgDn · ${this.detailPage + 1}/${this.detailPages}`;
      body.push(theme.fg("muted", visibleWidth(hint) <= innerWidth ? hint : "PgUp/PgDn"));
    }
    if (!layout.headerHeight && notice) body[0] = status;
    const lines = chrome.render(body, (text) => theme.fg("borderMuted", text));
    if (this.settingsFrames.size >= 12) this.settingsFrames.clear();
    this.settingsFrames.set(`${this.cursor}:${this.settingsScrollTop}:${this.detailPage}`,
      { lines, scrollTop: this.settingsScrollTop, detailPages: this.detailPages });
    return lines;
  }
}
