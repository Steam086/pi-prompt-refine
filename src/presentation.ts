import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ControllerState } from "./controller.js";
import { formatTokenUsage } from "./usage.js";

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

export function resultHeading(options: SummaryOptions, theme: PresentationTheme, includeBrand = true): string {
  const { state } = options;
  const time = `${options.elapsedSeconds}s`;
  const label = state.phase === "generating" ? `◌ Refining · ${time}`
    : state.phase === "error" ? `! Failed · ${time}`
      : state.phase === "idle" ? "Refine"
        : state.pendingSend ? `◌ Send pending · ${time}` : `✓ Done · ${time}`;
  const color = state.phase === "error" ? "warning" : state.phase === "ready" && !state.pendingSend ? "success" : "accent";
  const status = theme.fg(color, theme.bold(label));
  return includeBrand ? `${status} · ${theme.fg("muted", "Prompt Refine")}` : status;
}

/** Passive, height-bounded preview: no input handler, focus changes, or editor writes. */
export function renderSummary(options: SummaryOptions, width: number, theme: PresentationTheme = plainTheme): string[] {
  if (width < 1 || (options.state.phase === "idle" && !options.state.runningCount && !options.state.queuedCount)) return [];
  const available = Math.min(width, READING_WIDTH);
  const inset = available >= 16 ? 2 : 0;
  const contentWidth = Math.max(1, available - inset * 2);
  const lines = [`${theme.fg("text", theme.bold("Prompt refine"))} · ${resultHeading(options, theme, false)}`];
  if (options.state.queuedCount || (options.state.runningCount && (options.state.phase !== "generating" || options.state.runningCount > 1))) {
    lines.push(theme.fg("muted", `${options.state.runningCount ?? 0} running · ${options.state.queuedCount ?? 0} queued`));
  }
  lines.push(theme.fg("muted", truncateToWidth(sanitizeTerminalText(options.contextLabel), contentWidth, "")));
  lines.push("");
  if (options.state.phase === "ready" && options.candidateText) {
    const body = wrapTextWithAnsi(sanitizeTerminalText(options.candidateText), contentWidth);
    lines.push(...body.slice(0, 6).map((line) => theme.fg("text", line)));
    if (body.length > 6) lines.push(theme.fg("muted", "Open for full prompt"));
  } else {
    const message = options.state.phase === "error"
      ? options.errorLabel ?? "Request failed. Retry."
      : "Working in background. Keep editing.";
    lines.push(...wrapTextWithAnsi(sanitizeTerminalText(message), contentWidth).slice(0, 2)
      .map((line) => theme.fg(options.state.phase === "error" ? "warning" : "muted", line)));
  }
  const usageLabel = formatTokenUsage(options.state.usage);
  if (usageLabel && options.state.phase !== "generating") {
    lines.push("", theme.fg("muted", truncateToWidth(usageLabel, contentWidth, "")));
  }
  lines.push("");
  const hint = options.state.pendingSend ? "View · draft kept" : "View";
  lines.push(`${theme.fg("text", theme.bold(sanitizeTerminalText(options.openHint)))} ${theme.fg("muted", hint)}`);
  const prefix = " ".repeat(inset);
  const separator = prefix + theme.fg("borderMuted", "─".repeat(contentWidth));
  const content = lines.map((line) => prefix + truncateToWidth(line, contentWidth, ""));
  return [separator, ...content, separator];
}
