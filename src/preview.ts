import { Markdown, ScrollView, Text, truncateToWidth, wrapTextWithAnsi, type Component, type MarkdownTheme } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { KeyHint } from "./key-hints.js";
import { fittingHints, panelFrame, panelLayout } from "./panel-layout.js";
import { formatTokenUsage } from "./usage.js";
import { resultHeading, sanitizeTerminalText, type SummaryOptions } from "./presentation.js";

export interface PreviewOptions extends SummaryOptions {
  draft?: string;
  canRestore: boolean;
  /** An accepted snapshot is read-only, not an actionable candidate. */
  accepted?: { editorChanged: boolean };
  draftChanged?: boolean;
  /** Pending metadata, never part of the editable prompt or an accepted snapshot. */
  sessionTitle?: string;
  notice?: string;
}

type PreviewTheme = Pick<Theme, "fg" | "bold" | "italic" | "underline" | "strikethrough">;

function markdownTheme(theme: PreviewTheme): MarkdownTheme {
  return {
    heading: (text) => theme.fg("accent", theme.bold(text)),
    link: (text) => theme.fg("mdLink", text),
    linkUrl: (text) => theme.fg("mdLinkUrl", text),
    code: (text) => theme.fg("mdCode", text),
    codeBlock: (text) => theme.fg("mdCodeBlock", text),
    codeBlockBorder: (text) => theme.fg("borderMuted", text),
    quote: (text) => theme.fg("mdQuote", text),
    quoteBorder: (text) => theme.fg("borderMuted", text),
    hr: (text) => theme.fg("borderMuted", text),
    listBullet: (text) => theme.fg("accent", text),
    bold: (text) => theme.bold(text),
    italic: (text) => theme.italic(text),
    strikethrough: (text) => theme.strikethrough(text),
    underline: (text) => theme.underline(text),
  };
}

/** Read-only result view. Actions and candidate/session guards remain in the extension. */
export class PreviewPanel implements Component {
  private originalVisible = false;
  private helpVisible = false;
  private sourceVisible = false;
  private revealOriginal = false;
  private originalLine = 0;
  private document: Component = new Text("", 0, 0);
  private scroll: ScrollView;
  private cachedBody?: { width: number; lines: string[] };

  constructor(
    private options: PreviewOptions,
    private readonly theme: PreviewTheme,
    private readonly rows: () => number,
    private readonly requestRender: () => void,
  ) {
    this.scroll = new ScrollView({ render: (width) => this.renderBody(width), invalidate: () => this.invalidate() }, { scrollbar: "hidden" });
    this.rebuildDocument();
  }

  update(options: PreviewOptions): void {
    const changed = options.state.requestId !== this.options.state.requestId || options.candidateText !== this.options.candidateText;
    const textChanged = options.candidateText !== this.options.candidateText;
    this.options = options;
    if (textChanged) this.rebuildDocument();
    else this.cachedBody = undefined;
    if (changed) this.scroll.scrollToStart();
  }

  setNotice(notice: string): void { this.options = { ...this.options, notice }; }

  toggleOriginal(): void {
    if (this.options.draft === undefined) return;
    this.originalVisible = !this.originalVisible;
    this.cachedBody = undefined;
    // Expansion is an explicit comparison request: reveal the draft, not an off-screen section.
    this.revealOriginal = this.originalVisible;
    if (!this.originalVisible) this.scroll.scrollToStart();
  }

  toggleHelp(): void {
    this.helpVisible = !this.helpVisible;
    this.cachedBody = undefined;
    this.scroll.scrollToStart();
  }

  toggleSource(): void {
    this.sourceVisible = !this.sourceVisible;
    this.rebuildDocument();
    this.scroll.scrollToStart();
  }

  scrollBy(lines: number): void { this.scroll.scrollBy(lines); }
  page(direction: number): void { this.scroll.scrollBy(direction * Math.max(1, this.scroll.viewportHeight - 1)); }

  invalidate(): void {
    // Recreate Markdown's style prefixes on theme changes; never retain old ANSI in state.
    this.rebuildDocument();
  }

