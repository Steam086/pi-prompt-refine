import { Markdown, ScrollView, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type MarkdownTheme } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { fittingKeyHints, formatKeyHint, type KeyHint } from "./key-hints.js";
import { panelFrame, panelLayout } from "./panel-layout.js";
import { formatTokenUsage } from "./usage.js";
import { resultHeading, sanitizeTerminalText, type SummaryOptions } from "./presentation.js";

export interface PreviewOptions extends SummaryOptions {
  draft?: string;
  revisionInstruction?: string;
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
  private draftDocument = new Text("", 0, 0);
  private revisionDocument = new Text("", 0, 0);
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
    const changed = options.state.requestId !== this.options.state.requestId || options.state.phase !== this.options.state.phase ||
      options.candidateText !== this.options.candidateText;
    const textChanged = options.candidateText !== this.options.candidateText || options.draft !== this.options.draft ||
      options.revisionInstruction !== this.options.revisionInstruction;
    if (options.state.requestId !== this.options.state.requestId) this.helpVisible = false;
    if (options.state.requestId !== this.options.state.requestId ||
      (this.options.state.phase === "generating" && options.state.phase !== "generating")) {
      this.originalVisible = false;
      this.revealOriginal = false;
    }
    this.options = options;
    if (textChanged) this.rebuildDocument();
    else this.cachedBody = undefined;
    if (changed) this.scroll.scrollToStart();
  }

  setNotice(notice: string): void { this.options = { ...this.options, notice }; }

  toggleOriginal(): void {
    // The source is already the main document while generating or after a failed request.
    if (this.options.draft === undefined || this.options.candidateText === undefined) return;
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
    this.draftDocument = new Text(sanitizeTerminalText(this.options.draft ?? ""), 0, 0);
    this.revisionDocument = new Text(sanitizeTerminalText(this.options.revisionInstruction ?? ""), 0, 0);
    const text = sanitizeTerminalText(this.options.candidateText ?? "");
    this.document = this.sourceVisible ? new Text(text, 0, 0) : new Markdown(
      text, 0, 0, markdownTheme(this.theme), { color: (value) => this.theme.fg("text", value) },
      { preserveOrderedListMarkers: true, preserveBackslashEscapes: true, renderLatex: false },
    );
    this.cachedBody = undefined;
  }

  private isEmptyState(): boolean {
    return this.options.state.phase === "idle" && this.options.candidateText === undefined &&
      !this.options.accepted && !this.options.state.pendingSend && !this.helpVisible;
  }

  private hasActionableCandidate(): boolean {
    return this.options.candidateText !== undefined && !this.options.accepted &&
      !this.options.state.pendingSend && this.options.state.phase !== "generating";
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
      if (options.accepted) paragraph("Read-only snapshot; a/e/f/s disabled.\nEdit or send from the main editor.");
      const helpLine = (...items: KeyHint[]) => lines.push(...wrapTextWithAnsi(items.map((hint) => formatKeyHint(hint, theme)).join(" · "), width));
      if (this.hasActionableCandidate()) {
        helpLine(["a", "Accept into editor (no send)"], ["e", "Edit candidate (no model call)"]);
        helpLine(["f", "Revise current result with new instructions (model call)"]);
        helpLine(["s", "Send (follow-up if busy; draft kept)"]);
      }
      helpLine(["x/d", "Stop request / discard result (not just close)"]);
      helpLine(["z", "Restore draft before acceptance"]);
      lines.push("", theme.fg("muted", "Refine & navigate"));
      helpLine(["r", "Refine current draft (model call)"]);
      helpLine(["m", "Model"], ["c", "Cycle favorites"]);
      helpLine(["o", "Original"], ["v", "Formatted/source"]);
      helpLine(["↑↓", "Scroll"], ["PgUp/PgDn", "Page"]);
      helpLine(["i", "Input"], ["→", "Settings (← discards unsaved context)"]);
      helpLine(["q", "Back"], ["?", "Hide help"]);
      paragraph("Enter won't send", "muted");
      if (!options.canRestore) paragraph("Nothing to restore.", "muted");
      const model = options.state.model;
      paragraph(model ? `Model: ${model.provider}/${model.id}` : "No model", "muted");
      paragraph(options.contextLabel, "muted");
      lines.push("");
    }
    if (options.candidateText !== undefined) {
      if (options.state.phase === "error") {
        paragraph(`Revision failed; previous result kept. ${options.errorLabel ?? "Try again with f Revise."}`, "warning");
        lines.push("");
      }
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
      if (this.hasActionableCandidate() && !this.helpVisible) {
        paragraph("Accept puts the result in the editor; s sends directly.", "muted");
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
        lines.push(...this.draftDocument.render(width));
      }
    } else if (options.state.phase === "generating" || options.state.phase === "error") {
      if (options.state.phase === "error") {
        paragraph(options.errorLabel ?? "Request failed. Retry.", "warning");
        paragraph("Draft unchanged.", "muted");
        lines.push("");
      } else if (width >= 60) {
        paragraph("q returns to editing; work continues.", "muted");
        lines.push("");
      }
      if (options.draftChanged) {
        paragraph(width >= 60
          ? "Main editor differs; this request excludes its current edits."
          : "Editor differs; source below.", "warning");
      }
      if (options.draft !== undefined) {
        // Literal request snapshot, not a live editor preview or Markdown interpretation.
        // The existing bounded ScrollView exposes every line without growing the panel.
        const title = options.revisionInstruction !== undefined ? "Original task" : "Submitted original";
        lines.push(theme.fg("accent", theme.bold(width >= 40 ? `${title} · ${options.draft.length} chars` : title)));
        lines.push(...this.draftDocument.render(width));
        if (options.revisionInstruction !== undefined) {
          lines.push("", theme.fg("accent", theme.bold("Submitted revision instruction")));
          lines.push(...this.revisionDocument.render(width));
        }
      } else if (options.state.phase === "generating") {
        paragraph("Refining your prompt.");
      }
    } else {
      const needsModel = this.isEmptyState() && !options.state.model;
      paragraph(needsModel ? "No model selected" : "No result yet.");
      if (this.isEmptyState()) {
        const model = options.state.model;
        paragraph(model ? `${model.provider}/${model.id}` : "Choose one with m or /refine model.", "muted");
      }
    }
    if (options.state.pendingSend) {
      lines.push("");
      paragraph("Send pending Pi confirmation. Draft kept; don't resubmit.", "warning");
    }
    const bounded = lines.map((line) => truncateToWidth(line, width, ""));
    this.cachedBody = { width, lines: bounded };
    return bounded;
  }

  render(width: number, tabs?: string): string[] {
    if (width < 1) return [];
    const { theme, options } = this;
    const layout = panelLayout(width, this.rows());
    const { innerWidth, bodyHeight } = layout;
    const heading = options.accepted
      ? theme.fg("success", theme.bold(`✓ Accepted · ${options.elapsedSeconds}s`))
      : options.state.phase === "idle" ? "" : resultHeading(options, theme, false);
    const header = [truncateToWidth(tabs ?? theme.fg("accent", theme.bold("Prompt Refine")), innerWidth, "")];
    const model = options.state.model;
    // Idle has no request context to describe; details remain available in Help.
    const metadata = sanitizeTerminalText([
      model ? `${model.provider}/${model.id}` : "No model",
      ...(options.state.phase !== "idle" || options.accepted ? [options.contextLabel] : []),
    ].join(" · "));
    const status = this.isEmptyState() ? "" : [heading, theme.fg("muted", metadata)].filter(Boolean).join(" · ");
    header.push(options.notice ? theme.fg("muted", sanitizeTerminalText(options.notice)) : status);
    // Keep the main decision visible; secondary actions remain available in Help.
    // Pending/generating states take priority even if a previous candidate is retained.
    const primary: KeyHint[] = options.state.pendingSend
      ? [["", "Send pending"]]
      : options.state.phase === "generating"
        ? [["x", "Stop"]]
        : options.accepted
          ? [["r", "Refine draft"], ...(options.canRestore ? [["z", "Restore"] as KeyHint] : [])]
          : this.hasActionableCandidate()
            ? [["a", "Accept"], ["e", "Edit"], ["f", "Revise"]]
            : [["r", options.state.phase === "error" ? "Retry" : "Refine"], ["m", "Model"], ["i", "Input"]];
    const secondary: KeyHint[] = [["q", "Back"], ["?", this.helpVisible ? "Hide help" : "Help"]];
    // Independent rows keep long primary labels from crowding out Back/Help.
    const footer = [fittingKeyHints(primary, innerWidth, theme), fittingKeyHints(secondary, innerWidth, theme)];
    if (layout.footerHeight === 1) footer[0] = fittingKeyHints([...secondary, ...primary], innerWidth, theme);
    // ScrollView owns offsets/clamping. Explicit viewport composition also works in regular
    // mode, where ScrollView.render() alone returns the entire document without clipping.
    const body = this.scroll.render(innerWidth);
    this.scroll.updateLayout(body.length, bodyHeight, this.requestRender);
    if (this.revealOriginal) {
      this.scroll.scrollTo(this.originalLine);
      this.revealOriginal = false;
    }
    const start = this.scroll.scrollTop;
    let visible = body.slice(start, start + bodyHeight);
    if (this.isEmptyState() && body.length <= bodyHeight) {
      // Treat the empty message and its model as one quiet block, away from navigation.
      visible = [
        ...Array<string>(Math.floor((bodyHeight - body.length) / 2)).fill(""),
        ...visible.map((line) => " ".repeat(Math.max(0, Math.floor((innerWidth - visibleWidth(line)) / 2))) + line),
      ];
    }
    if (body.length > bodyHeight) {
      const position = `↑↓ ${start + 1}–${Math.min(body.length, start + bodyHeight)}/${body.length}`;
      // Position is secondary to notices; scrolling must not hide request feedback.
      header[1] = options.notice
        ? theme.fg("muted", `${sanitizeTerminalText(options.notice)} · ${position}`)
        : options.state.phase === "generating"
          ? [heading, theme.fg("muted", position), theme.fg("muted", metadata)].filter(Boolean).join(" · ")
          : [theme.fg("muted", position), status].filter(Boolean).join(" · ");
    }
    if (layout.headerHeight === 1 && options.state.phase === "generating") {
      header[0] = heading;
    }
    if (options.state.pendingSend) {
      // Delivery is not completion. Keep this visible even at the end of a long result.
      header[1] = `${theme.fg("warning", "Send pending · draft kept")} · ${header[1]}`;
      if (layout.headerHeight === 1) header[0] = theme.fg("warning", "Send pending · draft kept");
    }
    return panelFrame(layout, header, visible, footer, (text) => theme.fg("borderMuted", text));
  }
}
