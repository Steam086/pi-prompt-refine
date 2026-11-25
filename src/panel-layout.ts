import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import { READING_WIDTH } from "./presentation.js";

/** Shared frame geometry. Explicit heights remain bounded by the terminal. */
export function panelLayout(width: number, rows: number, requestedHeight = Math.min(24, Math.max(12, Math.round(rows * 0.65)))) {
  const height = Math.max(1, Math.min(rows - 4, Math.round(requestedHeight)));
  return panelGeometry(width, height);
}

export function panelGeometry(width: number, height: number, maxWidth = READING_WIDTH, topSeparator = true, centered = false, horizontalPadding?: number) {
  const panelWidth = Math.max(1, Math.min(width, maxWidth));
  const padding = horizontalPadding ?? (panelWidth >= 16 ? 2 : 0);
  const inset = (centered ? Math.max(0, Math.floor((width - panelWidth) / 2)) : 0) + padding;
  const innerWidth = Math.max(1, panelWidth - padding * 2);
  const headerHeight = height >= 12 ? 2 : height >= 3 ? 1 : 0;
  const footerHeight = height >= 6 ? 2 : height >= 2 ? 1 : 0;
  const separatorHeight = height >= 12 ? 1 : 0;
  const topSeparatorHeight = topSeparator && height >= 4 ? 1 : 0;
  return { height, inset, innerWidth, headerHeight, footerHeight, separatorHeight, topSeparatorHeight,
    bodyHeight: height - topSeparatorHeight - headerHeight - footerHeight - separatorHeight };
}

export type PanelLayout = ReturnType<typeof panelLayout>;
export type PanelLayoutProvider = (width: number) => PanelLayout;

export const WORKSPACE_PAGES = ["Preview", "Usage", "Settings"] as const;
export type WorkspacePage = typeof WORKSPACE_PAGES[number];

/** Persistent page identity, unchanged when a child focus suspends page navigation. */
export function workspaceTabs(layout: PanelLayout, active: WorkspacePage, theme: Pick<Theme, "fg" | "bg" | "bold">): string[] {
  return panelTabs(layout, [...WORKSPACE_PAGES], WORKSPACE_PAGES.indexOf(active), theme);
}

export function panelTabs(layout: PanelLayout, labels: string[], active: number, theme: Pick<Theme, "fg" | "bg" | "bold">,
  selectedTab = (label: string) => theme.bg("selectedBg", theme.fg("text", theme.bold(` ${label} `)))): string[] {
  if (layout.bodyHeight < 4) return [];
  const tab = (label: string, index: number) => index === active
    ? selectedTab(label)
    : theme.fg("muted", ` ${label} `);
  const strip = labels.map(tab).join("  ");
  if (visibleWidth(strip) <= layout.innerWidth) return [strip];
  const label = labels[active]!;
  if (layout.innerWidth < 3) return [theme.fg("text", theme.bold(truncateToWidth(label, layout.innerWidth, "")))];
  return [selectedTab(stripVTControlCharacters(truncateToWidth(label, layout.innerWidth - 2, "…")))];
}

export function panelHeader(base: PanelLayout, headings: string[], tabs: string[] = [], hints: string[] = []) {
  const width = base.innerWidth;
  const gap = 3;
  const [title = "", status = ""] = headings;
  const titleWidth = visibleWidth(title);
  const statusWidth = visibleWidth(status);
  const header: string[] = [];
  if (base.headerHeight > 0 && titleWidth) header.push(title);
  let separateStatus = "";
  if (base.headerHeight > 1 && statusWidth) {
    if (titleWidth && titleWidth + gap + statusWidth <= width) header[0] += " ".repeat(gap) + status;
    else separateStatus = status;
  }
  const actions = hints.slice(0, base.footerHeight).filter((line) => visibleWidth(line) > 0);
  if (!tabs.length && separateStatus) header.push(separateStatus);
  header.push(...tabs);
  if (actions.length === 1) {
    const row = header.at(-1);
    const action = actions[0];
    if (row && action) {
      const padding = width - visibleWidth(row) - visibleWidth(action);
      if (padding >= gap) {
        header[header.length - 1] = row + " ".repeat(padding) + action;
        actions.shift();
      }
    }
  }
  if (tabs.length && separateStatus) header.push(separateStatus);
  header.push(...actions);
  const layout = { ...base, headerHeight: header.length, footerHeight: 0,
    bodyHeight: base.height - base.topSeparatorHeight - base.separatorHeight - header.length };
  return {
    layout,
    render: (body: readonly string[], border: (text: string) => string) =>
      panelFrame(layout, header, body, [], border, { footerAfterBodyRows: 0 }),
  };
}

/** Optionally lift action hints above content, after the body's leading tab rows. */
export function panelFrame(layout: PanelLayout, header: string[], body: readonly string[], footer: string[], border: (text: string) => string,
  options: { footerAfterBodyRows?: number } = {}): string[] {
  const reserve = (lines: readonly string[], count: number) => Array.from({ length: count }, (_, i) => lines[i] ?? "");
  const content = reserve(body, layout.bodyHeight);
  const hints = reserve(footer, layout.footerHeight);
  const separator = layout.separatorHeight ? [border("─".repeat(layout.innerWidth))] : [];
  const split = Math.max(0, Math.min(content.length, options.footerAfterBodyRows ?? content.length));
  const middle = options.footerAfterBodyRows === undefined
    ? [...content, ...separator, ...hints]
    : [...content.slice(0, split), ...hints, ...separator, ...content.slice(split)];
  return [
    ...(layout.topSeparatorHeight ? [border("─".repeat(layout.innerWidth))] : []),
    ...reserve(header, layout.headerHeight),
    ...middle,
  ].map((line) => " ".repeat(layout.inset) + truncateToWidth(line, layout.innerWidth, ""));
}

/** Shared terminal-column widths keep corresponding hints aligned across rows. */
export function alignedHints(rows: string[][], width: number, separator = " · "): string[] {
  const columns = Math.max(0, ...rows.map((row) => row.length));
  const selected: { index: number; width: number }[] = [];
  let used = 0;
  for (let index = 0; index < columns; index++) {
    const columnWidth = Math.max(...rows.map((row) => visibleWidth(row[index] ?? "")));
    const required = columnWidth + (selected.length ? visibleWidth(separator) : 0);
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
    }).join(separator);
  });
}

/** Omit secondary hints instead of wrapping chrome into the content viewport. */
export function fittingHints(hints: string[], width: number, separator = " · "): string {
  let line = "";
  for (const hint of hints) {
    const next = line ? `${line}${separator}${hint}` : hint;
    if (visibleWidth(next) <= width) line = next;
  }
  return line;
}
