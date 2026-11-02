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

export function formatTokenUsage(usage: TokenUsage | undefined): string | undefined {
  if (!usage) return undefined;
  const labels = [
    ["totalTokens", "总计"], ["input", "输入"], ["output", "输出"],
    ["cacheRead", "缓存读取"], ["cacheWrite", "缓存写入"], ["reasoning", "推理（含于输出）"],
  ] as const;
  const parts = labels.flatMap(([key, label]) => usage[key] === undefined ? [] : [`${label} ${usage[key]}`]);
  return parts.length ? `Token：${parts.join(" · ")}` : undefined;
}
