import { matchesKey, parseKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type KeybindingsManager, type KeyId } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { panelFrame, type PanelLayoutProvider } from "../panel-layout.js";
import { alignedKeyHints, fittingKeyHints } from "../key-hints.js";
import type { PromptInput } from "../prompt-input.js";
import { sanitizeTerminalText } from "../presentation.js";
import { composeRevision, type RevisionDraft, type SelectedPreference } from "../revision-preferences.js";

export interface RevisionTarget { key: string; label?: string; submit(text: string): string | undefined }
interface RevisePageOptions {
  preferences: boolean;
  preferencesKey?: KeyId | null;
  preferencesKeyNotice: string;
  openPreferences(): void;
  back(): void;
  submitted(): void;
}

/** Revision-local controls never submit through child-page navigation. */
export class RevisePage {
  private revisionInput: PromptInput;
  private revisionTarget?: RevisionTarget;
  private revisionSelected: SelectedPreference[] = [];
  private revisionExpanded = false;
  private revisionFocus: "input" | "preferences" | "requirements" = "input";
  private reviewingRequirements = false;
  private requirementsScroll = 0;
  private requirementsCache?: { text: string; width: number; lines: string[] };
  private revisionSource?: { render(width: number): string[] };
  private inputError = "";
  private hasFocus = false;
  constructor(
    private readonly theme: Theme,
    private readonly keys: KeybindingsManager,
    private readonly options: RevisePageOptions,
    private readonly revisionDrafts: Map<string, RevisionDraft>,
    private readonly makeInput: () => PromptInput,
    private readonly layout: PanelLayoutProvider,
    private readonly tui: { terminal: { rows: number; columns: number }; requestRender(): void },
  ) { this.revisionInput = makeInput(); }
  set focused(value: boolean) {
    this.hasFocus = value;
    this.revisionInput.editor.focused = value && !this.reviewingRequirements && this.revisionFocus === "input";
  }
  invalidate(): void { this.revisionInput.editor.invalidate(); }
  open(target: RevisionTarget, source: { render(width: number): string[] } | undefined): void {
    const draft = this.revisionDrafts.get(target.key);
    if (target.key !== this.revisionTarget?.key) {
      // Undo must not resurrect another candidate's feedback. Child pages keep this instance.
      this.revisionInput.editor.focused = false;
      this.revisionInput = this.makeInput();
      this.revisionInput.editor.setText(draft?.freeText ?? "");
    }
    this.revisionTarget = target;
    this.revisionSelected = structuredClone(draft?.selected ?? []);
    this.revisionSource = source;
    this.inputError = "";
    this.revisionExpanded = false;
    this.revisionFocus = "input";
    this.reviewingRequirements = false;
  }
  preferenceDraft(): RevisionDraft {
    this.rememberRevision();
    return { selected: this.revisionSelected, freeText: this.revisionInput.editor.getExpandedText() };
  }
  bringBackPreferences(selected?: SelectedPreference[]): void {
    if (selected) { this.revisionSelected = selected; this.rememberRevision(); }
    this.revisionFocus = "input";
  }
  private rememberRevision(): void {
    if (!this.revisionTarget) return;
    this.revisionDrafts.set(this.revisionTarget.key, { freeText: this.revisionInput.editor.getExpandedText(), selected: structuredClone(this.revisionSelected) });
    if (this.revisionDrafts.size > 100) this.revisionDrafts.delete(this.revisionDrafts.keys().next().value!);
  }

