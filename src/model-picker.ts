import { stripVTControlCharacters } from "node:util";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type SelectItem } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { sanitizeTerminalText } from "./presentation.js";
import { panelHeader, panelLayout, workspaceTabs, type PanelLayout } from "./panel-layout.js";
import { workspaceFrame, workspaceLayout, workspaceViewport } from "./workspace-overlay.js";
import { fittingKeyHints, operationHintRows, type KeyHint } from "./key-hints.js";

export type ModelChoice = SelectItem & { usedInTask?: boolean };

/** Render independently of SelectList's fixed label/description columns; keep its input behavior. */
export function renderModelChoices(
  items: ModelChoice[], selectedKey: string | undefined, width: number, height: number, theme: Theme,
): string[] {
  if (width < 1 || height < 1) return [];
  if (!items.length) return [truncateToWidth(theme.fg("warning", "No matching models"), width)];
  const selected = Math.max(0, items.findIndex((item) => item.value === selectedKey));
  const entries = new Map<number, string[]>();
  const entryAt = (index: number): string[] => {
    const cached = entries.get(index);
    if (cached) return cached;
    const item = items[index]!;
    const active = index === selected;
    const prefix = active ? "› " : "  ";
    const badges = [item.label?.includes(" [thinking]") && "Thinking capable", item.label?.endsWith(" (current)") && "Current",
      item.usedInTask && "This task"].filter(Boolean).map((badge) => ` · ${badge}`).join("");
    const name = sanitizeTerminalText(item.description || item.value);
    const compact = visibleWidth(prefix + name + badges) > width;
    // Clip before styling so truncation resets cannot interrupt emphasis or the selected surface.
    const label = stripVTControlCharacters(truncateToWidth(name, Math.max(1, width - 2)));
    const primary = theme.fg("accent", prefix) + theme.fg("text", active ? theme.bold(label) : label);
    const entry = [compact ? primary : primary + theme.fg("muted", badges),
      theme.fg("muted", sanitizeTerminalText(`  ${item.value}`))];
    if (compact && badges) entry.push(theme.fg("muted", `  ${badges.slice(3)}`));
    const lines = entry.map((line) => {
      const fitted = truncateToWidth(line, width);
      return active ? theme.bg("selectedBg", fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)))) : fitted;
    });
    entries.set(index, lines);
    return lines;
  };
  let count = Math.min(items.length, 10, Math.max(1, Math.floor(height / 2)));
  let lines: string[];
  let moreHeight: number;
  while (true) {
    const start = Math.max(0, Math.min(selected - Math.floor(count / 2), items.length - count));
    lines = Array.from({ length: count }, (_, i) => entryAt(start + i)).flat();
    moreHeight = items.length > count && height >= 3 ? 1 : 0;
    if (lines.length <= height - moreHeight || count === 1) break;
    count--;
  }
  const body = lines.slice(0, height - moreHeight);
  if (moreHeight) body.push(truncateToWidth(theme.fg("muted", `  ${selected + 1}/${items.length} · ↑↓ More models`), width));
  return body;
}

export interface ModelPickerOptions {
  items: ModelChoice[];
  selectedKey?: string;
  fromSettings?: boolean;
  title: string;
  subtitle: string;
  query: string;
  thinkingStatus: string;
  thinkingKeys: string;
  run: boolean;
}

function renderSettingsModelPicker(options: ModelPickerOptions, layout: PanelLayout, theme: Theme): string[] {
  const { innerWidth: width } = layout;
  const primary: KeyHint[] = [["Esc", width >= 10 ? "Cancel" : ""]];
  if (options.items.length) primary.push([width >= 24 ? "Enter" : "↵", "Save"]);
  const thinking: KeyHint | undefined = options.thinkingKeys ? [options.thinkingKeys, "Thinking"] : undefined;
  const hints = operationHintRows(primary, thinking, layout, theme);
  const fullTitle = sanitizeTerminalText(options.title);
  const title = visibleWidth(fullTitle) <= width ? fullTitle : "Optimizer model";
  const scope = "Saves only optimizer settings";
  const chrome = panelHeader(layout, [theme.fg("text", theme.bold(title)),
    visibleWidth(scope) <= width ? theme.fg("muted", scope) : ""], workspaceTabs(layout, "Settings", theme), hints);
  const height = chrome.layout.bodyHeight;
  const body: string[] = [];
  if (height >= 2 && width > 8) {
    const query = truncateToWidth(sanitizeTerminalText(options.query || "Type to filter"), width - 8, "…");
    body.push(theme.fg("muted", "Search: ") + theme.fg(options.query ? "text" : "muted", query));
  }
  if (options.items.length && height - body.length >= 3) {
    const status = sanitizeTerminalText(options.thinkingStatus).replace(/^Thinking level: /, "Thinking: ");
    body.push(theme.fg("muted", truncateToWidth(status, width, "…")));
  }
  const choices = renderModelChoices(options.items, options.selectedKey, width, height - body.length, theme);
  return chrome.render([...body, ...choices], (line) => theme.fg("borderMuted", line));
}

export function renderModelPicker(options: ModelPickerOptions, width: number, rows: number, theme: Theme,
  layout: PanelLayout = panelLayout(width, rows)): string[] {
  if (width < 1) return [];
  if (options.fromSettings) return renderSettingsModelPicker(options, layout, theme);
  const w = layout.innerWidth;
  const primary: KeyHint[] = [[w < 30 ? "↵" : "Enter", options.run ? "Run" : w < 30 ? "Use" : "Confirm"], ["↑↓", "Select"]];
  const secondary: KeyHint[] = [["Esc", w < 16 ? "" : "Cancel"], ...(options.thinkingKeys ? [[options.thinkingKeys, "Thinking"] as KeyHint] : [])];
  const hints = layout.footerHeight === 1
    ? [fittingKeyHints([secondary[0]!, ...primary, ...secondary.slice(1)], w, theme, w < 30 ? " " : " · ")]
    : [fittingKeyHints(primary, w, theme), fittingKeyHints(secondary, w, theme)];
  const chrome = panelHeader(layout, [theme.fg("text", theme.bold(sanitizeTerminalText(options.title))),
    theme.fg("muted", sanitizeTerminalText(options.subtitle))], [], hints);
  const h = chrome.layout.bodyHeight;
  const search = h >= 4 ? [theme.fg("muted", "Search: ") + theme.fg(options.query ? "text" : "muted",
    truncateToWidth(sanitizeTerminalText(options.query || "provider/model, name, or thinking"), Math.max(1, w - 8), "…"))] : [];
  const detailHeight = h >= 6 ? Math.min(3, Math.floor(h / 4)) : 0;
  const details = detailHeight ? wrapTextWithAnsi(sanitizeTerminalText(options.thinkingStatus), w) : [];
  const detail = details.slice(0, detailHeight).map((line, index) => theme.fg("muted",
    index === detailHeight - 1 && details.length > detailHeight ? truncateToWidth(line + " …", w, "…") : line));
  const gap = detail.length ? 1 : 0;
  const listHeight = Math.max(0, h - search.length - detail.length - gap);
  const list = renderModelChoices(options.items, options.selectedKey, w, listHeight, theme);
  return chrome.render([...search, ...list, ...(gap ? [""] : []), ...detail],
    (text) => theme.fg("borderMuted", text));
}

export function renderOverlayModelPicker(options: ModelPickerOptions, width: number, rows: number, theme: Theme): string[] {
  if (width < 1) return [];
  return workspaceFrame(width, rows, renderModelPicker(options, workspaceViewport(width, rows).width, rows, theme,
    workspaceLayout(width, rows)), theme);
}
