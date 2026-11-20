import { parseKey, visibleWidth, wrapTextWithAnsi, type KeybindingsManager } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { fittingKeyHints, type KeyHint } from "../key-hints.js";
import { panelHeader, workspaceTabs, type PanelLayout } from "../panel-layout.js";
import { sanitizeTerminalText } from "../presentation.js";
import type { PromptInput } from "../prompt-input.js";
import type { SettingsResult } from "./settings-page.js";

export interface OptimizationPromptTarget {
  text: string;
  save(text: string): Promise<SettingsResult>;
}

/** Settings owns the list draft; this child owns only the policy draft and its confirmation. */
export class OptimizationPromptPage {
  private readonly initial: string;
  private confirmation?: string;
  private saving = false;
  private error = "";
  private hasFocus = false;
  private disposed = false;

  constructor(
    private readonly theme: Theme,
    private readonly keys: KeybindingsManager,
    private readonly input: PromptInput,
    private readonly target: OptimizationPromptTarget,
    private readonly close: (result?: SettingsResult) => void,
    private readonly redraw: () => void,
  ) {
    // Compare against the editor's representation (e.g. CRLF and tabs are normalized),
    // so opening an existing policy and saving without edits never rewrites config.
    input.editor.setText(sanitizeTerminalText(target.text.replace(/\r\n?/g, "\n")));
    this.initial = input.editor.getExpandedText();
    input.editor.disableSubmit = true;
  }

  set focused(value: boolean) {
    this.hasFocus = value;
    this.input.editor.focused = value && this.confirmation === undefined;
  }

  invalidate(): void { this.input.editor.invalidate(); }
  dispose(): void { this.disposed = true; this.focused = false; }

  handleInput(data: string): void {
    if (this.disposed || this.saving) return;
    const key = parseKey(data);
    const cancel = key === "escape" || key === "ctrl+\\" || this.keys.matches(data, "tui.select.cancel");
    if (this.confirmation !== undefined) {
      if (key === "y") void this.save(this.confirmation);
      else if (cancel || key === "n") {
        this.confirmation = undefined;
        this.focused = this.hasFocus;
      }
    } else if (cancel) {
      this.close();
    } else if (key === "ctrl+s") {
      const text = this.input.editor.getExpandedText();
      if (!text.trim()) this.error = "Prompt cannot be empty.";
      else if (text === this.initial) this.close();
      else {
        this.confirmation = text;
        this.focused = this.hasFocus;
      }
    } else {
      const before = this.input.editor.getExpandedText();
      if (this.keys.matches(data, "tui.input.submit")) this.input.editor.insertTextAtCursor("\n");
      else this.input.editor.handleInput(data);
      const text = this.input.editor.getExpandedText();
      const safe = sanitizeTerminalText(text);
      if (text !== safe) this.input.editor.setText(safe);
      if (safe !== before) this.error = "";
    }
    this.redraw();
  }

  private async save(text: string): Promise<void> {
    this.saving = true;
    let result: SettingsResult;
    try { result = await this.target.save(text); }
    catch { result = { message: "Not persisted · Could not save optimization prompt.", persisted: false }; }
    if (!this.disposed) {
      this.close(result);
      this.redraw();
    }
  }

  render(layout: PanelLayout): string[] {
    const { theme } = this;
    const { innerWidth: width } = layout;
    const confirming = this.confirmation !== undefined;
    const title = theme.fg("text", theme.bold(confirming ? "Save optimization prompt?" : "Optimization prompt"));
    const scope = theme.fg("muted", width >= 34 ? "Refine only · Applies next round" : "Refine only · Next round");
    const status = this.error ? theme.fg("warning", this.error) : this.saving ? theme.fg("muted", "Saving…") : scope;
    const hints: KeyHint[] = this.saving ? [] : confirming
      ? [["Esc", "Back"], ["y", "Save"]]
      : [["Esc", "Cancel"], [width >= 34 ? "Ctrl+S" : "^S", "Save"], ["Enter", "Newline"]];
    const hintLine = fittingKeyHints(hints, width, theme);
    const tabs = workspaceTabs(layout, "Settings", theme);
    const header = layout.headerHeight === 1 && this.error ? [status] : [title, status];
    const chrome = panelHeader(layout, header, tabs, [hintLine]);
    const body: string[] = [];
    if (layout.headerHeight === 0 && this.error) body.push(status);
    if (layout.footerHeight === 0 && hintLine) body.push(hintLine);
    if (layout.headerHeight < 2 && !this.error) body.push(status);
    if (confirming) {
      const details = "Writes to prompt-refine.json. The fixed role and JSON output protocol stay in place.";
      const notes = wrapTextWithAnsi(details, width);
      if (body.length + notes.length <= chrome.layout.bodyHeight) body.push(...notes.map((line) => theme.fg("muted", line)));
    } else {
      // In very short terminals, don't let optional scope text hide the edit cursor.
      if (body.at(-1) === scope && (body.length >= chrome.layout.bodyHeight || visibleWidth(scope) > width)) body.pop();
      body.push(...this.input.render(width, Math.max(1, chrome.layout.bodyHeight - body.length)));
    }
    return chrome.render(body, (line) => theme.fg("borderMuted", line));
  }
}
