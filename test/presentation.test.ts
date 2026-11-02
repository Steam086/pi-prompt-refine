import { describe, expect, it } from "vitest";
import { matchesKey, parseKey, visibleWidth } from "@earendil-works/pi-tui";
import { renderSummary, sanitizeTerminalText, type SummaryOptions } from "../src/presentation.js";

const options: SummaryOptions = {
  state: { phase: "ready", requestId: 1, pendingSend: false, model: { provider: "fake", id: "chat" } },
  contextLabel: "上下文：2 条 / 100 字符 · 含最近 assistant 回复",
  candidateText: "优化结果 😀 中文\n".repeat(100),
  openHint: "ctrl+\\",
  elapsedSeconds: 0,
};

describe("passive result summary", () => {
  it.each([1, 10, 20, 40, 80])("bounds lines and terminal columns at width %i", (width) => {
    const lines = renderSummary(options, width);
    expect(lines.length).toBeLessThanOrEqual(12);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  });

  it("marks preview truncation and never renders terminal control sequences from the model", () => {
    expect(renderSummary(options, 80).join("\n")).toContain("摘要已截断");
    const lines = renderSummary({ ...options, candidateText: "\x1b[2Jdanger\r\x07" }, 80);
    expect(lines.join("\n")).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f]/);
  });

  it("keeps the summary focused and limits prose even on wide terminals", () => {
    const lines = renderSummary(options, 200);
    const text = lines.join("\n");
    expect(text).toContain("✓ 优化完成");
    expect(text).toContain("ctrl+\\");
    expect(text).not.toContain("fake/chat");
    expect(text).not.toContain("a 接受");
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(100);
  });

  it("normalizes display-only CRLF and tabs without permitting cursor controls", () => {
    expect(sanitizeTerminalText("one\r\n\tcode\r\x1b[2J")).toBe("one\n    code��[2J");
  });

  it("does not render idle or zero-width widgets", () => {
    expect(renderSummary(options, 0)).toEqual([]);
    expect(renderSummary({ ...options, state: { ...options.state, phase: "idle" } }, 80)).toEqual([]);
  });

  it("recognizes Control+backslash without Kitty keyboard protocol", () => {
    expect(parseKey("\x1c")).toBe("ctrl+\\");
    expect(matchesKey("\x1c", "ctrl+\\")).toBe(true);
  });
});
