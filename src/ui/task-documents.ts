import type { Theme } from "@earendil-works/pi-coding-agent";
import type { HistoryStorageStatus } from "../history-store.js";
import { panelFrame, type PanelLayout } from "../panel-layout.js";
import { fittingKeyHints, formatKeyHint, type KeyHint } from "../key-hints.js";
import { sanitizeTerminalText } from "../presentation.js";
import { truncatedOutputHint } from "../usage.js";
import { pending, type TaskContent, type TaskRow } from "./task-content.js";

interface TaskDocumentOptions {
  row?: TaskRow;
  storage?: () => HistoryStorageStatus;
  notice: string;
  noticeColor: "muted" | "warning" | "error";
  inspecting: boolean;
  reading: boolean;
  retainedEarlier: boolean;
  usage: boolean;
  compareId?: number;
  inline: boolean;
  preferences: boolean;
  revise: boolean;
  deleteRecords: boolean;
  expansion?: KeyHint;
}

/** Help and storage are read-only documents; the panel retains their scroll anchor. */
export function renderTaskDocument(
  layout: PanelLayout, page: { kind: "help" | "storage"; scroll: number },
  options: TaskDocumentOptions, theme: Theme, content: TaskContent,
): { lines: string[]; scroll: number; viewport: number } {
  const body: string[] = [];
  let title = "Available actions";
  if (page.kind === "storage") {
    title = "History storage";
    const status = options.storage!();
    const labels: Record<HistoryStorageStatus["state"], string> = {
      disabled: "Disabled by historyPersistence=false", "no-session-file": "No session file · memory only",
      unavailable: "History writer not initialized · reload to enable saving", empty: status.memoryOnlyIds.length ? "Enabled · no saved snapshot yet" : "Enabled · no savable records yet",
      saving: "Saving… · pending records are not confirmed on disk", saved: "Saved",
      "load-error": "Load failed · existing file kept · saving paused until reload",
      "save-error": "Save failed · saving paused until reload", cleared: "Cleared · saving paused until reload",
      "clear-error": "Could not clear file · saving paused until reload",
    };
    const failed = status.state.endsWith("error");
    const warning = ["cleared", "disabled", "no-session-file", "unavailable"].includes(status.state);
    const summary = theme.fg(failed ? "error" : warning ? "warning" : "muted", labels[status.state])
      + (status.memoryOnlyIds.length ? theme.fg("warning", ` · ${status.memoryOnlyIds.length} memory-only / pending`) : "")
      + (status.omittedIds.length ? theme.fg("warning", ` · ${status.omittedIds.length} capacity omissions`) : "");
    body.push(summary,
      "", content.heading("File"), theme.fg("text", sanitizeTerminalText(status.path ?? "Not available")),
      "", content.heading("Confirmed saved runs"), content.muted(status.savedIds.map((id) => `#${id}`).join(", ") || "None"),
      "", content.heading("Memory-only / pending runs"), theme.fg(status.memoryOnlyIds.length ? "warning" : "muted", status.memoryOnlyIds.map((id) => `#${id}`).join(", ") || "None"),
      "", content.heading("Capacity omissions"), theme.fg(status.omittedIds.length ? "warning" : "muted", status.omittedIds.map((id) => `#${id}`).join(", ") || "None"),
      "", content.muted("Memory-only includes changes to previously saved runs whose latest state is not saved yet. Unsent drafts are not saved. Limit: 100 runs / 2 MiB. Minimal prompts/results only; full background is not saved."));
  } else {
    const row = options.row;
    if (options.notice) body.push(content.heading("Feedback"), theme.fg(options.noticeColor, sanitizeTerminalText(options.notice)), "");
    if (row) {
      body.push(content.heading(row.original ? "Original prompt" : `Run #${row.record.id} · ${row.record.input.model.id}`));
      if (row.record.error) body.push(theme.fg("error", sanitizeTerminalText(`Error: ${row.record.error}`)));
      if (row.record.error === "truncated") body.push(theme.fg("warning", truncatedOutputHint(row.record.usage)));
    }
    body.push(content.muted(`Focus: ${options.inspecting || options.reading ? "Reading · ↑↓ scroll" : "List · ↑↓ select"}`), "");
    const hints: KeyHint[] = [["Esc", "Back"], ["?", "Available actions and full feedback"]];
    const expansion = options.expansion;
    if (expansion) hints.push(expansion);
    const inline = options.inline;
    if (!options.inspecting) hints.push(["Enter", row?.original && row.record.status === "unsent" && (options.usage || row.record.archivedAt === undefined) ? "Optimize from original focus" : "Inspect"], ...(!options.retainedEarlier ? [["Tab", inline ? "List / Preferences" : options.reading ? "Select" : "Read"] as KeyHint] : []), ["n", "New"]);
    if (inline) hints.push(["Tab / Shift+Tab", "Enter preferences; return to tasks without changing selections"], ["Space", "Toggle at Preferences focus; saved immediately"], ["Enter", "Optimize this Unsent at Preferences focus; search/read never submit"], ["o", "Read original or full preference at its focus"], ["/", "Search at Preferences focus"]);
    if (options.preferences) hints.push(["p", inline ? "Manage / more; Alt+Enter brings back child changes" : "Preferences"]);
    if (row) {
      hints.push(["i", row.record.input.contextUnavailable ? "Copy to current" : "Edit original"]);
      if (!row.record.input.contextUnavailable) hints.push(["m", "Run model"]);
      if (!row.original && pending(row.record)) hints.push(["x", "Stop"]);
      if (!row.original && row.record.candidate) {
        hints.push(["a", "Accept"]);
        if (!row.record.input.contextUnavailable && options.revise) hints.push(["f", "Revise"]);
        if (options.inspecting) {
          hints.push(["e", "Edit result"], ["s", "Send to Pi"], ["o", "Switch result/reference"]);
          if (row.records.some((record) => record.id !== row.record.id && record.candidate)) hints.push(["c", options.compareId === undefined ? "Compare" : "Next comparison"]);
          if (options.compareId !== undefined) hints.push(["Tab", "Switch compared result"]);
        }
      }
      if (options.deleteRecords) hints.push(["d", "Delete"]);
    }
    if (!options.usage) body.push(content.muted("Preview shows the current round. Usage contains current and historical records; → opens Usage after leaving Preferences."), "");
    else body.push(content.muted("All rounds: current prompts, Earlier records, results and usage details. Restored records have no reusable background."), "");
    if (options.usage && options.storage) hints.push(["b", "History storage status and file location"]);
    body.push(...hints.map((hint) => formatKeyHint(hint, theme)), "", content.muted("Read-only help. Return with Esc before using these actions."));
  }
  const lines = content.wrapped(body.join("\n"), layout.innerWidth);
  const viewport = Math.max(1, layout.bodyHeight);
  const scroll = Math.min(page.scroll, Math.max(0, lines.length - viewport));
  const footer = [fittingKeyHints([["Esc", "Back"], ["↑↓", "Scroll"]], layout.innerWidth, theme)];
  return { lines: panelFrame(layout, [content.heading(title), content.muted(`${scroll + 1}–${Math.min(lines.length, scroll + viewport)} / ${lines.length} lines`)],
    lines.slice(scroll, scroll + viewport), footer, (text) => content.muted(text), { footerAfterBodyRows: 0 }), scroll, viewport };
}
