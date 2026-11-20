import { frameHeader } from "../support/panel-chrome.js";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { formatKeyHint } from "../../src/key-hints.js";
import { renderModelChoices, renderModelPicker, renderOverlayModelPicker, type ModelPickerOptions } from "../../src/model-picker.js";
import { panelLayout } from "../../src/panel-layout.js";
import { workspaceHeight } from "../../src/workspace-overlay.js";
import { getThemeByName } from "../support/pi-theme.js";

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
  it.each(["dark", "light"])("keeps Settings picker chrome, filter and selected identity readable (%s)", (name) => {
    const theme = getThemeByName(name)!;
    const bold = vi.spyOn(theme, "bold").mockImplementation((text) => `\x1b[1m${text}\x1b[22m`);
    const item = { value: "p/model", label: "p/model [thinking] (current)", description: "Model 中文😀", usedInTask: true };
    const options: ModelPickerOptions = { items: [...items, item], selectedKey: item.value, fromSettings: true,
      title: "Choose optimizer model", subtitle: "", query: "中文😀\x1b[2J", run: false,
      thinkingKeys: "Shift+Tab", thinkingStatus: "Thinking level: high · Last used for this model" };
    try {
      for (const [width, rows] of [[160, 40], [60, 20], [32, 9], [160, 40]] as const) {
        const lines = renderOverlayModelPicker(options, width, rows, theme);
        const output = lines.join("\n");
        expect(lines.map(visibleWidth)).toEqual(Array<number>(workspaceHeight(rows)).fill(width));
        expect(output).toContain(formatKeyHint(["Esc", "Cancel"], theme));
        expect(output).toContain(formatKeyHint(["Enter", "Save"], theme));
        expect(output).toContain(theme.fg("text", "中文😀�[2J"));
        expect(output).toContain(theme.fg("text", theme.bold(item.description)));
        expect(output).toContain(theme.fg("muted", `  ${item.value}`));
        expect(output).not.toContain("\x1b[2J");
        if (rows >= 20) {
          expect(output).toContain(theme.bg("selectedBg", theme.fg("text", theme.bold(" Settings "))));
          expect(output).toContain(formatKeyHint(["Shift+Tab", "Thinking"], theme));
          expect(output).toContain("This task");
          expect(output).not.toContain(theme.bold("This task"));
        }
      }
      options.items = []; options.thinkingKeys = "";
      const empty = renderOverlayModelPicker(options, 32, 9, theme).join("\n");
      expect(empty).toContain(theme.fg("warning", "No matching models"));
      expect(empty).toContain(formatKeyHint(["Esc", "Cancel"], theme));
      expect(empty).not.toContain(formatKeyHint(["Enter", "Save"], theme));
    } finally { bold.mockRestore(); }
  });

  it.each(["dark", "light"])("budgets the full picker frame across resize, search and thinking changes (%s)", (name) => {
    const theme = getThemeByName(name)!;
    const options: ModelPickerOptions = { items, selectedKey: items[12]!.value, query: "", title: "Choose optimizer model",
      subtitle: "Optimizer only · Main session unchanged", thinkingKeys: "Shift+Tab", thinkingStatus: "Thinking level: high · Last used for this model", run: false };
    for (const rows of [5, 8, 12, 24, 40, 80, 12]) for (const width of [1, 12, 20, 40, 100, 180]) {
      const lines = renderModelPicker(options, width, rows, theme);
      expect(lines).toHaveLength(panelLayout(width, rows).height);
      expect(lines.every((line) => visibleWidth(line) <= Math.min(width, 100))).toBe(true);
      if (width >= 20 && rows >= 8) expect(frameHeader(lines).join("\n")).toContain(formatKeyHint(["Esc", "Cancel"], theme));
      if (width >= 20 && rows === 8) expect(frameHeader(lines).join("\n")).toContain(formatKeyHint(width < 34 ? ["↵", "Use"] : ["Enter", "Confirm"], theme));
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
  it.each(["dark", "light"])("emphasizes only the selected model name through resize in %s", (name) => {
    const theme = getThemeByName(name)!;
    const bold = vi.spyOn(theme, "bold").mockImplementation((text) => `\x1b[1m${text}\x1b[22m`);
    const choices = [
      { value: "p/one", label: "one [thinking] (current)", description: "模型😀 One" },
      { value: "p/two", label: "two [thinking]", description: "模型😀 Two" },
    ];
    try {
      for (const width of [100, 30, 12, 8, 100]) for (const selected of choices) {
        bold.mockClear();
        const lines = renderModelChoices(choices, selected.value, width, 20, theme);
        const output = lines.join("\n");
        const label = stripVTControlCharacters(truncateToWidth(selected.description, width - 2));
        expect(bold.mock.calls).toEqual([[label]]);
        expect(output).toContain(theme.fg("accent", "› "));
        expect(output).toContain(theme.fg("text", theme.bold(label)));
        expect(output).toContain(theme.fg("muted", `  ${selected.value}`));
        for (const badge of ["Thinking capable", "Current"]) expect(output).not.toContain(theme.bold(badge));
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
        const active = lines.filter((line) => line.startsWith(theme.bg("selectedBg", "X").split("X")[0]!));
        expect(active.length).toBeGreaterThanOrEqual(2);
        expect(active.every((line) => visibleWidth(line) === width)).toBe(true);
        expect(active[0]).not.toContain("\x1b[0m");
      }
    } finally { bold.mockRestore(); }
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
    expect(output).toContain(theme.fg("text", theme.bold("Model 中文😀�[1m�[31m�]52;c;payload�")));
    expect(output).not.toContain(unsafe);
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
