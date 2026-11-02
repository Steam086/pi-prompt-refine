import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ControllerState } from "./controller.js";

/** Keep prose readable on wide terminals; widths are terminal columns, not characters. */
export const READING_WIDTH = 100;
export type PresentationTheme = Pick<Theme, "fg" | "bold">;
const plainTheme: PresentationTheme = { fg: (_color, text) => text, bold: (text) => text };

export function sanitizeTerminalText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\t/g, "    ")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "�");
}

export interface SummaryOptions {
  state: ControllerState;
  candidateText?: string;
  contextLabel: string;
  openHint: string;
  elapsedSeconds: number;
  errorLabel?: string;
}

export function resultHeading(options: SummaryOptions, theme: PresentationTheme): string {
  const { state } = options;
  const label = state.phase === "generating" ? `◌ 正在优化 · ${options.elapsedSeconds}s`
    : state.phase === "error" ? "! 优化未完成"
      : state.phase === "idle" ? "Prompt 优化"
        : state.pendingSend ? "◌ 等待发送确认" : "✓ 优化完成";
  const color = state.phase === "error" ? "warning" : state.phase === "ready" && !state.pendingSend ? "success" : "accent";
  return `${theme.fg(color, theme.bold(label))}  ${theme.fg("muted", "Prompt Refine")}`;
}

/** Passive, height-bounded preview: no input handler, focus changes, or editor writes. */
export function renderSummary(options: SummaryOptions, width: number, theme: PresentationTheme = plainTheme): string[] {
  if (width < 1 || options.state.phase === "idle") return [];
  const available = Math.min(width, READING_WIDTH);
  const inset = available >= 12 ? 2 : 0;
  const contentWidth = Math.max(1, available - inset);
  const lines = [resultHeading(options, theme)];
  lines.push(theme.fg("muted", truncateToWidth(sanitizeTerminalText(options.contextLabel), contentWidth)));
  lines.push("");
  if (options.state.phase === "ready" && options.candidateText) {
    const body = wrapTextWithAnsi(sanitizeTerminalText(options.candidateText), contentWidth);
    lines.push(...body.slice(0, 6).map((line) => theme.fg("text", line)));
    if (body.length > 6) lines.push(theme.fg("muted", "… 摘要已截断，打开面板查看完整结果"));
  } else {
    const message = options.state.phase === "error"
      ? options.errorLabel ?? "请求失败，请重试。"
      : "后台生成中，可继续编辑原稿。";
    lines.push(theme.fg(options.state.phase === "error" ? "warning" : "text", sanitizeTerminalText(message)));
  }
  lines.push("");
  const hint = options.state.pendingSend ? "主草稿保留 · 查看详情" : "查看结果与操作";
  lines.push(`${theme.fg("accent", theme.bold(sanitizeTerminalText(options.openHint)))}  ${theme.fg("muted", hint)}`);
  return lines.map((line, index) => {
    const prefix = inset ? (index >= 3 && index < lines.length - 2 ? `${theme.fg("borderMuted", "│")} ` : "  ") : "";
    return prefix + truncateToWidth(line, contentWidth);
  });
}
