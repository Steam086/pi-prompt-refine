import { parseKey, Text, truncateToWidth, type Component, type KeybindingsManager } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { RefineRecord } from "./history.js";
import { panelFrame, panelLayout, workspaceTabs } from "./panel-layout.js";
import { fittingKeyHints } from "./key-hints.js";
import { sanitizeTerminalText } from "./presentation.js";
import { formatTokenUsage } from "./usage.js";

export function recordStatus(record: RefineRecord): string {
  return [record.status, record.error, record.acceptedAt !== undefined ? "accepted into editor" : "", record.sentAt !== undefined ? "Pi accepted send/queue" : ""].filter(Boolean).join(" · ");
}

/** An isolated read-only snapshot. No callbacks to candidate/model/editor mutation. */
export class HistoryPanel implements Component {
  private cursor = 0;
  private top = 0;
  private detail = false;
  private original = false;
  private scroll = 0;
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
      const page = Math.max(1, panelLayout(80, this.rows()).bodyHeight - 4);
      const delta = key === "up" ? -1 : key === "down" ? 1 : key === "pageUp" ? -page : key === "pageDown" ? page : 0;
      if (this.detail) this.scroll = Math.max(0, this.scroll + delta);
      else this.cursor = Math.max(0, Math.min(entries.length - 1, this.cursor + delta));
    }
  }

  render(width: number): string[] {
    if (width < 1) return [];
    const layout = panelLayout(width, this.rows());
    const tabs = workspaceTabs(layout, this.usage ? "Usage" : "History", this.theme);
    const height = Math.max(1, layout.bodyHeight - tabs.length);
    const entries = this.entries();
    const record = entries[this.cursor];
    const clean = (text: string) => sanitizeTerminalText(text);
    let body: string[];
    let status = `Read-only · All session branches · Last 100 records · Since load`;
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
        this.document = new Text(clean(info.join("\n")), 0, 0);
      }
      const lines = this.document.render(layout.innerWidth);
      this.scroll = Math.min(this.scroll, Math.max(0, lines.length - height));
      body = lines.slice(this.scroll, this.scroll + height);
      status = `Read-only · ${this.cursor + 1}/${entries.length} · ${this.original ? "Original" : "Result"} · ↑↓ ${this.scroll + 1}–${Math.min(lines.length, this.scroll + height)}/${lines.length}`;
    } else {
      const perPage = Math.max(1, Math.floor(height / 2));
      this.top = Math.max(0, Math.min(this.top, this.cursor));
      if (this.cursor >= this.top + perPage) this.top = this.cursor - perPage + 1;
      body = entries.slice(this.top, this.top + perPage).flatMap((entry, index) => {
        const selected = this.top + index === this.cursor;
        const label = clean(`${selected ? "›" : " "} T${entry.taskId} #${entry.id} ${entry.input.model.provider}/${entry.input.model.id} · ${entry.kind} · ${recordStatus(entry)}`);
        const first = truncateToWidth(label, layout.innerWidth);
        return [selected ? this.theme.bg("selectedBg", this.theme.fg("text", this.theme.bold(first))) : this.theme.fg("muted", first),
          this.theme.fg("muted", truncateToWidth(clean(this.usage
            ? `  ${entry.elapsedSeconds ?? "?"}s · ${formatTokenUsage(entry.usage) ?? "Tokens: unknown"}`
            : `  ${entry.input.draft.replace(/\s+/g, " ")}`), layout.innerWidth))];
      });
      if (!body.length) body = ["No records yet."];
    }
    const footer = [
      fittingKeyHints(this.detail ? [["↑↓", "Scroll"], ["[ / ]", "Record"], ["o", "Original/result"]] : [["↑↓", "Select"], ["Enter", "Read"]], layout.innerWidth, this.theme),
      fittingKeyHints([["Esc", this.detail ? "List" : "Preview"], ["q", "Back"], ["←/→", "Page"]], layout.innerWidth, this.theme),
    ];
    if (layout.footerHeight === 1) footer[0] = fittingKeyHints([["Esc", "Back"], ["Enter", "Read"]], layout.innerWidth, this.theme);
    return panelFrame(layout, [this.theme.fg("text", this.theme.bold(this.usage ? "Usage" : "History")), this.theme.fg("muted", status)], [...tabs, ...body], footer, (text) => this.theme.fg("borderMuted", text));
  }
}
