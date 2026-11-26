import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import { READING_WIDTH } from "./presentation.js";

/** Shared frame geometry. Explicit heights remain bounded by the terminal. */
export function panelLayout(width: number, rows: number, requestedHeight = Math.min(24, Math.max(12, Math.round(rows * 0.65)))) {
  const height = Math.max(1, Math.min(rows - 4, Math.round(requestedHeight)));
  return panelGeometry(width, height);
}

/** Compose inner geometry independently of inline-panel/overlay height policy. */
export function panelGeometry(width: number, height: number, maxWidth = READING_WIDTH, topSeparator = true, centered = false, horizontalPadding?: number) {
  const panelWidth = Math.max(1, Math.min(width, maxWidth));
  const padding = horizontalPadding ?? (panelWidth >= 16 ? 2 : 0);
  const inset = (centered ? Math.max(0, Math.floor((width - panelWidth) / 2)) : 0) + padding;
  const innerWidth = Math.max(1, panelWidth - padding * 2);
  const headerHeight = height >= 12 ? 2 : height >= 3 ? 1 : 0;
  const footerHeight = height >= 6 ? 2 : height >= 2 ? 1 : 0;
  const separatorHeight = height >= 12 ? 1 : 0;
  // Separate the workspace from the transcript, but preserve content in tiny terminals.
  const topSeparatorHeight = topSeparator && height >= 4 ? 1 : 0;
  return { height, inset, innerWidth, headerHeight, footerHeight, separatorHeight, topSeparatorHeight,
    bodyHeight: height - topSeparatorHeight - headerHeight - footerHeight - separatorHeight };
}

export type PanelLayout = ReturnType<typeof panelLayout>;
export type PanelLayoutProvider = (width: number) => PanelLayout;

export const WORKSPACE_PAGES = ["Preview", "Usage", "Settings"] as const;
export type WorkspacePage = typeof WORKSPACE_PAGES[number];

export function focusLabel(theme: Theme, width: number, label: string, active: boolean): string {
  const text = stripVTControlCharacters(truncateToWidth(active ? `› ${label}` : label, width, width > 2 ? "…" : ""));
  return active ? theme.bg("selectedBg", theme.fg("text", theme.bold(text))) : theme.fg("muted", text);
}

/** Persistent page identity, unchanged when a child focus suspends page navigation. */
export function workspaceTabs(layout: PanelLayout, active: WorkspacePage, theme: Pick<Theme, "fg" | "bg" | "bold">): string[] {
  const labels = layout.innerWidth >= 48 ? [...WORKSPACE_PAGES] : [active];
  return panelTabs(layout, labels, labels.indexOf(active), theme);
}

/** One row of tabs with a flat selection surface and quiet inactive labels. */
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

const HEADER_GAP = "   ";

/** Keep the headline to two rows. Give tabbed pages a stationary action strip below their content. */
export function panelHeader(base: PanelLayout, headings: string[], tabs: string[] = [], actions = "") {
  const width = base.innerWidth;
  const [title = "", status = ""] = headings;
  const [tab = ""] = tabs;
  const header: string[] = [];
  const titleWidth = visibleWidth(title);
  const statusWidth = base.headerHeight > 1 ? visibleWidth(status) : 0;
  const statusRoom = width - titleWidth - HEADER_GAP.length;
  const separateStatus = statusWidth > 0 && (!!tab || statusWidth > statusRoom);
  const showActions = base.footerHeight > 0 && visibleWidth(actions) > 0;
  const footer = showActions && (tab || separateStatus) ? [actions] : [];
  if (tab) {
    const room = width - visibleWidth(tab) - 2;
    const clipped = truncateToWidth(title, Math.max(0, room), "…");
    header.push(clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped) - visibleWidth(tab))) + tab);
    if (base.headerHeight > 1) header.push(status);
  } else {
    if (base.headerHeight > 0) header.push(!separateStatus && statusWidth ? title + HEADER_GAP + status : title);
    if (separateStatus) header.push(status);
    else if (showActions) header.push(actions);
  }
  const layout = { ...base, headerHeight: header.length, footerHeight: footer.length,
    bodyHeight: base.height - base.topSeparatorHeight - base.separatorHeight - header.length - footer.length };
  return {
    layout,
    render: (body: readonly string[], border: (text: string) => string) => panelFrame(layout, header, body, footer, border),
  };
}

/** Place a confirmation question and its keys together in the center of the existing frame. */
export function panelConfirmation(layout: PanelLayout, title: string, actions: string, details: readonly string[],
  border: (text: string) => string): string[] {
  const frame = { ...layout, headerHeight: 0, footerHeight: 0, separatorHeight: 0,
    bodyHeight: layout.height - layout.topSeparatorHeight };
  const height = frame.bodyHeight;
  const notes = height > 2 ? details.slice(0, height - 2) : [];
  const lines = (height === 1 ? [actions || title] : [title, ...notes, actions])
    .map((line) => truncateToWidth(line, layout.innerWidth, "…"));
  const top = Math.floor((height - lines.length) / 2);
  const blockWidth = Math.max(...lines.map((line) => visibleWidth(line)));
  const left = " ".repeat(Math.floor((layout.innerWidth - blockWidth) / 2));
  return panelFrame(frame, [], [...Array<string>(top).fill(""), ...lines.map((line) => left + line)], [], border);
}

function panelFrame(layout: PanelLayout, header: string[], body: readonly string[], footer: string[], border: (text: string) => string): string[] {
  const reserve = (lines: readonly string[], count: number) => Array.from({ length: count }, (_, i) => lines[i] ?? "");
  return [
    ...(layout.topSeparatorHeight ? [border("─".repeat(layout.innerWidth))] : []),
    ...reserve(header, layout.headerHeight),
    ...(layout.separatorHeight ? [border("─".repeat(layout.innerWidth))] : []),
    ...reserve(body, layout.bodyHeight),
    ...reserve(footer, layout.footerHeight),
  ].map((line) => " ".repeat(layout.inset) + truncateToWidth(line, layout.innerWidth, ""));
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
