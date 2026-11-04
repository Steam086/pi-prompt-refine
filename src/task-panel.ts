import { stripVTControlCharacters } from "node:util";
import { parseKey, Text, truncateToWidth, visibleWidth, type KeybindingsManager } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { RefineRecord } from "./history.js";
import { panelFrame, panelLayout, workspaceTabs } from "./panel-layout.js";
import { alignedKeyHints, fittingKeyHints, type KeyHint } from "./key-hints.js";
import { sanitizeTerminalText } from "./presentation.js";
import { cacheHitRate, formatReferenceCost, formatRunUsage, totalInputTokens, truncatedOutputHint } from "./usage.js";

export interface TaskPanelActions {
  records(): RefineRecord[];
  appliedId(): number | undefined;
  activate(id: number): boolean;
  run(id: number): void;
  stop(id: number): void;
  editOriginal?(id?: number): void;
  chooseModel?(id: number): void;
  accept?(id: number): void;
  revise?(id: number): void;
  launchModel?(): string;
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
  private reading = false;
  private inspecting = false;
  private compareId?: number;
  private original = false;
  private viewport = 1;
  private top = 0;
  private notice = "";
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
  setNotice(text: string): void { this.notice = text; }
  openList(): void { this.inspecting = false; this.compareId = undefined; this.reading = false; }
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
  handleInput(data: string): boolean {
    const key = parseKey(data)?.toLowerCase();
    if (key) this.notice = "";
    const row = this.selected();
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
      if (row?.original && row.record.status === "unsent" && !this.inspecting) this.actions.run(row.record.id);
      else if (row) { this.inspecting = true; this.reading = true; }
      return true;
    }
    if (key === "n") { this.actions.editOriginal?.(); return true; }
    if (key === "i" || (key === "e" && !this.inspecting)) {
      this.actions.editOriginal?.(row?.record.id); return true;
    }
    if (key === "m") { if (!row) return false; this.actions.chooseModel?.(row.record.id); return true; }
    if (key === "x") { if (row && !row.original && pending(row.record)) this.actions.stop(row.record.id); return true; }
    if (key === "a") {
      if (row && !row.original && row.record.candidate) this.actions.accept?.(row.record.id);
      return true;
    }
    if (this.inspecting && key === "c") {
      const peers = row?.records.filter((record) => record.id !== row.record.id && record.candidate) ?? [];
      const index = peers.findIndex((record) => record.id === this.compareId);
      this.compareId = row && !row.original ? peers[index + 1]?.id : undefined;
      return true;
    }
    if (this.inspecting && key === "o") { this.original = !this.original; this.position.scroll = 0; return true; }
    if (this.inspecting && key === "g") { if (row) this.actions.run(row.record.id); return true; }
    if (this.inspecting && key === "f" && this.actions.revise) {
      if (row && !row.original && row.record.candidate) this.actions.revise(row.record.id);
      return true;
    }
    if (this.inspecting && ["e", "f", "s"].includes(key ?? "")) {
      return !(row && !row.original && row.record.candidate && this.actions.activate(row.record.id));
    }
    const delta = key === "up" ? -1 : key === "down" ? 1 : key === "pageup" ? -this.viewport : key === "pagedown" ? this.viewport : 0;
    if (delta) {
      if (row && (this.reading || this.inspecting)) this.scroll(row, delta);
      else {
        const rows = this.entries();
        const index = rows.findIndex((item) => this.isSelected(item));
        this.select(rows[Math.max(0, Math.min(rows.length - 1, index + delta))]);
      }
      return true;
    }
    // Main actions never leak to a different, previously applied result.
    if (["g", "c", "o", "h", "f", "s", "[", "]", "d", "z"].includes(key ?? "")) return true;
    return false;
  }
  private badge(record: RefineRecord): string {
    const warning = record.input.budget && (record.input.budget.status !== "ok" || record.input.budget.message) ? "⚠ " : "";
    return warning + this.statusBadge(record);
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
    return record.kind === "edit" ? "✓ Edited" : "✓ Done";
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
  private pane(row: Row, width: number, height: number, active = true): string[] {
    const { record, records } = row;
    const title = row.original ? "Original prompt" : record.input.model.id;
    const status = row.original && record.status !== "unsent"
      ? this.muted(`${records.filter((r) => r.status !== "unsent").length} runs · ${records.filter(pending).length} active`)
      : this.theme.fg(this.color(record), this.badge(record));
    const titleText = this.heading(title);
    const header = visibleWidth(titleText) + visibleWidth(status) + 2 <= width
      ? [titleText + " ".repeat(width - visibleWidth(titleText) - visibleWidth(status)) + status]
      : [truncateToWidth(titleText, width, "…"), status];
    if (!row.original) {
      header.push(...this.wrapped(this.muted(`${record.input.model.provider} · Thinking ${record.input.thinkingLevel ?? "default"}`), width));
      const metrics: string[] = [];
      if (record.status !== "unsent" && record.status !== "queued" && record.elapsedSeconds !== undefined) {
        metrics.push(this.theme.fg(record.status === "generating" ? "accent" : "text", this.theme.bold(`${record.elapsedSeconds}s`)));
      }
      if (record.kind !== "edit" && record.status !== "unsent" && record.status !== "queued") metrics.push(this.muted(formatRunUsage(record.usage)));
      if (metrics.length) header.push(...this.wrapped(metrics.join(this.muted(" · ")), width));
    }
    if (record.error) header.push(...this.wrapped(this.theme.fg("error", sanitizeTerminalText(`Error: ${record.error}`)), width));
    if (!row.original && record.error === "truncated") {
      header.push(...this.wrapped(this.theme.fg("warning", truncatedOutputHint(record.usage)), width));
    }
    if (!row.original && record.input.budget?.message) {
      const message = record.input.budget.status === "blocked"
        ? "Request not sent · budget exceeded" : record.input.budget.status === "trimmed"
          ? "Background reduced · token budget" : "Shared output limit · thinking may exhaust it";
      header.push(...this.wrapped(this.theme.fg("warning", sanitizeTerminalText(`⚠ ${message}`)), width));
    }
    for (const warning of record.input.projectDiagnostics?.warnings ?? record.input.project?.snapshot.warnings ?? []) {
      header.push(...this.wrapped(this.theme.fg("warning", sanitizeTerminalText(`Context warning: ${warning}`)), width));
    }
    const original = row.original || this.original || !record.candidate;
    const body = [
      ...(!row.original ? [this.heading(original ? "Original prompt" : "Result"), ""] : []),
      this.theme.fg("text", sanitizeTerminalText(original ? record.input.draft || "Empty prompt · Press i to edit" : record.candidate!.text)),
    ];
    if (this.inspecting || this.usage) {
      if (!row.original && record.candidate && !original) body.push("", this.heading("Original prompt"), "", this.theme.fg("text", sanitizeTerminalText(record.input.draft)));
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
      if (record.input.revision) body.push(this.muted(`Revision: ${record.input.revision.instruction}`));
    }
    const fixed = header.slice(0, Math.max(0, height - 2));
    if (height > fixed.length + 2) fixed.push("");
    const available = Math.max(1, height - fixed.length);
    const lines = this.wrapped(body.join("\n"), width);
    const offset = Math.min(active ? this.position.scroll ?? 0 : this.position.scrolls?.[this.rowKey(row)] ?? 0, Math.max(0, lines.length - available));
    if (active) { this.position.scroll = offset; this.viewport = available; }
    return [...fixed, ...lines.slice(offset, offset + available)];
  }
  render(width: number, _empty?: () => string[]): string[] {
    if (width < 1) return [];
    const layout = panelLayout(width, this.rows());
    const tabs = workspaceTabs(layout, this.usage ? "Usage" : "Preview", this.theme);
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
        ? `${active ? "›" : " "} ${record.status === "unsent" ? "○ Unsent ·" : "▾"} ${old ? "Earlier · " : ""}${record.input.draft.replace(/\s+/g, " ") || "Empty prompt"}`
        : `${prefix}${model}${" ".repeat(Math.max(1, leftWidth - visibleWidth(prefix + model + badge)))}${badge}`;
      const clean = stripVTControlCharacters(truncateToWidth(sanitizeTerminalText(label), leftWidth, "…"));
      const text = this.theme.fg(old ? "dim" : row.original ? "text" : this.color(record), clean);
      return active ? this.theme.bg("selectedBg", text + " ".repeat(Math.max(0, leftWidth - visibleWidth(text)))) : text;
    });
    let right = selected ? this.pane(selected, rightWidth, height) : [this.muted("No prompts yet. Press n to create one.")];
    let body: string[];
    const other = this.inspecting && this.compareId !== undefined ? rows.find((row) => !row.original && row.record.id === this.compareId) : undefined;
    if (other && layout.innerWidth >= 72) {
      const half = Math.floor((layout.innerWidth - 3) / 2);
      right = selected ? this.pane(selected, half, height - 1) : [];
      const peer = this.pane(other, layout.innerWidth - half - 3, height - 1, false);
      body = [this.muted("Selected result ← · Tab switches the result to accept")];
      body.push(...Array.from({ length: height - 1 }, (_, i) => {
        const line = right[i] ?? "";
        return line + " ".repeat(Math.max(0, half - visibleWidth(line))) + this.theme.fg("borderMuted", " │ ") + (peer[i] ?? "");
      }));
    } else {
      body = Array.from({ length: height }, (_, i) => {
        if (!split) return this.inspecting || this.reading || !rows.length ? right[i] ?? "" : list[i] ?? "";
        const line = list[i] ?? "";
        return line + " ".repeat(Math.max(0, leftWidth - visibleWidth(line))) + this.theme.fg("borderMuted", " │ ") + (right[i] ?? "");
      });
    }
    const action = !this.inspecting && selected?.original && selected.record.status === "unsent" ? "Run" : "Inspect";
    const restored = selected?.record.input.contextUnavailable;
    const primary: KeyHint[] = this.inspecting ? [["i", restored ? "Copy to current" : "Original"], ...(!restored ? [["m", "Run model"] as const] : [])]
      : [["Enter", action], ["i", restored ? "Copy to current" : "Edit"], ["n", "New"], ...(!restored ? [["m", selected ? "Run model" : "Model"] as const] : [])];
    if (selected && !selected.original && pending(selected.record)) primary.push(["x", "Stop"]);
    if (selected && !selected.original && selected.record.candidate) primary.push(["a", "Accept"]);
    const secondary: KeyHint[] = [["Esc", "Back"], ...(other || !this.inspecting ? [["Tab", other ? "Switch result" : this.reading ? "Select" : "Read"] as KeyHint] : [])];
    if (this.inspecting && selected && !selected.original && selected.record.candidate) {
      secondary.push(["c", other ? "Next comparison" : "Compare"], ["e", "Edit result"], ...(!restored ? [["f", "Revise"] as const] : []), ["s", "Send"]);
    }
    const footer = layout.innerWidth < 30
      ? [fittingKeyHints(primary.map(([key, label]) => [key === "Enter" ? "↵" : key, label]), layout.innerWidth, this.theme), fittingKeyHints(secondary, layout.innerWidth, this.theme)]
      : alignedKeyHints([primary, secondary], layout.innerWidth, this.theme);
    if (layout.footerHeight === 1) footer[0] = fittingKeyHints([["Esc", "Back"], ["Enter", action], ["Tab", this.reading ? "Select" : "Read"]], layout.innerWidth, this.theme);
    const title = this.inspecting ? (other ? "Compare results" : "Prompt details") : this.usage ? "Usage · All rounds" : "Prompt refine · Tasks";
    return panelFrame(layout, [this.heading(title), this.muted(this.notice || (this.inspecting
      ? `${selected && !selected.original ? `Selected: #${selected.record.id} ${selected.record.input.model.id}` : "Original prompt"} · ↑↓ scroll${other ? " · Same original and conversation context" : ""}`
      : `${rows.filter((row) => row.original).length} prompts · ${rows.filter((row) => !row.original).length} runs · ↑↓ select · Run: ${this.actions.launchModel?.() ?? "selected model"}`))],
    [...tabs, ...body], footer, (text) => this.theme.fg("borderMuted", text));
  }
}
