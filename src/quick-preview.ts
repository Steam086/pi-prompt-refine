import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TaskDisplayRecord } from "./history.js";
import { fittingKeyHints, type KeyHint } from "./key-hints.js";
import { READING_WIDTH, sanitizeTerminalText } from "./presentation.js";
import { workspaceHeight } from "./workspace-overlay.js";

export function quickTarget(records: readonly TaskDisplayRecord[], round: number | undefined, text: string,
  last?: number, remembered?: ReadonlyMap<number, number>, originalTask?: number) {
  const current = records.filter(r => round !== undefined && r.input.roundId === round && r.archivedAt === undefined && !r.input.contextUnavailable);
  if (!text.trim()) {
    const open = current.filter(r => r.acceptedAt === undefined && r.sentAt === undefined);
    return open.find(r => r.id === last) ?? open.findLast(r => r.status === "generated")
      ?? open.findLast(r => ["generating", "queued"].includes(r.status)) ?? open.at(-1);
  }
  const accepted = current.findLast(r => r.acceptedAt !== undefined && r.candidate?.text === text);
  if (accepted) return accepted;
  const matching = current.filter(r => r.input.draft === text);
  const task = matching.find(r => r.id === last)?.taskId ?? matching.at(-1)?.taskId;
  const runs = matching.filter(r => r.taskId === task);
  const selected = originalTask === undefined ? runs.find(r => r.id === last) : undefined;
  return selected ?? runs.find(r => r.id === remembered?.get(r.taskId)) ?? runs.findLast(r => r.acceptedAt !== undefined)
    ?? runs.findLast(r => r.candidate) ?? runs.at(-1);
}

const labels = { unsent: "Unsent", queued: "Queued", generating: "Generating", generated: "Ready",
  error: "Failed", cancelled: "Cancelled", interrupted: "Interrupted" };

export function quickHints(record: TaskDisplayRecord, expanded: boolean, multiple: boolean): KeyHint[] {
  const hints: KeyHint[] = [];
  if (record.candidate) hints.push(["a", "Accept"]);
  if (record.status === "unsent") hints.push(["Enter", "Start"]);
  if (record.status === "queued" || record.status === "generating") hints.push(["x", "Cancel"]);
  if (["cancelled", "error", "interrupted"].includes(record.status)) hints.push(["r", "Retry"]);
  hints.push(["Esc", expanded ? "Back" : "Close"], ["?", "Help"]);
  if (record.candidate) hints.push(["v", expanded ? "Back" : "Expand"], ["f", "Revise"]);
  if (multiple) hints.push(["←→", "Switch"]);
  if (!expanded && !["queued", "generating"].includes(record.status)) hints.push(["m", "Model"]);
  if (!expanded && (record.candidate || record.status === "unsent")) hints.push(["p", "Preferences"]);
  if (!expanded) hints.push(["n", "New draft"]);
  hints.push(["w", "Workspace"]);
  return hints;
}

export class QuickReader {
  expanded = false;
  help = false;
  question?: string;
  private anchors = new Map<string, { paragraph: number; line: number }>();
  private lines: { text: string; paragraph: number; line: number }[] = [];
  private view = 1;
  private offset = 0;
  private key = "";
  private wrapped?: { body: string; width: number };
  private locked?: { width: number; rows: number; height: number };

  scroll(key: string) {
    const last = Math.max(0, this.lines.length - this.view);
    const step = Math.max(1, this.view - 1);
    const next = { up: this.offset - 1, down: this.offset + 1, pageUp: this.offset - step,
      pageDown: this.offset + step, home: 0, end: last }[key];
    if (next === undefined) return;
    this.offset = Math.max(0, Math.min(last, next));
    const line = this.lines[this.offset];
    if (line) this.anchors.set(this.key, { paragraph: line.paragraph, line: line.line });
  }

