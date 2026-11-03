import { parseKey, Text, truncateToWidth, visibleWidth, type Component, type KeybindingsManager } from "@earendil-works/pi-tui";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { RefineRecord } from "./history.js";
import { fittingHints, panelFrame, panelLayout, workspaceTabs } from "./panel-layout.js";
import { fittingKeyHints } from "./key-hints.js";
import { sanitizeTerminalText } from "./presentation.js";
import { formatTokenUsage } from "./usage.js";

export function recordStatus(record: RefineRecord): string {
  return [record.status, record.error, record.acceptedAt !== undefined ? "accepted into editor" : "", record.sentAt !== undefined ? "Pi accepted send/queue" : ""].filter(Boolean).join(" · ");
}

interface RecordColumn {
  key: "draft" | "status" | "elapsed" | "tokens" | "model";
  label: string;
  width: number;
  right?: boolean;
}

/** Stable columns for the whole viewport; shed metadata before squeezing the summary. */
function recordColumns(width: number, usage: boolean): RecordColumn[] {
  const columns: RecordColumn[] = [];
  if (width >= (usage ? 68 : 64)) columns.push({ key: "status", label: "State", width: usage ? 9 : 13 });
  if (usage && width >= 72) columns.push({ key: "elapsed", label: "Time", width: 7, right: true });
  if (usage && width >= 28) columns.push({ key: "tokens", label: "Total tok", width: 10, right: true });
  if (width >= (usage ? 44 : 32)) columns.push({ key: "model", label: "Model", width: Math.min(30, Math.floor(width * 0.3)), right: true });
  const summaryWidth = Math.max(0, width - 2 - columns.reduce((sum, column) => sum + column.width + 2, 0));
  return [{ key: "draft", label: "Request", width: summaryWidth }, ...columns];
}

function singleLine(text: string): string {
  return sanitizeTerminalText(text).replace(/\s+/g, " ").trim();
}

function recordBadge(record: RefineRecord, usage: boolean): { text: string; color: ThemeColor } {
  if (record.status === "error") return { text: record.error === "timeout" ? "Timed out" : "Failed", color: "error" };
  if (record.status === "cancelled") return { text: "Cancelled", color: "warning" };
  if (record.status === "generating") return { text: "Running", color: "accent" };
  if (!usage) {
    if (record.sentAt !== undefined) return { text: "Send accepted", color: "success" };
    if (record.acceptedAt !== undefined) return { text: "Accepted", color: "success" };
    if (record.kind === "edit") return { text: "Edited", color: "muted" };
    if (record.kind === "revise") return { text: "Revised", color: "muted" };
  }
  return { text: usage ? "Done" : "Ready", color: "muted" };
}

/** An isolated read-only snapshot. No callbacks to candidate/model/editor mutation. */
export class HistoryPanel implements Component {
  private cursor = 0;
  private top = 0;
  private detail = false;
  private original = false;
  private scroll = 0;
  private viewportHeight = 1;
  private document?: Text;

  constructor(
    private readonly records: RefineRecord[],
    private readonly theme: Theme,
    private readonly rows: () => number,
    private readonly keys: KeybindingsManager,
    private readonly back: () => void,
    private readonly usage = false,
  ) {}

  private entries(): RefineRecord[] {
    return this.records.filter((record) => this.usage ? record.kind !== "edit" : !!record.candidate).slice().reverse();
  }

  invalidate(): void { this.document = undefined; }

  handleInput(data: string): void {
    const key = parseKey(data);
    if (key === "q" || key === "ctrl+\\" || this.keys.matches(data, "tui.select.cancel")) {
      if (this.detail) { this.detail = false; this.scroll = 0; this.document = undefined; }
      else this.back();
      return;
    }
    const entries = this.entries();
    if (!entries.length) return;
    if (this.detail && key === "o") {
      this.original = !this.original;
      this.scroll = 0;
      this.document = undefined;
    } else if (this.detail && (key === "[" || key === "]")) {
      this.cursor = (this.cursor + (key === "[" ? -1 : 1) + entries.length) % entries.length;
      this.scroll = 0;
      this.document = undefined;
    } else if (!this.detail && this.keys.matches(data, "tui.select.confirm")) {
      this.detail = true;
      this.original = false;
      this.scroll = 0;
      this.document = undefined;
    } else {
      const page = this.detail || this.viewportHeight < 3 ? this.viewportHeight : this.viewportHeight - 1;
      const delta = key === "up" ? -1 : key === "down" ? 1 : key === "pageUp" ? -page : key === "pageDown" ? page : 0;
      if (this.detail) this.scroll = Math.max(0, this.scroll + delta);
      else this.cursor = Math.max(0, Math.min(entries.length - 1, this.cursor + delta));
    }
  }

  private listRow(columns: RecordColumn[], width: number, entry?: RefineRecord, selected = false): string {
    const badge = entry ? recordBadge(entry, this.usage) : undefined;
    const values = entry ? {
      draft: singleLine(entry.input.draft) || "(Empty draft)",
      model: singleLine(entry.input.model.id),
      status: badge!.text,
      elapsed: entry.elapsedSeconds === undefined ? "—" : `${entry.elapsedSeconds}s`,
      tokens: entry.usage?.totalTokens === undefined ? "—" : entry.usage.totalTokens.toLocaleString("en-US"),
    } : undefined;
    const cells = columns.map((column) => {
      const value = values ? values[column.key] : column.label;
      const text = truncateToWidth(value, column.width, "…");
      const padding = " ".repeat(Math.max(0, column.width - visibleWidth(text)));
      const color = !entry ? "muted" : column.key === "draft" ? "text" : column.key === "status" ? badge!.color : "muted";
      const styled = this.theme.fg(color, selected && column.key === "draft" ? this.theme.bold(text) : text);
      return column.right ? padding + styled : styled + padding;
    });
    const marker = this.theme.fg(selected ? "accent" : "muted", (selected ? "› " : "  ").slice(0, width));
    const line = marker + cells.join("  ");
    return selected ? this.theme.bg("selectedBg", line) : line;
  }

