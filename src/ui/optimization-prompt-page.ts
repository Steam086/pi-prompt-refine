import { parseKey, visibleWidth, wrapTextWithAnsi, type KeybindingsManager } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { confirmationKeyHints, discardKeyHints, fittingKeyHints, type KeyHint } from "../key-hints.js";
import { panelConfirmation, panelHeader, workspaceTabs, type PanelLayout } from "../panel-layout.js";
import { sanitizeTerminalText } from "../presentation.js";
import type { PromptInput } from "../prompt-input.js";
import type { SettingsResult } from "../settings.js";

export interface OptimizationPromptTarget {
  text: string;
  save(text: string): Promise<SettingsResult>;
}

/** Settings owns the list draft; this child owns only the policy draft and its confirmation. */
export class OptimizationPromptPage {
  private readonly initial: string;
  private confirmation?: { kind: "save"; text: string } | { kind: "discard" };
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
    if (this.confirmation) {
      if (key === "y") {
        if (this.confirmation.kind === "save") void this.save(this.confirmation.text);
        else this.close();
      } else if (cancel || key === "n") {
        this.confirmation = undefined;
        this.focused = this.hasFocus;
      }
    } else if (cancel) {
      if (this.input.editor.getExpandedText() === this.initial) this.close();
      else {
        this.confirmation = { kind: "discard" };
        this.focused = this.hasFocus;
      }
    } else if (key === "ctrl+s") {
      const text = this.input.editor.getExpandedText();
      if (!text.trim()) this.error = "Prompt cannot be empty.";
      else if (text === this.initial) this.close();
      else {
        this.confirmation = { kind: "save", text };
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
    const discard = this.confirmation?.kind === "discard";
    const confirmTitle = discard ? "Discard unsaved prompt?" : "Save optimization prompt?";
    const heading = this.saving ? "Saving prompt…" : confirming
      ? (visibleWidth(confirmTitle) <= width ? confirmTitle : discard ? "Discard prompt?" : "Save prompt?") : "Optimization prompt";
    const title = theme.fg("text", theme.bold(heading));
    const scope = width >= 34 ? "Refine only · Applies next round" : "Refine only · Next round";
    const status = this.error && !confirming ? theme.fg("warning", visibleWidth(this.error) <= width ? this.error : "Empty prompt")
      : !confirming && visibleWidth(scope) <= width ? theme.fg("muted", scope) : "";
    const border = (text: string) => theme.fg("borderMuted", text);
    if (confirming) {
      const hints = this.saving ? "" : discard ? discardKeyHints(width, theme) : confirmationKeyHints(["Esc", "Back"], ["y", "Save"], width, theme);
      const notes = discard ? [] : wrapTextWithAnsi("Writes to prompt-refine.json for the next round.", Math.min(width, 56));
      return panelConfirmation(layout, title, hints, notes.map((line) => theme.fg("muted", line)), border);
    }
    const tabs = workspaceTabs(layout, "Settings", theme);
    const primary: KeyHint[] = [["Esc", width >= 10 ? "Cancel" : ""], [width >= 34 ? "Ctrl+S" : "^S", "Save"], ["Enter", "Newline"]];
    const hints = fittingKeyHints(primary, layout.innerWidth, theme, width < 27 ? " " : " · ");
    const header = layout.headerHeight === 1 && this.error ? [status] : [title, status];
    const chrome = panelHeader(layout, header, tabs, hints);
    const height = chrome.layout.bodyHeight;
    const body: string[] = [];
    if (!layout.headerHeight && this.error && height > 1) body.push(status);
    body.push(...this.input.render(width, height - body.length).map((line) => theme.fg("text", line)));
    return chrome.render(body, border);
  }
}
