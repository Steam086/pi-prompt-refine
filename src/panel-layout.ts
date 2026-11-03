import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
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
  // Separate the workspace from the transcript, but preserve content in tiny terminals.
  const topSeparatorHeight = height >= 4 ? 1 : 0;
  return { height, inset, innerWidth, headerHeight, footerHeight, separatorHeight, topSeparatorHeight,
    bodyHeight: height - topSeparatorHeight - headerHeight - footerHeight - separatorHeight };
}

export type PanelLayout = ReturnType<typeof panelLayout>;

export const WORKSPACE_PAGES = ["Preview", "History", "Usage", "Settings"] as const;
export type WorkspacePage = typeof WORKSPACE_PAGES[number];

/** One persistent top-level strip; compact terminals retain the active page and arrows. */
export function workspaceTabs(layout: PanelLayout, active: WorkspacePage, theme: Pick<Theme, "fg" | "bg" | "bold">): string[] {
  const arrows = layout.innerWidth >= 8;
  const tabs = panelTabs({ ...layout, innerWidth: Math.max(1, layout.innerWidth - (arrows ? 4 : 0)) }, [...WORKSPACE_PAGES], WORKSPACE_PAGES.indexOf(active), theme);
  return tabs.map((line) => line && arrows ? `${theme.fg("muted", "←")} ${line} ${theme.fg("muted", "→")}` : line);
}

/** Shared group strip: reserve the same rows on reading and settings pages. */
export function panelTabs(layout: PanelLayout, labels: string[], active: number, theme: Pick<Theme, "fg" | "bg" | "bold">): string[] {
  if (layout.bodyHeight < 4) return [];
  const tab = (label: string, index: number) => index === active
    ? theme.bg("toolPendingBg", theme.fg("text", theme.bold(` ${label} `)))
    : theme.fg("muted", ` ${label} `);
  const strip = labels.map(tab).join("  ");
  const line = visibleWidth(strip) <= layout.innerWidth ? strip : tab(labels[active]!, active);
  return layout.bodyHeight >= 8 ? ["", line, ""] : [line];
}

export function panelFrame(layout: PanelLayout, header: string[], body: string[], footer: string[], border: (text: string) => string): string[] {
  const reserve = (lines: string[], count: number) => Array.from({ length: count }, (_, i) => lines[i] ?? "");
  return [
    ...(layout.topSeparatorHeight ? [border("─".repeat(layout.innerWidth))] : []),
    ...reserve(header, layout.headerHeight),
    ...reserve(body, layout.bodyHeight),
    ...(layout.separatorHeight ? [border("─".repeat(layout.innerWidth))] : []),
    ...reserve(footer, layout.footerHeight),
  ].map((line) => " ".repeat(layout.inset) + truncateToWidth(line, layout.innerWidth, ""));
}

/** Shared terminal-column widths keep corresponding hints aligned across rows. */
export function alignedHints(rows: string[][], width: number): string[] {
  const columns = Math.max(0, ...rows.map((row) => row.length));
  const selected: { index: number; width: number }[] = [];
  let used = 0;
  for (let index = 0; index < columns; index++) {
    const columnWidth = Math.max(...rows.map((row) => visibleWidth(row[index] ?? "")));
    const required = columnWidth + (selected.length ? 3 : 0);
    if (used + required > width) continue;
    selected.push({ index, width: columnWidth });
    used += required;
  }
  return rows.map((row) => {
    let last = selected.length - 1;
    while (last >= 0 && !row[selected[last].index]) last--;
    return selected.slice(0, last + 1).map((column, i) => {
      const cell = row[column.index] ?? "";
      return cell + (i < last ? " ".repeat(column.width - visibleWidth(cell)) : "");
    }).join(" · ");
  });
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
