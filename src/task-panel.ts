import { stripVTControlCharacters } from "node:util";
import { parseKey, Text, truncateToWidth, visibleWidth, type KeybindingsManager } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { RefineRecord } from "./history.js";
import { panelFrame, panelLayout, workspaceTabs } from "./panel-layout.js";
import { fittingKeyHints } from "./key-hints.js";
import { sanitizeTerminalText } from "./presentation.js";
import { formatTokenUsage } from "./usage.js";

export interface TaskPanelActions {
  records(): RefineRecord[];
  appliedId(): number | undefined;
  activate(id: number): boolean;
  run(id: number): void;
  stop(id: number): void;
  copy(id: number): void;
  launchModel?(): string;
}
export interface TaskPanelPosition { selectedId?: number; scroll?: number; archived?: boolean }

/** Live, ID-selected task browser. Completion never sorts rows or moves selection. */
export class TaskPanel {
  private reading = false;
  private original = false;
  private viewport = 1;
  private top = 0;
  private notice = "";
  private cached?: { key: string; lines: string[] };
  constructor(
    private readonly actions: TaskPanelActions,
    private readonly theme: Theme,
    private readonly rows: () => number,
    private readonly keys: KeybindingsManager,
    private readonly usage = false,
    private readonly position: TaskPanelPosition = {},
  ) {}
  invalidate(): void { this.cached = undefined; }
  setNotice(text: string): void { this.notice = text; }
  private entries(): RefineRecord[] {
    const records = this.actions.records();
    const current = records.filter((record) => record.archivedAt === undefined);
    // With no current work, retain the older entries instead of presenting a false empty workspace.
    const visible = this.usage || this.position.archived || !current.length ? records : records.filter((record) =>
      record.archivedAt === undefined || record.id === this.position.selectedId);
    const groups = new Map<string, RefineRecord[]>();
    for (const record of visible) {
      const key = `${record.input.roundId}:${record.taskId}`;
      const group = groups.get(key) ?? [];
      group.push(record);
      groups.set(key, group);
    }
    return [...groups.values()].flat();
  }
  private selected(records = this.entries()): RefineRecord | undefined {
    let selected = records.find((record) => record.id === this.position.selectedId);
    if (!selected) {
      selected = records.find((record) => record.id === this.actions.appliedId()) ?? records[0];
      this.position.selectedId = selected?.id;
      this.position.scroll = 0;
    }
    return selected;
  }
  /** Returns false for parent navigation/model/input keys; true for owned actions. */
  handleInput(data: string): boolean {
    const key = parseKey(data)?.toLowerCase();
    if (key) this.notice = "";
    const selected = this.selected();
    if (key === "tab") { this.reading = !this.reading; return true; }
    if (key === "h" && !this.usage) { this.position.archived = !this.position.archived; return true; }
    if (key === "o") { this.original = !this.original; this.position.scroll = 0; return true; }
    if (this.keys.matches(data, "tui.select.confirm")) {
      if (selected) this.actions.activate(selected.id);
      return true;
    }
    if (key === "g" || key === "x" || key === "n") {
      if (selected) {
        if (key === "g") this.actions.run(selected.id);
        else if (key === "x") this.actions.stop(selected.id);
        else this.actions.copy(selected.id);
      }
      return true;
    }
    const delta = key === "up" ? -1 : key === "down" ? 1 : key === "pageup" ? -this.viewport : key === "pagedown" ? this.viewport : 0;
    if (delta) {
      if (this.reading) this.position.scroll = Math.max(0, (this.position.scroll ?? 0) + delta);
      else {
        const records = this.entries();
        const index = records.findIndex((record) => record.id === selected?.id);
        this.position.selectedId = records[Math.max(0, Math.min(records.length - 1, index + delta))]?.id;
        this.position.scroll = 0;
        this.original = false;
      }
      return true;
    }
    // Mutation shortcuts belong to the applied-result view, never a merely selected row.
    if (["a", "e", "f", "s", "[", "]"].includes(key ?? "") && selected?.id !== this.actions.appliedId()) {
      this.notice = "Enter applies a completed result first; Pi editor unchanged.";
      return true;
    }
    return false;
  }
  private badge(record: RefineRecord): string {
    if (record.status === "unsent") return "○ Unsent";
    if (record.status === "queued") return "… Queued";
    if (record.status === "generating") return "◌ Running";
    if (record.status === "error") return record.error === "timeout" ? "! Timed out" : "! Failed";
    if (record.status === "cancelled") return "× Cancelled";
    if (record.id === this.actions.appliedId()) return "✓ Applied";
    return record.kind === "edit" ? "✓ Edited" : "✓ Done";
  }
  render(width: number, empty?: () => string[]): string[] {
    if (width < 1) return [];
    const layout = panelLayout(width, this.rows());
    const tabs = workspaceTabs(layout, this.usage ? "Usage" : "Preview", this.theme);
    const height = Math.max(1, layout.bodyHeight - tabs.length);
    this.viewport = height;
    const records = this.entries();
    if (!records.length && empty) return empty();
    const selected = this.selected(records);
    const split = layout.innerWidth >= 72;
    const leftWidth = split ? Math.min(36, Math.floor(layout.innerWidth / 3)) : layout.innerWidth;
    const rightWidth = split ? layout.innerWidth - leftWidth - 3 : layout.innerWidth;
    const clean = (text: string) => sanitizeTerminalText(text);
    const clip = (text: string, width: number) => stripVTControlCharacters(truncateToWidth(text, width, "…"));
    const list: string[] = [];
    let selectedLine = 0;
    let group = "";
    for (const record of records) {
      const next = `${record.input.roundId ?? 0}:${record.taskId}`;
      const old = record.archivedAt !== undefined;
      if (next !== group) {
        group = next;
        list.push(this.theme.fg(old ? "dim" : "muted", clip(
          `R${record.input.roundId ?? "?"} · ${old ? "Earlier · " : ""}${clean(record.input.draft).replace(/\s+/g, " ")}`, leftWidth)));
      }
      const active = record.id === selected?.id;
      if (active) selectedLine = list.length;
      const label = `${active ? "›" : " "} ${this.badge(record)} · ${clean(record.input.model.id)}`;
      const color = old ? "dim" : record.status === "unsent" || record.status === "cancelled" ? "warning"
        : record.status === "error" ? "error" : record.status === "generating" || record.status === "queued" ? "accent" : "text";
      const text = this.theme.fg(color, clip(label, leftWidth));
      list.push(active ? this.theme.bg("selectedBg", text + " ".repeat(Math.max(0, leftWidth - visibleWidth(text)))) : text);
    }
    if (!records.length) list.push(this.theme.fg("muted", "No tasks yet. Use i or r."));
    this.top = Math.max(0, Math.min(this.top, selectedLine, list.length - height));
    if (selectedLine >= this.top + height) this.top = selectedLine - height + 1;
    const document = selected ? [
      `Round ${selected.input.roundId ?? "?"} · Task ${selected.taskId} · #${selected.id} ${selected.kind}${selected.parentId ? ` from #${selected.parentId}` : ""}`,
      `${selected.input.model.provider}/${selected.input.model.id} · thinking ${selected.input.thinkingLevel ?? "default"}`,
      `${this.badge(selected)}${selected.archivedAt !== undefined ? " · Earlier context · Archived" : " · Frozen context"}`,
      `${new Date(selected.createdAt).toLocaleTimeString()} · Branch: ${selected.input.branchLeafId ?? "root"}`,
      ...(selected.error ? [`Error: ${selected.error}`] : []),
      ...(selected.input.projectDiagnostics?.warnings ?? selected.input.project?.snapshot.warnings ?? []).map((warning) => `Context warning: ${warning}`),
      ...(selected.acceptedAt !== undefined ? [`Accepted into Pi editor: ${new Date(selected.acceptedAt).toLocaleTimeString()}`] : []),
      ...(selected.sentAt !== undefined ? [`Pi started send: ${new Date(selected.sentAt).toLocaleTimeString()}`] : []),
      selected.kind === "edit" ? "Manual edit · no model call" : selected.status === "unsent" ? "Not sent to optimizer" :
        `${selected.elapsedSeconds ?? "—"}s · ${formatTokenUsage(selected.usage) ?? "Tokens: unknown"}`,
      ...(selected.input.revision ? [`Revision: ${selected.input.revision.instruction}`] : []),
      "", this.original || !selected.candidate ? "Original prompt" : "Result",
      this.original || !selected.candidate ? selected.input.draft : selected.candidate.text,
    ].map(clean).join("\n") : "Select a task. Enter refines an unsent prompt or applies a completed result. Apply never writes to Pi.";
    const cacheKey = JSON.stringify([document, rightWidth]);
    if (this.cached?.key !== cacheKey) this.cached = { key: cacheKey, lines: new Text(document, 0, 0).render(rightWidth) };
    this.position.scroll = Math.min(this.position.scroll ?? 0, Math.max(0, this.cached.lines.length - height));
    const detail = this.cached.lines.slice(this.position.scroll, this.position.scroll + height);
    const body = Array.from({ length: height }, (_, i) => {
      if (!split) return this.reading ? detail[i] ?? "" : list[this.top + i] ?? "";
      const left = list[this.top + i] ?? "";
      return left + " ".repeat(Math.max(0, leftWidth - visibleWidth(left))) + this.theme.fg("borderMuted", " │ ") + (detail[i] ?? "");
    });
    const action = selected?.status === "unsent" ? (selected.archivedAt !== undefined ? "Refine (old context)" : "Refine") : selected?.candidate ? "Apply result" : "No result yet";
    const footer = [
      fittingKeyHints([["Enter", action], ["Tab", this.reading ? "Select" : "Read"], ["g", "Run with model"], ["x", "Stop"]], layout.innerWidth, this.theme),
      fittingKeyHints([["Esc", "Back"], ["m", "Model"], ["i", "Input"], ["n", "Copy to round"], ["o", "Original"], ...(!this.usage ? [["h", "Earlier"] as const] : [])], layout.innerWidth, this.theme),
    ];
    if (layout.footerHeight === 1) footer[0] = fittingKeyHints([["Esc", "Back"], ["Enter", action], ["Tab", "Read/select"]], layout.innerWidth, this.theme);
    return panelFrame(layout, [this.theme.fg("text", this.theme.bold(this.usage ? "Usage · All rounds" : "Prompt refine · Tasks")),
      this.theme.fg("muted", this.notice || `${records.length} entries · ${this.reading ? "Reading · ↑↓ scroll" : "↑↓ select"} · Run: ${this.actions.launchModel?.() ?? "selected model"}`)],
    [...tabs, ...body], footer, (text) => this.theme.fg("borderMuted", text));
  }
}
