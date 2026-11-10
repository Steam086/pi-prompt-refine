import { stripVTControlCharacters } from "node:util";
import { matchesKey, parseKey, truncateToWidth, visibleWidth, type KeybindingsManager, type KeyId } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { RefineRecord } from "./history.js";
import type { HistoryStorageStatus } from "./history-store.js";
import { panelFrame, panelLayout, workspaceTabs, type PanelLayoutProvider } from "./panel-layout.js";
import { alignedKeyHints, fittingKeyHints, formatKeyHint, type KeyHint } from "./key-hints.js";
import { sanitizeTerminalText } from "./presentation.js";
import { selectionWindow } from "./selection-window.js";
import type { InlinePreferences } from "./inline-preferences.js";
import { TaskContent, pending, type TaskRow as Row } from "./ui/task-content.js";
import { renderTaskDocument } from "./ui/task-documents.js";
import { renderInactivePreferences, renderTaskPreferences } from "./ui/task-preferences.js";

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
  private readonly content: TaskContent;
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
  ) { this.content = new TaskContent(theme); }
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
      : this.paneHeader(row, rightWidth).length + 3 + this.content.wrapped(sanitizeTerminalText(row.record.candidate?.text ?? row.record.input.draft), rightWidth).length;
    return Math.max(rows.length, summary);
  }
  invalidate(): void { this.content.invalidate(); }
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
  private headerOptions(row: Row) {
    return { inline: !!this.inline(row), preferences: !!this.actions.preferences,
      inspecting: this.inspecting, referenceOnly: this.referenceOnly };
  }
  private originalHeight(row: Row, width: number): number {
    return this.content.originalHeight(row, width, this.headerOptions(row));
  }
  private paneHeader(row: Row, width: number): string[] {
    return this.content.paneHeader(row, width, this.headerOptions(row));
  }
  private pane(row: Row, width: number, height: number, active = true, previewDetails = false, showInline = true): string[] {
    const inline = showInline && this.inline(row);
    if (inline) return renderInactivePreferences(inline, width, height, this.originalHeight(row, width),
      (bounded) => this.pane(row, width, bounded, active, false, false));
    const key = this.rowKey(row);
    if (previewDetails) this.position.scrolls ??= {};
    const result = this.content.pane(row, width, height, {
      ...this.headerOptions(row), original: this.original, usage: this.usage,
      scroll: active ? this.position.scroll ?? 0 : this.position.scrolls?.[key] ?? 0,
      referenceScroll: this.position.scrolls?.[`${key}-reference`] ?? 0,
    }, previewDetails);
    if (active) {
      for (const { reference, offset } of result.offsets) this.rememberRenderedScroll(`${key}${reference ? "-reference" : ""}`, offset);
      this.viewport = result.viewport;
    }
    return result.lines;
  }
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
  render(width: number, _empty?: () => string[]): string[] {
    if (width < 1) return [];
    const layout = this.layout(width);
    if (this.document) return this.renderDocument(width);
    if (this.deletion) {
      const body = this.content.wrapped(this.theme.fg("warning", `Delete ${this.deletion.label}?`) +
        "\n\nRunning requests will be stopped; queued requests will be removed.\nThis removes Refine history. Pi editor and conversation stay unchanged.", layout.innerWidth);
      return panelFrame(layout, [this.content.heading("Delete request"), this.content.muted("Confirmation required")],
        body, [fittingKeyHints([["Esc / n", "Cancel"], ["y", "Delete"]], layout.innerWidth, this.theme)],
        (text) => this.content.muted(text), { footerAfterBodyRows: 0 });
    }
    const tabs = workspaceTabs(layout, this.usage ? "Usage" : "Preview", this.theme, !this.referenceOnly && !this.preferenceFocus);
    const height = Math.max(1, layout.bodyHeight - tabs.length);
    const rows = this.entries();
    const selected = this.selected(rows);
    const inline = this.inline(selected);
    this.actions.inlinePreferences?.setTarget(inline ? selected!.record.id : undefined, this.preferenceFocus);
    if (inline && this.preferenceFocus && selected) return renderTaskPreferences(selected, inline, layout, tabs, this.theme, this.content,
      (columns, rows) => this.pane(selected, columns, rows, true, false, false), this.canExpand() ? this.expansionHint?.() : undefined);
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
      const badge = this.content.badge(record);
      const model = stripVTControlCharacters(truncateToWidth(sanitizeTerminalText(record.input.model.id), Math.max(1, leftWidth - visibleWidth(prefix + badge) - 1), "…"));
      const label = row.original
        ? `${active ? "›" : " "} ${record.status === "unsent" ? `○ Unsent ·${record.input.preferences?.length ? ` P:${record.input.preferences.length} ·` : ""}` : "▾"} ${old ? "Earlier · " : ""}${record.input.draft.replace(/\s+/g, " ") || "Empty prompt"}`
        : `${prefix}${model}${" ".repeat(Math.max(1, leftWidth - visibleWidth(prefix + model + badge)))}${badge}`;
      const clean = stripVTControlCharacters(truncateToWidth(sanitizeTerminalText(label), leftWidth, "…"));
      let text: string;
      if (row.original) {
        const earlierAt = old ? clean.indexOf("Earlier · ") : -1;
        text = earlierAt < 0 ? this.theme.fg("text", clean)
          : this.theme.fg("text", clean.slice(0, earlierAt)) + this.content.muted("Earlier · ") + this.theme.fg("text", clean.slice(earlierAt + 10));
      } else {
        const badgeAt = Math.min(clean.length, label.length - badge.length);
        const status = clean.slice(badgeAt);
        text = this.theme.fg("text", clean.slice(0, badgeAt))
          + (status.startsWith("⚠") ? this.theme.fg("warning", "⚠") + this.theme.fg(this.content.color(record), status.slice(1))
            : this.theme.fg(this.content.color(record), status));
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
        const label = truncateToWidth(this.content.heading(identity(selected)), half, "…");
        body = [label + " ".repeat(Math.max(0, half - visibleWidth(label))) + this.content.muted(" │ ") + this.content.heading(identity(other))];
        body.push(...Array.from({ length: height - 1 }, (_, i) => {
          const line = right[i] ?? "";
          return line + " ".repeat(Math.max(0, half - visibleWidth(line))) + this.content.muted(" │ ") + (peer[i] ?? "");
        }));
      } else {
        let caption = this.content.heading(identity(selected)) + this.content.muted(" · ") + formatKeyHint(["Tab", identity(other)], this.theme);
        if (visibleWidth(caption) > layout.innerWidth) {
          const compact = (row: Row) => `${letter(row)}#${row.record.id}`;
          caption = this.content.heading(compact(selected)) + " " + formatKeyHint(["Tab", compact(other)], this.theme);
        }
        body = [caption, ...this.pane(selected, layout.innerWidth, height - 1)];
      }
    } else {
      const empty = this.usage ? "No records yet. Return to Preview to create a prompt."
        : this.actions.records().some((record) => record.archivedAt !== undefined)
          ? "No current prompts. History is still available in Usage. Press → to view it, or n to create a prompt."
          : "No current prompts. Press n to create one. Usage contains current and historical records.";
      const right = selected ? this.pane(selected, rightWidth, height) : this.content.wrapped(this.content.muted(empty), rightWidth);
      body = Array.from({ length: height }, (_, i) => {
        if (!split) return this.inspecting || this.reading || this.preferenceFocus || !rows.length ? right[i] ?? "" : list[i] ?? "";
        const line = list[i] ?? "";
        return line + " ".repeat(Math.max(0, leftWidth - visibleWidth(line))) + this.content.muted(" │ ") + (right[i] ?? "");
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
      const prefix = !selected.original && layout.innerWidth >= 48 ? this.content.muted("Selected: ") : "";
      const identity = !selected.original ? `#${selected.record.id} ${selected.record.input.model.id}` : "Original prompt";
      const fullHints = scroll + (reference ? this.content.muted(" · ") + reference : "");
      let hints = visibleWidth(prefix + fullHints) + 15 <= layout.innerWidth ? fullHints : reference || scroll;
      if (visibleWidth(prefix + hints) + 7 > layout.innerWidth) {
        hints = previewDetails ? formatKeyHint(["o", this.original ? "Result" : "Ref"], this.theme) : formatKeyHint(["↑↓", ""], this.theme);
      }
      const space = Math.max(0, layout.innerWidth - visibleWidth(prefix + hints) - 3);
      const label = stripVTControlCharacters(truncateToWidth(sanitizeTerminalText(identity), space, "…"));
      inspectionSubtitle = prefix + this.content.heading(label) + this.content.muted(" · ") + hints;
    }
    const subtitle = this.referenceOnly ? this.content.muted("Read-only reference") : this.notice ? feedback : this.retainedEarlier
      ? this.content.muted(layout.innerWidth < 32 ? "Earlier → Usage" : layout.innerWidth < 72
        ? "Earlier · Usage → · Esc current" : "Earlier · kept open · Esc returns to current · History in Usage →") : this.inspecting
      ? inspectionSubtitle
      : this.content.muted(`${this.usage ? "Current + history · " : ""}${rows.filter((row) => row.original).length} prompts · ${rows.filter((row) => !row.original).length} runs · `)
        + formatKeyHint(["↑↓", this.reading ? "scroll" : "select"], this.theme) + this.content.muted(` · Run: ${this.actions.launchModel?.() ?? "selected model"}`);
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
      ? this.content.muted(" · ") + this.content.heading(`#${selected.record.id} ${selected.record.input.model.id}`) : "";
    const header = [showHistoryHint
      ? (layout.innerWidth >= 72 ? this.content.heading(title) + this.content.muted(` · ${historyHint}`) : this.content.muted(historyHint))
      : this.content.heading(title) + identity, subtitle];
    const historyStatus = this.retainedEarlier || showHistoryHint;
    if (historyStatus && layout.headerHeight < 2 && !this.notice) {
      const status = showHistoryHint ? this.content.muted(historyHint) : subtitle;
      if (layout.headerHeight === 1) header[0] = status;
      else body = [status, ...body];
    }
    if (!inline && !this.notice && !this.referenceOnly && this.canChoosePreferences(selected)) {
      const summary = this.content.muted(this.content.preferenceSummary(selected!.record));
      header[1] = summary + this.content.muted(" · ") + subtitle;
      if (layout.headerHeight === 1) header[0] = summary;
    }
    if (this.notice && !this.referenceOnly && layout.headerHeight < 2) {
      if (layout.headerHeight === 1) header[0] = truncateToWidth(feedback, layout.innerWidth, "…");
      else body = [feedback, ...body];
    }
    const visibleTabs = layout.headerHeight === 0 && (this.notice || historyStatus) ? [] : tabs;
    // Retain source geometry in Revise, but hide actions while its editor owns focus.
    return panelFrame(layout, header,
      [...visibleTabs, ...body], this.referenceOnly ? [] : footer, (text) => this.content.muted(text),
      { footerAfterBodyRows: visibleTabs.length });
  }
}
