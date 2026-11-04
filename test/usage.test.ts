import { describe, expect, it } from "vitest";
import { cacheHitRate, formatReferenceCost, formatRunUsage, formatTokenUsage, readRunUsage, readTokenUsage, totalInputTokens } from "../src/usage.js";

describe("response token usage", () => {
  it("sums only normalized input buckets and does not infer missing values", () => {
    const usage = { input: 100, cacheRead: 900, cacheWrite: 200, output: 300, reasoning: 250 };
    expect(totalInputTokens(usage)).toBe(1200);
    expect(cacheHitRate(usage)).toBe(75);
    expect(formatRunUsage(usage)).toBe("↑1.2k ↓300 · Cost —");
    expect(totalInputTokens({ input: 100 })).toBeUndefined();
    expect(cacheHitRate({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBeUndefined();
  });

  it("preserves positive SDK estimates and rejects invalid/ambiguous zero estimates", () => {
    const counts = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 };
    const usage = readRunUsage({ ...counts, cost: { total: 0.012, input: 0.01, output: 0.002, cacheRead: -1 } }, { subscription: true });
    expect(usage?.cost).toEqual({ total: 0.012, input: 0.01, output: 0.002 });
    expect(formatReferenceCost(usage)).toBe("≈$0.012 (sub)");
    for (const total of [NaN, Infinity, -1, "0", 0]) {
      expect(readRunUsage({ ...counts, cost: { total } })?.cost).toBeUndefined();
    }
    expect(readRunUsage({ ...counts, cost: { total: 0 } }, { hasPricing: true })?.cost?.total).toBe(0);
    expect(readRunUsage({ input: 0, cost: { total: 0 } }, { hasPricing: true })?.cost).toBeUndefined();
  });

  it("distinguishes unknown, zero and tiny nonzero cost", () => {
    expect(formatReferenceCost(undefined)).toBe("Cost —");
    expect(formatReferenceCost({ cost: { total: 0 } })).toBe("$0");
    expect(formatReferenceCost({ cost: { total: 0.00001 } })).toBe("<$0.001");
  });

  it("keeps reported counts without inferring a total or adding reasoning twice", () => {
    const usage = readTokenUsage({ input: 100, output: 20, reasoning: 10, cacheRead: 0, cost: { total: 1 } });
    expect(usage).toEqual({ input: 100, output: 20, reasoning: 10, cacheRead: 0 });
    expect(formatTokenUsage(usage)).toBe("Tokens: in 100 · out 20 · read 0 · think(out) 10");
  });

  it("summarizes only reported totals/input/output without mutating detailed usage", () => {
    const usage = { totalTokens: 190, input: 120, output: 30, cacheRead: 40, cacheWrite: 0, reasoning: 10 };
    expect(formatTokenUsage(usage, "summary")).toBe("Tokens: total 190 · in 120 · out 30");
    expect(formatTokenUsage(usage)).toBe("Tokens: total 190 · in 120 · out 30 · read 40 · write 0 · think(out) 10");
    expect(formatTokenUsage({ reasoning: 10 }, "summary")).toBe("Tokens: details in Usage");
    expect(formatTokenUsage({ input: 0 }, "summary")).toBe("Tokens: in 0");
    expect(formatTokenUsage({}, "summary")).toBeUndefined();
    expect(formatTokenUsage(undefined, "summary")).toBeUndefined();
  });

  it("omits missing or invalid usage and preserves explicitly supplied zero", () => {
    for (const value of [undefined, null, {}, { input: -1, output: NaN, totalTokens: Infinity, cacheRead: "12", reasoning: 1.5 }]) {
      expect(readTokenUsage(value)).toBeUndefined();
    }
    expect(formatTokenUsage(undefined)).toBeUndefined();
    expect(readTokenUsage({ totalTokens: 0 })).toEqual({ totalTokens: 0 });
  });
});
