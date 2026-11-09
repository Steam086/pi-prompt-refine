import { stripVTControlCharacters } from "node:util";
import { matchesKey, parseKey, Text, truncateToWidth, visibleWidth, type KeybindingsManager, type KeyId } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { RefineRecord } from "./history.js";
import type { HistoryStorageStatus } from "./history-store.js";
import { panelFrame, panelLayout, workspaceTabs, type PanelLayout, type PanelLayoutProvider } from "./panel-layout.js";
import { alignedKeyHints, fittingKeyHints, formatKeyHint, type KeyHint } from "./key-hints.js";
import { sanitizeTerminalText } from "./presentation.js";
import { selectionWindow } from "./selection-window.js";
import type { InlinePreferences } from "./inline-preferences.js";
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
  inlinePreferences?: InlinePreferences;
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
  /** Explicit page navigation may follow an open archived target, never a late result. */
  earlierTarget(): { id: number; original: boolean } | undefined {
    const row = this.selected();
    return this.retainedEarlier && row ? { id: row.record.id, original: row.original } : undefined;
  }
  ownsInput(): boolean { return !!this.deletion || !!this.document || this.preferenceFocus; }
  private preferenceFocus = false;
  // A view opened while current may outlive its round. Keep only that view,
  // not archived tree rows, until the user explicitly leaves it.
  private viewedRow?: Row;
  private retainedEarlier = false;
  private document?: { kind: "help" | "storage"; scroll: number };
  private reading = false;
  private referenceOnly = false;
  private inspecting = false;
  private compareId?: number;
  private original = false;
  private viewport = 1;
  private top = 0;
  private navigationDirection = 1;
  private notice = "";
  private noticeColor: "muted" | "warning" | "error" = "muted";
  private cache = new Map<string, string[]>();
  // Keep requested anchors separate from effective offsets. A taller viewport
  // may reveal earlier lines near the end, but must not erase the compact anchor.
  private renderedScrolls = new Map<string, number>();
  private rememberRenderedScroll(key: string, offset: number): void {
    if (this.renderedScrolls.size >= 200 && !this.renderedScrolls.has(key)) this.renderedScrolls.delete(this.renderedScrolls.keys().next().value!);
    this.renderedScrolls.set(key, offset);
  }
  constructor(
    private readonly actions: TaskPanelActions,
    private readonly theme: Theme,
    private readonly rows: () => number,
    private readonly keys: KeybindingsManager,
    private readonly usage = false,
    private readonly position: TaskPanelPosition = {},
    private readonly layout: PanelLayoutProvider = (width) => panelLayout(width, this.rows()),
    private readonly expansionHint?: () => KeyHint | undefined,
  ) {}
  canExpand(): boolean { return !this.referenceOnly && !this.deletion && !this.document &&
    (!this.preferenceFocus || this.actions.inlinePreferences?.hints !== "search"); }
  /** Initial tree/summary demand only. Never select, render or clamp a live pane. */
  preferredBodyHeight(innerWidth: number): number {
    const rows = this.entries();
    const row = rows.find((item) => this.isSelected(item)) ?? rows.find((item) =>
      !item.original && item.record.id === this.actions.appliedId()) ?? rows[0];
    if (!row) return 3;
    const rightWidth = innerWidth >= 72 ? innerWidth - Math.min(36, Math.floor(innerWidth / 3)) - 3 : innerWidth;
    const inline = this.inline(row);
    const summary = row.original ? this.originalHeight(row, rightWidth) + (inline ? 1 + inline.preferredHeight(row.record.id) : 0)
      : this.paneHeader(row, rightWidth).length + 3 + this.wrapped(sanitizeTerminalText(row.record.candidate?.text ?? row.record.input.draft), rightWidth).length;
    return Math.max(rows.length, summary);
  }
  invalidate(): void { this.cache.clear(); }
  setNotice(text: string, color: "muted" | "warning" | "error" = "muted"): void { this.notice = text; this.noticeColor = color; }
  openList(): void {
    this.inspecting = false; this.compareId = undefined; this.reading = false; this.preferenceFocus = false; this.original = false;
    if (this.retainedEarlier) this.viewedRow = undefined;
    this.retainedEarlier = false;
  }
  /** Preserve the source and reading position while a revision owns focus. */
  snapshot(referenceOnly = false): TaskPanel {
    const records = this.actions.records().map((record) => ({ ...record, input: { ...record.input },
      candidate: record.candidate && { ...record.candidate } }));
    const appliedId = this.actions.appliedId();
    const panel = new TaskPanel({ ...this.actions, inlinePreferences: undefined, records: () => records, appliedId: () => appliedId },
      this.theme, this.rows, this.keys, this.usage, structuredClone(this.position), this.layout);
    panel.referenceOnly = referenceOnly;
    panel.inspecting = this.inspecting; panel.compareId = this.compareId; panel.reading = this.reading;
    panel.original = this.original; panel.top = this.top; panel.navigationDirection = this.navigationDirection;
    panel.viewedRow = this.viewedRow; panel.retainedEarlier = this.retainedEarlier;
    panel.notice = this.notice; panel.noticeColor = this.noticeColor;
    return panel;
  }
  private entries(allRounds = false): Row[] {
    const groups = new Map<number, RefineRecord[]>();
    for (const record of this.actions.records()) {
      if (!allRounds && !this.usage && record.archivedAt !== undefined) continue;
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
    this.viewedRow = row;
    this.retainedEarlier = false;
  }
  private selected(rows = this.entries()): Row | undefined {
    let row = rows.find((item) => this.isSelected(item));
    if (!row && !this.usage && this.viewedRow && this.isSelected(this.viewedRow)) {
      row = this.entries(true).find((item) => this.rowKey(item) === this.rowKey(this.viewedRow!));
      if (row?.record.archivedAt !== undefined) {
        this.retainedEarlier = true;
        this.viewedRow = row;
        return row;
      }
    }
    this.retainedEarlier = false;
    if (!row) {
      row = rows.find((item) => !item.original && item.record.id === this.actions.appliedId()) ?? rows[0];
      this.select(row);
    }
    this.viewedRow = row;
    return row;
  }
  private scroll(row: Row, delta: number): void {
    this.position.scroll = Math.max(0, (this.renderedScrolls.get(this.rowKey(row)) ?? this.position.scroll ?? 0) + delta);
    this.renderedScrolls.delete(this.rowKey(row));
    (this.position.scrolls ??= {})[this.rowKey(row)] = this.position.scroll;
  }
  private canOpenPreferences(): boolean {
    return !!this.actions.preferences;
  }
  private canChoosePreferences(row?: Row): boolean {
    return !!(row?.original && row.record.status === "unsent" && row.record.archivedAt === undefined && !row.record.input.contextUnavailable && this.actions.preferences);
  }
  private inline(row?: Row): InlinePreferences | undefined {
    return !this.usage && !this.referenceOnly && !this.inspecting && this.canChoosePreferences(row) &&
      this.actions.inlinePreferences?.available(row!.record.id) ? this.actions.inlinePreferences : undefined;
  }
  private runOriginal(row: Row): void {
    this.actions.run(row.record.id);
    // Failed starts retain the original and focus. Successful starts follow only
    // this explicit target, never whichever candidate completed in the meantime.
    const started = this.entries().find((item) => !item.original && item.record.id === row.record.id);
    if (started) {
      this.preferenceFocus = false; this.reading = false;
      this.actions.inlinePreferences?.setTarget(undefined, false);
      this.select(started);
    }
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
    const inlineRow = this.selected();
    if (this.retainedEarlier && (key === "q" || key === "ctrl+\\" || this.keys.matches(data, "tui.select.cancel"))) {
      this.openList(); this.selected();
      return true;
    }
    const inline = this.inline(inlineRow);
    this.actions.inlinePreferences?.setTarget(inline ? inlineRow!.record.id : undefined, this.preferenceFocus);
    if (this.preferenceFocus && !inline) {
      this.preferenceFocus = false; this.reading = false;
      this.setNotice("Original changed or already started; no selection applied.", "warning");
      return true;
    }
    if (inline && !this.preferenceFocus && (key === "tab" || key === "shift+tab")) {
      this.preferenceFocus = true; this.reading = false;
      inline.setTarget(inlineRow!.record.id, true);
      return true;
    }
    if (inline && this.preferenceFocus) {
      if (this.actions.preferencesKey && matchesKey(data, this.actions.preferencesKey) && inline.hints === "select") {
        this.actions.preferences?.(inlineRow!.record.id, true);
      } else {
        const action = inline.handleInput(data);
        if (action === "back") { this.preferenceFocus = false; this.reading = false; inline.setTarget(inlineRow!.record.id, false); }
        else if (action === "manage") this.actions.preferences?.(inlineRow!.record.id, true);
        else if (action === "submit") this.runOriginal(inlineRow!);
      }
      return true;
    }
    if (inline && key === "o") {
      this.reading = !this.reading;
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
        const other = this.entries(this.retainedEarlier).find((item) => !item.original && item.record.id === this.compareId);
        if (other) { this.compareId = row.record.id; this.select(other); }
      } else if (!this.inspecting && !this.retainedEarlier) this.reading = !this.reading;
      return true;
    }
    if (this.keys.matches(data, "tui.select.confirm")) {
      if (row?.original && row.record.status === "unsent" && (this.usage || row.record.archivedAt === undefined) && !this.inspecting) {
        this.runOriginal(row);
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
      if (row && (this.reading || this.inspecting || this.retainedEarlier)) {
        if (this.inspecting && !this.usage && this.compareId === undefined && !row.original && row.record.candidate && this.original) {
          const key = `${this.rowKey(row)}-reference`;
          const scrolls = this.position.scrolls ??= {};
          scrolls[key] = Math.max(0, (this.renderedScrolls.get(key) ?? scrolls[key] ?? 0) + delta);
          this.renderedScrolls.delete(key);
        } else this.scroll(row, delta);
      }
      else {
        this.navigationDirection = Math.sign(delta);
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
  /** Measure content, never render a pane: rendering can clamp its reading position. */
  private originalHeight(row: Row, width: number): number {
    const body = row.record.input.draft || "Empty prompt · i Edit original";
    return this.paneHeader(row, width).length + 1 + this.wrapped(sanitizeTerminalText(body), width).length;
  }
  private paneHeader(row: Row, width: number, previewDetails = false): string[] {
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
    if (!this.inline(row) && ((row.original && record.status === "unsent" && this.actions.preferences) || record.input.preferences?.length)) {
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
    return header;
  }
  private pane(row: Row, width: number, height: number, active = true, previewDetails = false, showInline = true): string[] {
    const inline = showInline && this.inline(row);
    if (inline) {
      // Inactive checklist only; the focused selector owns its full-height layout.
      const reserved = height < 9 ? 1 : Math.min(7, Math.max(5, Math.floor(height / 2)));
      const originalHeight = Math.min(this.originalHeight(row, width), Math.max(0, height - reserved - 1));
      const original = originalHeight > 0 ? this.pane(row, width, originalHeight, active, false, false) : [];
      // Short originals end naturally. Give the reclaimed rows to the checklist,
      // rather than padding between the original and Preferences.
      return [...original, ...(original.length ? [""] : []), ...inline.render(width, height - original.length - (original.length ? 1 : 0))];
    }
    const { record } = row;
    const header = this.paneHeader(row, width, previewDetails);
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
    if (height > fixed.length + 2 || (row.original && height === fixed.length + 2)) fixed.push("");
    const available = Math.max(1, height - fixed.length);
    // Overflow diagnostics belong to the scrollable document, never a clipped header.
    const lines = this.wrapped([...header.slice(Math.max(0, height - 2)), ...body].join("\n"), width);
    const offset = Math.min(active ? this.position.scroll ?? 0 : this.position.scrolls?.[this.rowKey(row)] ?? 0, Math.max(0, lines.length - available));
    if (active) { this.rememberRenderedScroll(this.rowKey(row), offset); this.viewport = available; }
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
      this.rememberRenderedScroll(key, offset);
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
    const layout = this.layout(width);
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
      const expansion = this.expansionHint?.();
      if (expansion) hints.push(expansion);
      const inline = this.inline(row);
      if (!this.inspecting) hints.push(["Enter", row?.original && row.record.status === "unsent" && (this.usage || row.record.archivedAt === undefined) ? "Optimize from original focus" : "Inspect"], ...(!this.retainedEarlier ? [["Tab", inline ? "List / Preferences" : this.reading ? "Select" : "Read"] as KeyHint] : []), ["n", "New"]);
      if (inline) hints.push(["Tab / Shift+Tab", "Enter preferences; return to tasks without changing selections"], ["Space", "Toggle at Preferences focus; saved immediately"], ["Enter", "Optimize this Unsent at Preferences focus; search/read never submit"], ["o", "Read original or full preference at its focus"], ["/", "Search at Preferences focus"]);
      if (this.canOpenPreferences()) hints.push(["p", inline ? "Manage / more; Alt+Enter brings back child changes" : "Preferences"]);
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
      if (!this.usage) body.push(this.muted("Preview shows the current round. Usage contains current and historical records; → opens Usage after leaving Preferences."), "");
      else body.push(this.muted("All rounds: current prompts, Earlier records, results and usage details. Restored records have no reusable background."), "");
      if (this.usage && this.actions.historyStorage) hints.push(["b", "History storage status and file location"]);
      body.push(...hints.map((hint) => formatKeyHint(hint, this.theme)), "", this.muted("Read-only help. Return with Esc before using these actions."));
    }
    const lines = this.wrapped(body.join("\n"), layout.innerWidth);
    this.viewport = Math.max(1, layout.bodyHeight);
    page.scroll = Math.min(page.scroll, Math.max(0, lines.length - this.viewport));
    const footer = [fittingKeyHints([["Esc", "Back"], ["↑↓", "Scroll"]], layout.innerWidth, this.theme)];
    return panelFrame(layout, [this.heading(title), this.muted(`${page.scroll + 1}–${Math.min(lines.length, page.scroll + this.viewport)} / ${lines.length} lines`)],
      lines.slice(page.scroll, page.scroll + this.viewport), footer, (text) => this.muted(text), { footerAfterBodyRows: 0 });
  }
  /** Selection temporarily replaces the task tree; references never gain an action focus. */
  private renderPreferences(row: Row, inline: InlinePreferences, layout: PanelLayout, tabs: string[]): string[] {
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
      const original = originalHeight ? this.pane(row, rightWidth, originalHeight, true, false, false) : [];
      const preview = inline.renderPreview(rightWidth, Math.max(0, height - feedbackHeight - original.length - (original.length ? 1 : 0) - 1));
      const selected = row.record.input.preferences ?? [];
      const feedback = [this.muted(`Selected · ${selected.length}`)];
      const room = Math.min(feedbackHeight, height - original.length - (original.length ? 1 : 0)
        - preview.length - (preview.length ? 1 : 0)) - feedback.length;
      if (!selected.length && room > 0) feedback.push(this.muted("None yet"));
      else if (room > 0) {
        // Keep newly appended selections visible without changing composition order.
        const count = Math.min(selected.length, Math.max(0, room - (selected.length > room ? 1 : 0)));
        if (count < selected.length) feedback.push(this.muted(`… ${selected.length - count} more`));
        for (const item of count ? selected.slice(-count) : []) {
          feedback.push(truncateToWidth(this.muted("· ") + this.theme.fg("text", sanitizeTerminalText(item.name).replace(/\s+/gu, " ")), rightWidth, "…"));
        }
      }
      const reference = [...original, ...(original.length ? [""] : []), ...preview, ...(preview.length ? [""] : []), ...feedback];
      body = Array.from({ length: height }, (_, i) => {
        const line = choices[i] ?? "";
        return line + " ".repeat(Math.max(0, leftWidth - visibleWidth(line))) + this.muted(" │ ") + (reference[i] ?? "");
      });
    } else {
      // Reading uses the full width. Narrow selection prioritizes choices over references.
      const summary = mode !== "read" && height >= 8
        ? [truncateToWidth(this.muted("Original: ") + this.theme.fg("text", sanitizeTerminalText(row.record.input.draft).replace(/\s+/gu, " ")), width, "…")] : [];
      body = [...summary, ...inline.render(width, height - summary.length, showInlineWarning)];
    }
    const back: KeyHint = ["Esc", width < 8 ? "" : mode === "select" ? width < 40 ? "Back" : "Back to tasks"
      : mode === "search" ? width < 40 ? "Back" : "End search" : width < 40 ? "Back" : "Back to preferences"];
    const submit: KeyHint = [width < 16 ? "↵" : "Enter", width < 10 ? "Start" : "Optimize"];
    const primary: KeyHint[] = mode === "select" ? [back, submit]
      : mode === "search" ? [back, ["Enter", "Results"]] : [back, ["↑↓", "Scroll"]];
    const secondary: KeyHint[] = mode === "select"
      ? [["Space", "Toggle"], ["Tab", "Back"], ["o", "Read"], ["↑↓", "Choose"], ["/", "Search"], ["p", "Manage"]] : [];
    const expansion = this.canExpand() && this.expansionHint?.();
    if (expansion) secondary.push(expansion);
    const pairFits = visibleWidth(formatKeyHint(primary[0]!, this.theme) + " · " + formatKeyHint(primary[1]!, this.theme)) <= width;
    const header = [this.heading("Choose preferences"), this.muted(`Focus: Preferences${mode === "search" ? " · Search" : mode === "read" ? " · Read-only" : ""}`)];
    const footer = layout.footerHeight > 1 && !pairFits
      ? [fittingKeyHints([back], width, this.theme), fittingKeyHints([...primary.slice(1), ...secondary], width, this.theme)]
      : [fittingKeyHints(primary, width, this.theme), fittingKeyHints(secondary, width, this.theme)];
    if (layout.footerHeight === 1) footer[0] = fittingKeyHints([...primary, ...secondary], width, this.theme);
    if (layout.footerHeight === 1 && mode === "select" && !pairFits && layout.headerHeight > 0) {
      // Keep both action meanings, rather than dropping Optimize in short/narrow frames.
      header[layout.headerHeight - 1] = formatKeyHint(submit, this.theme);
    }
    if (warning && layout.headerHeight > 0) header[layout.headerHeight - 1] = this.theme.fg("warning", sanitizeTerminalText(`⚠ ${warning}`));
    return panelFrame(layout, header, [...tabs, ...body], footer, (text) => this.muted(text), { footerAfterBodyRows: tabs.length });
  }
  render(width: number, _empty?: () => string[]): string[] {
    if (width < 1) return [];
    const layout = this.layout(width);
    if (this.document) return this.renderDocument(width);
    if (this.deletion) {
      const body = this.wrapped(this.theme.fg("warning", `Delete ${this.deletion.label}?`) +
        "\n\nRunning requests will be stopped; queued requests will be removed.\nThis removes Refine history. Pi editor and conversation stay unchanged.", layout.innerWidth);
      return panelFrame(layout, [this.heading("Delete request"), this.muted("Confirmation required")],
        body, [fittingKeyHints([["Esc / n", "Cancel"], ["y", "Delete"]], layout.innerWidth, this.theme)],
        (text) => this.muted(text), { footerAfterBodyRows: 0 });
    }
    const tabs = workspaceTabs(layout, this.usage ? "Usage" : "Preview", this.theme, !this.referenceOnly && !this.preferenceFocus);
    const height = Math.max(1, layout.bodyHeight - tabs.length);
    const rows = this.entries();
    const selected = this.selected(rows);
    const inline = this.inline(selected);
    this.actions.inlinePreferences?.setTarget(inline ? selected!.record.id : undefined, this.preferenceFocus);
    if (inline && this.preferenceFocus && selected) return this.renderPreferences(selected, inline, layout, tabs);
    const split = !this.inspecting && !this.retainedEarlier && layout.innerWidth >= 72;
    const leftWidth = split ? Math.min(36, Math.floor(layout.innerWidth / 3)) : layout.innerWidth;
    const rightWidth = split ? layout.innerWidth - leftWidth - 3 : layout.innerWidth;
    const selectedIndex = Math.max(0, rows.findIndex((row) => this.isSelected(row)));
    this.top = selectionWindow(rows.length, selectedIndex, height, this.top, undefined, 0, this.navigationDirection).start;
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
      let text: string;
      if (row.original) {
        const earlierAt = old ? clean.indexOf("Earlier · ") : -1;
        text = earlierAt < 0 ? this.theme.fg("text", clean)
          : this.theme.fg("text", clean.slice(0, earlierAt)) + this.muted("Earlier · ") + this.theme.fg("text", clean.slice(earlierAt + 10));
      } else {
        const badgeAt = Math.min(clean.length, label.length - badge.length);
        const status = clean.slice(badgeAt);
        text = this.theme.fg("text", clean.slice(0, badgeAt))
          + (status.startsWith("⚠") ? this.theme.fg("warning", "⚠") + this.theme.fg(this.color(record), status.slice(1))
            : this.theme.fg(this.color(record), status));
      }
      return active ? this.theme.bg("selectedBg", text + " ".repeat(Math.max(0, leftWidth - visibleWidth(text)))) : text;
    });
    const previewDetails = this.inspecting && !this.usage && this.compareId === undefined && !!selected && !selected.original && !!selected.record.candidate;
    let body: string[];
    const other = this.inspecting && this.compareId !== undefined ? this.entries(this.retainedEarlier).find((row) => !row.original && row.record.id === this.compareId) : undefined;
    // Exactly one layout owns the horizontal split: list + summary, Enter
    // details (result + reference), or Compare. Never nest detail columns inside
    // an existing pane, or render an unused pane that clamps its scroll offset.
    if (this.retainedEarlier && !this.inspecting && selected) {
      body = this.pane(selected, layout.innerWidth, height);
    } else if (previewDetails && selected) {
      body = this.pane(selected, layout.innerWidth, height, true, true);
    } else if (other && selected) {
      // A/B identities stay attached to runs when Tab swaps the action target.
      const letter = (row: Row) => row.record.id === Math.min(selected.record.id, other.record.id) ? "A" : "B";
      const identity = (row: Row) => `${letter(row)} · Run #${row.record.id}`;
      if (layout.innerWidth >= 72) {
        const half = Math.floor((layout.innerWidth - 3) / 2);
        const right = this.pane(selected, half, height - 1);
        const peer = this.pane(other, layout.innerWidth - half - 3, height - 1, false);
        const label = truncateToWidth(this.heading(identity(selected)), half, "…");
        body = [label + " ".repeat(Math.max(0, half - visibleWidth(label))) + this.muted(" │ ") + this.heading(identity(other))];
        body.push(...Array.from({ length: height - 1 }, (_, i) => {
          const line = right[i] ?? "";
          return line + " ".repeat(Math.max(0, half - visibleWidth(line))) + this.muted(" │ ") + (peer[i] ?? "");
        }));
      } else {
        let caption = this.heading(identity(selected)) + this.muted(" · ") + formatKeyHint(["Tab", identity(other)], this.theme);
        if (visibleWidth(caption) > layout.innerWidth) {
          const compact = (row: Row) => `${letter(row)}#${row.record.id}`;
          caption = this.heading(compact(selected)) + " " + formatKeyHint(["Tab", compact(other)], this.theme);
        }
        body = [caption, ...this.pane(selected, layout.innerWidth, height - 1)];
      }
    } else {
      const empty = this.usage ? "No records yet. Return to Preview to create a prompt."
        : this.actions.records().some((record) => record.archivedAt !== undefined)
          ? "No current prompts. History is still available in Usage. Press → to view it, or n to create a prompt."
          : "No current prompts. Press n to create one. Usage contains current and historical records.";
      const right = selected ? this.pane(selected, rightWidth, height) : this.wrapped(this.muted(empty), rightWidth);
      body = Array.from({ length: height }, (_, i) => {
        if (!split) return this.inspecting || this.reading || this.preferenceFocus || !rows.length ? right[i] ?? "" : list[i] ?? "";
        const line = list[i] ?? "";
        return line + " ".repeat(Math.max(0, leftWidth - visibleWidth(line))) + this.muted(" │ ") + (right[i] ?? "");
      });
    }
    const action = !this.inspecting && selected?.original && selected.record.status === "unsent" && (this.usage || selected.record.archivedAt === undefined) ? "Optimize" : "Inspect";
    const restored = selected?.record.input.contextUnavailable;
    const primary: KeyHint[] = this.inspecting ? [["i", restored ? "Copy to current" : "Edit original"], ...(!restored ? [["m", "Run model"] as const] : [])]
      : [["Enter", action], ["i", restored ? "Copy to current" : "Edit original"], ["n", "New"], ...(!restored ? [["m", selected ? "Run model" : "Model"] as const] : [])];
    if (inline) primary.splice(1, 0, ["Tab", layout.innerWidth < 56 ? "Preferences" : "Choose preferences"]);
    if (this.canOpenPreferences()) primary.splice(this.inspecting ? 0 : inline ? 2 : 1, 0, ["p", inline ? "Manage / more" : "Preferences"]);
    if (selected && !selected.original && pending(selected.record)) primary.unshift(["x", "Stop"]);
    if (selected && !selected.original && selected.record.candidate) {
      primary.unshift(...(this.inspecting ? [["s", "Send to Pi"] as const] : []));
      primary.unshift(["a", "Accept"]);
    }
    if (selected && this.actions.deleteRecords) primary.push(["d", "Delete"]);
    // Reserve both focus labels so Tab never shifts columns or changes which hints fit.
    const focusAction = (this.reading ? "Select" : "Read").padEnd("Select".length);
    const secondary: KeyHint[] = [["Esc", "Back"], ["?", layout.innerWidth < 56 ? "Help" : "Actions"], ...(this.usage && this.actions.historyStorage ? [["b", "Storage"] as const] : []), ...(!this.inspecting && selected && !selected.original && selected.record.candidate && !restored && this.actions.revise ? [["f", "Revise"] as KeyHint] : []), ...(previewDetails ? [["o", this.original ? "Result" : "Reference"] as KeyHint] : []), ...(inline ? [["o", this.reading ? "Select" : "Read original"] as KeyHint] : other || (!this.inspecting && !this.retainedEarlier) ? [["Tab", other ? "Switch result" : focusAction] as KeyHint] : [])];
    if (this.inspecting && selected && !selected.original && selected.record.candidate) {
      secondary.push(...(selected.records.some((record) => record.id !== selected.record.id && record.candidate) ? [["c", other ? "Next comparison" : "Compare"] as KeyHint] : []), ["e", "Edit result"], ...(!restored ? [["f", "Revise"] as const] : []));
    }
    const expansion = this.canExpand() && this.expansionHint?.();
    if (expansion) secondary.splice(this.usage ? 3 : 2, 0, expansion);
    const compact = (hints: KeyHint[]): KeyHint[] => hints.map(([key, label]) => [key === "Enter" ? "↵" : key, label === "Send to Pi" ? "Send" : label]);
    const footer = layout.innerWidth < 56
      ? [fittingKeyHints(compact(primary), layout.innerWidth, this.theme, layout.innerWidth < 30 ? " " : " · "), fittingKeyHints(secondary, layout.innerWidth, this.theme, layout.innerWidth < 30 ? " " : " · ")]
      : alignedKeyHints([primary, secondary], layout.innerWidth, this.theme);
    if (layout.footerHeight === 1) footer[0] = fittingKeyHints([["Esc", "Back"], ["?", "Help"], ...compact(primary)], layout.innerWidth, this.theme, " ");
    const title = this.inspecting ? (other ? "Compare results" : "Prompt details") : this.usage ? "Usage · All rounds" : "Prompt refine · Tasks";
    const feedback = this.notice ? this.theme.fg(this.noticeColor, sanitizeTerminalText(this.notice)) : "";
    let inspectionSubtitle = "";
    if (this.inspecting && selected) {
      const scroll = formatKeyHint(["↑↓", `scroll${previewDetails ? (this.original ? " reference" : " result") : ""}`], this.theme);
      const reference = previewDetails ? formatKeyHint(["o", this.original ? "Result" : "Reference"], this.theme) : "";
      const prefix = !selected.original && layout.innerWidth >= 48 ? this.muted("Selected: ") : "";
      const identity = !selected.original ? `#${selected.record.id} ${selected.record.input.model.id}` : "Original prompt";
      const fullHints = scroll + (reference ? this.muted(" · ") + reference : "");
      let hints = visibleWidth(prefix + fullHints) + 15 <= layout.innerWidth ? fullHints : reference || scroll;
      if (visibleWidth(prefix + hints) + 7 > layout.innerWidth) {
        hints = previewDetails ? formatKeyHint(["o", this.original ? "Result" : "Ref"], this.theme) : formatKeyHint(["↑↓", ""], this.theme);
      }
      const space = Math.max(0, layout.innerWidth - visibleWidth(prefix + hints) - 3);
      const label = stripVTControlCharacters(truncateToWidth(sanitizeTerminalText(identity), space, "…"));
      inspectionSubtitle = prefix + this.heading(label) + this.muted(" · ") + hints;
    }
    const subtitle = this.referenceOnly ? this.muted("Read-only reference") : this.notice ? feedback : this.retainedEarlier
      ? this.muted(layout.innerWidth < 32 ? "Earlier → Usage" : layout.innerWidth < 72
        ? "Earlier · Usage → · Esc current" : "Earlier · kept open · Esc returns to current · History in Usage →") : this.inspecting
      ? inspectionSubtitle
      : this.muted(`${this.usage ? "Current + history · " : ""}${rows.filter((row) => row.original).length} prompts · ${rows.filter((row) => !row.original).length} runs · `)
        + formatKeyHint(["↑↓", this.reading ? "scroll" : "select"], this.theme) + this.muted(` · Run: ${this.actions.launchModel?.() ?? "selected model"}`);
    const earlier = this.usage ? [] : this.actions.records().filter((record) => record.archivedAt !== undefined);
    const earlierPending = earlier.filter(pending).length;
    const earlierCount = new Set(earlier.map((record) => record.taskId)).size;
    const earlierLabel = `${earlierCount} earlier prompt${earlierCount === 1 ? "" : "s"}`;
    const historyHint = layout.innerWidth < 32 ? "History → Usage"
      : layout.innerWidth < 72 ? `History → Usage · ${earlierPending ? `${earlierPending} active` : earlierLabel}`
      : `Current round · History → Usage · ${earlierPending ? `${earlierPending} running / queued · ` : ""}${earlierLabel}`;
    const showHistoryHint = earlier.length > 0 && !this.retainedEarlier && !this.notice && !this.inspecting && !this.referenceOnly;
    // Keep launch-model metadata and the selected run identity visible: history
    // navigation shares the title, not their subtitle or the result body.
    const identity = this.retainedEarlier && selected && !selected.original
      ? this.muted(" · ") + this.heading(`#${selected.record.id} ${selected.record.input.model.id}`) : "";
    const header = [showHistoryHint
      ? (layout.innerWidth >= 72 ? this.heading(title) + this.muted(` · ${historyHint}`) : this.muted(historyHint))
      : this.heading(title) + identity, subtitle];
    const historyStatus = this.retainedEarlier || showHistoryHint;
    if (historyStatus && layout.headerHeight < 2 && !this.notice) {
      const status = showHistoryHint ? this.muted(historyHint) : subtitle;
      if (layout.headerHeight === 1) header[0] = status;
      else body = [status, ...body];
    }
    if (!inline && !this.notice && !this.referenceOnly && this.canChoosePreferences(selected)) {
      const summary = this.muted(this.preferenceSummary(selected!.record));
      header[1] = summary + this.muted(" · ") + subtitle;
      if (layout.headerHeight === 1) header[0] = summary;
    }
    if (this.notice && !this.referenceOnly && layout.headerHeight < 2) {
      if (layout.headerHeight === 1) header[0] = truncateToWidth(feedback, layout.innerWidth, "…");
      else body = [feedback, ...body];
    }
    const visibleTabs = layout.headerHeight === 0 && (this.notice || historyStatus) ? [] : tabs;
    // Retain source geometry in Revise, but hide actions while its editor owns focus.
    return panelFrame(layout, header,
      [...visibleTabs, ...body], this.referenceOnly ? [] : footer, (text) => this.muted(text),
      { footerAfterBodyRows: visibleTabs.length });
  }
}
