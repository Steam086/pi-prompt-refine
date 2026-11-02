import { truncateToWidth, visibleWidth, type SelectItem } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

/** Render independently of SelectList's fixed label/description columns; keep its input behavior. */
export function renderModelChoices(
  items: SelectItem[], selectedKey: string | undefined, width: number, rows: number, theme: Theme,
): string[] {
  if (width < 1) return [];
  if (!items.length) return [truncateToWidth(theme.fg("warning", "No matching models"), width)];
  const selected = Math.max(0, items.findIndex((item) => item.value === selectedKey));
  const count = Math.min(items.length, Math.max(1, Math.min(10, Math.floor((rows - 16) / 3))));
  const start = Math.max(0, Math.min(selected - Math.floor(count / 2), items.length - count));
  const lines: string[] = [];
  for (let i = start; i < start + count; i++) {
    const item = items[i]!;
    const active = i === selected;
    const prefix = active ? "→ " : "  ";
    const badges = `${item.label?.includes(" [thinking]") ? " · Thinking capable" : ""}${item.label?.endsWith(" (current)") ? " · Current" : ""}`;
    // On narrow terminals keep badges separate so they never consume the model name's space.
    const name = item.description || item.value;
    const compact = visibleWidth(prefix + name + badges) > width;
    const primary = prefix + theme.bold(truncateToWidth(name, Math.max(1, width - 2)));
    const entry = [compact ? primary : primary + theme.fg("muted", badges),
      theme.fg("muted", `  ${item.value}`)];
    if (compact && badges) entry.push(theme.fg("muted", `  ${badges.slice(3)}`));
    for (const line of entry) {
      const fitted = truncateToWidth(line, width);
      lines.push(active ? theme.bg("selectedBg", fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)))) : fitted);
    }
  }
  if (items.length > count) lines.push(truncateToWidth(theme.fg("dim", `  ${selected + 1}/${items.length} · ↑↓ More models`), width));
  return lines;
}