  private rebuildDocument(): void {
    const text = sanitizeTerminalText(this.options.candidateText ?? "");
    this.document = this.sourceVisible ? new Text(text, 0, 0) : new Markdown(
      text, 0, 0, markdownTheme(this.theme), { color: (value) => this.theme.fg("text", value) },
      { preserveOrderedListMarkers: true, preserveBackslashEscapes: true, renderLatex: false },
    );
    this.cachedBody = undefined;
  }

  private renderBody(width: number): string[] {
    if (this.cachedBody?.width === width) return this.cachedBody.lines;
    const { theme, options } = this;
    const lines: string[] = [];
    const paragraph = (text: string, color: "text" | "muted" | "warning" = "text") => {
      lines.push(...wrapTextWithAnsi(sanitizeTerminalText(text), width).map((line) => theme.fg(color, line)));
    };
    const usageLabel = formatTokenUsage(options.state.usage);
    if (usageLabel && options.state.phase !== "generating") {
      paragraph(usageLabel, "muted");
      lines.push("");
    }
    if (this.helpVisible) {
      lines.push(theme.fg("accent", theme.bold("Help · Keyboard reference")), "");
      if (options.accepted) paragraph("Read-only snapshot; a/e/s disabled.\nEdit or send from the main editor.");
      const hint = (key: string, label: string) => `${theme.fg("accent", theme.bold(key))} ${theme.fg("text", label)}`;
      const helpLine = (...items: KeyHint[]) => lines.push(...wrapTextWithAnsi(items.map(([key, label]) => hint(key, label)).join(theme.fg("muted", " · ")), width));
      if (!options.accepted) {
        helpLine(["a", "Accept into editor (no send)"], ["e", "Edit candidate"]);
        helpLine(["s", "Send (follow-up if busy; draft kept)"]);
      }
      helpLine(["x/d", "Break / cancel (stops the running request)"]);
      helpLine(["z", "Restore draft before acceptance"]);
      lines.push("", theme.bold("Refine & navigate"));
      helpLine(["r", "Refine current draft (model call)"]);
      helpLine(["m", "Model"], ["c", "Cycle favorites"]);
      helpLine(["o", "Original"], ["v", "Formatted/source"]);
      helpLine(["↑↓", "Scroll"], ["PgUp/PgDn", "Page"]);
      helpLine(["i", "Input"], ["→", "Context (← returns without saving)"]);
      helpLine(["q", "Back"], ["?", "Hide help"]);
      paragraph("Enter won't send", "muted");
      if (!options.canRestore) paragraph("Nothing to restore.", "muted");
      const model = options.state.model;
      paragraph(model ? `Model: ${model.provider}/${model.id}` : "No model", "muted");
      paragraph(options.contextLabel, "muted");
      lines.push("");
    }
    if (options.candidateText !== undefined) {
      if (options.accepted) {
        paragraph(options.accepted.editorChanged
          ? "Editor changed; this snapshot excludes later edits."
          : "In editor. Viewing makes no model call or draft changes.", options.accepted.editorChanged ? "warning" : "muted");
        paragraph("q Back to editor · r Refine current draft", "muted");
        lines.push("");
      } else if (options.draftChanged) {
        paragraph("Editor changed; candidate uses the original draft.", "warning");
        lines.push("");
      }
      if (!options.accepted && options.sessionTitle) {
        paragraph(`Title on accept: ${options.sessionTitle}`, "muted");
        lines.push("");
      }
      const title = options.accepted ? "Accepted prompt · read-only" : "Refined prompt";
      lines.push(theme.fg("accent", theme.bold(`${title}${this.sourceVisible ? " · source" : ""}`)), "");
      lines.push(...this.document.render(width));
      if (this.originalVisible && options.draft !== undefined) {
        this.originalLine = lines.length;
        lines.push("", theme.fg("borderMuted", "─".repeat(width)), "");
        paragraph("Original draft · at request time", "muted");
        lines.push("");
        // Keep the comparison literal and legible, rather than dimming its body.
        lines.push(...new Text(sanitizeTerminalText(options.draft), 0, 0).render(width));
      }
    } else if (options.state.phase === "generating") {
      paragraph("Refining your prompt.");
      lines.push("");
      paragraph("Results appear here. q returns to editing; work continues.", "muted");
    } else if (options.state.phase === "error") {
      paragraph(options.errorLabel ?? "Request failed. Retry.", "warning");
      lines.push("");
      paragraph("Draft unchanged. r Retry · m Model", "muted");
    } else {
      paragraph("No result yet.");
      lines.push("");
      paragraph("r Refine current draft · m Model", "muted");
    }
    if (options.state.pendingSend) {
      lines.push("");
      paragraph("Send pending Pi confirmation. Draft kept; don't resubmit.", "warning");
    }
    const bounded = lines.map((line) => truncateToWidth(line, width, ""));
    this.cachedBody = { width, lines: bounded };
    return bounded;
  }

