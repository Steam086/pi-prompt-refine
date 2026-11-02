import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { READING_WIDTH } from "./presentation.js";

/** One geometry for reading, settings and input; only terminal resize changes it. */
export function panelLayout(width: number, rows: number) {
  const height = Math.max(1, Math.min(rows - 4, 24, Math.max(12, Math.round(rows * 0.65))));
  const panelWidth = Math.max(1, Math.min(width, READING_WIDTH));
  const inset = panelWidth >= 16 ? 2 : 0;
  const innerWidth = Math.max(1, panelWidth - inset * 2);
  const headerHeight = height >= 12 ? 2 : height >= 3 ? 1 : 0;
  const footerHeight = height >= 6 ? 2 : height >= 2 ? 1 : 0;
  const separatorHeight = height >= 12 ? 1 : 0;
  return { height, inset, innerWidth, headerHeight, footerHeight, separatorHeight,
    bodyHeight: height - headerHeight - footerHeight - separatorHeight };
}

export type PanelLayout = ReturnType<typeof panelLayout>;

export function panelFrame(layout: PanelLayout, header: string[], body: string[], footer: string[], border: (text: string) => string): string[] {
  const reserve = (lines: string[], count: number) => Array.from({ length: count }, (_, i) => lines[i] ?? "");
  return [
    ...reserve(header, layout.headerHeight),
    ...reserve(body, layout.bodyHeight),
    ...(layout.separatorHeight ? [border("─".repeat(layout.innerWidth))] : []),
    ...reserve(footer, layout.footerHeight),
  ].map((line) => " ".repeat(layout.inset) + truncateToWidth(line, layout.innerWidth, ""));
}

/** Omit secondary hints instead of wrapping chrome into the content viewport. */
export function fittingHints(hints: string[], width: number): string {
  let line = "";
  for (const hint of hints) {
    const next = line ? `${line} · ${hint}` : hint;
    if (visibleWidth(next) <= width) line = next;
  }
  return line;
}
