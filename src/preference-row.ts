import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { sanitizeTerminalText } from "./presentation.js";
import type { RevisionPreference } from "./revision-preferences.js";

interface PreferenceRow {
  width: number;
  name: string;
  scope: RevisionPreference["scope"];
  selected: boolean;
  selectionEditable?: boolean;
  focused: boolean;
  cursor: "›" | "·" | " ";
  warning?: string;
  showStatus?: boolean;
  prefixColor?: "text" | "muted";
  projectDefault?: boolean;
}

/** Shared list cell, independent of inline saves or the child panel's pending selection. */
export function renderPreferenceRow(row: PreferenceRow, theme: Pick<Theme, "fg" | "bg" | "bold">): string {
  const { width, focused, warning } = row;
  if (width < 1) return "";
  // Reserve the source first, even for long names or tiny panes. Both list hosts
  // choose full labels by their actual pane width, not the outer window width.
  const fullSource = width >= 28;
  const sourceWidth = fullSource ? (row.scope === "builtin" ? 8 : 7) : 1;
  const sourceGap = width >= sourceWidth + 2 ? 1 : 0;
  const contentWidth = width - sourceWidth - sourceGap;
  const checkbox = row.selected ? "[x]" : row.selectionEditable === false ? "   " : "[ ]";
  const prefixColor = row.prefixColor ?? "muted";
  let prefix: string;
  if (contentWidth >= (warning ? 8 : 6) + 1) {
    prefix = theme.fg(prefixColor, `${row.cursor} ${checkbox} `)
      + (warning ? theme.fg("warning", "! ") : "");
  } else if (contentWidth >= (warning ? 5 : 4) + 1) {
    prefix = theme.fg(prefixColor, `${row.cursor}${checkbox}`)
      + (warning ? theme.fg("warning", "!") : "");
  } else if (contentWidth >= 4 && !warning && (row.selected || row.selectionEditable !== false)) {
    prefix = theme.fg(prefixColor, checkbox);
  } else {
    prefix = contentWidth >= (warning ? 3 : 2) ? theme.fg(prefixColor, row.cursor) : "";
    if (warning && contentWidth > 0) prefix += theme.fg("warning", "!");
  }
  // A default marker describes future drafts independently of this row's checkbox.
  if (row.projectDefault && contentWidth - visibleWidth(prefix) >= 3) prefix += theme.fg("muted", "* ");
  const name = sanitizeTerminalText(row.name).replace(/\n/g, " ");
  const status = warning && row.showStatus !== false ? ` · ${sanitizeTerminalText(warning)}` : "";
  const nameWidth = Math.max(0, contentWidth - visibleWidth(prefix));
  const label = truncateToWidth(name, nameWidth, "…");
  const content = prefix + theme.fg("text", focused ? theme.bold(label) : label)
    + (visibleWidth(name + status) <= nameWidth && status ? theme.fg("muted", status) : "");
  const scopeLabel = { project: "Project", global: "Global", builtin: "Built-in" }[row.scope];
  const source = fullSource ? scopeLabel : scopeLabel[0];
  const cell = content + " ".repeat(Math.max(0, contentWidth - visibleWidth(content)) + sourceGap)
    + theme.fg("muted", source.padStart(sourceWidth));
  return focused ? theme.bg("selectedBg", cell) : cell;
}
