import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { alignedKeyHints, fittingKeyHints, formatKeyHint, keyHintGrid, type KeyHint } from "../../src/key-hints.js";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const hints: KeyHint[] = [["r", "Refine"], ["m", "Model"], ["x", "Cancel"]];

describe("fixed-column key hints", () => {
  it("uses neutral bold keys and muted descriptions", () => {
    const styled = {
      fg: (color: string, text: string) => `\x1b[${color === "muted" ? 90 : 37}m${text}\x1b[39m`,
      bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
    };
    const save = "\x1b[37m\x1b[1mEnter\x1b[22m\x1b[39m \x1b[90mSave\x1b[39m";
    expect(formatKeyHint(["Enter", "Save"], styled)).toBe(save);
    expect(alignedKeyHints([[["Enter", "Save"]]], 40, styled)).toEqual([save]);
    expect(fittingKeyHints([["Enter", "Save"], ["Space", "Toggle"]], 10, styled)).toBe(save);
    expect(formatKeyHint(["", "Send pending"], styled)).toBe(styled.fg("muted", "Send pending"));
    expect(formatKeyHint(["↑↓", ""], styled)).toBe(styled.fg("text", styled.bold("↑↓")));
    const pair: KeyHint[] = [["a", "Accept"], ["s", "Send to Pi"]];
    const joined = pair.map((hint) => formatKeyHint(hint, styled)).join(styled.fg("muted", " · "));
    expect(alignedKeyHints([pair], 23, styled)).toEqual([joined]);
    expect(fittingKeyHints(pair, 23, styled)).toBe(joined);
    expect(fittingKeyHints(pair, 22, styled)).toBe(formatKeyHint(pair[0]!, styled));
  });

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
    expect(lines[0]).toContain(styled.fg("text", "中文") + " ".repeat(16) + "\x1b[31m?");
    expect(visibleWidth(lines[0]!)).toBe(28);
    expect(lines.join("\n")).not.toContain("\t");
  });
});
