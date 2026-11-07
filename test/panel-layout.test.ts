import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { alignedHints, panelLayout, WorkspaceHeight } from "../src/panel-layout.js";

describe("opening-scoped height", () => {
  it("sizes once, bounds long content and remeasures only on resize", () => {
    const sizing = new WorkspaceHeight();
    let demand = 3;
    let measurements = 0;
    const measure = () => { measurements++; return demand; };
    expect(sizing.layout(100, 60, measure).height).toBe(18);
    demand = 1000;
    expect(sizing.layout(100, 60, measure).height).toBe(18);
    expect(measurements).toBe(1);
    expect(sizing.layout(80, 60, measure).height).toBe(24);
    expect(measurements).toBe(2);
    expect(new WorkspaceHeight().layout(100, 60, measure).height).toBe(24);
  });

  it("expands within terminal bounds without remeasuring or changing the compact choice", () => {
    const sizing = new WorkspaceHeight();
    let calls = 0;
    const measure = () => { calls++; return 3; };
    expect(sizing.layout(100, 60, measure).height).toBe(18);
    sizing.toggle(60);
    expect(sizing.isExpanded).toBe(true);
    expect(sizing.layout(100, 60, measure).height).toBe(51);
    sizing.toggle(60);
    expect(sizing.layout(100, 60, measure).height).toBe(18);
    expect(calls).toBe(1);
    for (let rows = 1; rows <= 100; rows++) {
      const compact = sizing.layout(100, rows, measure).height;
      sizing.toggle(rows);
      const expanded = sizing.layout(100, rows, measure).height;
      expect(expanded).toBeGreaterThanOrEqual(compact);
      expect(expanded).toBeLessThanOrEqual(Math.max(1, rows - 4));
      sizing.toggle(rows);
      expect(sizing.layout(100, rows, measure).height).toBe(compact);
    }
  });

  it("respects terminal bounds and leaves body space even in tiny terminals", () => {
    for (let rows = 1; rows <= 100; rows++) {
      for (const demand of [0, 3, 10, 1000]) {
        const layout = new WorkspaceHeight().layout(20, rows, () => demand);
        expect(layout.height).toBeLessThanOrEqual(Math.max(1, rows - 4));
        expect(layout.height).toBeLessThanOrEqual(panelLayout(20, rows).height);
        expect(layout.bodyHeight).toBeGreaterThanOrEqual(1);
        expect(panelLayout(20, rows, 1000).height).toBe(Math.max(1, rows - 4));
      }
    }
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