  render(width: number): string[] {
    if (width < 1) return [];
    const { theme, options } = this;
    const layout = panelLayout(width, this.rows());
    const { innerWidth, bodyHeight } = layout;
    const heading = options.accepted
      ? `${theme.fg("success", theme.bold(`✓ Accepted · ${options.elapsedSeconds}s`))}  ${theme.fg("muted", "Prompt Refine")}`
      : resultHeading(options, theme);
    const header = [truncateToWidth(`${theme.fg("accent", theme.bold("Main"))}  ${heading}`, innerWidth, "")];
    const model = options.state.model;
    header.push(theme.fg("muted", sanitizeTerminalText(options.notice ?? `${model ? `${model.provider}/${model.id}` : "No model"} · ${options.contextLabel}`)));
    const ready = options.candidateText !== undefined;
    const primary: KeyHint[] = options.accepted
      ? [["r", "Refine draft"], ...(options.canRestore ? [["z", "Restore"] as KeyHint] : [])]
      : ready
        ? [["a", "Accept"], ["e", "Edit"], options.state.pendingSend ? ["", "Send pending"] : ["s", "Send"], ["x", "Cancel"]]
        : [["r", options.state.phase === "generating" ? "Restart" : "Refine"], ["m", "Model"], ["x", options.state.phase === "generating" ? "Break" : "Cancel"]];
    const hint = ([key, label]: KeyHint) => `${theme.fg("accent", theme.bold(key))}${key ? " " : ""}${label}`;
    const secondary: KeyHint[] = [
      ["q", "Back"], ["?", this.helpVisible ? "Hide help" : "Help"], ["i", "Input"], ["→", innerWidth < 30 ? "Ctx" : "Context"],
      ...(ready ? [["o", this.originalVisible ? "Hide original" : "Original"] as KeyHint] : []),
    ];
    const footer = [
      fittingHints([...primary.map(hint), "Enter won't send"], innerWidth),
      fittingHints(secondary.map(hint), innerWidth),
    ];
    if (layout.footerHeight === 1) footer[0] = fittingHints(["q Back", "i Input", "→ Ctx", "? Help"], innerWidth);
    // ScrollView owns offsets/clamping. Explicit viewport composition also works in regular
    // mode, where ScrollView.render() alone returns the entire document without clipping.
    const body = this.scroll.render(innerWidth);
    this.scroll.updateLayout(body.length, bodyHeight, this.requestRender);
    if (this.revealOriginal) {
      this.scroll.scrollTo(this.originalLine);
      this.revealOriginal = false;
    }
    const start = this.scroll.scrollTop;
    const visible = body.slice(start, start + bodyHeight);
    if (body.length > bodyHeight) {
      const position = `↑↓ ${start + 1}–${Math.min(body.length, start + bodyHeight)}/${body.length}`;
      header[1] = theme.fg("muted", sanitizeTerminalText(`${position} · ${options.notice ?? options.contextLabel}`));
    }
    return panelFrame(layout, header, visible, footer, (text) => theme.fg("borderMuted", text));
  }
}
