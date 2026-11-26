import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { fittingHints } from "./panel-layout.js";

export type KeyHint = readonly [key: string, label: string];
type HintTheme = Pick<Theme, "fg" | "bold">;
type HintStyle = "primary" | "secondary" | "secondary-compact";

/** Shared chrome: emphasize keys, never their descriptions; secondary hints use punctuation instead of weight. */
export function formatKeyHint([key, label]: KeyHint, theme: HintTheme, keyWidth = 1, style: HintStyle = "primary"): string {
  const prefix = !key ? "" : style === "primary" ? theme.fg("text", theme.bold(key))
    : theme.fg("muted", key + (style === "secondary" && label ? ":" : ""));
  const gap = key && label ? " ".repeat(Math.max(1, keyWidth - visibleWidth(key) + 1)) : "";
  return prefix + gap + (label ? theme.fg("muted", label) : "");
}

export function fittingKeyHints(hints: KeyHint[], width: number, theme: HintTheme, separator = " · ", style: HintStyle = "primary"): string {
  return fittingHints(hints.map((hint) => formatKeyHint(hint, theme, 1, style)), width, theme.fg("muted", separator));
}

export function confirmationKeyHints(cancel: KeyHint, confirm: KeyHint, width: number, theme: HintTheme): string {
  const full = fittingKeyHints([cancel, confirm], Infinity, theme);
  if (visibleWidth(full) <= width) return full;
  const short = fittingKeyHints([["Esc", ""], confirm], Infinity, theme, " ");
  return visibleWidth(short) <= width ? short : fittingKeyHints([["Esc", ""], [confirm[0], ""]], width, theme, " ");
}

export function discardKeyHints(width: number, theme: HintTheme): string {
  return confirmationKeyHints(["Esc", width >= 29 ? "Keep editing" : "Keep"], ["y", "Discard"], width, theme);
}

export function passiveHeaderHints(hints: KeyHint[], compact: KeyHint[], width: number, theme: HintTheme): string {
  return width >= 40 ? fittingKeyHints(hints, width, theme, "  ", "secondary")
    : fittingKeyHints(compact, width, theme, width < 30 ? " " : " · ", "secondary-compact");
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
