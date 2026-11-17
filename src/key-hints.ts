import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { alignedHints, fittingHints } from "./panel-layout.js";

export type KeyHint = readonly [key: string, label: string];
type HintTheme = Pick<Theme, "fg" | "bold">;
type HintStyle = "primary" | "secondary";

/** Shared chrome: emphasize keys, never their descriptions; secondary hints use punctuation instead of weight. */
export function formatKeyHint([key, label]: KeyHint, theme: HintTheme, keyWidth = 1, style: HintStyle = "primary"): string {
  const prefix = key ? style === "secondary" ? theme.fg("muted", key + (label ? ":" : "")) : theme.fg("text", theme.bold(key)) : "";
  const gap = key && label ? " ".repeat(Math.max(1, keyWidth - visibleWidth(key) + 1)) : "";
  return prefix + gap + (label ? theme.fg("muted", label) : "");
}

export function alignedKeyHints(rows: KeyHint[][], width: number, theme: HintTheme): string[] {
  return alignedHints(rows.map((row) => row.map((hint) => formatKeyHint(hint, theme))), width, theme.fg("muted", " · "));
}

export function fittingKeyHints(hints: KeyHint[], width: number, theme: HintTheme, separator = " · ", style: HintStyle = "primary"): string {
  return fittingHints(hints.map((hint) => formatKeyHint(hint, theme, 1, style)), width, theme.fg("muted", separator));
}

/** Low-emphasis chrome: keep key/action pairs together, wrap rather than omit hints. */
export function wrappedKeyHints(hints: KeyHint[], width: number, theme: HintTheme): string[] {
  if (width < 1) return [];
  const separator = theme.fg("muted", " · ");
  const lines: string[] = [];
  let line = "";
  for (const [key, label] of hints) {
    const hint = formatKeyHint([key, label], theme, 1, "secondary");
    const next = line ? line + separator + hint : hint;
    if (visibleWidth(next) <= width) {
      line = next;
    } else {
      if (line) lines.push(line);
      const wrapped = wrapTextWithAnsi(hint, width);
      lines.push(...wrapped.slice(0, -1));
      line = wrapped.at(-1) ?? "";
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Fixed tab stops, measured in terminal columns (never literal tabs or ANSI length). */
export function keyHintGrid(
  hints: readonly KeyHint[], width: number, theme: Pick<Theme, "fg" | "bold">,
  keyWidth = 1, cellWidth = 22,
): string[] {
  if (width < 1) return [];
  const columns = Math.max(1, Math.floor((width + 2) / cellWidth));
  const lines: string[] = [];
  for (let start = 0; start < hints.length; start += columns) {
    const cells = hints.slice(start, start + columns).map((hint) => {
      const text = formatKeyHint(hint, theme, keyWidth);
      return text + " ".repeat(Math.max(0, cellWidth - visibleWidth(text)));
    });
    lines.push(truncateToWidth(cells.join("").trimEnd(), width, ""));
  }
  return lines;
}
