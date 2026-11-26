import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { alignedHints, fittingHints, type PanelLayout } from "./panel-layout.js";

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

export function alignedKeyHints(rows: KeyHint[][], width: number, theme: HintTheme): string[] {
  return alignedHints(rows.map((row) => row.map((hint) => formatKeyHint(hint, theme))), width, theme.fg("muted", " · "));
}

export function fittingKeyHints(hints: KeyHint[], width: number, theme: HintTheme, separator = " · ", style: HintStyle = "primary"): string {
  return fittingHints(hints.map((hint) => formatKeyHint(hint, theme, 1, style)), width, theme.fg("muted", separator));
}

/** Operation pages keep Back and the primary action together, with one optional hint. */
export function operationHintRows(primary: KeyHint[], secondary: KeyHint | undefined, layout: PanelLayout, theme: HintTheme): string[] {
  const { innerWidth: width, footerHeight } = layout;
  if (!footerHeight) return [];
  const first = fittingKeyHints(primary, width, theme);
  if (!first) return [];
  if (!secondary || first !== fittingKeyHints(primary, Number.POSITIVE_INFINITY, theme)) return [first];
  const extra = formatKeyHint(secondary, theme);
  const combined = first + theme.fg("muted", " · ") + extra;
  if (visibleWidth(combined) <= width) return [combined];
  return footerHeight > 1 && visibleWidth(extra) <= width ? [first, extra] : [first];
}

export function discardHintRows(layout: PanelLayout, theme: HintTheme): string[] {
  const { innerWidth: width } = layout;
  return operationHintRows([["Esc", width >= 28 ? "Keep editing" : width >= 20 ? "Keep" : ""],
    ["y", width >= 15 ? "Discard" : ""]], undefined, layout, theme);
}

/** Low-emphasis chrome: keep key/action pairs together, wrap rather than omit hints. */
export function wrappedKeyHints(hints: KeyHint[], width: number, theme: HintTheme, compact = false, gap = " · "): string[] {
  if (width < 1) return [];
  const separator = theme.fg("muted", compact && width < 30 ? " " : gap);
  const lines: string[] = [];
  let line = "";
  for (const [key, label] of hints) {
    const hint = formatKeyHint([key, label], theme, 1, compact ? "secondary-compact" : "secondary");
    if (compact && visibleWidth(hint) > width) continue;
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

/** Top browsing chrome consumes at most two rows and always leaves room for content. */
export function passiveHintLayout(layout: PanelLayout, tabRows: number, hints: KeyHint[], compact: KeyHint[], theme: HintTheme) {
  const budget = Math.max(0, Math.min(layout.footerHeight, layout.bodyHeight + layout.footerHeight - tabRows - 1));
  const width = layout.innerWidth;
  const fitsWholePairs = hints.every((hint) => visibleWidth(formatKeyHint(hint, theme, 1, "secondary")) <= width);
  const wrapped = fitsWholePairs ? wrappedKeyHints(hints, width, theme, false, "  ") : undefined;
  const footer = !budget ? [] : wrapped && wrapped.length <= budget ? wrapped
    : wrappedKeyHints(compact, width, theme, true).slice(0, budget);
  return { layout: { ...layout, bodyHeight: layout.bodyHeight + layout.footerHeight - footer.length, footerHeight: footer.length }, footer };
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