  render(width: number, rows: number, record: TaskDisplayRecord, index: string, multiple: boolean,
    changed: boolean, elapsed: number, theme: Theme) {
    const budget = Math.min(12, Math.floor(rows * .3));
    const frame = width >= 48 && (this.expanded || budget >= 7);
    const inner = Math.max(1, width - (frame ? 4 : 0));
    const hints = quickHints(record, this.expanded, multiple);
    this.key = record.id + (this.help ? "-help" : "");
    const preferences = record.input.preferences?.length ?? 0;
    let body = record.candidate?.text ?? (record.status === "unsent" ? record.input.draft :
      record.status === "error" ? `Request failed: ${record.error ?? "failed"}` :
      `Optimizer: ${record.input.model.id} · ${preferences} preference${preferences === 1 ? "" : "s"}`);
    if (this.expanded && record.candidate?.additional?.length) body += "\n\nResult notes · preview only\n" +
      record.candidate.additional.map(note => note.name + "\n" + (note.text ?? "Note unavailable for this run.")).join("\n\n");
    if (this.help) body = hints.map(([k,v]) => k + " " + v).concat("↑↓ Scroll · PgUp/PgDn Page · Home/End").join("\n");
    if (this.question) body = this.question;
    const wrapWidth = Math.min(READING_WIDTH, inner);
    if (body !== this.wrapped?.body || wrapWidth !== this.wrapped.width) {
      this.lines = sanitizeTerminalText(body).split("\n").flatMap((p, paragraph) =>
        wrapTextWithAnsi(p, wrapWidth).map((text, line) => ({ text, paragraph, line })));
      this.wrapped = { body, width: wrapWidth };
    }
    const divider = frame && !!record.candidate;
    const chrome = (frame ? 4 : 2) + Number(divider);
    let height = Math.max(3, Math.min(budget, chrome + Math.max(1, this.lines.length)));
    if (this.expanded) height = workspaceHeight(rows);
    else if (this.question) height = Math.min(workspaceHeight(rows), chrome + this.lines.length);
    else if (record.candidate && !this.help && !this.question) {
      if (this.locked?.width !== width || this.locked.rows !== rows) this.locked = { width, rows, height };
      height = this.locked.height;
    }
    this.view = Math.max(1, height - chrome);
    const anchor = this.anchors.get(this.key);
    const start = anchor ? this.lines.findIndex(line => line.paragraph === anchor.paragraph) : 0;
    const end = anchor ? this.lines.findLastIndex(line => line.paragraph === anchor.paragraph) : 0;
    const anchoredLine = start < 0 ? this.lines.length : Math.min(end, start + (anchor?.line ?? 0));
    this.offset = Math.max(0, Math.min(this.lines.length - this.view, anchoredLine));
    const overflow = this.lines.length > this.view;
    const title = theme.fg("text", theme.bold("Refine")) + " · " + (this.question ? "Confirm" : this.help ? "Help" : this.expanded ? "Full preview" :
      theme.fg(record.status === "generated" ? "success" : record.status === "error" ? "error" : record.status === "generating" ? "accent" : "muted", labels[record.status]));
    const counts = overflow ? ` · Lines ${this.offset + 1}–${this.offset + this.view}/${this.lines.length}` : "";
    const meta = sanitizeTerminalText(index + counts + (changed ? " · Editor changed" : "") + ` · ${record.input.model.id} · ${elapsed}s`).replace(/\n/g, " ");
    const border = (s: string) => theme.fg("borderAccent", s);
    const line = (s: string) => {
      const fit = truncateToWidth(s, inner, "");
      return frame ? border("│") + " " + fit + " ".repeat(inner - visibleWidth(fit) + 1) + border("│") : fit;
    };
    if (overflow && !this.help) hints.splice(3, 0, ["↑↓", "Scroll"]);
    const actions: KeyHint[] = this.question ? [["Esc", "Keep"], ["y", "Confirm"]] : this.help ? [["?", "Back"], ["↑↓", "Scroll"]] : hints;
    return [...(frame ? [border("╭" + "─".repeat(width - 2) + "╮")] : []), line(title + theme.fg("muted", meta)),
      ...(divider ? [line(theme.fg("borderMuted", "─".repeat(inner)))] : []),
      ...Array.from({length: this.view}, (_, i) => line(theme.fg("text", this.lines[this.offset + i]?.text ?? ""))),
      line(fittingKeyHints(actions, inner, theme, "  ")), ...(frame ? [border("╰" + "─".repeat(width - 2) + "╯")] : [])];
  }
}
