import { Markdown, ScrollView, Text, truncateToWidth, wrapTextWithAnsi, type Component, type MarkdownTheme } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { READING_WIDTH, resultHeading, sanitizeTerminalText, type SummaryOptions } from "./presentation.js";

export interface PreviewOptions extends SummaryOptions {
  draft?: string;
  canRestore: boolean;
  /** An accepted snapshot is read-only, not an actionable candidate. */
  accepted?: { editorChanged: boolean };
  draftChanged?: boolean;
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
    if (this.helpVisible) {
      paragraph("操作说明", "muted");
      if (options.accepted) paragraph("已接受结果仅供查看；a/e/s 不操作历史快照。\n请返回主输入框继续编辑或发送当前草稿。");
      else paragraph("a 接受到输入框（不发送） · e 微调候选\ns 发送候选（忙时 follow-up，保留主草稿）");
      paragraph("x/d 取消任务与候选 · z 恢复上次接受前的草稿\nr 重新优化当前输入框（调用模型）\nm 选择模型 · c 收藏循环\no 展开/收起原稿 · v 排版/纯文本\n↑↓ 逐行 · PgUp/PgDn 翻页\nq/Esc 返回 · Enter 不发送 · ? 收起帮助");
      if (!options.canRestore) paragraph("暂无可恢复的接受记录。", "muted");
      lines.push("");
    }
    if (options.candidateText !== undefined) {
      if (options.accepted) {
        paragraph(options.accepted.editorChanged
          ? "主输入框已修改。下方是上次接受的结果，不包含后续微调。"
          : "结果已在主输入框。查看不会调用模型，也不会覆盖草稿。", options.accepted.editorChanged ? "warning" : "muted");
        paragraph("q 返回继续编辑 · r 使用当前输入框重新优化", "muted");
        lines.push("");
      } else if (options.draftChanged) {
        paragraph("主输入框已修改；此候选仍基于触发时草稿。", "warning");
        lines.push("");
      }
      const title = options.accepted ? "上次接受的 Prompt · 只读快照" : "优化后的 Prompt";
      lines.push(theme.fg("accent", theme.bold(`${title}${this.sourceVisible ? " · 纯文本" : ""}`)), "");
      lines.push(...this.document.render(width));
      if (this.originalVisible && options.draft !== undefined) {
        this.originalLine = lines.length;
        lines.push("", theme.fg("borderMuted", "─".repeat(width)), "");
        paragraph("原始草稿 · 触发时", "muted");
        lines.push("");
        // Keep the comparison literal and legible, rather than dimming its body.
        lines.push(...new Text(sanitizeTerminalText(options.draft), 0, 0).render(width));
      }
    } else if (options.state.phase === "generating") {
      paragraph("正在整理你的 Prompt…");
      lines.push("");
      paragraph("完成后会在这里显示结果。\nEsc 返回继续编辑，不会取消后台任务。", "muted");
    } else if (options.state.phase === "error") {
      paragraph(options.errorLabel ?? "请求失败，请重试。", "warning");
      lines.push("");
      paragraph("原始草稿未修改。按 r 重试，或 m 更换模型。", "muted");
    } else {
      paragraph("当前没有可预览的结果。");
      lines.push("");
      paragraph("按 r 优化当前草稿，或 m 选择模型。", "muted");
    }
    if (options.state.pendingSend) {
      lines.push("");
      paragraph("发送待 Pi 确认；主草稿保留，请勿重复提交。", "warning");
    }
    const bounded = lines.map((line) => truncateToWidth(line, width));
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
      ? `${theme.fg("success", theme.bold("✓ 已接受到输入框"))}  ${theme.fg("muted", "Prompt Refine")}`
      : resultHeading(options, theme);
    const header = [truncateToWidth(heading, innerWidth)];
    if (!compact) {
      const model = options.state.model;
      header.push(theme.fg("muted", truncateToWidth(sanitizeTerminalText(model ? `${model.provider}/${model.id}` : "未配置模型"), innerWidth)));
      header.push(theme.fg("muted", truncateToWidth(sanitizeTerminalText(options.contextLabel), innerWidth)), "");
    }
    const key = (label: string) => theme.fg("accent", theme.bold(label));
    const ready = options.candidateText !== undefined;
    const primary = options.accepted
      ? `${key("r")} 优化当前草稿${options.canRestore ? `  ${key("z")} 恢复接受前草稿` : ""}`
      : ready
        ? `${key("a")} 接受  ${key("e")} 微调  ${options.state.pendingSend ? theme.fg("muted", "发送待确认") : `${key("s")} 发送`}  ${key("x")} 取消`
        : `${key("r")} ${options.state.phase === "generating" ? "重新优化" : "优化当前草稿"}  ${key("m")} 模型  ${key("x")} 取消`;
    const secondary = `${ready && !options.accepted ? `${key("r")} 优化当前草稿  ` : ""}${ready ? `${key("o")} ${this.originalVisible ? "收起原稿" : "查看原稿"}  ` : ""}${key("?")} ${this.helpVisible ? "收起帮助" : "更多操作"}  ${key("q/Esc")} 返回`;
    const compactPrimary = options.accepted ? "r 优化当前草稿" : ready
      ? options.state.pendingSend ? "a 接受 · 发送待确认" : "a 接受 · s 发送"
      : "r 优化 · m 模型";
    const footer = innerWidth < 40
      ? [truncateToWidth(compactPrimary, innerWidth), truncateToWidth("? 帮助 · q 返回", innerWidth)]
      : [primary, secondary];
    if (!compact) footer.push(theme.fg("muted", "↑↓ / PgUp/PgDn 滚动 · Enter 不发送"));
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
      footer[footer.length - 1] = theme.fg("muted", `↑↓ / PgUp/PgDn · ${start + 1}–${Math.min(body.length, start + bodyHeight)} / ${body.length} 行 · Enter 不发送`);
    }
    const lines = [...header, ...visible, ...(!compact ? ["", border] : []), ...footer];
    // Tiny terminals degrade to a bounded view instead of exceeding the host viewport.
    return lines.slice(0, height).map((line) => " ".repeat(inset) + truncateToWidth(line, innerWidth));
  }
}
