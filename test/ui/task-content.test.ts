import { visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskContent } from "../../src/ui/task-content.js";
import { getThemeByName } from "../support/pi-theme.js";
import { record } from "../support/task-panel.js";

afterEach(() => vi.restoreAllMocks());

describe("TaskContent reading seam", () => {
  it.each(["dark", "light"])("returns separate effective offsets without changing requested anchors in %s", (name) => {
    const theme = getThemeByName(name)!;
    vi.spyOn(theme, "bold").mockImplementation((text) => `\x1b[1m${text}\x1b[22m`);
    const content = new TaskContent(theme);
    const run = record();
    run.input.draft = "Original 中文😀 **literal**\n".repeat(80);
    run.candidate!.text = "Result 中文😀 **literal**\n".repeat(80);
    const row = { record: run, original: false, records: [run] };
    const options = Object.freeze({ inline: false, preferences: false, inspecting: true, referenceOnly: false,
      original: false, usage: false, scroll: 40, referenceScroll: 20 });
    const compact = content.pane(row, 100, 15, options, true);
    expect(compact.offsets).toEqual([{ reference: false, offset: 40 }, { reference: true, offset: 20 }]);
    expect(compact.lines.every((line) => visibleWidth(line) <= 100)).toBe(true);
    // Wrapped multiline documents carry their color across line boundaries.
    expect(compact.lines.join("\n")).toContain(theme.fg("text", "Result 中文😀 **literal**").replace(/\x1b\[39m$/u, ""));
    expect(compact.lines.join("\n")).toContain(theme.fg("text", "Original 中文😀 **literal**").replace(/\x1b\[39m$/u, ""));
    expect(compact.lines.join("\n")).not.toContain(theme.bold("Result 中文😀 **literal**"));
    expect(compact.lines.join("\n")).not.toContain(theme.bold("Original 中文😀 **literal**"));
    const tall = content.pane(row, 100, 100, options, true);
    expect(tall.offsets.every(({ offset }) => offset < 20)).toBe(true);
    expect(options.scroll).toBe(40);
    expect(options.referenceScroll).toBe(20);
    expect(content.pane(row, 100, 15, options, true)).toEqual(compact);
    const narrow = content.pane(row, 50, 15, { ...options, original: true }, true);
    expect(narrow.offsets).toEqual([{ reference: true, offset: 20 }]);
    expect(stripVTControlCharacters(narrow.lines.join("\n"))).toContain("Original 中文😀 **literal**");
    expect(stripVTControlCharacters(narrow.lines.join("\n"))).not.toContain("Result 中文😀 **literal**");
    content.invalidate();
    expect(content.pane(row, 100, 15, options, true)).toEqual(compact);
  });
});