  handleInput(data: string, width = this.tui.terminal.columns): boolean {
    const key = parseKey(data);
    if (this.reviewingRequirements) {
      if (this.keys.matches(data, "tui.select.cancel") || key === "ctrl+\\") {
        this.reviewingRequirements = false; this.revisionFocus = "input"; this.focused = this.hasFocus;
      } else if (key === "up" || key === "down" || key === "pageup" || key === "pagedown") {
        const delta = key === "up" ? -1 : key === "down" ? 1 : (key === "pageup" ? -1 : 1) * Math.max(1, this.tui.terminal.rows - 8);
        this.requirementsScroll = Math.max(0, this.requirementsScroll + delta);
      }
      this.tui.requestRender(); return true;
    }
    if (key === "tab" || key === "shift+tab") {
      const controls = this.options.preferences ? ["input", "preferences", "requirements"] as const : ["input", "requirements"] as const;
      const index = controls.findIndex((control) => control === this.revisionFocus);
      this.revisionFocus = controls[(index + (key === "tab" ? 1 : controls.length - 1)) % controls.length]!;
      this.focused = this.hasFocus; this.tui.requestRender(); return true;
    }
    if (this.revisionFocus !== "input" && this.keys.matches(data, "tui.select.confirm")) {
      if (this.revisionFocus === "preferences") this.options.openPreferences();
      else { this.reviewingRequirements = true; this.requirementsScroll = 0; this.focused = this.hasFocus; }
      this.tui.requestRender(); return true;
    }
    if (this.options.preferencesKey && matchesKey(data, this.options.preferencesKey)) {
      this.options.openPreferences(); return true;
    }
    if (key === "ctrl+e") {
      if (this.canInlineRevision(width)) this.revisionExpanded = !this.revisionExpanded;
      this.tui.requestRender();
      return true;
    }
    if (this.keys.matches(data, "tui.select.cancel") || key === "ctrl+\\") {
      this.rememberRevision();
      this.options.back();
    } else {
      const text = this.revisionInput.editor.getExpandedText();
      this.inputError = "";
      if (key === "ctrl+s") {
        const requirements = composeRevision(this.revisionSelected, text);
        const error = !requirements.trim() ? "Select preferences or enter additional requirements before submitting."
          : this.revisionTarget?.submit(requirements);
        this.inputError = this.revisionTarget ? error ?? "" : "No current result to revise.";
        if (!this.inputError) this.options.submitted();
      } else if (this.revisionFocus === "input" && this.keys.matches(data, "tui.input.submit")) this.revisionInput.editor.insertTextAtCursor("\n");
      else if (this.revisionFocus === "input") this.revisionInput.editor.handleInput(data);
      if (this.revisionTarget) this.rememberRevision();
      this.tui.requestRender();
    }
    return true;
  }
  private renderRequirements(width: number): string[] {
    const layout = this.layout(width);
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

  private canInlineRevision(width: number): boolean {
    const layout = this.layout(width);
    return layout.bodyHeight >= 12 && layout.innerWidth >= 36;
  }

  private renderRevision(width: number): string[] {
    const layout = this.layout(width);
    const { theme } = this;
    const canInline = this.canInlineRevision(width);
    const inline = !this.revisionExpanded && canInline;
    const editorHeight = inline ? Math.min(10, Math.max(5, Math.floor(layout.bodyHeight * 0.3))) : layout.bodyHeight;
    const title = layout.innerWidth < 64 ? "Revise" : "Revise current result";
    const identity = this.revisionTarget?.label ? theme.fg("muted", sanitizeTerminalText(` · ${this.revisionTarget.label}`)) : "";
    const selected = this.revisionSelected.length ? `${this.revisionSelected.length} · ${this.revisionSelected.map((item) => item.name + (item.body !== item.sourceBody ? "*" : "")).join(", ")}` : "None";
    const status = this.inputError || this.options.preferencesKeyNotice.trim() || `Revision not submitted${this.revisionSelected.some((item) => item.body !== item.sourceBody) ? " · * Edited for this revision only" : ""}`;
    const warning = !!(this.inputError || this.options.preferencesKeyNotice);
    const feedback = theme.fg(warning ? "warning" : "muted", sanitizeTerminalText(`${warning ? "⚠ " : ""}${status}`));
    const control = (label: string, active: boolean) => active ? theme.bg("selectedBg", theme.fg("text", theme.bold(`› ${label}`))) : theme.fg("muted", label);
    const preferences = this.options.preferences ? control(sanitizeTerminalText(`Preferences: ${selected}`), this.revisionFocus === "preferences") : undefined;
    const review = control("Review full requirements", this.revisionFocus === "requirements");
    const inputs = control("Additional requirements:", this.revisionFocus === "input");
    const tools = preferences ? [preferences, review] : [review];
    const strip = tools.join(theme.fg("muted", " · "));
    // Keep both explicit navigation targets, but avoid a separate row for every control.
    const controls = [...(visibleWidth(strip) <= layout.innerWidth ? [strip] : tools), inputs];
    const header = [theme.fg("text", theme.bold(title)) + identity, feedback];
    if (layout.headerHeight === 1 && warning) header[0] = feedback;
    const footer = alignedKeyHints([
      [["Ctrl+S", "Revise"], ["Enter", "Newline"], ...(this.options.preferencesKey ? [[this.options.preferencesKey.toUpperCase(), "Preferences"] as const] : [])],
      [["Esc", "Back"], ["Tab", "Focus"], ...(canInline ? [["Ctrl+E", inline ? "Editor only" : "Show source"] as const] : [])],
    ], layout.innerWidth, theme);
    if (layout.footerHeight === 1) footer[0] = fittingKeyHints([["Esc", "Back"], ["^S", "Revise"], ["Tab", "Focus"]], layout.innerWidth, theme);
    if (this.revisionFocus !== "input") footer[0] = fittingKeyHints([
      ...(layout.footerHeight === 1 ? [["Esc", "Back"] as const] : []),
      ["Enter", this.revisionFocus === "preferences" ? "Preferences" : "Review"], ["Tab", "Focus"], ["Ctrl+S", "Revise"]], layout.innerWidth, theme);
    const visibleControls = layout.bodyHeight <= 1 && this.revisionFocus === "input" ? [] : layout.bodyHeight >= controls.length + 1 ? controls
      : [this.revisionFocus === "preferences" ? preferences! : this.revisionFocus === "requirements" ? review : inputs];
    const editor = this.revisionInput.render(layout.innerWidth, Math.max(1, inline ? editorHeight : layout.bodyHeight - visibleControls.length));
    const body = layout.headerHeight === 0 && warning ? [feedback, ...editor] : [...visibleControls, ...editor];
    if (!inline) return panelFrame(layout, header, body, footer, (text) => theme.fg("borderMuted", text));
    // Keep the source panel's viewport/scroll unchanged; its snapshot has no live action hints.
    const source = this.revisionSource?.render(width);
    const pad = (line: string) => " ".repeat(layout.inset) + truncateToWidth(line, layout.innerWidth, "");
    const bottom = [theme.fg("borderMuted", "─".repeat(layout.innerWidth)), ...header,
      ...visibleControls, ...Array.from({ length: editorHeight }, (_, i) => editor[i] ?? ""),
      ...footer.slice(0, layout.footerHeight)].map(pad);
    return [...(source ?? []).slice(0, layout.height - bottom.length), ...bottom];
  }

  render(width: number): string[] {
    return this.reviewingRequirements ? this.renderRequirements(width) : this.renderRevision(width);
  }
}
