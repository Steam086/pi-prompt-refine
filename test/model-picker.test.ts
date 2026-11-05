import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { renderModelChoices } from "../src/model-picker.js";

const items = Array.from({ length: 20 }, (_, i) => ({
  value: `provider/very-long-model-identifier-${i}`,
  label: `provider/very-long-model-identifier-${i} [thinking]${i === 12 ? " (current)" : ""}`,
  description: `模型 Model ${i}`,
}));

describe("model picker layout", () => {
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
