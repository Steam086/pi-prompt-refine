import { Markdown, ScrollView, Text, truncateToWidth, wrapTextWithAnsi, type Component, type MarkdownTheme } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatTokenUsage } from "./usage.js";
import { READING_WIDTH, resultHeading, sanitizeTerminalText, type SummaryOptions } from "./presentation.js";

export interface PreviewOptions extends SummaryOptions {
  draft?: string;
  canRestore: boolean;
  /** An accepted snapshot is read-only, not an actionable candidate. */
  accepted?: { editorChanged: boolean };
  draftChanged?: boolean;
  /** Pending metadata, never part of the editable prompt or an accepted snapshot. */
  sessionTitle?: string;
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
    this.options = options;
    this.rebuildDocument();
    if (changed) this.scroll.scrollToStart();
  }

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
      paragraph("Keys", "muted");
      if (options.accepted) paragraph("Read-only snapshot; a/e/s disabled.\nEdit or send from the main editor.");
      else paragraph("a Accept into editor (no send) · e Edit candidate\ns Send (follow-up if busy; draft kept)");
      paragraph("x/d Cancel · z Restore draft before acceptance\nr Refine current draft (model call)\nm Model · c Cycle favorites\no Original · v Formatted/source\n↑↓ Scroll · PgUp/PgDn Page\nq/Esc Back · Enter won't send · ? Hide help");
      if (!options.canRestore) paragraph("Nothing to restore.", "muted");
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
      paragraph("Results appear here. Esc returns to editing; work continues.", "muted");
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
    const panelWidth = Math.min(width, READING_WIDTH);
    const inset = panelWidth >= 16 ? 2 : 0;
    const innerWidth = Math.max(1, panelWidth - inset * 2);
    const height = Math.max(1, Math.min(34, this.rows() - 4));
    const compact = height < 12;
    const heading = options.accepted
      ? `${theme.fg("success", theme.bold(`✓ Accepted · ${options.elapsedSeconds}s`))}  ${theme.fg("muted", "Prompt Refine")}`
      : resultHeading(options, theme);
    const header = [truncateToWidth(heading, innerWidth, "")];
    if (!compact) {
      const model = options.state.model;
      header.push(theme.fg("muted", truncateToWidth(sanitizeTerminalText(model ? `${model.provider}/${model.id}` : "No model"), innerWidth, "")));
      header.push(theme.fg("muted", truncateToWidth(sanitizeTerminalText(options.contextLabel), innerWidth, "")), "");
    }
    const key = (label: string) => theme.fg("accent", theme.bold(label));
    const ready = options.candidateText !== undefined;
    const primary = options.accepted
      ? `${key("r")} Refine draft${options.canRestore ? `  ${key("z")} Restore` : ""}`
      : ready
        ? `${key("a")} Accept  ${key("e")} Edit  ${options.state.pendingSend ? theme.fg("muted", "Send pending") : `${key("s")} Send`}  ${key("x")} Cancel`
        : `${key("r")} ${options.state.phase === "generating" ? "Restart" : "Refine"}  ${key("m")} Model  ${key("x")} Cancel`;
    const secondary = `${ready && !options.accepted ? `${key("r")} Refine  ` : ""}${ready ? `${key("o")} ${this.originalVisible ? "Hide original" : "Original"}  ` : ""}${key("?")} ${this.helpVisible ? "Hide help" : "Help"}  ${key("q/Esc")} Back`;
    const compactPrimary = options.accepted ? "r Refine draft" : ready
      ? options.state.pendingSend ? "a Accept · Send pending" : "a Accept · s Send"
      : "r Refine · m Model";
    const footer = innerWidth < 60
      ? [truncateToWidth(compactPrimary, innerWidth, ""), truncateToWidth("? Help · q Back", innerWidth, "")]
      : [primary, secondary];
    if (!compact) footer.push(theme.fg("muted", "↑↓ / PgUp/PgDn Scroll · Enter won't send"));
    const border = theme.fg("borderMuted", "─".repeat(innerWidth));
    // ScrollView owns offsets/clamping. Explicit viewport composition also works in regular
    // mode, where ScrollView.render() alone returns the entire document without clipping.
    const body = this.scroll.render(innerWidth);
    const chrome = header.length + footer.length + (compact ? 0 : 2);
    const bodyHeight = Math.max(1, height - chrome);
    this.scroll.updateLayout(body.length, bodyHeight, this.requestRender);
    if (this.revealOriginal) {
      this.scroll.scrollTo(this.originalLine);
      this.revealOriginal = false;
    }
    const start = this.scroll.scrollTop;
    const visible = body.slice(start, start + bodyHeight);
    if (body.length > bodyHeight && !compact) {
      footer[footer.length - 1] = theme.fg("muted", `↑↓ / PgUp/PgDn · ${start + 1}–${Math.min(body.length, start + bodyHeight)}/${body.length} lines · Enter won't send`);
    }
    const lines = [...header, ...visible, ...(!compact ? ["", border] : []), ...footer];
    // Tiny terminals degrade to a bounded view instead of exceeding the host viewport.
    return lines.slice(0, height).map((line) => " ".repeat(inset) + truncateToWidth(line, innerWidth, ""));
  }
}
