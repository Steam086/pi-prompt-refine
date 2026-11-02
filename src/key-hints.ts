import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

export type KeyHint = readonly [key: string, label: string];

/** Fixed tab stops, measured in terminal columns (never literal tabs or ANSI length). */
export function keyHintGrid(
  hints: readonly KeyHint[], width: number, theme: Pick<Theme, "fg" | "bold">,
  keyWidth = 1, cellWidth = 22,
): string[] {
  if (width < 1) return [];
  const columns = Math.max(1, Math.floor((width + 2) / cellWidth));
  const lines: string[] = [];
  for (let start = 0; start < hints.length; start += columns) {
    const cells = hints.slice(start, start + columns).map(([key, label]) => {
      const prefix = key + " ".repeat(Math.max(1, keyWidth - visibleWidth(key) + 1));
      const text = `${theme.fg("accent", theme.bold(key))}${prefix.slice(key.length)}${label}`;
      return text + " ".repeat(Math.max(0, cellWidth - visibleWidth(text)));
    });
    lines.push(truncateToWidth(cells.join("").trimEnd(), width, ""));
  }
  return lines;
}
