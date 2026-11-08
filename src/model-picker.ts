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
  const moreHeight = items.length > 1 && height >= 2 ? 1 : 0;
  const count = Math.min(items.length, Math.max(1, Math.min(10, Math.floor((height - moreHeight) / 3))));
  const start = Math.max(0, Math.min(selected - Math.floor(count / 2), items.length - count));
  const lines: string[] = [];
  for (let i = start; i < start + count; i++) {
    const item = items[i]!;
    const active = i === selected;
    const prefix = active ? "› " : "  ";
    const badges = `${item.label?.includes(" [thinking]") ? " · Thinking capable" : ""}${item.label?.endsWith(" (current)") ? " · Current" : ""}`;
    // On narrow terminals keep badges separate so they never consume the model name's space.
    const name = sanitizeTerminalText(item.description || item.value);
    const compact = visibleWidth(prefix + name + badges) > width;
    const primary = theme.fg("accent", prefix) + theme.fg("text", truncateToWidth(name, Math.max(1, width - 2)));
    const entry = [compact ? primary : primary + theme.fg("muted", badges),
      theme.fg("muted", sanitizeTerminalText(`  ${item.value}`))];
    if (compact && badges) entry.push(theme.fg("muted", `  ${badges.slice(3)}`));
    for (const line of entry) {
      const fitted = truncateToWidth(line, width);
      lines.push(active ? theme.bg("selectedBg", fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)))) : fitted);
    }
  }
  const body = lines.slice(0, height - (items.length > count ? moreHeight : 0));
  if (items.length > count && moreHeight) body.push(truncateToWidth(theme.fg("muted", `  ${selected + 1}/${items.length} · ↑↓ More models`), width));
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