  render(width: number): string[] {
    if (width < 1) return [];
    const layout = panelLayout(width, this.rows());
    const tabs = workspaceTabs(layout, this.usage ? "Usage" : "History", this.theme);
    const height = Math.max(1, layout.bodyHeight - tabs.length);
    this.viewportHeight = height;
    const entries = this.entries();
    const record = entries[this.cursor];
    const clean = (text: string) => sanitizeTerminalText(text);
    let body: string[];
    let status: string;
    if (this.detail && record) {
      const candidate = record.candidate;
      if (!this.document) {
        const info = [
          `Task ${record.taskId} · #${record.id} ${record.kind}${record.parentId ? ` from #${record.parentId}` : ""}`,
          `${record.input.model.provider}/${record.input.model.id} · thinking ${record.input.thinkingLevel ?? "default"}`,
          `${new Date(record.createdAt).toLocaleTimeString()} · ${recordStatus(record)}`,
          `Branch: ${record.input.branchLeafId ?? "root"}`,
          ...(record.acceptedAt !== undefined ? [`Accepted into editor: ${new Date(record.acceptedAt).toLocaleTimeString()}`] : []),
          ...(record.sentAt !== undefined ? [`Pi accepted send/queue: ${new Date(record.sentAt).toLocaleTimeString()}`] : []),
          record.kind === "edit" ? "Manual edit · no model call" : `${record.elapsedSeconds ?? "?"}s · ${formatTokenUsage(record.usage) ?? "Tokens: unknown"}`,
          ...(record.input.revision ? [`Revision instruction: ${record.input.revision.instruction}`] : []),
          "", this.original ? "Original draft" : candidate ? "Candidate" : "Submitted original",
          this.original || !candidate ? record.input.draft : candidate.text,
        ];
        this.document = new Text(info.map((line, index) => {
          const text = clean(line);
          return index === 0 || index === info.length - 2 ? this.theme.fg("text", this.theme.bold(text))
            : this.theme.fg(index === info.length - 1 ? "text" : "muted", text);
        }).join("\n"), 0, 0);
      }
      const lines = this.document.render(layout.innerWidth);
      this.scroll = Math.min(this.scroll, Math.max(0, lines.length - height));
      body = lines.slice(this.scroll, this.scroll + height);
      status = `Read-only · ${this.cursor + 1}/${entries.length} · ${this.original ? "Original" : "Result"} · ↑↓ ${this.scroll + 1}–${Math.min(lines.length, this.scroll + height)}/${lines.length}`;
    } else {
      const showColumns = height >= 3;
      const perPage = Math.max(1, height - (showColumns ? 1 : 0));
      this.top = Math.max(0, Math.min(this.top, this.cursor, entries.length - perPage));
      if (this.cursor >= this.top + perPage) this.top = this.cursor - perPage + 1;
      const columns = recordColumns(layout.innerWidth, this.usage);
      body = [
        ...(showColumns ? [this.listRow(columns, layout.innerWidth)] : []),
        ...entries.slice(this.top, this.top + perPage).map((entry, index) =>
          this.listRow(columns, layout.innerWidth, entry, this.top + index === this.cursor)),
      ];
      const range = entries.length ? `${this.top + 1}–${Math.min(entries.length, this.top + perPage)}/${entries.length}` : "0";
      status = fittingHints(["Read-only", `${range} ${this.usage ? "requests" : "candidates"}`, "All branches", "Last 100", "Since load"], layout.innerWidth);
      if (!entries.length) {
        const message = this.usage ? "No model requests yet." : "No candidates yet.";
        const text = truncateToWidth(message, layout.innerWidth);
        body = [...Array.from({ length: Math.floor((height - 1) / 2) }, () => ""),
          " ".repeat(Math.max(0, Math.floor((layout.innerWidth - visibleWidth(text)) / 2))) + this.theme.fg("muted", text)];
      }
    }
    const footer = [
      fittingKeyHints(this.detail ? [["↑↓", "Scroll"], ["[ / ]", "Record"], ["o", "Original/result"]] : [["↑↓", "Select"], ["Enter", "Details"], ["PgUp/PgDn", "Scroll"]], layout.innerWidth, this.theme),
      fittingKeyHints([["Esc", this.detail ? "List" : "Preview"], ["q", "Back"], ["←/→", "Page"]], layout.innerWidth, this.theme),
    ];
    const legend = " · — not reported";
    if (this.usage && !this.detail && visibleWidth(footer[1]) + visibleWidth(legend) <= layout.innerWidth) {
      footer[1] += this.theme.fg("muted", legend);
    }
    if (layout.footerHeight === 1) footer[0] = fittingKeyHints([["Esc", "Back"], [this.detail ? "↑↓" : "Enter", this.detail ? "Scroll" : "Details"]], layout.innerWidth, this.theme);
    return panelFrame(layout, [this.theme.fg("text", this.theme.bold(this.usage ? "Usage" : "History")), this.theme.fg("muted", status)], [...tabs, ...body], footer, (text) => this.theme.fg("borderMuted", text));
  }
}
