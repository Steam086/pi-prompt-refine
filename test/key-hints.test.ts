import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { keyHintGrid, type KeyHint } from "../src/key-hints.js";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const hints: KeyHint[] = [["r", "Refine"], ["m", "Model"], ["x", "Cancel"]];

describe("fixed-column key hints", () => {
  it("wraps whole cells at fixed tab stops when resized", () => {
    expect(keyHintGrid(hints, 64, theme)).toEqual(["r Refine              m Model               x Cancel"]);
    expect(keyHintGrid(hints, 42, theme)).toEqual(["r Refine              m Model", "x Cancel"]);
    expect(keyHintGrid(hints, 20, theme)).toEqual(["r Refine", "m Model", "x Cancel"]);
    expect(keyHintGrid(hints, 0, theme)).toEqual([]);
  });

  it("aligns context key and action columns", () => {
    expect(keyHintGrid([["↑↓", "Select"], ["Space", "Toggle"], ["Enter", "Save"], ["←/q/Esc", "Back (discard)"]], 60, theme, 7, 30)).toEqual([
      "↑↓      Select                Space   Toggle",
      "Enter   Save                  ←/q/Esc Back (discard)",
    ]);
  });

  it("measures visible columns rather than ANSI or Unicode string lengths", () => {
    const styled = { fg: (_color: string, text: string) => `\x1b[31m${text}\x1b[39m`, bold: theme.bold };
    const lines = keyHintGrid([["→", "中文"], ["?", "Help"]], 42, styled);
    expect(lines[0]).toContain("中文" + " ".repeat(16) + "\x1b[31m?");
    expect(visibleWidth(lines[0]!)).toBe(28);
    expect(lines.join("\n")).not.toContain("\t");
  });
});
