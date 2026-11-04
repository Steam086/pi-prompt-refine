/** Raw counts exposed by Pi's normalized response; reasoning is a subset of output. */
export interface ReferenceCost {
  total: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}
export interface TokenUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  totalTokens?: number;
  /** Request-time SDK estimate, not an invoice or subscription quota. */
  cost?: ReferenceCost;
  subscription?: boolean;
}

export function readTokenUsage(value: unknown): TokenUsage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const usage: TokenUsage = {};
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens"] as const) {
    const count = (value as Record<string, unknown>)[key];
    if (typeof count === "number" && Number.isFinite(count) && count >= 0 && Number.isInteger(count)) usage[key] = count;
  }
  return Object.keys(usage).length ? usage : undefined;
}

const finiteCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Preserve the SDK estimate (including tier/cache pricing), never reprice old records. */
export function readRunUsage(value: unknown, options: { hasPricing?: boolean; subscription?: boolean } = {}): TokenUsage | undefined {
  const usage = readTokenUsage(value);
  if (!usage) return undefined;
  const cost = (value as Record<string, unknown>).cost;
  if (typeof cost === "object" && cost !== null) {
    const values = cost as Record<string, unknown>;
    // A zero-filled SDK default is not evidence that an unpriced model is free.
    if (finiteCount(values.total) && (values.total > 0 || (options.hasPricing && totalInputTokens(usage) !== undefined && usage.output !== undefined))) {
      usage.cost = { total: values.total };
      for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
        if (finiteCount(values[key])) usage.cost[key] = values[key];
      }
    }
  }
  if (options.subscription !== undefined) usage.subscription = options.subscription;
  return usage;
}

/** Pi normalizes input to uncached tokens; cache read/write are disjoint buckets. */
export function totalInputTokens(usage: TokenUsage | undefined): number | undefined {
  if (usage?.input === undefined || usage.cacheRead === undefined || usage.cacheWrite === undefined) return undefined;
  const total = usage.input + usage.cacheRead + usage.cacheWrite;
  return Number.isSafeInteger(total) ? total : undefined;
}

export function cacheHitRate(usage: TokenUsage | undefined): number | undefined {
  const input = totalInputTokens(usage);
  return input === undefined || input === 0 ? undefined : usage!.cacheRead! / input * 100;
}

export function compactTokens(count: number | undefined): string {
  if (count === undefined) return "—";
  if (count < 1000) return String(count);
  return `${Number((count / (count >= 1_000_000 ? 1_000_000 : 1000)).toFixed(1))}${count >= 1_000_000 ? "m" : "k"}`;
}

export function formatReferenceCost(usage: TokenUsage | undefined): string {
  const cost = usage?.cost?.total;
  const label = cost === undefined ? "Cost —" : cost === 0 ? "$0" : cost < 0.001 ? "<$0.001" : `≈$${cost.toFixed(3)}`;
  return label + (usage?.subscription ? " (sub)" : "");
}

export function formatRunUsage(usage: TokenUsage | undefined): string {
  return `↑${compactTokens(totalInputTokens(usage))} ↓${compactTokens(usage?.output)} · ${formatReferenceCost(usage)}`;
}

export function formatTokenUsage(usage: TokenUsage | undefined, detail: "full" | "summary" = "full"): string | undefined {
  if (!usage) return undefined;
  const labels = [
    ["totalTokens", "total"], ["input", "in"], ["output", "out"],
    ["cacheRead", "read"], ["cacheWrite", "write"], ["reasoning", "think(out)"],
  ] as const;
  const visible = detail === "summary" ? labels.slice(0, 3) : labels;
  const parts = visible.flatMap(([key, label]) => usage[key] === undefined ? [] : [`${label} ${usage[key]}`]);
  return parts.length ? `Tokens: ${parts.join(" · ")}`
    : detail === "summary" && labels.some(([key]) => usage[key] !== undefined) ? "Tokens: details in Usage" : undefined;
}
