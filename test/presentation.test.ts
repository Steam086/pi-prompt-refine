import { describe, expect, it } from "vitest";
import { matchesKey, parseKey, visibleWidth } from "@earendil-works/pi-tui";
import { renderSummary, sanitizeTerminalText, type SummaryOptions } from "../src/presentation.js";
import { panelLayout } from "../src/panel-layout.js";

const options: SummaryOptions = {
  state: { phase: "ready", requestId: 1, pendingSend: false, model: { provider: "fake", id: "chat" } },
  contextLabel: "2 msgs · 100 char · assistant",
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
    const contextLabel = "⚠1 · 7 msgs · 2032 char · assistant · 3 rules · 10 skills";
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
    expect(lines[0]).toBe("  " + "─".repeat(76));
    expect(lines.at(-1)).toBe(lines[0]);
    expect(lines[1]).toContain("Prompt refine");
    expect(lines[1]).not.toContain("[Prompt refine]");
    expect(colors).toContain("borderMuted");
  });

  it("aligns the background card with the workspace and keeps the shortcut concise", () => {
    const lines = renderSummary({ ...options, state: { ...options.state, phase: "generating" } }, 80);
    expect(lines[1]).toBe("  Prompt refine · ◌ Refining · 12s");
    expect(lines[2]).toBe("  2 msgs · 100 char · assistant");
    expect(lines).toContain("  Working in background. Keep editing.");
    expect(lines.at(-2)).toBe("  ctrl+\\ View");
    expect(lines.join("\n")).not.toMatch(/│|\/ actions/);
  });

  it.each([1, 10, 12, 15, 16, 20, 40, 80, 100, 200])("matches workspace insets and content width at %i columns", (width) => {
    const layout = panelLayout(width, 24);
    const lines = renderSummary({ ...options, candidateText: "x".repeat(300) }, width);
    const prefix = " ".repeat(layout.inset);
    expect(lines[0]).toBe(prefix + "─".repeat(layout.innerWidth));
    expect(lines.at(-1)).toBe(lines[0]);
    expect(lines[4]).toBe(prefix + "x".repeat(layout.innerWidth));
    for (const line of lines) {
      expect(line.startsWith(prefix)).toBe(true);
      expect(visibleWidth(line)).toBeLessThanOrEqual(layout.inset + layout.innerWidth);
    }
  });

  it.each([
    ["generating", "accent"], ["ready", "success"], ["error", "warning"],
  ] as const)("uses neutral title and shortcut styling while retaining %s status color", (phase, statusColor) => {
    const styles: [string, string][] = [];
    renderSummary({ ...options, state: { ...options.state, phase } }, 80, {
      fg: (color, text) => { styles.push([color, text]); return text; },
      bold: (text) => `<bold>${text}</bold>`,
    });
    expect(styles).toContainEqual(["text", "<bold>Prompt refine</bold>"]);
    expect(styles).toContainEqual(["text", "<bold>ctrl+\\</bold>"]);
    expect(styles).toContainEqual(["muted", "View"]);
    expect(styles).toContainEqual([statusColor, expect.stringMatching(/^<bold>.* · 12s<\/bold>$/)]);
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
