import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { renderModelChoices, renderModelPicker, renderOverlayModelPicker, type ModelPickerOptions } from "../src/model-picker.js";
import { workspaceHeight } from "../src/workspace-overlay.js";
import { panelLayout } from "../src/panel-layout.js";
import { stripVTControlCharacters } from "node:util";
import { formatKeyHint } from "../src/key-hints.js";

const items = Array.from({ length: 20 }, (_, i) => ({
  value: `provider/very-long-model-identifier-${i}`,
  label: `provider/very-long-model-identifier-${i} [thinking]${i === 12 ? " (current)" : ""}`,
  description: `模型 Model ${i}`,
}));

describe("model picker layout", () => {
  it.each(["dark", "light"])("uses the workspace overlay bounds and aligned frame (%s)", (name) => {
    const theme = getThemeByName(name)!;
    const options: ModelPickerOptions = { items, selectedKey: items[12]!.value, query: "中文😀\x1b[31m", title: "Choose optimizer model",
      subtitle: "Optimizer only · Main session unchanged", thinkingKeys: "Shift+Tab", thinkingStatus: "Thinking level: high", run: false };
    for (const rows of [1, 5, 8, 24, 60]) for (const width of [1, 7, 12, 20, 40, 100, 240]) {
      const lines = renderOverlayModelPicker(options, width, rows, theme);
      expect(lines).toHaveLength(workspaceHeight(rows));
      expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
      expect(lines.join("\n")).not.toContain("\x1b[31m");
      if (width >= 8 && workspaceHeight(rows) >= 6) {
        expect(stripVTControlCharacters(lines[0]!)).toMatch(/^╭─+╮$/);
        expect(stripVTControlCharacters(lines.at(-1)!)).toMatch(/^╰─+╯$/);
      }
      if (width >= 40 && rows >= 24) expect(lines.join("\n")).toContain("模型 Model 12");
    }
  });
  it.each(["dark", "light"])("budgets the full picker frame across resize, search and thinking changes (%s)", (name) => {
    const theme = getThemeByName(name)!;
    const options: ModelPickerOptions = { items, selectedKey: items[12]!.value, query: "", title: "Choose optimizer model",
      subtitle: "Optimizer only · Main session unchanged", thinkingKeys: "Shift+Tab", thinkingStatus: "Thinking level: high · Last used for this model", run: false };
    for (const rows of [5, 8, 12, 24, 40, 80, 12]) for (const width of [1, 12, 20, 40, 100, 180]) {
      const lines = renderModelPicker(options, width, rows, theme);
      expect(lines).toHaveLength(panelLayout(width, rows).height);
      expect(lines.every((line) => visibleWidth(line) <= Math.min(width, 100))).toBe(true);
      if (width >= 20 && rows >= 8) expect(lines.at(-1)).toContain(formatKeyHint(["Esc", "Cancel"], theme));
      if (width >= 20 && rows === 8) expect(lines.at(-1)).toContain(formatKeyHint(width < 34 ? ["↵", "Use"] : ["Enter", "Confirm"], theme));
      if (width >= 40 && rows >= 12) expect(lines.join("\n")).toContain("模型 Model 12");
      if (width >= 100 && rows >= 24) expect(lines.join("\n")).toContain(theme.fg("muted", options.thinkingStatus));
    }
    options.query = "中文😀\x1b[31m".repeat(30); options.items = [];
    const empty = renderModelPicker(options, 40, 40, theme);
    expect(empty.join("\n")).not.toContain("\x1b[31m");
    expect(stripVTControlCharacters(empty.join("\n"))).toContain("No matching models");
    expect(empty.join("\n")).toContain(formatKeyHint(["Esc", "Cancel"], theme));
    for (const height of [0, 1, 2, 3, 4, 10, 20]) {
      const choices = renderModelChoices(items, items[12]!.value, 30, height, theme);
      expect(choices.length).toBeLessThanOrEqual(height);
      if (height) expect(choices.join("\n")).toContain("模型 Model 12");
    }
  });

  it.each(["dark", "light"])("fills the wide picker with complete models instead of unused three-row reservations (%s)", (name) => {
    const theme = getThemeByName(name)!;
    const options: ModelPickerOptions = { items: items.slice(0, 10), selectedKey: items[0]!.value, query: "",
      title: "Run original with another model", subtitle: "Same original and conversation context · Default model unchanged",
      thinkingKeys: "Shift+Tab", thinkingStatus: "Thinking level: off · Last used for this model", run: true };
    for (const [width, rows] of [[100, 40], [24, 40], [180, 80], [100, 40]] as const) {
      for (const selected of [0, 5, 9]) {
        options.selectedKey = items[selected]!.value;
        const lines = renderModelPicker(options, width, rows, theme);
        const plain = lines.map(stripVTControlCharacters);
        // Wide entries use two rows; narrow entries keep their badges on a third row.
        expect(plain.filter((line) => line.includes("模型 Model"))).toHaveLength(width >= 100 ? 7 : 4);
        expect(plain.join("\n")).toContain(`模型 Model ${selected}`);
        const more = plain.findIndex((line) => line.includes("More models"));
        const thinking = plain.findIndex((line) => line.includes("Thinking level:"));
        if (width >= 100) {
          expect(thinking - more).toBe(2); // Only the intentional one-row gap remains.
          expect(lines[thinking]).toContain(theme.fg("muted", options.thinkingStatus));
        }
        expect(lines.join("\n")).toContain(formatKeyHint([width < 34 ? "↵" : "Enter", "Run"], theme));
        expect(lines.join("\n")).toContain(formatKeyHint(["Esc", "Cancel"], theme));
      }
    }
  });

  it.each(["dark", "light"])("fits mixed entry heights and only reserves scrolling when needed (%s)", (name) => {
    const theme = getThemeByName(name)!;
    const mixed = [
      { value: "p/0", label: "short", description: "Short 中文😀" },
      { value: "p/1", label: "long [thinking]", description: "Long model 中文😀" },
      { value: "p/2", label: "short", description: "Short model" },
      { value: "p/3", label: "long [thinking]", description: "Long model 中文😀" },
    ];
    const lines = renderModelChoices(mixed, "p/1", 30, 8, theme);
    expect(lines).toHaveLength(8); // 2 + 3 + 2 rows, then the scroll indicator.
    const plain = lines.map((line) => stripVTControlCharacters(line).trimEnd());
    for (const id of ["p/0", "p/1", "p/2"]) expect(plain).toContain(`  ${id}`);
    expect(plain.at(-1)).toContain("2/4 · ↑↓ More models");
    expect(lines.every((line) => visibleWidth(line) <= 30)).toBe(true);

    const all = renderModelChoices(mixed.slice(0, 3), "p/1", 30, 7, theme);
    expect(all).toHaveLength(7);
    expect(all.join("\n")).not.toContain("More models");
    expect(all.map(stripVTControlCharacters).at(-1)).toBe("  p/2");
  });

  it.each(["dark", "light"])("fits terminal widths and keeps selection visible (%s)", (name) => {
    const theme = getThemeByName(name)!;
    for (const width of [1, 2, 12, 30, 60, 100, 160]) {
      const lines = renderModelChoices(items, items[12]!.value, width, 40, theme);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      if (width >= 30) {
        expect(lines.join("\n")).toContain("模型 Model 12");
        expect(lines.join("\n")).toContain("Thinking capable");
        expect(lines.join("\n")).toContain("Current");
        expect(lines.join("\n")).toContain("13/20");
      }
      expect(lines.some((line) => line.startsWith(theme.bg("selectedBg", "X").split("X")[0]!))).toBe(true);
    }
  });
  it.each(["dark", "light"])("uses normal model text and an accent selection marker in %s", (name) => {
    const theme = getThemeByName(name)!;
    const bold = vi.spyOn(theme, "bold");
    const output = renderModelChoices(items, items[12]!.value, 100, 40, theme).join("\n");
    const calls = [...bold.mock.calls];
    bold.mockRestore();
    expect(calls).toEqual([]);
    expect(output).toContain(theme.fg("accent", "› "));
    expect(output).toContain(theme.fg("text", "模型 Model 12"));
    expect(output).toContain(theme.fg("muted", `  ${items[12]!.value}`));
  });

  it("uses wide terminals for full identities without a fixed label column", () => {
    const output = renderModelChoices(items, items[12]!.value, 160, 40, getThemeByName("dark")!).join("\n");
    expect(output).toContain(items[12]!.value);
  });
  it.each(["dark", "light"])("sanitizes external model identities and descriptions before styling (%s)", (name) => {
    const theme = getThemeByName(name)!;
    const unsafe = "\x1b[1m\x1b[31m\x1b]52;c;payload\x07";
    const item = { value: `provider/model${unsafe}`, label: `provider/model${unsafe}`, description: `Model 中文😀${unsafe}` };
    const output = renderModelChoices([item], item.value, 100, 40, theme).join("\n");
    expect(output).not.toContain("\x1b[1m");
    expect(output).not.toContain("\x1b[31m");
    expect(output).not.toContain("\x1b]52");
    expect(output).toContain("Model 中文😀�[1m�[31m�]52;c;payload�");
    expect(output).toContain("provider/model�[1m�[31m�]52;c;payload�");
  });

  it("handles no results and zero width", () => {
    const theme = getThemeByName("dark")!;
    expect(renderModelChoices([], undefined, 40, 24, theme).join("")).toContain("No matching models");
    expect(renderModelChoices(items, undefined, 0, 24, theme)).toEqual([]);
  });
});
