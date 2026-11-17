import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskContent } from "../../src/ui/task-content.js";
import { sanitizeTerminalText } from "../../src/presentation.js";
import { getThemeByName } from "../support/pi-theme.js";
import { record } from "../support/task-panel.js";

afterEach(() => vi.restoreAllMocks());

const previewOptions = { taskPreview: true, inline: false, preferences: true, inspecting: false,
  referenceOnly: false, original: false, usage: false, scroll: 0, referenceScroll: 0 };

function previewRecord() {
  const run = record();
  run.input.preferences = [
    { id: "tone", scope: "project", version: 1, name: "Neutral Prompt Tone", body: "Keep tone neutral.", sourceBody: "Keep tone neutral." },
    { id: "structure", scope: "project", version: 1, name: "Prompt Bullet Structure", body: "Use bullets.", sourceBody: "Use bullets." },
  ];
  return run;
}

describe("Tasks preview hierarchy", () => {
  it.each(["dark", "light"])("separates a prominent title, quiet metadata and literal body in %s", (name) => {
    const theme = getThemeByName(name)!;
    vi.spyOn(theme, "bold").mockImplementation((text) => `\x1b[1m${text}\x1b[22m`);
    const content = new TaskContent(theme);
    const run = previewRecord();
    run.input.draft = "# Literal heading 中文😀\n\nKeep **literal** text.\n\n```ts\n  const path = '/src/a.ts';\n```";
    const row = { record: run, original: true, records: [run] };
    const pane = content.pane(row, 105, 30, previewOptions);
    const plain = pane.lines.map(stripVTControlCharacters);
    expect(pane.lines[0]).toContain(theme.fg("text", theme.bold("Original prompt")));
    expect(pane.lines[0]).toContain(theme.fg("muted", "1 runs · 0 active"));
    expect(visibleWidth(pane.lines[0]!)).toBe(105); // Statistics remain right aligned.
    expect(pane.lines[1]).toContain(theme.fg("muted", content.preferenceSummary(run)));
    expect(pane.lines[1]).not.toContain("\x1b[1m");
    expect(pane.lines[2]).toBe(theme.fg("muted", "─".repeat(88)));
    expect(plain[3]).toBe("");
    expect(plain.slice(4).map((line) => line.trimEnd()).join("\n")).toBe(run.input.draft);
    expect(pane.lines.join("\n")).toContain(theme.fg("text", "# Literal heading 中文😀").replace(/\x1b\[39m$/u, ""));
    expect(pane.lines.slice(4).join("\n")).not.toContain("\x1b[1m");
    const renderedRun = content.pane({ ...row, original: false }, 105, 30, previewOptions).lines.join("\n");
    expect(renderedRun).toContain(theme.fg("muted", "23s"));
    expect(renderedRun).not.toContain(theme.bold("23s"));
    expect(renderedRun).toContain(theme.fg("success", "✓ Done"));
  });

  it.each(["dark", "light"])("wraps without editing paragraphs, code, paths or long strings in %s", (name) => {
    const content = new TaskContent(getThemeByName(name)!);
    const run = previewRecord();
    run.input.draft = "中英文 mixed 😀 " + "readable prose with natural spacing. ".repeat(10)
      + "\n\n```ts\n    const path = '/data/Sources/中文/path.ts';\n```\n\n"
      + "https://example.com/" + "long-path/".repeat(20) + "\n" + "Z".repeat(240)
      + "\n\nEND 中文😀 **literal**\x1b[2J";
    const frozen = structuredClone(run);
    const row = { record: run, original: true, records: [run] };
    for (const width of [28, 40, 60, 88, 105, 160, 28, 105]) {
      const pane = content.pane(row, width, 200, previewOptions);
      const plain = pane.lines.map(stripVTControlCharacters);
      const divider = plain.findIndex((line) => /^─+$/u.test(line));
      const columns = Math.min(width, 88);
      const expected = new Text(sanitizeTerminalText(run.input.draft), 0, 0).render(columns).map(stripVTControlCharacters);
      expect(divider).toBeGreaterThan(0);
      expect(plain.slice(divider + 2)).toEqual(expected);
      expect(pane.lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(plain.slice(divider + 2).every((line) => visibleWidth(line) <= columns)).toBe(true);
      expect(pane.lines.join("\n")).not.toContain("\x1b[2J");
      expect(pane.offsets).toEqual([{ reference: false, offset: 0 }]);
    }
    expect(run).toEqual(frozen);
    expect(content.originalHeight(row, 105, previewOptions)).toBe(content.paneHeader(row, 105, previewOptions).length
      + 2 + new Text(sanitizeTerminalText(run.input.draft), 0, 0).render(88).length);
  });

  it.each(["dark", "light"])("spends short-pane space on content and keeps overflowing warnings scrollable in %s", (name) => {
    const content = new TaskContent(getThemeByName(name)!);
    const run = record();
    run.input.draft = "Line 0\n\nLine 1\n" + Array.from({ length: 30 }, (_, i) => `Body ${i}`).join("\n");
    const row = { record: run, original: true, records: [run] };
    const options = { ...previewOptions, preferences: false };
    for (const height of [3, 4, 5]) {
      const pane = content.pane(row, 40, height, options);
      expect(pane.lines).toHaveLength(height);
      expect(pane.lines.map(stripVTControlCharacters).join("\n")).not.toContain("─");
      expect(pane.lines.map(stripVTControlCharacters).join("\n")).toContain("Line 0");
    }
    run.input.projectDiagnostics = { warnings: ["Context warning 中文😀 ".repeat(10)], referencedDirectoryCount: 0 };
    const header = content.paneHeader(row, 40, options);
    let seen = "";
    for (let scroll = 0; scroll < 40; scroll++) {
      const pane = content.pane(row, 40, 5, { ...options, scroll });
      expect(pane.lines.length).toBeLessThanOrEqual(5);
      seen += pane.lines.join("\n");
    }
    expect(seen).toContain(header.at(-1));
    expect(stripVTControlCharacters(seen)).toContain("Body 29");
  });
});

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
