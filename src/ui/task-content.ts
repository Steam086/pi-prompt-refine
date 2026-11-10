import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { RefineRecord } from "../history.js";
import { formatKeyHint } from "../key-hints.js";
import { sanitizeTerminalText } from "../presentation.js";
import { cacheHitRate, formatReferenceCost, formatRunUsage, totalInputTokens, truncatedOutputHint } from "../usage.js";

export interface TaskRow { record: RefineRecord; original: boolean; records: RefineRecord[] }
export const pending = (record: RefineRecord) => record.status === "queued" || record.status === "generating";

interface HeaderOptions {
  inline: boolean;
  preferences: boolean;
  inspecting: boolean;
  referenceOnly: boolean;
}
interface PaneOptions extends HeaderOptions {
  original: boolean;
  usage: boolean;
  scroll: number;
  referenceScroll: number;
}
export interface TaskPane {
  lines: string[];
  viewport: number;
  offsets: { reference: boolean; offset: number }[];
}

/** Literal task documents and their bounded wrapping cache; never owns a selected identity. */
export class TaskContent {
  private cache = new Map<string, string[]>();
  constructor(private readonly theme: Theme) {}
  preferenceSummary(record: RefineRecord): string {
    const selected = record.input.preferences ?? [];
    return `Preferences: ${selected.length ? `${selected.length} · ${selected.map((entry) => entry.name).join(", ")}` : "None"}`;
  }
  invalidate(): void { this.cache.clear(); }
  badge(record: RefineRecord): string {
    const warning = record.input.budget && (record.input.budget.status !== "ok" || record.input.budget.message) ? "⚠ " : "";
    return warning + this.statusBadge(record);
  }
  styledBadge(record: RefineRecord): string {
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
  color(record: RefineRecord): "error" | "warning" | "accent" | "success" {
    return record.status === "error" ? "error" : record.status === "unsent" || record.status === "cancelled" || record.status === "interrupted" ? "warning"
      : pending(record) ? "accent" : "success";
  }
  heading(text: string): string { return this.theme.fg("text", this.theme.bold(sanitizeTerminalText(text))); }
  muted(text: string): string { return this.theme.fg("muted", sanitizeTerminalText(text)); }
  wrapped(document: string, width: number): string[] {
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
  originalHeight(row: TaskRow, width: number, options: HeaderOptions): number {
    const body = row.record.input.draft || "Empty prompt · i Edit original";
    return this.paneHeader(row, width, options).length + 1 + this.wrapped(sanitizeTerminalText(body), width).length;
  }
  paneHeader(row: TaskRow, width: number, options: HeaderOptions, previewDetails = false): string[] {
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
    if (!options.inline && ((row.original && record.status === "unsent" && options.preferences) || record.input.preferences?.length)) {
      header.push(...this.wrapped(this.muted(this.preferenceSummary(record)), width));
    }
    if (!row.original) {
      if (!previewDetails && record.kind === "revise") header.push(...this.wrapped(this.muted(`Revision${record.parentId ? ` of run #${record.parentId}` : ""}${options.inspecting && !options.referenceOnly ? " · o Original" : ""}`), width));
      const metadata = this.muted(`${record.input.model.provider} · Thinking ${record.input.thinkingLevel ?? "default"}`);
      if (!previewDetails) header.push(...this.wrapped(metadata, width));
      const metrics: string[] = [];
      if (record.status !== "unsent" && record.status !== "queued" && record.elapsedSeconds !== undefined) {
        metrics.push(options.inspecting ? this.muted(`${record.elapsedSeconds}s`)
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
  pane(row: TaskRow, width: number, height: number, options: PaneOptions, previewDetails = false): TaskPane {
    const { record } = row;
    const header = this.paneHeader(row, width, options, previewDetails);
    if (previewDetails) return this.previewDetails(row, width, height, header, options);
    const original = row.original || options.original || !record.candidate;
    const body = [
      ...(!row.original ? [this.heading(original ? "Original prompt" : record.kind === "revise" ? "Revised result" : "Result"), ""] : []),
      original && !record.input.draft ? this.muted("Empty prompt · ") + formatKeyHint(["i", "Edit original"], this.theme)
        : this.theme.fg("text", sanitizeTerminalText(original ? record.input.draft : record.candidate!.text)),
    ];
    if (options.inspecting || options.usage) {
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
    const offset = Math.min(options.scroll, Math.max(0, lines.length - available));
    return { lines: [...fixed, ...lines.slice(offset, offset + available)], viewport: available,
      offsets: [{ reference: false, offset }] };
  }
  /** Preview keeps reference material separate from the result and Usage details. */
  private previewDetails(row: TaskRow, width: number, height: number, header: string[], options: PaneOptions): TaskPane {
    const { record } = row;
    // The shared reading frame is capped at 100 columns; reserve at least 30 for references.
    const wide = width >= 90;
    const leftWidth = wide ? Math.floor((width - 3) * 0.65) : width;
    const rightWidth = wide ? width - leftWidth - 3 : width;
    const fixed = header.slice(0, Math.max(0, height - 2));
    if (height > fixed.length + 2) fixed.push("");
    const available = Math.max(1, height - fixed.length);
    const offsets: TaskPane["offsets"] = [];
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
      const offset = Math.min(isReference ? options.referenceScroll : options.scroll, Math.max(0, lines.length - available));
      offsets.push({ reference: isReference, offset });
      return lines.slice(offset, offset + available);
    };
    if (!wide) return { lines: [...fixed, ...clip(options.original ? reference : result, width, options.original)], viewport: available, offsets };
    const left = clip(result, leftWidth, false);
    const right = clip(reference, rightWidth, true);
    return { lines: [...fixed, ...Array.from({ length: available }, (_, i) => {
      const line = left[i] ?? "";
      return line + " ".repeat(Math.max(0, leftWidth - visibleWidth(line))) + this.muted(" │ ") + (right[i] ?? "");
    })], viewport: available, offsets };
  }
}
