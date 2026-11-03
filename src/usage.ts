/** Counts exposed by the model response; never inferred from text or summed locally. */
export interface TokenUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  totalTokens?: number;
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
