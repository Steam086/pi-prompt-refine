import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type SelectItem } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { sanitizeTerminalText } from "./presentation.js";
import { panelFrame, panelLayout } from "./panel-layout.js";
import { fittingKeyHints, type KeyHint } from "./key-hints.js";

/** Render independently of SelectList's fixed label/description columns; keep its input behavior. */
export function renderModelChoices(
  items: SelectItem[], selectedKey: string | undefined, width: number, height: number, theme: Theme,
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
    const badges = `${item.label?.includes(" [thinking]") ? " · Thinking capable" : ""}${item.label?.endsWith(" (current)") ? " · Current" : ""}`;
    // On narrow terminals keep badges separate so they never consume the model name's space.
    const name = sanitizeTerminalText(item.description || item.value);
    const compact = visibleWidth(prefix + name + badges) > width;
    const primary = theme.fg("accent", prefix) + theme.fg("text", truncateToWidth(name, Math.max(1, width - 2)));
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
    moreHeight = items.length > count && height >= 2 ? 1 : 0;
    if (lines.length <= height - moreHeight || count === 1) break;
    count--;
  }
  const body = lines.slice(0, height - moreHeight);
  if (moreHeight) body.push(truncateToWidth(theme.fg("muted", `  ${selected + 1}/${items.length} · ↑↓ More models`), width));
  return body;
}

export interface ModelPickerOptions {
  items: SelectItem[];
  selectedKey?: string;
  title: string;
  subtitle: string;
  query: string;
  thinkingStatus: string;
  thinkingKeys: string;
  run: boolean;
}

/** Budget actual content rows inside the same bounded frame as the workspace. */
export function renderModelPicker(options: ModelPickerOptions, width: number, rows: number, theme: Theme): string[] {
  if (width < 1) return [];
  const layout = panelLayout(width, rows);
  const w = layout.innerWidth, h = layout.bodyHeight;
  const search = h >= 4 ? [theme.fg("muted", "Search: ") + theme.fg(options.query ? "text" : "muted",
    truncateToWidth(sanitizeTerminalText(options.query || "provider/model, name, or thinking"), Math.max(1, w - 8), "…"))] : [];
  const detailHeight = h >= 6 ? Math.min(3, Math.floor(h / 4)) : 0;
  const details = detailHeight ? wrapTextWithAnsi(sanitizeTerminalText(options.thinkingStatus), w) : [];
  const detail = details.slice(0, detailHeight).map((line, index) => theme.fg("muted",
    index === detailHeight - 1 && details.length > detailHeight ? truncateToWidth(line + " …", w, "…") : line));
  const gap = detail.length ? 1 : 0;
  const listHeight = Math.max(0, h - search.length - detail.length - gap);
  const list = renderModelChoices(options.items, options.selectedKey, w, listHeight, theme);
  const primary: KeyHint[] = [[w < 30 ? "↵" : "Enter", options.run ? "Run" : w < 30 ? "Use" : "Confirm"], ["↑↓", "Select"]];
  const secondary: KeyHint[] = [["Esc", w < 16 ? "" : "Cancel"], ...(options.thinkingKeys ? [[options.thinkingKeys, "Thinking"] as KeyHint] : [])];
  const footer = [fittingKeyHints(primary, w, theme), fittingKeyHints(secondary, w, theme)];
  if (layout.footerHeight === 1) footer[0] = fittingKeyHints([secondary[0]!, primary[0]!, ...primary.slice(1), ...secondary.slice(1)], w, theme, w < 30 ? " " : " · ");
  return panelFrame(layout, [theme.fg("text", theme.bold(sanitizeTerminalText(options.title))), theme.fg("muted", sanitizeTerminalText(options.subtitle))],
    [...search, ...Array.from({ length: listHeight }, (_, i) => list[i] ?? ""), ...(gap ? [""] : []), ...detail], footer,
    (text) => theme.fg("borderMuted", text));
}
