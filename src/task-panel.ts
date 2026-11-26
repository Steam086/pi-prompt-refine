import { stripVTControlCharacters } from "node:util";
import { matchesKey, parseKey, sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi, type KeybindingsManager, type KeyId, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { ReadingMouse, type ReadingRegion } from "./ui/reading-mouse.js";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { selectTaskOriginal, taskGroups, type TaskDisplayRecord } from "./history.js";
import { runId, taskId } from "./app/operation-contract.js";
import type { HistoryStorageStatus } from "./history-store.js";
import { fittingHints, focusLabel, panelConfirmation, panelHeader, panelLayout, workspaceTabs, type PanelLayoutProvider } from "./panel-layout.js";
import { confirmationKeyHints, fittingKeyHints, passiveHeaderHints, type KeyHint } from "./key-hints.js";
import { sanitizeTerminalText } from "./presentation.js";
import { selectionWindow } from "./selection-window.js";
import type { InlinePreferences } from "./inline-preferences.js";
import { TaskContent, pending, type TaskRow as Row } from "./ui/task-content.js";
import { renderTaskDocument } from "./ui/task-documents.js";
import { renderInactivePreferences, renderTaskPreferences } from "./ui/task-preferences.js";

export interface TaskPanelActions {
  records(): readonly TaskDisplayRecord[];
  elapsedSeconds?(id: number): number | undefined;
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
  sessionPreferences?: boolean;
  launchModel?(): string;
  showOptimizerQuota?(): boolean;
  historyStorage?(): HistoryStorageStatus;
}
export interface TaskPanelPosition {
  selectedId?: number;
  selectedTaskId?: number;
  scroll?: number;
  scrolls?: Record<string, number>;
  topRowKey?: string;
}

interface TaskEntries {
  source: readonly TaskDisplayRecord[];
  rows: Row[];
  positions: Map<string, number>;
  prompts: number;
  earlierCount: number;
  earlierPending: number;
}

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
  private listCapacity?: number;
  private listSelectionKey?: string;
  private top = 0;
  private navigationDirection = 1;
  private readonly projections = new Map<boolean, TaskEntries>();
  private rowLines = new WeakMap<Row, { width: number; height: number; elapsed?: number; variants: Map<string, string[]> }>();
  private notice = "";
  private noticeColor: "muted" | "warning" | "error" = "muted";
  private readonly readingMouse = new ReadingMouse();
  private readingRegions: ReadingRegion[] = [];
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
    private readonly content = new TaskContent(theme),
  ) {}
  canExpand(): boolean { return !this.referenceOnly && !this.deletion && !this.document &&
    (!this.preferenceFocus || this.actions.inlinePreferences?.hints !== "search"); }
  /** Initial tree/summary demand only. Never select, render or clamp a live pane. */
  preferredBodyHeight(innerWidth: number): number {
    const entries = this.entries();
    const row = this.rowAt(entries, this.selectionKey()) ?? this.defaultRow(entries);
    if (!row) return 3;
    const rightWidth = innerWidth >= 72 ? innerWidth - Math.min(innerWidth >= 120 ? 48 : 36, Math.floor(innerWidth / 3)) - 3 : innerWidth;
    const inline = this.inline(row);
    const summary = row.original ? this.originalHeight(row, rightWidth) + (inline ? 1 + inline.preferredHeight(row.record.id) : 0)
      : this.paneHeader(row, rightWidth).length + 3 + this.content.wrapped(sanitizeTerminalText(row.record.candidate?.text ?? row.record.input.draft), rightWidth).length;
    return Math.max(entries.rows.length, summary);
  }
  invalidate(): void {
    this.content.invalidate();
    this.rowLines = new WeakMap();
  }
  setNotice(text: string, color: "muted" | "warning" | "error" = "muted"): void { this.notice = text; this.noticeColor = color; }
  openList(): void {
    this.inspecting = false; this.compareId = undefined; this.reading = false; this.preferenceFocus = false; this.original = false;
    if (this.retainedEarlier) this.viewedRow = undefined;
    this.retainedEarlier = false;
  }
  /** Preserve the source and reading position while a revision owns focus. */
  snapshot(referenceOnly = false): TaskPanel {
    const records = Object.freeze(this.actions.records().map((record) => ({
      ...record, elapsedSeconds: this.elapsedSeconds(record), input: { ...record.input },
      candidate: record.candidate && { ...record.candidate },
    })));
    const appliedId = this.actions.appliedId();
    const panel = new TaskPanel({ ...this.actions, elapsedSeconds: undefined, inlinePreferences: undefined,
      records: () => records, appliedId: () => appliedId },
      this.theme, this.rows, this.keys, this.usage, structuredClone(this.position), this.layout);
    panel.referenceOnly = referenceOnly;
    panel.inspecting = this.inspecting; panel.compareId = this.compareId; panel.reading = this.reading;
    panel.original = this.original; panel.top = this.top; panel.navigationDirection = this.navigationDirection;
    panel.viewedRow = this.viewedRow; panel.retainedEarlier = this.retainedEarlier;
    panel.notice = this.notice; panel.noticeColor = this.noticeColor;
    return panel;
  }
  private entries(allRounds = false, history = this.actions.records()): TaskEntries {
    const all = allRounds || this.usage;
    const cached = this.projections.get(all);
    if (cached?.source === history) return cached;
    const groups = taskGroups(history, all);
    const rows = groups.flatMap((records) => {
      const source = selectTaskOriginal(records)!;
      const children = records.filter((r) => r.status !== "unsent").sort((a, b) => b.id - a.id);
      return [{ record: source, original: true, records },
        ...children.map((record) => ({ record, original: false, records }))];
    });
    const earlier = this.usage ? [] : history.filter((record) => record.archivedAt !== undefined);
    const entries = { source: history, rows, prompts: groups.length,
      positions: new Map(rows.map((row, index) => [this.rowKey(row), index])),
      earlierCount: new Set(earlier.map((record) => record.taskId)).size,
      earlierPending: earlier.filter(pending).length };
    // Published journal snapshots are immutable. Other readers may update rows in place.
    if (Object.isFrozen(history)) this.projections.set(all, entries);
    return entries;
  }
  private rowKey(row: Row): string { return row.original ? taskId(row.record.taskId) : runId(row.record.id); }
  private selectionKey(): string {
    return this.position.selectedTaskId !== undefined ? taskId(this.position.selectedTaskId)
      : this.position.selectedId !== undefined ? runId(this.position.selectedId) : "";
  }
  private rowAt(entries: TaskEntries, key: string): Row | undefined {
    return entries.rows[entries.positions.get(key) ?? -1];
  }
  private defaultRow(entries: TaskEntries): Row | undefined {
    const appliedId = this.actions.appliedId();
    return (appliedId === undefined ? undefined : this.rowAt(entries, runId(appliedId))) ?? entries.rows[0];
  }
  private elapsedSeconds(record: TaskDisplayRecord): number | undefined {
    return (record.status === "generating" ? this.actions.elapsedSeconds?.(record.id) : undefined) ?? record.elapsedSeconds;
  }
  private withElapsed(row: Row): Row {
    const elapsedSeconds = this.elapsedSeconds(row.record);
    return elapsedSeconds === row.record.elapsedSeconds ? row : { ...row, record: { ...row.record, elapsedSeconds } };
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
  private selected(entries = this.entries()): Row | undefined {
    const key = this.selectionKey();
    let row = this.rowAt(entries, key);
    if (!row && !this.usage && this.viewedRow && this.rowKey(this.viewedRow) === key) {
      row = this.rowAt(this.entries(true, entries.source), key);
      if (row?.record.archivedAt !== undefined) {
        this.retainedEarlier = true;
        this.viewedRow = row;
        return row;
      }
    }
    this.retainedEarlier = false;
    if (!row) {
      row = this.defaultRow(entries);
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
    return !!(row?.original && row.record.status === "unsent" && (this.usage || row.record.archivedAt === undefined)
      && !row.record.input.contextUnavailable && this.actions.preferences);
  }
  private inline(row?: Row): InlinePreferences | undefined {
    return !this.usage && !this.referenceOnly && !this.inspecting && this.canChoosePreferences(row) &&
      this.actions.inlinePreferences?.available(row!.record.id) ? this.actions.inlinePreferences : undefined;
  }
  private refineModelLabel(width: number): string {
    const model = sanitizeTerminalText(this.actions.launchModel?.() ?? "selected model").replace(/\n/g, " ");
    const id = model.slice(model.indexOf("/") + 1) || model;
    // Preserve the qualified identity first, then the full ID before truncating anything.
    const choices = [["Refine model: ", model], ["Model: ", model], ["Model: ", id], ["", id]] as const;
    const [label, name] = choices.find(([label, name]) => visibleWidth(label + name) <= width)
      ?? ["", stripVTControlCharacters(truncateToWidth(id, width, "…"))];
    return (label ? this.theme.fg("muted", label) : "") + this.theme.fg("text", name);
  }
  private runOriginal(row: Row): void {
    this.actions.run(row.record.id);
    // Failed starts retain the original and focus. Successful starts follow only
    // this explicit target, never whichever candidate completed in the meantime.
    const started = this.rowAt(this.entries(), runId(row.record.id));
    if (started) {
      this.preferenceFocus = false; this.reading = false;
      this.actions.inlinePreferences?.setTarget(undefined, false);
      this.select(started);
    }
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
        this.content.invalidate();
        this.setNotice(removed ? "Deleted" : "Request changed or send pending; deletion cancelled", removed ? "muted" : "warning");
      } else if (key === "n" || key === "q" || key === "ctrl+\\" || this.keys.matches(data, "tui.select.cancel")) {
        this.deletion = undefined;
      }
      return true;
    }
    const entries = this.entries();
    const inlineRow = this.selected(entries);
    if (this.retainedEarlier && (key === "q" || key === "ctrl+\\" || this.keys.matches(data, "tui.select.cancel"))) {
      this.openList(); this.selected(entries);
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
    const row = inlineRow;
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
    if (this.inspecting && (key === "q" || key === "ctrl+\\" || this.keys.matches(data, "tui.select.cancel"))) {
      this.openList();
      return true;
    }
    if (key === "tab") {
      if (this.compareId !== undefined && row) {
        const other = this.rowAt(this.entries(this.retainedEarlier, entries.source), runId(this.compareId));
        if (other) { this.compareId = row.record.id; this.select(other); }
      } else if (row && !this.inspecting && !this.retainedEarlier) this.reading = !this.reading;
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
    const page = this.reading || this.inspecting || this.retainedEarlier ? this.viewport : this.listCapacity ?? 1;
    const delta = key === "up" ? -1 : key === "down" ? 1 : key === "pageup" ? -page : key === "pagedown" ? page : 0;
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
        const { rows, positions } = entries;
        const index = positions.get(this.selectionKey()) ?? -1;
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
  private headerOptions(row: Row) {
    return { inline: !!this.inline(row), preferences: !!this.actions.preferences,
      taskPreview: !this.usage && !this.inspecting && !this.referenceOnly && !this.preferenceFocus && !this.retainedEarlier,
      inspecting: this.inspecting, referenceOnly: this.referenceOnly };
  }
  private originalHeight(row: Row, width: number): number {
    return this.content.originalHeight(row, width, this.headerOptions(row));
  }
  private paneHeader(row: Row, width: number): string[] {
    return this.content.paneHeader(this.withElapsed(row), width, this.headerOptions(row));
  }
  private pane(row: Row, width: number, height: number, active = true, previewDetails = false, showInline = true,
    origin?: { x: number; y: number }): string[] {
    const inline = showInline && this.inline(row);
    if (inline) return renderInactivePreferences(inline, width, height, this.originalHeight(row, width),
      (bounded) => this.pane(row, width, bounded, active, false, false, origin));
    const key = this.rowKey(row);
    if (previewDetails) this.position.scrolls ??= {};
    const result = this.content.pane(this.withElapsed(row), width, height, {
      ...this.headerOptions(row), original: this.original, usage: this.usage,
      scroll: active ? this.position.scroll ?? 0 : this.position.scrolls?.[key] ?? 0,
      referenceScroll: this.position.scrolls?.[`${key}-reference`] ?? 0,
    }, previewDetails);
    if (active) {
      for (const { reference, offset } of result.offsets) this.rememberRenderedScroll(`${key}${reference ? "-reference" : ""}`, offset);
      this.viewport = result.viewport;
    }
    if (origin && height > 0) {
      for (const document of result.documents) {
        const scrollKey = document.reference ? `${key}-reference` : key;
        let offset = document.offset;
        this.readingRegions.push({
          key: scrollKey, x: origin.x + document.x, y: origin.y + document.y, width: document.width, lines: document.lines,
          scroll: (delta) => {
            offset = Math.max(0, Math.min(document.maxOffset, offset + delta));
            (this.position.scrolls ??= {})[scrollKey] = offset;
            this.renderedScrolls.delete(scrollKey);
            if (active && !document.reference) this.position.scroll = offset;
          },
        });
      }
    }
    return result.lines;
  }
  handleReadingMouse(event: TuiMouseEvent, copy: (text: string) => void) {
    return this.readingMouse.handle(event, copy);
  }
  clearReadingSelection(): void { this.readingMouse.clear(); }
  private renderDocument(width: number): string[] {
    const row = this.document!.kind === "help" ? this.selected() : undefined;
    const result = renderTaskDocument(this.layout(width), this.document!, {
      row, storage: this.actions.historyStorage, notice: this.notice, noticeColor: this.noticeColor,
      inspecting: this.inspecting, reading: this.reading, retainedEarlier: this.retainedEarlier, usage: this.usage,
      compareId: this.compareId, inline: !!this.inline(row), preferences: this.canOpenPreferences(),
      revise: !!this.actions.revise, deleteRecords: !!this.actions.deleteRecords, expansion: this.document!.kind === "help" ? this.expansionHint?.() : undefined,
    }, this.theme, this.content);
    this.document!.scroll = result.scroll;
    this.viewport = result.viewport;
    return result.lines;
  }
  private renderList(entries: TaskEntries, selected: Row | undefined, width: number, height: number, rowHeight: number): string[] {
    const { rows, positions } = entries;
    const selectedKey = this.selectionKey();
    const selectedIndex = positions.get(selectedKey) ?? 0;
    const capacity = Math.max(1, Math.floor(height / rowHeight));
    const anchored = Math.min(positions.get(this.position.topRowKey ?? "") ?? this.top, Math.max(0, rows.length - capacity));
    const keepsSelection = selectedIndex >= anchored && selectedIndex < anchored + capacity;
    const sameSelection = this.listSelectionKey === undefined || this.listSelectionKey === selectedKey;
    this.top = this.position.topRowKey && sameSelection && keepsSelection && (this.listCapacity === undefined || this.listCapacity === capacity)
      ? anchored : selectionWindow(rows.length, selectedIndex, capacity, anchored, undefined, 0, this.navigationDirection).start;
    this.listSelectionKey = selectedKey;
    this.listCapacity = capacity;
    const topRow = rows[this.top];
    this.position.topRowKey = topRow && this.rowKey(topRow);
    return rows.slice(this.top, this.top + capacity).flatMap((row) => {
      const active = row === selected;
      const focusedTaskOriginal = row.original && !this.usage && row.record.taskId === selected?.record.taskId;
      const summarizeCompact = focusedTaskOriginal && !selected?.original && rowHeight === 1;
      const elapsed = rowHeight > 1 && !row.original ? this.elapsedSeconds(row.record) : undefined;
      const variant = [active, focusedTaskOriginal, summarizeCompact].join(":");
      let cache = this.rowLines.get(row);
      if (!cache || cache.width !== width || cache.height !== rowHeight || cache.elapsed !== elapsed) {
        cache = { width, height: rowHeight, elapsed, variants: new Map() };
        this.rowLines.set(row, cache);
      }
      let lines = cache.variants.get(variant);
      if (!lines) {
        lines = this.renderListRow(row, width, rowHeight, { active, focusedTaskOriginal, summarizeCompact, elapsedSeconds: elapsed });
        cache.variants.set(variant, lines);
      }
      return lines;
    });
  }
  private renderListRow(row: Row, leftWidth: number, rowHeight: number,
    { active, focusedTaskOriginal, summarizeCompact, elapsedSeconds }: {
      active: boolean; focusedTaskOriginal: boolean; summarizeCompact: boolean; elapsedSeconds?: number;
    }): string[] {
    const { record } = row;
    const old = record.archivedAt !== undefined;
    const children = row.records.filter((record) => record.status !== "unsent");
    const lastChild = record.id === Math.min(...children.map((record) => record.id));
    const continuation = children.length > 0 && (row.original || !lastChild) ? "  │" : "   ";
    const prefix = `${active ? "›" : " "} ${lastChild ? "└─" : "├─"} `;
    const badge = this.content.badge(record);
    const ambiguous = !row.original && rowHeight === 1 && row.records.some(({ input }) => input.model.id === record.input.model.id && input.model.provider !== record.input.model.provider);
    const identity = ambiguous ? `#${record.id} ${record.input.model.id} · ${record.input.model.provider}` : record.input.model.id;
    const model = stripVTControlCharacters(truncateToWidth(sanitizeTerminalText(identity), Math.max(1, leftWidth - visibleWidth(prefix + badge) - 1), "…"));
    const draft = record.input.draft.replace(/\s+/g, " ") || "Empty prompt";
    const cleanDraft = summarizeCompact ? sanitizeTerminalText(draft) : draft;
    const summaryWidth = Math.max(1, leftWidth - 4);
    const excerpt = summarizeCompact && visibleWidth(cleanDraft) > summaryWidth
      ? stripVTControlCharacters(truncateToWidth(cleanDraft, Math.ceil(summaryWidth / 2), "…") + sliceByColumn(cleanDraft, visibleWidth(cleanDraft) - Math.floor(summaryWidth / 2), Math.floor(summaryWidth / 2))) : draft;
    const label = row.original
      ? `${active ? "›" : " "} ${record.status === "unsent" ? `○ Unsent ·${record.input.preferences?.length ? ` P:${record.input.preferences.length} ·` : ""}` : "▾"} ${old ? "Earlier · " : ""}${rowHeight > 1 ? "Original prompt" : excerpt}`
      : `${prefix}${model}${" ".repeat(Math.max(1, leftWidth - visibleWidth(prefix + model + badge)))}${badge}`;
    const clean = stripVTControlCharacters(truncateToWidth(sanitizeTerminalText(label), leftWidth, "…"));
    const emphasize = (text: string) => active && rowHeight > 1 ? this.theme.bold(text) : text;
    const primary = (text: string) => this.theme.fg("text", active ? this.theme.bold(text) : text);
    // Selection survives a reading-focus change. Accent only the existing
    // cursor, not model identities, tree guides or semantic status badges.
    const cursor = active && clean.startsWith("›")
      ? this.theme.fg("accent", this.theme.bold("›")) : primary(clean.slice(0, 1));
    let text: string;
    if (row.original) {
      const earlierAt = old ? clean.indexOf("Earlier · ") : -1;
      text = cursor + (earlierAt < 0 ? primary(clean.slice(1))
        : primary(clean.slice(1, earlierAt)) + this.content.muted("Earlier · ") + primary(clean.slice(earlierAt + 10)));
    } else {
      const badgeAt = Math.min(clean.length, label.length - badge.length);
      const gutterEnd = Math.min(visibleWidth(prefix), badgeAt);
      const status = clean.slice(badgeAt);
      text = cursor + primary(clean.slice(1, 2)) + this.content.muted(clean.slice(2, gutterEnd)) + primary(clean.slice(gutterEnd, badgeAt))
        + emphasize(status.startsWith("⚠") ? this.theme.fg("warning", "⚠") + this.theme.fg(this.content.color(record), status.slice(1))
          : this.theme.fg(this.content.color(record), status));
    }
    const highlight = (line: string) => active
      ? this.theme.bg("selectedBg", line + " ".repeat(Math.max(0, leftWidth - visibleWidth(line)))) : line;
    if (rowHeight === 1) return [highlight(text)];
    if (focusedTaskOriginal && children.length) {
      const columns = leftWidth - 4;
      const excerpt = truncateToWidth(sanitizeTerminalText(draft), columns * 2, "…");
      const lines = wrapTextWithAnsi(excerpt, columns);
      const guide = this.content.muted(continuation) + " ";
      return [highlight(text), highlight(guide + this.theme.fg("text", lines[0] ?? "")), lines[1]
        ? highlight(guide + this.theme.fg("text", truncateToWidth(lines.slice(1).join(" "), columns, "…"))) : this.content.muted(continuation.trimEnd())];
    }
    const detail = row.original ? this.theme.fg("text", sanitizeTerminalText(draft))
      : this.content.muted(`#${record.id} · ${record.input.model.provider}${elapsedSeconds !== undefined ? ` · ${elapsedSeconds}s` : ""}`);
    // Keep the parent/sibling spine through secondary lines and spacing,
    // but stop after the final child so separate prompts never join together.
    return [highlight(text),
      highlight(truncateToWidth(this.content.muted(continuation) + (row.original ? " " : "  ") + detail, leftWidth, "…")),
      this.content.muted(continuation.trimEnd())];
  }
  render(width: number, _empty?: () => string[]): string[] {
    this.readingRegions = [];
    return this.readingMouse.render(this.renderPanel(width), this.readingRegions, this.theme);
  }
  private renderPanel(width: number): string[] {
    if (width < 1) return [];
    const layout = this.layout(width);
    if (this.document) return this.renderDocument(width);
    if (this.deletion) {
      const title = this.theme.fg("warning", this.theme.bold(`Delete ${this.deletion.label}?`));
      const hints = confirmationKeyHints(["Esc / n", "Cancel"], ["y", "Delete"], layout.innerWidth, this.theme);
      const details = this.content.wrapped("Running requests will be stopped. Queued requests and saved Refine history will be removed.",
        Math.min(layout.innerWidth, 56));
      return panelConfirmation(layout, title, hints, details, (text) => this.theme.fg("borderMuted", text));
    }
    const tabs = workspaceTabs(layout, this.usage ? "Usage" : "Preview", this.theme);
    const entries = this.entries();
    const { rows, prompts, earlierCount, earlierPending } = entries;
    const selected = this.selected(entries);
    const inline = this.inline(selected);
    this.actions.inlinePreferences?.setTarget(inline ? selected!.record.id : undefined, this.preferenceFocus);
    if (inline && this.preferenceFocus && selected) return renderTaskPreferences(selected, inline, layout, tabs, this.theme, this.content,
      (columns, rows) => this.pane(selected, columns, rows, true, false, false), this.canExpand() ? this.expansionHint?.() : undefined,
      this.actions.showOptimizerQuota?.());
    const previewDetails = this.inspecting && !this.usage && this.compareId === undefined && !!selected && !selected.original && !!selected.record.candidate;
    const other = this.inspecting && this.compareId !== undefined
      ? this.rowAt(this.entries(this.retainedEarlier, entries.source), runId(this.compareId)) : undefined;
    const passiveHints = !this.inspecting && !this.retainedEarlier && !this.referenceOnly;
    const action = !this.inspecting && selected?.original && selected.record.status === "unsent" && (this.usage || selected.record.archivedAt === undefined) ? "Optimize" : "Inspect";
    const restored = selected?.record.input.contextUnavailable;
    const run = selected && !selected.original ? selected.record : undefined;
    const stop = run && pending(run);
    const back: KeyHint = ["Esc", passiveHints ? "Close" : "Back"];
    // Reading the original does not change the action target. Name the result
    // explicitly here, even when the selected result itself is off screen.
    const editorHint = this.inspecting && layout.innerWidth < 44 ? "Editor"
      : this.original && run?.candidate ? "Result to editor only" : "Editor only";
    const compact = (hints: KeyHint[]): KeyHint[] => hints.map(([key, label]) => [key === "Enter" ? "↵" : key, label === "Send to Pi" ? "Send" : label]);
    const actionWidth = layout.innerWidth;
    let footer: string;
    if (passiveHints) {
      const primary: KeyHint[] = !selected ? [["n", "New"]] : [["Enter", action]];
      if (stop) primary.unshift(["x", "Stop"]);
      if (run?.candidate && !this.usage) primary.push(["a", editorHint]);
      // Reserve both focus labels so a focus change never moves or hides other hints.
      const preferences: KeyHint[] = this.actions.sessionPreferences || (!inline && this.canChoosePreferences(selected))
        ? [["p", "Preferences"]] : [];
      const focus: KeyHint[] = inline ? [["Tab", "Preferences"], ["o", (this.reading ? "Select" : "Read original").padEnd("Read original".length)]]
        : selected ? [["Tab", (this.reading ? "Select" : "Read").padEnd("Select".length)]] : [];
      footer = passiveHeaderHints(
        [back, ...primary, ["?", "Help"], ...preferences, ...focus, ["←→", "Tabs"]],
        [actionWidth < 9 || stop && actionWidth < 36 ? ["Esc", ""] : back, ...compact(primary), ["?", "Help"],
          ["←→", actionWidth < 34 ? "" : "Tabs"], ...preferences, ...focus], actionWidth, this.theme);
    } else {
      const primary: KeyHint[] = !selected ? [["n", "New"]] : [
        ...(!this.inspecting ? [["Enter", action] as const] : []),
        ["i", restored ? "Copy to current" : "Edit original"], ...(!this.inspecting ? [["n", "New"] as const] : []),
        ...(!restored ? [["m", "Run model"] as const] : []),
      ];
      if (this.canOpenPreferences()) primary.splice(this.inspecting ? 0 : 1, 0, ["p", "Preferences"]);
      if (stop) primary.unshift(["x", "Stop"]);
      if (run?.candidate) primary.unshift(["a", editorHint], ...(this.inspecting ? [["s", "Send to Pi"] as const] : []));
      if (selected && this.actions.deleteRecords) primary.push(["d", "Delete"]);
      const secondary: KeyHint[] = [];
      if (this.usage && this.actions.historyStorage) secondary.push(["b", "Storage"]);
      if (this.canExpand()) {
        const expansion = this.expansionHint?.();
        if (expansion) secondary.push(expansion);
      }
      if (run?.candidate && !this.inspecting && !restored && this.actions.revise) secondary.push(["f", "Revise"]);
      if (this.inspecting && selected && run?.candidate) {
        if (selected.records.some((record) => record.id !== run.id && record.candidate)) secondary.push(["c", other ? "Next comparison" : "Compare"]);
        secondary.push(["e", "Edit result"], ...(!restored ? [["f", "Revise"] as const] : []));
      }
      const actions = actionWidth < 60 ? compact(primary) : primary;
      const firstActions = run?.candidate && this.inspecting ? actions.slice(0, 2) : actions.slice(0, 1);
      const readingAction: KeyHint | undefined = other ? ["Tab", actionWidth < 64 ? "Switch" : "Switch result"]
        : previewDetails || this.inspecting && this.usage && run?.candidate
          ? ["o", this.original ? "Result" : actionWidth < 48 ? "Ref" : "Reference"] : undefined;
      if (this.inspecting) secondary.unshift(["↑↓", previewDetails ? this.original ? "Scroll reference" : "Scroll result" : "Scroll"]);
      const narrow = actionWidth < 34 && !!run?.candidate && this.inspecting;
      const view: KeyHint[] = readingAction ? [actionWidth < 30 ? [readingAction[0], ""] : readingAction] : [];
      const essential: KeyHint[] = narrow
        ? [["Esc", ""], ["a", "Editor"], ...view, ["s", actionWidth < 23 ? "" : "Send"]]
        : [back, ...firstActions, ...view];
      const help: KeyHint = ["?", actionWidth < 56 && this.inspecting ? "" : "Help"];
      const remaining = actions.filter(([key]) => !essential.some(([shown]) => key === shown));
      const contextual = restored && this.inspecting ? remaining.filter(([key]) => key === "i" || key === "p") : [];
      footer = fittingKeyHints([...essential, ...contextual, help, ...remaining.filter((hint) => !contextual.includes(hint)),
        ...secondary], actionWidth, this.theme, actionWidth < 44 ? " " : " · ");
    }
    const title = this.inspecting ? (other ? "Compare results" : "Prompt details") : this.usage ? "Usage · All rounds" : "Prompt refine · Tasks";
    const feedback = this.notice ? this.theme.fg(this.noticeColor, sanitizeTerminalText(this.notice)) : "";
    const inspectionSubtitle = this.inspecting && run && !other
      ? this.theme.fg("text", stripVTControlCharacters(truncateToWidth(sanitizeTerminalText(`#${run.id} · ${run.input.model.id}`), layout.innerWidth, "…"))) : "";
    const runs = rows.length - prompts;
    const separator = this.content.muted(" · ");
    const model = passiveHints && !this.notice && action === "Optimize" ? this.refineModelLabel(layout.innerWidth) : "";
    const preference = model && !inline && this.canChoosePreferences(selected)
      ? this.content.muted(this.content.preferenceSummary(selected!.record).replace(/\n/g, " ")) : "";
    const hasPreferences = !!selected?.record.input.preferences?.length;
    const browseStatus = fittingHints([
      model,
      hasPreferences ? preference : "",
      selected ? this.content.muted(`${prompts} prompt${prompts === 1 ? "" : "s"} · ${runs} run${runs === 1 ? "" : "s"}`) : "",
      hasPreferences ? "" : preference,
      this.reading && selected ? this.content.muted("↑↓ scroll") : "",
    ].filter(Boolean), layout.innerWidth, separator);
    const subtitle = this.referenceOnly ? this.content.muted("Read-only reference") : this.notice ? feedback : this.retainedEarlier
      ? this.content.muted(layout.innerWidth < 32 ? "Earlier → Usage" : layout.innerWidth < 72
        ? "Earlier · Usage → · Esc current" : "Earlier · kept open · Esc returns to current · History in Usage →") : this.inspecting
      ? inspectionSubtitle : browseStatus;
    const earlierLabel = `${earlierCount} earlier prompt${earlierCount === 1 ? "" : "s"}`;
    const historyHint = layout.innerWidth < 32 ? "History → Usage"
      : layout.innerWidth < 72 ? `History → Usage · ${earlierPending ? `${earlierPending} active` : earlierLabel}`
      : `History → Usage · ${earlierPending ? `${earlierPending} running / queued · ` : ""}${earlierLabel}`;
    const showHistoryHint = earlierCount > 0 && !this.retainedEarlier && !this.notice && !this.inspecting && !this.referenceOnly;
    const identity = this.retainedEarlier && run
      ? this.theme.fg("text", `#${run.id} ${sanitizeTerminalText(run.input.model.id)}`) : "";
    const history = showHistoryHint ? this.content.muted(historyHint) : "";
    const earlier = layout.innerWidth < 72 ? this.content.muted("Earlier · Esc current") : subtitle;
    const status = this.retainedEarlier ? fittingHints([earlier, identity].filter(Boolean), layout.innerWidth, separator)
      : fittingHints([model && subtitle ? subtitle : history, model && subtitle ? history : subtitle].filter(Boolean), layout.innerWidth, separator);
    const header = [this.content.heading(title), status || subtitle];
    const banners: string[] = [];
    const historyStatus = this.retainedEarlier || showHistoryHint;
    if (showHistoryHint && model && status === subtitle && layout.headerHeight > 1) banners.push(history);
    if (historyStatus && layout.headerHeight < 2 && !this.notice) {
      const status = showHistoryHint ? this.content.muted(historyHint) : subtitle;
      if (layout.headerHeight === 1) header[0] = status;
      else banners.push(status);
    }
    if (layout.headerHeight === 1 && model) {
      const combined = header[0] + separator + model;
      header[0] = visibleWidth(combined) <= layout.innerWidth ? combined : model;
    }
    if (this.notice && !this.referenceOnly && layout.headerHeight < 2) {
      if (layout.headerHeight === 1) header[0] = truncateToWidth(feedback, layout.innerWidth, "…");
      else banners.unshift(feedback);
    }
    const quota = passiveHints && !this.notice && action === "Optimize" && !restored && this.actions.showOptimizerQuota?.()
      ? this.content.optimizerQuotaHint(layout.innerWidth) : "";
    if (quota) banners.push(quota);
    const visibleTabs = layout.headerHeight < 2 && (this.notice || historyStatus || model) ? []
      : layout.innerWidth < 32 && (this.inspecting || this.retainedEarlier) ? [] : tabs;
    const chrome = panelHeader(layout, header, visibleTabs, this.referenceOnly ? "" : footer);
    const height = Math.max(1, chrome.layout.bodyHeight - banners.length);
    const split = !!selected && !this.inspecting && !this.retainedEarlier && layout.innerWidth >= 72;
    const leftWidth = split ? Math.min(layout.innerWidth >= 120 ? 48 : 36, Math.floor(layout.innerWidth / 3)) : layout.innerWidth;
    const rightWidth = split ? layout.innerWidth - leftWidth - 3 : layout.innerWidth;
    const rowHeight = split && layout.innerWidth >= 100 && height >= 24 ? 3 : 1;
    const list = !this.inspecting && !this.retainedEarlier && (split || !this.reading && !this.preferenceFocus)
      ? this.renderList(entries, selected, leftWidth, height, rowHeight) : [];
    let body: string[];
    const bodyOrigin = {
      x: chrome.layout.inset,
      y: chrome.layout.topSeparatorHeight + chrome.layout.headerHeight + chrome.layout.separatorHeight + banners.length,
    };
    const origin = (x = 0, y = 0) => ({ x: bodyOrigin.x + x, y: bodyOrigin.y + y });
    // Exactly one layout owns the horizontal split: list + summary, Enter
    // details (result + reference), or Compare. Never nest detail columns inside
    // an existing pane, or render an unused pane that clamps its scroll offset.
    if (this.retainedEarlier && !this.inspecting && selected) {
      body = this.pane(selected, layout.innerWidth, height, true, false, true, bodyOrigin);
    } else if (previewDetails && selected) {
      body = this.pane(selected, layout.innerWidth, height, true, true, true, bodyOrigin);
    } else if (other && selected) {
      const [a, b] = selected.record.id < other.record.id ? [selected, other] : [other, selected];
      const active = (row: Row) => row === selected && !this.referenceOnly;
      const label = (row: Row, compact = false) => `${row === a ? "A" : "B"}${compact ? "" : " · "}#${row.record.id}`;
      if (layout.innerWidth >= 72) {
        const half = Math.floor((layout.innerWidth - 3) / 2);
        const rightWidth = layout.innerWidth - half - 3;
        const left = this.pane(a, half, height - 1, a === selected, false, true, origin(0, 1));
        const right = this.pane(b, rightWidth, height - 1, b === selected, false, true, origin(half + 3, 1));
        const caption = focusLabel(this.theme, half, label(a), active(a));
        body = [caption + " ".repeat(Math.max(0, half - visibleWidth(caption))) + this.content.muted(" │ ")
          + focusLabel(this.theme, rightWidth, label(b), active(b))];
        body.push(...Array.from({ length: height - 1 }, (_, i) => {
          const line = left[i] ?? "";
          return line + " ".repeat(Math.max(0, half - visibleWidth(line))) + this.content.muted(" │ ") + (right[i] ?? "");
        }));
      } else {
        const compact = visibleWidth(`› ${label(a)}   ${label(b)}`) > layout.innerWidth;
        const choice = (row: Row) => (active(row) ? "" : "  ") + focusLabel(this.theme, layout.innerWidth, label(row, compact), active(row));
        const caption = `${choice(a)} ${choice(b)}`;
        body = [caption, ...this.pane(selected, layout.innerWidth, height - 1, true, false, true, origin(0, 1))];
      }
    } else {
      const empty = this.usage ? "No records yet." : "No current prompts.";
      const reading = this.inspecting || this.reading || this.preferenceFocus;
      const right = selected ? this.pane(selected, rightWidth, height, true, false, true,
        split ? origin(leftWidth + 3) : reading ? bodyOrigin : undefined) : this.content.wrapped(this.content.muted(empty), rightWidth);
      body = Array.from({ length: height }, (_, i) => {
        if (!split) return this.inspecting || this.reading || this.preferenceFocus || !rows.length ? right[i] ?? "" : list[i] ?? "";
        const line = list[i] ?? "";
        return line + " ".repeat(Math.max(0, leftWidth - visibleWidth(line))) + this.content.muted(" │ ") + (right[i] ?? "");
      });
    }
    return chrome.render([...banners, ...body], (text) => this.theme.fg("borderMuted", text));
  }
}
