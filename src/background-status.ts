import type { RefineRecord } from "./history.js";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatKeyHint } from "./key-hints.js";
import { READING_WIDTH, sanitizeTerminalText, type PresentationTheme } from "./presentation.js";

export interface BackgroundSummary {
  running: number;
  queued: number;
  newResults: number;
  failed: number;
  /** Longest running request, or the sole unseen result when nothing is running. */
  elapsedSeconds?: number;
  openHint: string;
}

/** Session-local attention state, separate from acceptance and persisted history. */
export class BackgroundStatus {
  private sessionId?: string;
  private seen = new Set<number>();

  update(sessionId: string, records: RefineRecord[], workspaceOpen: boolean, openHint: string): BackgroundSummary | undefined {
    if (sessionId !== this.sessionId) {
      this.sessionId = sessionId;
      this.seen.clear();
    }
    const current = records.filter((record) => record.archivedAt === undefined && !record.input.contextUnavailable);
    const ids = new Set(current.map((record) => record.id));
    this.seen = new Set([...this.seen].filter((id) => ids.has(id)));
    const completed = current.filter((record) => record.status === "generated" || record.status === "error");
    if (workspaceOpen) {
      for (const record of completed) this.seen.add(record.id);
      return undefined;
    }
    const unseen = completed.filter((record) => !this.seen.has(record.id) && record.kind !== "edit" &&
      record.acceptedAt === undefined && record.sentAt === undefined);
    // Archived requests can still be running; keep their count and timing together.
    const running = records.filter((record) => record.status === "generating");
    const results = unseen.filter((record) => record.status === "generated");
    const timed = running.length ? running : results.length === 1 ? results : [];
    const durations = timed.map((record) => record.elapsedSeconds)
      .filter((seconds): seconds is number => seconds !== undefined && Number.isFinite(seconds) && seconds >= 0);
    const summary: BackgroundSummary = {
      running: running.length,
      queued: records.filter((record) => record.status === "queued").length,
      newResults: results.length,
      failed: unseen.filter((record) => record.status === "error").length,
      elapsedSeconds: durations.length ? Math.floor(Math.max(...durations)) : undefined,
      openHint,
    };
    return summary.running || summary.queued || summary.newResults || summary.failed ? summary : undefined;
  }
}

/** A single line above the editor, independent of the host's footer and other statuses. */
export function renderBackgroundStatus(status: BackgroundSummary, width: number, theme: PresentationTheme): string[] {
  if (width < 1) return [];
  const available = Math.min(width, READING_WIDTH);
  const separator = theme.fg("muted", " · ");
  const brand = theme.fg("text", theme.bold("Refine"));
  const key = sanitizeTerminalText(status.openHint).replace(/\n/g, " ").trim();
  const open = formatKeyHint([key, "Open"], theme);
  const entries = ([
    { count: status.running, label: "running", compact: "run", color: "accent", priority: 4 },
    { count: status.queued, label: "queued", compact: "queue", color: "muted", priority: 1 },
    { count: status.newResults, label: "new", compact: "new", color: "success", priority: 2 },
    { count: status.failed, label: "failed", compact: "fail", color: "error", priority: 3 },
  ] as const).filter((entry) => entry.count > 0);
  const renderEntries = (elapsed: boolean, compact = false) => entries.map((entry) => {
    const text = theme.fg(entry.color, `${entry.count} ${compact ? entry.compact : entry.label}`);
    const timed = entry.label === "running" || (entry.label === "new" && !status.running && status.newResults === 1);
    return text + (elapsed && timed && status.elapsedSeconds !== undefined
      ? theme.fg(entry.label === "running" ? "accent" : "muted", ` ${status.elapsedSeconds}s`) : "");
  });
  const fit = (parts: string[], joiner = separator): string[] | undefined => {
    const line = parts.join(joiner);
    const columns = visibleWidth(line);
    if (columns > available) return undefined;
    const inset = columns + 4 <= available ? 2 : 0;
    return [" ".repeat(inset) + line];
  };
  // Time and branding yield first; keep complete state counts and the open hint.
  const untimed = renderEntries(false);
  const compact = renderEntries(false, true);
  for (const parts of [[brand, ...renderEntries(true), open], [brand, ...untimed, open], [...untimed, open], [...compact, open]]) {
    const fitted = fit(parts);
    if (fitted) return fitted;
  }
  // When even compact counts cannot fit, retain the most relevant state, without
  // rotating or cutting labels. Running > failed > new > queued.
  let retained = entries.map((entry, index) => ({ ...entry, text: compact[index]! }));
  for (const entry of [...retained].sort((a, b) => a.priority - b.priority)) {
    if (retained.length <= 1) break;
    retained = retained.filter((item) => item !== entry);
    const fitted = fit([...retained.map((item) => item.text), open]);
    if (fitted) return fitted;
  }
  const keyOnly = formatKeyHint([key, ""], theme);
  const primary = retained.map((entry) => entry.text);
  return fit([...primary, open], " ") ?? fit([...primary, keyOnly]) ?? fit([...primary, keyOnly], " ") ??
    [truncateToWidth(keyOnly, available, "")];
}
