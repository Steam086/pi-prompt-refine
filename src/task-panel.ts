import { stripVTControlCharacters } from "node:util";
import { matchesKey, parseKey, Text, truncateToWidth, visibleWidth, type KeybindingsManager, type KeyId } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { RefineRecord } from "./history.js";
import type { HistoryStorageStatus } from "./history-store.js";
import { panelFrame, panelLayout, workspaceTabs } from "./panel-layout.js";
import { alignedKeyHints, fittingKeyHints, formatKeyHint, type KeyHint } from "./key-hints.js";
import { sanitizeTerminalText } from "./presentation.js";
import { cacheHitRate, formatReferenceCost, formatRunUsage, totalInputTokens, truncatedOutputHint } from "./usage.js";

export interface TaskPanelActions {
  records(): RefineRecord[];
  appliedId(): number | undefined;
  activate(id: number): boolean;
  run(id: number): void;
  stop(id: number): void;
  deleteRecords?(ids: readonly number[]): boolean;
  editOriginal?(id?: number): void;
  chooseModel?(id: number): void;
  accept?(id: number): void;
  revise?(id: number): void;
  preferences?(id?: number, original?: boolean): void;
  preferencesKey?: KeyId | null;
  launchModel?(): string;
  historyStorage?(): HistoryStorageStatus;
}
export interface TaskPanelPosition {
  selectedId?: number;
  selectedTaskId?: number;
  scroll?: number;
  scrolls?: Record<string, number>;
}
interface Row { record: RefineRecord; original: boolean; records: RefineRecord[] }
const pending = (record: RefineRecord) => record.status === "queued" || record.status === "generating";

