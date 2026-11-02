import { describe, expect, it } from "vitest";
import { formatTokenUsage, readTokenUsage } from "../src/usage.js";

describe("response token usage", () => {
  it("keeps reported counts without inferring a total or adding reasoning twice", () => {
    const usage = readTokenUsage({ input: 100, output: 20, reasoning: 10, cacheRead: 0, cost: { total: 1 } });
    expect(usage).toEqual({ input: 100, output: 20, reasoning: 10, cacheRead: 0 });
    expect(formatTokenUsage(usage)).toBe("Token：输入 100 · 输出 20 · 缓存读取 0 · 推理（含于输出） 10");
  });

  it("omits missing or invalid usage and preserves explicitly supplied zero", () => {
    for (const value of [undefined, null, {}, { input: -1, output: NaN, totalTokens: Infinity, cacheRead: "12", reasoning: 1.5 }]) {
      expect(readTokenUsage(value)).toBeUndefined();
    }
    expect(formatTokenUsage(undefined)).toBeUndefined();
    expect(readTokenUsage({ totalTokens: 0 })).toEqual({ totalTokens: 0 });
  });
});
