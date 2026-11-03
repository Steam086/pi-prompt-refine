import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { alignedHints, fittingHints } from "./panel-layout.js";

export type KeyHint = readonly [key: string, label: string];
type HintTheme = Pick<Theme, "fg" | "bold">;

/** Shared chrome: emphasize keys, never their descriptions. */
export function formatKeyHint([key, label]: KeyHint, theme: HintTheme, keyWidth = 1): string {
  const prefix = key ? theme.fg("text", theme.bold(key)) : "";
  const gap = key && label ? " ".repeat(Math.max(1, keyWidth - visibleWidth(key) + 1)) : "";
  return prefix + gap + (label ? theme.fg("muted", label) : "");
}

export function alignedKeyHints(rows: KeyHint[][], width: number, theme: HintTheme): string[] {
  return alignedHints(rows.map((row) => row.map((hint) => formatKeyHint(hint, theme))), width);
}

export function fittingKeyHints(hints: KeyHint[], width: number, theme: HintTheme): string {
  return fittingHints(hints.map((hint) => formatKeyHint(hint, theme)), width);
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
