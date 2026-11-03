import { describe, expect, it } from "vitest";
import { formatTokenUsage, readTokenUsage } from "../src/usage.js";

describe("response token usage", () => {
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