/** Two-level original/run tree. Selection and scroll belong to identities, never row indexes. */
export class TaskPanel {
  private deletion?: { ids: number[]; label: string };
  isConfirmingDelete(): boolean { return !!this.deletion; }
  ownsInput(): boolean { return !!this.deletion || !!this.document; }
  private document?: { kind: "help" | "storage"; scroll: number };
  private reading = false;
  private referenceOnly = false;
  private inspecting = false;
  private compareId?: number;
  private original = false;
  private viewport = 1;
  private top = 0;
  private notice = "";
  private noticeColor: "muted" | "warning" | "error" = "muted";
  private cache = new Map<string, string[]>();
  constructor(
    private readonly actions: TaskPanelActions,
    private readonly theme: Theme,
    private readonly rows: () => number,
    private readonly keys: KeybindingsManager,
    private readonly usage = false,
    private readonly position: TaskPanelPosition = {},
  ) {}
  invalidate(): void { this.cache.clear(); }
  setNotice(text: string, color: "muted" | "warning" | "error" = "muted"): void { this.notice = text; this.noticeColor = color; }
  openList(): void { this.inspecting = false; this.compareId = undefined; this.reading = false; this.original = false; }
  /** Preserve the source and reading position while a revision owns focus. */
  snapshot(referenceOnly = false): TaskPanel {
    const records = this.actions.records().map((record) => ({ ...record, input: { ...record.input },
      candidate: record.candidate && { ...record.candidate } }));
    const appliedId = this.actions.appliedId();
    const panel = new TaskPanel({ ...this.actions, records: () => records, appliedId: () => appliedId },
      this.theme, this.rows, this.keys, this.usage, structuredClone(this.position));
    panel.referenceOnly = referenceOnly;
    panel.inspecting = this.inspecting; panel.compareId = this.compareId; panel.reading = this.reading;
    panel.original = this.original; panel.top = this.top; panel.notice = this.notice; panel.noticeColor = this.noticeColor;
    return panel;
  }
  private entries(): Row[] {
    const groups = new Map<number, RefineRecord[]>();
    for (const record of this.actions.records()) {
      const group = groups.get(record.taskId) ?? [];
      group.push(record);
      groups.set(record.taskId, group);
    }
    return [...groups.values()].sort((a, b) =>
      Number(a[0]!.archivedAt !== undefined) - Number(b[0]!.archivedAt !== undefined) ||
      (b[0]!.input.roundId ?? 0) - (a[0]!.input.roundId ?? 0) ||
      Math.max(...b.map((r) => r.id)) - Math.max(...a.map((r) => r.id)),
    ).flatMap((records) => {
      const source = records.find((r) => !r.input.revision) ?? records[0]!;
      const children = records.filter((r) => r.status !== "unsent").sort((a, b) => b.id - a.id);
      return [{ record: source, original: true, records },
        ...children.map((record) => ({ record, original: false, records }))];
    });
  }
  private rowKey(row: Row): string { return row.original ? `task-${row.record.taskId}` : `run-${row.record.id}`; }
  private isSelected(row: Row): boolean {
    return this.position.selectedTaskId !== undefined
      ? row.original && row.record.taskId === this.position.selectedTaskId
      : !row.original && row.record.id === this.position.selectedId;
  }
  private select(row: Row | undefined): void {
    if (!row) return;
    this.position.selectedTaskId = row.original ? row.record.taskId : undefined;
    this.position.selectedId = row.record.id;
    this.position.scroll = this.position.scrolls?.[this.rowKey(row)] ?? 0;
    this.original = false;
  }
  private selected(rows = this.entries()): Row | undefined {
    let row = rows.find((item) => this.isSelected(item));
    if (!row) {
      row = rows.find((item) => !item.original && item.record.id === this.actions.appliedId()) ?? rows[0];
      this.select(row);
    }
    return row;
  }
  private scroll(row: Row, delta: number): void {
    this.position.scroll = Math.max(0, (this.position.scroll ?? 0) + delta);
    (this.position.scrolls ??= {})[this.rowKey(row)] = this.position.scroll;
  }
  private canOpenPreferences(): boolean {
    return !!this.actions.preferences;
  }
  private canChoosePreferences(row?: Row): boolean {
    return !!(row?.original && row.record.status === "unsent" && !row.record.input.contextUnavailable && this.actions.preferences);
  }
  private preferenceSummary(record: RefineRecord): string {
    const selected = record.input.preferences ?? [];
    return `Preferences: ${selected.length ? `${selected.length} · ${selected.map((entry) => entry.name).join(", ")}` : "None"}`;
  }
  handleInput(data: string): boolean {
    const key = parseKey(data)?.toLowerCase();
    if (this.document) {
      if (key === "q" || key === "ctrl+\\" || this.keys.matches(data, "tui.select.cancel")) this.document = undefined;
      else if (key === "up" || key === "pageup") this.document.scroll = Math.max(0, this.document.scroll - (key === "up" ? 1 : this.viewport));
      else if (key === "down" || key === "pagedown") this.document.scroll += key === "down" ? 1 : this.viewport;
      else if (key === "home") this.document.scroll = 0;
      else if (key === "end") this.document.scroll = Number.MAX_SAFE_INTEGER;
      return true;
    }
    if (this.deletion) {
      if (key === "y") {
        const target = this.deletion;
        this.deletion = undefined;
        const removed = this.actions.deleteRecords?.(target.ids);
        this.openList();
        this.cache.clear();
        this.setNotice(removed ? "Deleted" : "Request changed or send pending; deletion cancelled", removed ? "muted" : "warning");
      } else if (key === "n" || key === "q" || key === "ctrl+\\" || this.keys.matches(data, "tui.select.cancel")) {
        this.deletion = undefined;
      }
      return true;
    }
    if (key === "?" || (key === "b" && this.usage && this.actions.historyStorage)) {
      this.document = { kind: key === "?" ? "help" : "storage", scroll: 0 };
      return true;
    }
    if (key && !["up", "down", "pageup", "pagedown", "tab"].includes(key)) this.notice = "";
    this.noticeColor = this.notice ? this.noticeColor : "warning";
    const row = this.selected();
    if (key === "d") {
      if (row && this.actions.deleteRecords) this.deletion = {
        ids: (row.original ? row.records : [row.record]).map((record) => record.id),
        label: row.original ? `original prompt and all ${row.records.length} request(s)` : `run #${row.record.id}`,
      };
      else this.notice = "Select an original or request to delete";
      return true;
    }
    if (row?.record.input.contextUnavailable && ["m", "g", "f"].includes(key ?? "")) {
      this.notice = "Background not saved · Press i to copy into current round";
      return true;
    }
    if (this.inspecting && (key === "q" || this.keys.matches(data, "tui.select.cancel"))) {
      this.openList();
      return true;
    }
    if (key === "tab") {
      if (this.compareId !== undefined && row) {
        const other = this.entries().find((item) => !item.original && item.record.id === this.compareId);
        if (other) { this.compareId = row.record.id; this.select(other); }
      } else if (!this.inspecting) this.reading = !this.reading;
      return true;
    }
    if (this.keys.matches(data, "tui.select.confirm")) {
      if (row?.original && row.record.status === "unsent" && !this.inspecting) {
        this.actions.run(row.record.id);
        // Only explicit submission moves focus; failed starts and background updates do not.
        this.select(this.entries().find((item) => !item.original && item.record.id === row.record.id));
      } else if (row) { this.inspecting = true; this.reading = true; }
      return true;
    }
    if (key === "n") {
      if (!this.inspecting) this.actions.editOriginal?.();
      else this.notice = "Return to the list to create a new original (n).";
      return true;
    }
    if (key === "i") {
      if (row) this.actions.editOriginal?.(row.record.id);
      else this.notice = "No original selected · Press n to create one";
      return true;
    }
    if (key === "m") {
      if (row) this.actions.chooseModel?.(row.record.id);
      else this.notice = "Select an original or request first";
      return true;
    }
    if (key === "x") {
      if (row && !row.original && pending(row.record)) this.actions.stop(row.record.id);
      else this.notice = "Select a queued or running request to stop";
      return true;
    }
    if (key === "a") {
      if (row && !row.original && row.record.candidate) this.actions.accept?.(row.record.id);
      else this.notice = "Select a request with a result to accept";
      return true;
    }
    if (this.inspecting && key === "c") {
      const peers = row?.records.filter((record) => record.id !== row.record.id && record.candidate) ?? [];
      if (!peers.length || row?.original) this.notice = "No other result for this original to compare";
      const index = peers.findIndex((record) => record.id === this.compareId);
      this.compareId = row && !row.original ? peers[index + 1]?.id : undefined;
      this.original = false;
      return true;
    }
    if (this.inspecting && key === "o") {
      if (!row || row.original || !row.record.candidate) {
        this.notice = "No result/reference pair for this item";
        return true;
      }
      this.original = !this.original;
      if (this.usage || this.compareId !== undefined) this.position.scroll = 0;
      return true;
    }
    if (key === "p" || (this.actions.preferencesKey && matchesKey(data, this.actions.preferencesKey))) {
      if (this.canOpenPreferences()) this.actions.preferences!(row?.record.id, row?.original);
      else this.notice = "Preferences unavailable";
      return true;
    }
    if (key === "g") {
      this.notice = "Press m to run the original with a model";
      return true;
    }
    if (key === "f") {
      if (row && !row.original && row.record.candidate && this.actions.revise) {
        this.inspecting = true; this.reading = true; this.compareId = undefined; this.original = false;
        this.actions.revise(row.record.id);
      } else this.notice = "Select a request with a result and saved background to revise";
      return true;
    }
    if (this.inspecting && ["e", "s"].includes(key ?? "")) {
      if (row && !row.original && row.record.candidate && this.actions.activate(row.record.id)) return false;
      this.notice = "Result unavailable or send pending · Select an actionable result";
      return true;
    }
    const delta = key === "up" ? -1 : key === "down" ? 1 : key === "pageup" ? -this.viewport : key === "pagedown" ? this.viewport : 0;
    if (delta) {
      if (row && (this.reading || this.inspecting)) {
        if (this.inspecting && !this.usage && this.compareId === undefined && !row.original && row.record.candidate && this.original) {
          const key = `${this.rowKey(row)}-reference`;
          const scrolls = this.position.scrolls ??= {};
          scrolls[key] = Math.max(0, (scrolls[key] ?? 0) + delta);
        } else this.scroll(row, delta);
      }
      else {
        const rows = this.entries();
        const index = rows.findIndex((item) => this.isSelected(item));
        this.select(rows[Math.max(0, Math.min(rows.length - 1, index + delta))]);
      }
      return true;
    }
    if (key === "h" || key === "u") return true;
    // Main actions never leak to a different, previously applied result.
    if (["e", "c", "o", "s", "[", "]", "d", "z", "r", "?", "v"].includes(key ?? "")) {
      this.notice = key === "e" ? "Press i to edit the original, or Enter then e to edit the result"
        : "Action unavailable here · Inspect the selected request with Enter";
      return true;
    }
    return false;
  }
  private badge(record: RefineRecord): string {
    const warning = record.input.budget && (record.input.budget.status !== "ok" || record.input.budget.message) ? "⚠ " : "";
    return warning + this.statusBadge(record);
  }
  private styledBadge(record: RefineRecord): string {
    const warning = this.badge(record).startsWith("⚠") ? this.theme.fg("warning", "⚠ ") : "";
    return warning + this.theme.fg(this.color(record), this.statusBadge(record));
  }
  private statusBadge(record: RefineRecord): string {
    if (record.status === "unsent") return "○ Unsent";
    if (record.status === "queued") return "… Queued";
    if (record.status === "generating") return "◌ Running";
    if (record.status === "error") return record.error === "timeout" ? "! Timed out" : "! Failed";
    if (record.status === "cancelled") return "× Cancelled";
    if (record.status === "interrupted") return "× Interrupted";
    if (record.sentAt !== undefined) return "✓ Sent to Pi";
    if (record.acceptedAt !== undefined) return "✓ Accepted";
    return record.kind === "edit" ? "✓ Edited" : record.kind === "revise" ? "✓ Revised" : "✓ Done";
  }
  private color(record: RefineRecord): "error" | "warning" | "accent" | "success" {
    return record.status === "error" ? "error" : record.status === "unsent" || record.status === "cancelled" || record.status === "interrupted" ? "warning"
      : pending(record) ? "accent" : "success";
  }
  private heading(text: string): string { return this.theme.fg("text", this.theme.bold(sanitizeTerminalText(text))); }
  private muted(text: string): string { return this.theme.fg("muted", sanitizeTerminalText(text)); }
  private wrapped(document: string, width: number): string[] {
    const key = JSON.stringify([document, width]);
    let lines = this.cache.get(key);
    if (!lines) {
      lines = new Text(document, 0, 0).render(width);
      if (this.cache.size >= 12) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, lines);
    }
    return lines;
  }
  private pane(row: Row, width: number, height: number, active = true, previewDetails = false): string[] {
    const { record, records } = row;
    const title = row.original ? "Original prompt" : record.input.model.id;
    const status = row.original && record.status !== "unsent"
      ? this.muted(`${records.filter((r) => r.status !== "unsent").length} runs · ${records.filter(pending).length} active`)
      : this.styledBadge(record);
    const titleText = previewDetails ? this.theme.fg("text", sanitizeTerminalText(title)) : this.heading(title);
    const header = visibleWidth(titleText) + visibleWidth(status) + 3 <= width
      ? [titleText + (previewDetails ? this.muted(" · ") : " ".repeat(width - visibleWidth(titleText) - visibleWidth(status))) + status]
      : [truncateToWidth(titleText, width, "…"), status];
    const identityLines = header.length;
    if ((row.original && record.status === "unsent" && this.actions.preferences) || record.input.preferences?.length) {
      header.push(...this.wrapped(this.muted(this.preferenceSummary(record)), width));
    }
    if (!row.original) {
      if (!previewDetails && record.kind === "revise") header.push(...this.wrapped(this.muted(`Revision${record.parentId ? ` of run #${record.parentId}` : ""}${this.inspecting && !this.referenceOnly ? " · o Original" : ""}`), width));
      const metadata = this.muted(`${record.input.model.provider} · Thinking ${record.input.thinkingLevel ?? "default"}`);
      if (!previewDetails) header.push(...this.wrapped(metadata, width));
      const metrics: string[] = [];
      if (record.status !== "unsent" && record.status !== "queued" && record.elapsedSeconds !== undefined) {
        metrics.push(this.inspecting ? this.muted(`${record.elapsedSeconds}s`)
          : this.theme.fg(record.status === "generating" ? "accent" : "text", this.theme.bold(`${record.elapsedSeconds}s`)));
      }
      if (record.kind !== "edit" && record.status !== "unsent" && record.status !== "queued") metrics.push(this.muted(formatRunUsage(record.usage)));
      if (previewDetails) metrics.unshift(metadata);
      if (metrics.length) header.push(...this.wrapped(metrics.join(this.muted(" · ")), width));
    }
    const diagnostics: string[] = [];
    if (record.error) diagnostics.push(...this.wrapped(this.theme.fg("error", sanitizeTerminalText(`Error: ${record.error}`)), width));
    if (!row.original && record.error === "truncated") {
      diagnostics.push(...this.wrapped(this.theme.fg("warning", truncatedOutputHint(record.usage)), width));
    }
    if (!row.original && record.input.budget?.message) {
      const message = record.input.budget.status === "blocked"
        ? "Request not sent · budget exceeded" : record.input.budget.status === "trimmed"
          ? "Background reduced · token budget" : "Shared output limit · thinking may exhaust it";
      diagnostics.push(...this.wrapped(this.theme.fg("warning", sanitizeTerminalText(`⚠ ${message}`)), width));
    }
    for (const warning of record.input.projectDiagnostics?.warnings ?? record.input.project?.snapshot.warnings ?? []) {
      diagnostics.push(...this.wrapped(this.theme.fg("warning", sanitizeTerminalText(`Context warning: ${warning}`)), width));
    }
    header.splice(identityLines, 0, ...diagnostics);
    if (previewDetails) return this.previewDetails(row, width, height, header);
    const original = row.original || this.original || !record.candidate;
    const body = [
      ...(!row.original ? [this.heading(original ? "Original prompt" : record.kind === "revise" ? "Revised result" : "Result"), ""] : []),
      original && !record.input.draft ? this.muted("Empty prompt · ") + formatKeyHint(["i", "Edit original"], this.theme)
        : this.theme.fg("text", sanitizeTerminalText(original ? record.input.draft : record.candidate!.text)),
    ];
    if (this.inspecting || this.usage) {
      if (record.input.editingInstruction) body.push("", this.heading("Initial editing instruction"), "", this.theme.fg("text", sanitizeTerminalText(record.input.editingInstruction)));
      if (!row.original && record.candidate && !original) body.push("", this.heading("Original prompt"), "", this.theme.fg("text", sanitizeTerminalText(record.input.draft)));
      if (!row.original && record.input.revision) {
        body.push("", this.heading("Revision instruction"), "", this.theme.fg("text", sanitizeTerminalText(record.input.revision.instruction)),
          "", this.heading("Before revision"), "", record.input.revision.previousCandidate
            ? this.theme.fg("text", sanitizeTerminalText(record.input.revision.previousCandidate))
            : this.muted("Before-revision text was not retained in this record."));
      }
      const value = (n: number | undefined) => n === undefined ? "—" : n.toLocaleString("en-US");
      const pairs = [
        ["Input (total)", value(totalInputTokens(record.usage)), "Output (total)", value(record.usage?.output)],
        ["Uncached input", value(record.usage?.input), "Cache hit", cacheHitRate(record.usage) === undefined ? "—" : `${cacheHitRate(record.usage)!.toFixed(1)}%`],
        ["Cache read", value(record.usage?.cacheRead), "Cache write", value(record.usage?.cacheWrite)],
        ["Reasoning", value(record.usage?.reasoning), "Total", value(record.usage?.totalTokens)],
      ];
      if (!row.original && record.status !== "unsent") {
        body.push("", this.heading(record.kind === "edit" ? "Manual edit · no model call" : "Usage · tokens"));
        for (const [a, b, c, d] of pairs) {
          const cell = (label: string, count: string, w: number) => this.muted(label + " ".repeat(Math.max(1, w - label.length - count.length)) + count);
          if (width >= 44) {
            const half = Math.floor((width - 3) / 2);
            body.push(cell(a!, b!, half) + "   " + cell(c!, d!, width - half - 3));
          } else body.push(cell(a!, b!, width), cell(c!, d!, width));
        }
        if (record.kind !== "edit") {
          body.push(this.muted("Input includes cache read/write; reasoning is included in output."), "", this.heading("Reference cost · USD"), this.muted(formatReferenceCost(record.usage)));
          if (record.usage?.cost) {
            for (const [key, label] of [["input", "Uncached input"], ["output", "Output"], ["cacheRead", "Cache read"], ["cacheWrite", "Cache write"]] as const) {
              const cost = record.usage.cost[key];
              body.push(this.muted(`${label}: ${cost === undefined ? "—" : `$${cost.toFixed(6)}`}`));
            }
            body.push(this.muted("Request-time SDK estimate; not actual billing or subscription quota."));
          } else body.push(this.muted("No reliable SDK cost estimate; pricing or usage may be unavailable. Zero-price catalog defaults are treated as unknown."));
        }
      }
      if (!row.original && record.input.budget) {
        const budget = record.input.budget;
        body.push("", this.heading("Request budget · conservative token estimate"),
          this.muted(`Input ${budget.inputTokens} + output ${budget.outputTokens} + safety ${budget.safetyTokens} / window ${budget.contextWindow}`));
        if (budget.message) body.push(this.theme.fg("warning", sanitizeTerminalText(`⚠ ${budget.message}`)));
      }
      body.push("", this.heading("Record"), this.muted(`Round ${record.input.roundId ?? "?"} · Task ${record.taskId}${record.archivedAt !== undefined ? " · Earlier context" : ""}`));
      if (record.input.contextUnavailable) body.push(this.muted("Restored history · background not saved. Press i to copy the original into the current round."));
      if (!row.original) body.push(this.muted(`Run #${record.id} · ${record.kind}${record.parentId ? ` from #${record.parentId}` : ""}`));
      body.push(this.muted(`Created ${new Date(record.createdAt).toLocaleTimeString()}`));
      if (record.acceptedAt !== undefined) body.push(this.muted(`Accepted into Pi editor: ${new Date(record.acceptedAt).toLocaleTimeString()}`));
      if (record.sentAt !== undefined) body.push(this.muted(`Pi started send: ${new Date(record.sentAt).toLocaleTimeString()}`));
    }
    const fixed = header.slice(0, Math.max(0, height - 2));
    if (height > fixed.length + 2) fixed.push("");
    const available = Math.max(1, height - fixed.length);
    // Overflow diagnostics belong to the scrollable document, never a clipped header.
    const lines = this.wrapped([...header.slice(Math.max(0, height - 2)), ...body].join("\n"), width);
    const offset = Math.min(active ? this.position.scroll ?? 0 : this.position.scrolls?.[this.rowKey(row)] ?? 0, Math.max(0, lines.length - available));
    if (active) { this.position.scroll = offset; this.viewport = available; }
    return [...fixed, ...lines.slice(offset, offset + available)];
  }
  /** Preview keeps reference material separate from the result and Usage details. */
  private previewDetails(row: Row, width: number, height: number, header: string[]): string[] {
    const { record } = row;
    // The shared reading frame is capped at 100 columns; reserve at least 30 for references.
    const wide = width >= 90;
    const leftWidth = wide ? Math.floor((width - 3) * 0.65) : width;
    const rightWidth = wide ? width - leftWidth - 3 : width;
    const fixed = header.slice(0, Math.max(0, height - 2));
    if (height > fixed.length + 2) fixed.push("");
    const available = Math.max(1, height - fixed.length);
    this.viewport = available;
    const literal = (text: string) => this.theme.fg("text", sanitizeTerminalText(text));
    const result = [...header.slice(Math.max(0, height - 2)), this.heading(record.kind === "revise" ? "Revised result" : "Result"), "", literal(record.candidate!.text)];
    const reference = [this.heading("Original prompt"), "", literal(record.input.draft)];
    if (record.input.editingInstruction) reference.push("", this.heading("Initial editing instruction"), "", literal(record.input.editingInstruction));
    if (record.input.revision) {
      reference.push("", this.heading("Revision instruction"), "", literal(record.input.revision.instruction),
        "", this.muted(`Revision${record.parentId ? ` of run #${record.parentId}` : ""}`),
        "", this.heading("Before revision"), "", record.input.revision.previousCandidate
          ? literal(record.input.revision.previousCandidate)
          : this.muted("Before-revision text was not retained in this record."));
    }
    reference.push("", this.muted(`Round ${record.input.roundId ?? "?"} · Task ${record.taskId}${record.archivedAt !== undefined ? " · Earlier context" : ""}`));
    if (record.input.contextUnavailable) reference.push(this.muted("Restored history · background not saved. Press i to copy the original into the current round."));
    const clip = (body: string[], columns: number, isReference: boolean): string[] => {
      const lines = this.wrapped(body.join("\n"), columns);
      const key = `${this.rowKey(row)}${isReference ? "-reference" : ""}`;
      const scrolls = this.position.scrolls ??= {};
      const offset = Math.min(isReference ? scrolls[key] ?? 0 : this.position.scroll ?? 0, Math.max(0, lines.length - available));
      scrolls[key] = offset;
      if (!isReference) this.position.scroll = offset;
      return lines.slice(offset, offset + available);
    };
    if (!wide) return [...fixed, ...clip(this.original ? reference : result, width, this.original)];
    const left = clip(result, leftWidth, false);
    const right = clip(reference, rightWidth, true);
    return [...fixed, ...Array.from({ length: available }, (_, i) => {
      const line = left[i] ?? "";
      return line + " ".repeat(Math.max(0, leftWidth - visibleWidth(line))) + this.muted(" │ ") + (right[i] ?? "");
    })];
  }
  private renderDocument(width: number): string[] {
    const layout = panelLayout(width, this.rows());
    const page = this.document!;
    const body: string[] = [];
    let title = "Available actions";
    if (page.kind === "storage") {
      title = "History storage";
      const status = this.actions.historyStorage!();
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
      const summary = this.theme.fg(failed ? "error" : warning ? "warning" : "muted", labels[status.state])
        + (status.memoryOnlyIds.length ? this.theme.fg("warning", ` · ${status.memoryOnlyIds.length} memory-only / pending`) : "")
        + (status.omittedIds.length ? this.theme.fg("warning", ` · ${status.omittedIds.length} capacity omissions`) : "");
      body.push(summary,
        "", this.heading("File"), this.theme.fg("text", sanitizeTerminalText(status.path ?? "Not available")),
        "", this.heading("Confirmed saved runs"), this.muted(status.savedIds.map((id) => `#${id}`).join(", ") || "None"),
        "", this.heading("Memory-only / pending runs"), this.theme.fg(status.memoryOnlyIds.length ? "warning" : "muted", status.memoryOnlyIds.map((id) => `#${id}`).join(", ") || "None"),
        "", this.heading("Capacity omissions"), this.theme.fg(status.omittedIds.length ? "warning" : "muted", status.omittedIds.map((id) => `#${id}`).join(", ") || "None"),
        "", this.muted("Memory-only includes changes to previously saved runs whose latest state is not saved yet. Unsent drafts are not saved. Limit: 100 runs / 2 MiB. Minimal prompts/results only; full background is not saved."));
    } else {
      const row = this.selected();
      if (this.notice) body.push(this.heading("Feedback"), this.theme.fg(this.noticeColor, sanitizeTerminalText(this.notice)), "");
      if (row) {
        body.push(this.heading(row.original ? "Original prompt" : `Run #${row.record.id} · ${row.record.input.model.id}`));
        if (row.record.error) body.push(this.theme.fg("error", sanitizeTerminalText(`Error: ${row.record.error}`)));
        if (row.record.error === "truncated") body.push(this.theme.fg("warning", truncatedOutputHint(row.record.usage)));
      }
      body.push(this.muted(`Focus: ${this.inspecting || this.reading ? "Reading · ↑↓ scroll" : "List · ↑↓ select"}`), "");
      const hints: KeyHint[] = [["Esc", "Back"], ["?", "Available actions and full feedback"]];
      if (!this.inspecting) hints.push(["Enter", row?.original && row.record.status === "unsent" ? "Run" : "Inspect"], ["Tab", this.reading ? "Select" : "Read"], ["n", "New"]);
      if (this.canOpenPreferences()) hints.push(["p", "Preferences"]);
      if (row) {
        hints.push(["i", row.record.input.contextUnavailable ? "Copy to current" : "Edit original"]);
        if (!row.record.input.contextUnavailable) hints.push(["m", "Run model"]);
        if (!row.original && pending(row.record)) hints.push(["x", "Stop"]);
        if (!row.original && row.record.candidate) {
          hints.push(["a", "Accept"]);
          if (!row.record.input.contextUnavailable && this.actions.revise) hints.push(["f", "Revise"]);
          if (this.inspecting) {
            hints.push(["e", "Edit result"], ["s", "Send to Pi"], ["o", "Switch result/reference"]);
            if (row.records.some((record) => record.id !== row.record.id && record.candidate)) hints.push(["c", this.compareId === undefined ? "Compare" : "Next comparison"]);
            if (this.compareId !== undefined) hints.push(["Tab", "Switch compared result"]);
          }
        }
        if (this.actions.deleteRecords) hints.push(["d", "Delete"]);
      }
      if (this.usage && this.actions.historyStorage) hints.push(["b", "History storage status and file location"]);
      body.push(...hints.map((hint) => formatKeyHint(hint, this.theme)), "", this.muted("Read-only help. Return with Esc before using these actions."));
    }
    const lines = this.wrapped(body.join("\n"), layout.innerWidth);
    this.viewport = Math.max(1, layout.bodyHeight);
    page.scroll = Math.min(page.scroll, Math.max(0, lines.length - this.viewport));
    const footer = [fittingKeyHints([["Esc", "Back"], ["↑↓", "Scroll"]], layout.innerWidth, this.theme)];
    return panelFrame(layout, [this.heading(title), this.muted(`${page.scroll + 1}–${Math.min(lines.length, page.scroll + this.viewport)} / ${lines.length} lines`)],
      lines.slice(page.scroll, page.scroll + this.viewport), footer, (text) => this.muted(text));
  }
  render(width: number, _empty?: () => string[]): string[] {
    if (width < 1) return [];
    const layout = panelLayout(width, this.rows());
    if (this.document) return this.renderDocument(width);
    if (this.deletion) {
      const body = this.wrapped(this.theme.fg("warning", `Delete ${this.deletion.label}?`) +
        "\n\nRunning requests will be stopped; queued requests will be removed.\nThis removes Refine history. Pi editor and conversation stay unchanged.", layout.innerWidth);
      return panelFrame(layout, [this.heading("Delete request"), this.muted("Confirmation required")],
        body, [fittingKeyHints([["y", "Delete"], ["Esc / n", "Cancel"]], layout.innerWidth, this.theme)],
        (text) => this.muted(text));
    }
    const tabs = workspaceTabs(layout, this.usage ? "Usage" : "Preview", this.theme, !this.referenceOnly);
    const height = Math.max(1, layout.bodyHeight - tabs.length);
    const rows = this.entries();
    const selected = this.selected(rows);
    const split = !this.inspecting && layout.innerWidth >= 72;
    const leftWidth = split ? Math.min(36, Math.floor(layout.innerWidth / 3)) : layout.innerWidth;
    const rightWidth = split ? layout.innerWidth - leftWidth - 3 : layout.innerWidth;
    const selectedIndex = Math.max(0, rows.findIndex((row) => this.isSelected(row)));
    this.top = Math.max(0, Math.min(this.top, selectedIndex, rows.length - height));
    if (selectedIndex >= this.top + height) this.top = selectedIndex - height + 1;
    const list = rows.slice(this.top, this.top + height).map((row) => {
      const { record } = row;
      const old = record.archivedAt !== undefined;
      const active = this.isSelected(row);
      const prefix = `${active ? "›" : " "} ${record.id === Math.min(...row.records.filter((r) => r.status !== "unsent").map((r) => r.id)) ? "└" : "├"} `;
      const badge = this.badge(record);
      const model = stripVTControlCharacters(truncateToWidth(sanitizeTerminalText(record.input.model.id), Math.max(1, leftWidth - visibleWidth(prefix + badge) - 1), "…"));
      const label = row.original
        ? `${active ? "›" : " "} ${record.status === "unsent" ? `○ Unsent ·${record.input.preferences?.length ? ` P:${record.input.preferences.length} ·` : ""}` : "▾"} ${old ? "Earlier · " : ""}${record.input.draft.replace(/\s+/g, " ") || "Empty prompt"}`
        : `${prefix}${model}${" ".repeat(Math.max(1, leftWidth - visibleWidth(prefix + model + badge)))}${badge}`;
      const clean = stripVTControlCharacters(truncateToWidth(sanitizeTerminalText(label), leftWidth, "…"));
      const color = old ? "dim" : row.original ? "text" : this.color(record);
      const warningAt = !row.original && badge.startsWith("⚠") ? clean.lastIndexOf("⚠") : -1;
      const text = warningAt < 0 ? this.theme.fg(color, clean)
        : this.theme.fg(color, clean.slice(0, warningAt)) + this.theme.fg("warning", "⚠") + this.theme.fg(color, clean.slice(warningAt + 1));
    let right = selected ? this.pane(selected, rightWidth, height, true, previewDetails) : [this.muted("No prompts yet. Press n to create one.")];
      return active ? this.theme.bg("selectedBg", text + " ".repeat(Math.max(0, leftWidth - visibleWidth(text)))) : text;
    });
    const previewDetails = this.inspecting && !this.usage && this.compareId === undefined && !!selected && !selected.original && !!selected.record.candidate;
    let body: string[];
    const other = this.inspecting && this.compareId !== undefined ? rows.find((row) => !row.original && row.record.id === this.compareId) : undefined;
    if (other && layout.innerWidth >= 72) {
      const half = Math.floor((layout.innerWidth - 3) / 2);
      right = selected ? this.pane(selected, half, height - 1) : [];
      const peer = this.pane(other, layout.innerWidth - half - 3, height - 1, false);
      body = [this.muted("Selected result ← · Tab switches the result to accept")];
      body.push(...Array.from({ length: height - 1 }, (_, i) => {
        const line = right[i] ?? "";
        return line + " ".repeat(Math.max(0, half - visibleWidth(line))) + this.muted(" │ ") + (peer[i] ?? "");
      }));
    } else {
      body = Array.from({ length: height }, (_, i) => {
        if (!split) return this.inspecting || this.reading || !rows.length ? right[i] ?? "" : list[i] ?? "";
        const line = list[i] ?? "";
        return line + " ".repeat(Math.max(0, leftWidth - visibleWidth(line))) + this.muted(" │ ") + (right[i] ?? "");
      });
    }
    const action = !this.inspecting && selected?.original && selected.record.status === "unsent" ? "Run" : "Inspect";
    const restored = selected?.record.input.contextUnavailable;
    const primary: KeyHint[] = this.inspecting ? [["i", restored ? "Copy to current" : "Edit original"], ...(!restored ? [["m", "Run model"] as const] : [])]
      : [["Enter", action], ["i", restored ? "Copy to current" : "Edit original"], ["n", "New"], ...(!restored ? [["m", selected ? "Run model" : "Model"] as const] : [])];
    if (this.canOpenPreferences()) primary.splice(this.inspecting ? 0 : 1, 0, ["p", "Preferences"]);
    if (selected && !selected.original && pending(selected.record)) primary.unshift(["x", "Stop"]);
    if (selected && !selected.original && selected.record.candidate) {
      primary.unshift(...(this.inspecting ? [["s", "Send to Pi"] as const] : []));
      primary.unshift(["a", "Accept"]);
    }
    if (selected && this.actions.deleteRecords) primary.push(["d", "Delete"]);
    // Reserve both focus labels so Tab never shifts columns or changes which hints fit.
    const focusAction = (this.reading ? "Select" : "Read").padEnd("Select".length);
    const secondary: KeyHint[] = [["Esc", "Back"], ["?", layout.innerWidth < 56 ? "Help" : "Actions"], ...(this.usage && this.actions.historyStorage ? [["b", "Storage"] as const] : []), ...(!this.inspecting && selected && !selected.original && selected.record.candidate && !restored && this.actions.revise ? [["f", "Revise"] as KeyHint] : []), ...(previewDetails ? [["o", this.original ? "Result" : "Reference"] as KeyHint] : []), ...(other || !this.inspecting ? [["Tab", other ? "Switch result" : focusAction] as KeyHint] : [])];
    if (this.inspecting && selected && !selected.original && selected.record.candidate) {
      secondary.push(...(selected.records.some((record) => record.id !== selected.record.id && record.candidate) ? [["c", other ? "Next comparison" : "Compare"] as KeyHint] : []), ["e", "Edit result"], ...(!restored ? [["f", "Revise"] as const] : []));
    }
    const compact = (hints: KeyHint[]): KeyHint[] => hints.map(([key, label]) => [key === "Enter" ? "↵" : key, label === "Send to Pi" ? "Send" : label]);
    const footer = layout.innerWidth < 56
      ? [fittingKeyHints(compact(primary), layout.innerWidth, this.theme, layout.innerWidth < 30 ? " " : " · "), fittingKeyHints(secondary, layout.innerWidth, this.theme, layout.innerWidth < 30 ? " " : " · ")]
      : alignedKeyHints([primary, secondary], layout.innerWidth, this.theme);
    if (layout.footerHeight === 1) footer[0] = fittingKeyHints([["Esc", "Back"], ["?", "Help"], ...compact(primary)], layout.innerWidth, this.theme, " ");
    const title = this.inspecting ? (other ? "Compare results" : "Prompt details") : this.usage ? "Usage · All rounds" : "Prompt refine · Tasks";
    const feedback = this.notice ? this.theme.fg(this.noticeColor, sanitizeTerminalText(this.notice)) : "";
    const subtitle = this.referenceOnly ? this.muted("Read-only reference") : this.notice ? feedback : this.inspecting
      ? (selected && !selected.original
        ? this.muted("Selected: ") + this.heading(`#${selected.record.id} ${selected.record.input.model.id}`)
        : this.heading("Original prompt")) + this.muted(" · ")
        + formatKeyHint(["↑↓", `scroll${previewDetails ? (this.original ? " reference" : " result") : ""}`], this.theme)
        + (previewDetails ? this.muted(" · ") + formatKeyHint(["o", this.original ? "Result" : "Reference"], this.theme)
          : other ? this.muted(" · Same original and conversation context") : "")
      : this.muted(`${rows.filter((row) => row.original).length} prompts · ${rows.filter((row) => !row.original).length} runs · `)
        + formatKeyHint(["↑↓", this.reading ? "scroll" : "select"], this.theme) + this.muted(` · Run: ${this.actions.launchModel?.() ?? "selected model"}`);
    const header = [this.heading(title), subtitle];
    if (!this.notice && !this.referenceOnly && this.canChoosePreferences(selected)) {
      const summary = this.muted(this.preferenceSummary(selected!.record));
      header[1] = summary + this.muted(" · ") + subtitle;
      if (layout.headerHeight === 1) header[0] = summary;
    }
    if (this.notice && !this.referenceOnly && layout.headerHeight < 2) {
      if (layout.headerHeight === 1) header[0] = truncateToWidth(feedback, layout.innerWidth, "…");
      else body = [feedback, ...body];
    }
    return panelFrame(layout, header,
      [...(layout.headerHeight === 0 && this.notice ? [] : tabs), ...body], footer, (text) => this.muted(text));
  }
}
