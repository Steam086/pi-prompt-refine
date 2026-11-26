import { stripVTControlCharacters } from "node:util";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type SelectItem } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { sanitizeTerminalText } from "./presentation.js";
import { panelHeader, panelLayout, workspaceTabs, type PanelLayout } from "./panel-layout.js";
import { workspaceFrame, workspaceLayout, workspaceViewport } from "./workspace-overlay.js";
import { fittingKeyHints, type KeyHint } from "./key-hints.js";

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
    // On narrow terminals keep badges separate so they never consume the model name's space.
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
  // Fit actual two-/three-row entries, not a three-row reservation for every model.
  // Keep the selection centered and never cut a model unless even one cannot fit.
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

function formatThinkingStatus(status: string, width: number, theme: Theme, compact = false): string {
  const text = sanitizeTerminalText(status);
  const match = /^Thinking level: (\S+)(?= · |$)/.exec(text);
  if (!match) return theme.fg("muted", compact ? text.replace(/^Thinking level: /, "Thinking: ") : text);
  const level = match[1]!;
  const label = !compact && visibleWidth(`Thinking level: ${level}`) <= width ? "Thinking level: "
    : visibleWidth(`Thinking: ${level}`) <= width ? "Thinking: " : "";
  const value = (label ? theme.fg("muted", label) : "") + theme.fg("text", theme.bold(level));
  const note = text.slice(match[0].length);
  if (!note) return value;
  if (!compact) return value + theme.fg("muted", note);
  const room = width - visibleWidth(value);
  return room > 4 ? value + theme.fg("muted", truncateToWidth(note, room, "…")) : value;
}

function renderSettingsModelPicker(options: ModelPickerOptions, layout: PanelLayout, theme: Theme): string[] {
  const { innerWidth: width } = layout;
  const primary: KeyHint[] = [["Esc", width >= 10 ? "Cancel" : ""]];
  if (options.items.length) primary.push([width >= 24 ? "Enter" : "↵", "Save"]);
  if (options.thinkingKeys) primary.push([options.thinkingKeys, "Thinking"]);
  const tabs = workspaceTabs(layout, "Settings", theme);
  const hints = fittingKeyHints(primary, layout.innerWidth, theme, width < 27 ? " " : " · ");
  const fullTitle = sanitizeTerminalText(options.title);
  const title = visibleWidth(fullTitle) <= width ? fullTitle : "Optimizer model";
  const scope = "Saves only optimizer settings";
  const chrome = panelHeader(layout, [theme.fg("text", theme.bold(title)),
    visibleWidth(scope) <= width ? theme.fg("muted", scope) : ""], tabs, hints);
  const height = chrome.layout.bodyHeight;
  const body: string[] = [];
  if (height >= 2 && width > 8) {
    const query = truncateToWidth(sanitizeTerminalText(options.query || "Type to filter"), width - 8, "…");
    body.push(theme.fg("muted", "Search: ") + theme.fg(options.query ? "text" : "muted", query));
  }
  // Always leave space for the highlighted name and model ID before adding metadata.
  if (options.items.length && height - body.length >= 3) {
    const status = formatThinkingStatus(options.thinkingStatus, width, theme, true);
    body.push(truncateToWidth(status, width, "…"));
  }
  const choices = renderModelChoices(options.items, options.selectedKey, width, height - body.length, theme);
  return chrome.render([...body, ...choices], (line) => theme.fg("borderMuted", line));
}

/** Budget actual content rows inside the same bounded frame as the workspace. */
export function renderModelPicker(options: ModelPickerOptions, width: number, rows: number, theme: Theme,
  layout: PanelLayout = panelLayout(width, rows)): string[] {
  if (width < 1) return [];
  if (options.fromSettings) return renderSettingsModelPicker(options, layout, theme);
  const w = layout.innerWidth;
  const primary: KeyHint[] = [[w < 30 ? "↵" : "Enter", options.run ? "Run" : w < 30 ? "Use" : "Confirm"], ["↑↓", "Select"]];
  const secondary: KeyHint[] = [["Esc", w < 16 ? "" : "Cancel"], ...(options.thinkingKeys ? [[options.thinkingKeys, "Thinking"] as KeyHint] : [])];
  const hints = fittingKeyHints([secondary[0]!, ...primary, ...secondary.slice(1)], w, theme, w < 30 ? " " : " · ");
  const chrome = panelHeader(layout, [theme.fg("text", theme.bold(sanitizeTerminalText(options.title))),
    theme.fg("muted", sanitizeTerminalText(options.subtitle))], [], hints);
  const h = chrome.layout.bodyHeight;
  const search = h >= 4 ? [theme.fg("muted", "Search: ") + theme.fg(options.query ? "text" : "muted",
    truncateToWidth(sanitizeTerminalText(options.query || "provider/model, name, or thinking"), Math.max(1, w - 8), "…"))] : [];
  const detailHeight = h >= 6 ? Math.min(3, Math.floor(h / 4)) : 0;
  const details = detailHeight ? wrapTextWithAnsi(formatThinkingStatus(options.thinkingStatus, w, theme), w) : [];
  const detail = details.slice(0, detailHeight);
  const lastDetail = detail.at(-1);
  if (lastDetail !== undefined && details.length > detailHeight && visibleWidth(lastDetail) + 2 <= w) {
    detail[detail.length - 1] = lastDetail + theme.fg("muted", " …");
  }
  const gap = detail.length ? 1 : 0;
  const listHeight = Math.max(0, h - search.length - detail.length - gap);
  const list = renderModelChoices(options.items, options.selectedKey, w, listHeight, theme);
  return chrome.render([...search, ...list, ...(gap ? [""] : []), ...detail],
    (text) => theme.fg("borderMuted", text));
}

/** Model selection shares the workspace shell, including when embedded as a child page. */
export function renderOverlayModelPicker(options: ModelPickerOptions, width: number, rows: number, theme: Theme): string[] {
  if (width < 1) return [];
  return workspaceFrame(width, rows, renderModelPicker(options, workspaceViewport(width, rows).width, rows, theme,
    workspaceLayout(width, rows)), theme);
}
