import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { alignedHints, panelFrame, panelGeometry } from "../src/panel-layout.js";
import { workspaceHeight, workspaceLayout, workspaceViewport } from "../src/workspace-overlay.js";

describe("overlay geometry", () => {
  it("uses the terminal budget rather than initial content demand", () => {
    expect(workspaceHeight(60)).toBe(57);
    expect(workspaceLayout(100, 60)).toEqual(workspaceLayout(100, 60));
    expect(workspaceLayout(100, 60).bodyHeight).toBeGreaterThan(40);
    expect(workspaceLayout(100, 80).bodyHeight).toBeGreaterThan(workspaceLayout(100, 60).bodyHeight);
  });

  it("reserves its border, centers a bounded canvas and never allocates negative body rows", () => {
    for (let rows = 1; rows <= 100; rows++) for (const width of [1, 2, 7, 8, 12, 20, 40, 100, 240]) {
      const viewport = workspaceViewport(width, rows);
      const layout = workspaceLayout(width, rows);
      expect(viewport.height).toBeLessThanOrEqual(rows);
      expect(layout.height + (viewport.framed ? 2 : 0)).toBe(viewport.height);
      expect(layout.bodyHeight).toBeGreaterThanOrEqual(1);
      expect(layout.inset + layout.innerWidth).toBeLessThanOrEqual(viewport.width);
      expect(layout.innerWidth).toBeLessThanOrEqual(156);
      expect(layout.topSeparatorHeight).toBe(0);
    }
    expect(workspaceLayout(240, 80).inset).toBeGreaterThan(20);
    expect(workspaceViewport(7, 40).framed).toBe(false);
    expect(workspaceViewport(100, 5).framed).toBe(false);
  });
});

describe("frame action placement", () => {
  it("lifts hints after tabs without changing content capacity or default footer placement", () => {
    const layout = panelGeometry(40, 12, 40, false, false, 0);
    const header = ["Title", "Status"];
    const body = ["Tabs", "", "Original 中文😀", "Result", "Last line"];
    const hints = ["Enter Inspect", "Esc Back"];
    const bottom = panelFrame(layout, header, body, hints, (text) => text);
    const top = panelFrame(layout, header, body, hints, (text) => text, { footerAfterBodyRows: 2 });
    expect(bottom.slice(-2)).toEqual(hints);
    expect(top.slice(0, 7)).toEqual([...header, ...body.slice(0, 2), ...hints, "─".repeat(40)]);
    expect(top.slice(7)).toEqual(bottom.slice(4, -3));
    expect(top).toHaveLength(layout.height);
    expect(top.join("\n")).toContain("Original 中文😀");
    expect(top.join("\n")).toContain("Last line");
  });
});

describe("aligned footer hints", () => {
  it("shares column starts rather than distributing each row independently", () => {
    expect(alignedHints([
      ["r Refine", "m Model", "x Cancel", "Enter won't send"],
      ["q Back", "? Help", "i Input", "→ Settings"],
    ], 96)).toEqual([
      "r Refine · m Model · x Cancel · Enter won't send",
      "q Back   · ? Help  · i Input  · → Settings",
    ]);
  });

  it("measures ANSI and wide text in terminal columns", () => {
    const lines = alignedHints([["\x1b[1m中😀\x1b[22m", "Next"], ["é", "Back"]], 30);
    expect(visibleWidth(lines[0].split(" · ")[0])).toBe(4);
    expect(visibleWidth(lines[1].split(" · ")[0])).toBe(4);
  });

  it.each([1, 8, 16, 20, 36, 76, 96])("omits whole columns without overflow at %i columns", (width) => {
    const lines = alignedHints([["a Accept", "e Edit", "Enter won't send"], ["q Back", "? Help"]], width);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      expect(line).not.toMatch(/ · $/);
    }
    expect(lines).toHaveLength(2);
  });

  it("does not leave separators for missing trailing cells", () => {
    expect(alignedHints([["Accept"], ["Back", "Help"]], 30)).toEqual(["Accept", "Back   · Help"]);
  });
});
