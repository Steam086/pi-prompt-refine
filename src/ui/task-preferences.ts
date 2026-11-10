import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { panelFrame, type PanelLayout } from "../panel-layout.js";
import { fittingKeyHints, formatKeyHint, type KeyHint } from "../key-hints.js";
import { sanitizeTerminalText } from "../presentation.js";
import type { InlinePreferences } from "../inline-preferences.js";
import type { TaskContent, TaskRow } from "./task-content.js";

/** Inactive checklist shares the pane without changing its reading identity. */
export function renderInactivePreferences(
  inline: InlinePreferences, width: number, height: number, originalHeight: number,
  renderOriginal: (height: number) => string[],
): string[] {
  const reserved = height < 9 ? 1 : Math.min(7, Math.max(5, Math.floor(height / 2)));
  const bounded = Math.min(originalHeight, Math.max(0, height - reserved - 1));
  const original = bounded > 0 ? renderOriginal(bounded) : [];
  // Short originals return their unused rows to the checklist.
  return [...original, ...(original.length ? [""] : []), ...inline.render(width, height - original.length - (original.length ? 1 : 0))];
}

/** Selection temporarily replaces the task tree; references never gain an action focus. */
export function renderTaskPreferences(
  row: TaskRow, inline: InlinePreferences, layout: PanelLayout, tabs: string[], theme: Theme,
  content: TaskContent, renderOriginal: (width: number, height: number) => string[], expansion?: KeyHint,
): string[] {
  const width = layout.innerWidth;
  const height = Math.max(1, layout.bodyHeight - tabs.length);
  const mode = inline.hints;
  const warning = inline.warning;
  const showInlineWarning = layout.headerHeight === 0;
  let body: string[];
  if (width >= 72 && mode !== "read") {
    const leftWidth = Math.min(48, Math.floor(width / 3));
    const rightWidth = width - leftWidth - 3;
    const choices = inline.render(leftWidth, height, showInlineWarning, false);
    const feedbackHeight = Math.min(height, Math.max(2, Math.min(5, Math.floor(height * 0.25))));
    // Bound the original so the highlighted instructions own the reading space.
    // Short originals return their unused rows; checked names stay compact.
    const originalHeight = Math.min(6, Math.max(0, Math.floor((height - feedbackHeight) / 3)));
    const original = originalHeight ? renderOriginal(rightWidth, originalHeight) : [];
    const preview = inline.renderPreview(rightWidth, Math.max(0, height - feedbackHeight - original.length - (original.length ? 1 : 0) - 1));
    const selected = row.record.input.preferences ?? [];
    const feedback = [content.muted(`Selected · ${selected.length}`)];
    const room = Math.min(feedbackHeight, height - original.length - (original.length ? 1 : 0)
      - preview.length - (preview.length ? 1 : 0)) - feedback.length;
    if (!selected.length && room > 0) feedback.push(content.muted("None yet"));
    else if (room > 0) {
      // Keep newly appended selections visible without changing composition order.
      const count = Math.min(selected.length, Math.max(0, room - (selected.length > room ? 1 : 0)));
      if (count < selected.length) feedback.push(content.muted(`… ${selected.length - count} more`));
      for (const item of count ? selected.slice(-count) : []) {
        feedback.push(truncateToWidth(content.muted("· ") + theme.fg("text", sanitizeTerminalText(item.name).replace(/\s+/gu, " ")), rightWidth, "…"));
      }
    }
    const reference = [...original, ...(original.length ? [""] : []), ...preview, ...(preview.length ? [""] : []), ...feedback];
    body = Array.from({ length: height }, (_, i) => {
      const line = choices[i] ?? "";
      return line + " ".repeat(Math.max(0, leftWidth - visibleWidth(line))) + content.muted(" │ ") + (reference[i] ?? "");
    });
  } else {
    // Reading uses the full width. Narrow selection prioritizes choices over references.
    const summary = mode !== "read" && height >= 8
      ? [truncateToWidth(content.muted("Original: ") + theme.fg("text", sanitizeTerminalText(row.record.input.draft).replace(/\s+/gu, " ")), width, "…")] : [];
    body = [...summary, ...inline.render(width, height - summary.length, showInlineWarning)];
  }
  const back: KeyHint = ["Esc", width < 8 ? "" : mode === "select" ? width < 40 ? "Back" : "Back to tasks"
    : mode === "search" ? width < 40 ? "Back" : "End search" : width < 40 ? "Back" : "Back to preferences"];
  const submit: KeyHint = [width < 16 ? "↵" : "Enter", width < 10 ? "Start" : "Optimize"];
  const primary: KeyHint[] = mode === "select" ? [back, submit]
    : mode === "search" ? [back, ["Enter", "Results"]] : [back, ["↑↓", "Scroll"]];
  const secondary: KeyHint[] = mode === "select"
    ? [["Space", "Toggle"], ["c", "Clear all"], ["Tab", "Back"], ["o", "Read"], ["↑↓", "Choose"], ["/", "Search"], ["p", "Manage"]] : [];
  if (expansion) secondary.push(expansion);
  const pairFits = visibleWidth(formatKeyHint(primary[0]!, theme) + " · " + formatKeyHint(primary[1]!, theme)) <= width;
  const header = [content.heading("Choose preferences"), content.muted(`Focus: Preferences${mode === "search" ? " · Search" : mode === "read" ? " · Read-only" : ""}`)];
  const footer = layout.footerHeight > 1 && !pairFits
    ? [fittingKeyHints([back], width, theme), fittingKeyHints([...primary.slice(1), ...secondary], width, theme)]
    : [fittingKeyHints(primary, width, theme), fittingKeyHints(secondary, width, theme)];
  if (layout.footerHeight === 1) footer[0] = fittingKeyHints([...primary, ...secondary], width, theme);
  if (layout.footerHeight === 1 && mode === "select" && !pairFits && layout.headerHeight > 0) {
    // Keep both action meanings, rather than dropping Optimize in short/narrow frames.
    header[layout.headerHeight - 1] = formatKeyHint(submit, theme);
  }
  if (warning && layout.headerHeight > 0) header[layout.headerHeight - 1] = theme.fg("warning", sanitizeTerminalText(`⚠ ${warning}`));
  return panelFrame(layout, header, [...tabs, ...body], footer, (text) => content.muted(text), { footerAfterBodyRows: tabs.length });
}
