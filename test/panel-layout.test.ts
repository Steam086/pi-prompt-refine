import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { alignedHints } from "../src/panel-layout.js";

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
