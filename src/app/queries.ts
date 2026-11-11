import type { RefineRecord } from "../history.js";
import type { TokenUsage } from "../usage.js";
import type { Availability, FailureCode, RunDetail, RunSummary, TaskDetail, TaskSummary, UsageDto } from "./api.js";

export const taskId = (id: number): string => `task-${id}`;
export const runId = (id: number): string => `run-${id}`;
export function localId(value: string, kind: "task" | "run"): number | undefined {
  const match = new RegExp(`^${kind}-([1-9][0-9]*)$`).exec(value);
  const id = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(id) ? id : undefined;
}
export function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
const action = (reason?: FailureCode): Availability => reason ? { enabled: false, reason } : { enabled: true };
/** Shared ordering, independent of focus, completion order and the presentation clock. */
export function taskGroups(records: readonly RefineRecord[], all = false): RefineRecord[][] {
  const groups = new Map<number, RefineRecord[]>();
  for (const record of records) {
    if (!all && record.archivedAt !== undefined) continue;
    const group = groups.get(record.taskId) ?? [];
    group.push(record);
    groups.set(record.taskId, group);
  }
  return [...groups.values()].sort((a, b) =>
    Number(a[0]!.archivedAt !== undefined) - Number(b[0]!.archivedAt !== undefined) ||
    (b[0]!.input.roundId ?? 0) - (a[0]!.input.roundId ?? 0) ||
    Math.max(...b.map((record) => record.id)) - Math.max(...a.map((record) => record.id)));
}
export function taskSummary(records: readonly RefineRecord[], version: number, pendingSend: boolean, modelUnavailable?: FailureCode): TaskSummary {
  const source = records.find((record) => !record.input.revision) ?? records[0]!;
  const editable = source.status === "unsent" && source.archivedAt === undefined && !source.input.contextUnavailable;
  return {
    id: taskId(source.taskId), version, displayNumber: source.taskId, roundId: source.input.roundId,
    archived: source.archivedAt !== undefined, excerpt: (source.originalInput ?? source.input).draft.slice(0, 160),
    runIds: records.filter((record) => record.status !== "unsent").sort((a, b) => b.id - a.id).map((record) => runId(record.id)),
    backgroundAvailable: !source.input.contextUnavailable,
    actions: {
      edit: action(editable ? undefined : "not-editable"),
      discard: action(editable ? undefined : "not-editable"), copy: action(),
      start: action(source.input.contextUnavailable ? "background-unavailable" : pendingSend ? "send-pending" :
        !(source.originalInput ?? source.input).draft.trim() ? "empty" : modelUnavailable),
    },
  };
}
export function taskDetail(records: readonly RefineRecord[], version: number, pendingSend: boolean, modelUnavailable?: FailureCode): TaskDetail {
  const source = records.find((record) => !record.input.revision) ?? records[0]!;
  const original = source.originalInput ?? source.input;
  return { ...taskSummary(records, version, pendingSend, modelUnavailable), text: original.draft,
    initialInstruction: original.editingInstruction, selectedNames: (original.preferences ?? []).map((entry) => entry.name) };
}
/** Explicit allowlist: never spread SDK/provider objects into public data. */
export function usageDto(usage: TokenUsage | undefined): UsageDto | undefined {
  if (!usage) return undefined;
  const result: UsageDto = {};
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens"] as const) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) result[key] = value;
  }
  if (typeof usage.subscription === "boolean") result.subscription = usage.subscription;
  if (usage.cost && Number.isFinite(usage.cost.total) && usage.cost.total >= 0) {
    result.cost = { total: usage.cost.total };
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      const value = usage.cost[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) result.cost[key] = value;
    }
  }
  return result;
}
export function runSummary(record: RefineRecord, version: number, elapsedSeconds = record.elapsedSeconds): RunSummary {
  if (record.status === "unsent") throw new Error("Unsent originals are not runs");
  return {
    id: runId(record.id), taskId: taskId(record.taskId), version, displayNumber: record.id,
    kind: record.kind, status: record.status, model: { provider: record.input.model.provider, id: record.input.model.id },
    thinking: record.input.thinkingLevel, createdAt: record.createdAt, elapsedSeconds,
    archived: record.archivedAt !== undefined, hasOutput: !!record.candidate,
    usage: usageDto(record.usage),
    // Provider diagnostics can contain credentials or paths. Only publish classified status.
    diagnostic: record.error ? `Run ${record.status}; inspect local diagnostics for details.` : undefined,
    actions: { stop: action(["queued", "generating"].includes(record.status) ? undefined : "not-editable") },
  };
}
export function runDetail(record: RefineRecord, version: number, elapsedSeconds = record.elapsedSeconds): RunDetail {
  const budget = record.input.budget;
  return { ...runSummary(record, version, elapsedSeconds), original: record.input.draft, text: record.candidate?.text,
    initialInstruction: record.input.editingInstruction, revisionInstruction: record.input.revision?.instruction,
    previousResult: record.input.revision?.previousCandidate, backgroundAvailable: !record.input.contextUnavailable,
    ...(budget ? { budget: { status: budget.status, inputTokens: budget.inputTokens,
      outputTokens: budget.outputTokens, contextWindow: budget.contextWindow } } : {}) };
}
