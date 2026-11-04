import type { RefineRecord } from "./history.js";
import { sanitizeTerminalText } from "./presentation.js";

/** Session-local attention state, separate from acceptance and persisted history. */
export class BackgroundStatus {
  private sessionId?: string;
  private seen = new Set<number>();

  update(sessionId: string, records: RefineRecord[], workspaceOpen: boolean, openHint: string): string | undefined {
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
    const counts: [number, string][] = [
      [records.filter((record) => record.status === "generating").length, "running"],
      [records.filter((record) => record.status === "queued").length, "queued"],
      [unseen.filter((record) => record.status === "generated").length, "new results"],
      [unseen.filter((record) => record.status === "error").length, "failed"],
    ];
    const parts = counts.filter(([count]) => count > 0).map(([count, label]) => `${count} ${count === 1 && label === "new results" ? "new result" : label}`);
    return parts.length ? `Refine · ${parts.join(" · ")} · ${sanitizeTerminalText(openHint)} Open` : undefined;
  }
}
