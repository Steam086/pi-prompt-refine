import { describe, expect, it } from "vitest";
import { matchesKey, parseKey, visibleWidth } from "@earendil-works/pi-tui";
import { renderSummary, sanitizeTerminalText, type SummaryOptions } from "../src/presentation.js";

const options: SummaryOptions = {
  state: { phase: "ready", requestId: 1, pendingSend: false, model: { provider: "fake", id: "chat" } },
  contextLabel: "2 msgs/100 ch · asst",
  candidateText: "优化结果 😀 中文\n".repeat(100),
  openHint: "ctrl+\\",
  elapsedSeconds: 12,
};

describe("passive result summary", () => {
  it.each([1, 10, 20, 40, 80])("bounds lines and terminal columns at width %i", (width) => {
    const lines = renderSummary(options, width);
    expect(lines.length).toBeLessThanOrEqual(14);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  });

  it("marks preview truncation and never renders terminal control sequences from the model", () => {
    expect(renderSummary(options, 80).join("\n")).toContain("Open for full prompt");
    const lines = renderSummary({ ...options, candidateText: "\x1b[2Jdanger\r\x07" }, 80);
    expect(lines.join("\n")).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f]/);
  });

  it("keeps the summary focused and limits prose even on wide terminals", () => {
    const lines = renderSummary(options, 200);
    const text = lines.join("\n");
    expect(text).toContain("✓ Done · 12s");
    expect(text).toContain("ctrl+\\");
    expect(text).not.toContain("fake/chat");
    expect(text).not.toContain("a Accept");
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(100);
  });

  it.each([40, 80, 100])("uses compact English chrome without ellipses at %i columns", (width) => {
    const contextLabel = "⚠1 · 7 msgs/2032 ch · asst · 3 rules   ·   10 skills";
    for (const phase of ["generating", "ready", "error"] as const) {
      const lines = renderSummary({ ...options, contextLabel, candidateText: "Refined prompt", state: { ...options.state, phase } }, width);
      const text = lines.join("\n");
      expect(text).not.toMatch(/[\p{Script=Han}…]|\.{3}/u);
      expect(text).toContain("12s");
      if (width >= 80) expect(lines.filter((line) => line.includes(contextLabel))).toHaveLength(1);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it.each(["generating", "ready", "error"] as const)("separates the %s plugin preview from session content", (phase) => {
    const colors: string[] = [];
    const lines = renderSummary({ ...options, state: { ...options.state, phase } }, 80, {
      fg: (color, text) => { colors.push(color); return text; },
      bold: (text) => text,
    });
    expect(lines[0]).toBe("─".repeat(80));
    expect(lines.at(-1)).toBe(lines[0]);
    expect(lines[1]).toContain("Prompt Refine");
    expect(colors).toContain("borderMuted");
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
