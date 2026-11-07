import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { InlinePreferences } from "../src/inline-preferences.js";
import { TaskPanel, type TaskPanelPosition } from "../src/task-panel.js";
import { selectHistory } from "../src/context.js";
import type { RefineRecord } from "../src/history.js";
import type { RevisionPreference } from "../src/revision-preferences.js";

const plain = (lines: string[]) => lines.map(stripVTControlCharacters);
const checklistRow = (lines: string[]) => plain(lines).findIndex((line) => line.split(" │ ")[1]?.includes("Preferences ·"));

describe("original and checklist geometry", () => {
  it.each(["dark", "light"])("packs short originals without focus-dependent gaps (%s)", async (name) => {
    const theme = getThemeByName(name)!;
    const keys = getKeybindings();
    const size = { rows: 40 };
    const record: RefineRecord = { id: 1, taskId: 1, kind: "refine", status: "unsent", createdAt: 1,
      input: { draft: "Original 中文😀\x1b[2J", model: { provider: "p", id: "m" }, sessionId: "s", branchLeafId: null,
        systemPrompt: "Policy", history: selectHistory([], 0, 0) } };
    const entries: RevisionPreference[] = Array.from({ length: 18 }, (_, i) => ({ id: `p${i}`, scope: "project", version: 1,
      name: `Preference ${i}`, body: "Requirement\n".repeat(40), metadata: { kind: "task", activation: "manual", description: "" } }));
    const picker = new InlinePreferences({ load: async () => ({ entries, errors: {} }), save: vi.fn(), remove: vi.fn() },
      () => ({ selected: [], save: () => undefined }), theme, keys, () => {});
    const position: TaskPanelPosition = { selectedTaskId: 1 };
    const run = vi.fn();
    const panel = new TaskPanel({ records: () => [record], appliedId: () => undefined, activate: () => false,
      run, stop() {}, preferences() {}, inlinePreferences: picker }, theme, () => size.rows, keys, false, position);
    try {
      const beforeMeasurement = structuredClone(position);
      expect(panel.preferredBodyHeight(96)).toBeGreaterThan(3);
      expect(panel.preferredBodyHeight(96)).toBeGreaterThan(3);
      expect(position).toEqual(beforeMeasurement);
      expect(run).not.toHaveBeenCalled();
      panel.render(100); await Promise.resolve();
      for (const width of [100, 80, 100]) {
        const frame = panel.render(width);
        const lines = plain(frame);
        const original = lines.findIndex((line) => line.split(" │ ")[1]?.includes("Original 中文😀"));
        const preferences = checklistRow(frame);
        expect(preferences - original).toBe(2);
        expect(frame.join("\n")).not.toContain("\x1b[2J");
        expect(frame.join("\n")).toContain(theme.fg("text", theme.bold("Preferences")));
        // Ordinary focus changes must neither move the checklist boundary nor resize the frame.
        for (const key of ["\t", "\t", " ", "\t"]) {
          panel.handleInput(key);
          const next = panel.render(width);
          expect(next).toHaveLength(frame.length);
          expect(checklistRow(next)).toBe(preferences);
        }
        expect(frame.every((line) => visibleWidth(line) <= width)).toBe(true);
      }
      record.input.draft = Array.from({ length: 60 }, (_, i) => `Original line ${i} 中文😀`).join("\n");
      const initial = plain(panel.render(100));
      expect(initial.join("\n")).toContain("Preferences ·");
      panel.handleInput("\t"); panel.handleInput("\x1b[6~");
      expect(plain(panel.render(100)).join("\n")).not.toContain("Original line 0 中文😀");
      expect(checklistRow(panel.render(100))).toBe(checklistRow(initial));
      const scroll = position.scroll;
      panel.handleInput("\t"); panel.handleInput("\r");
      expect(plain(panel.render(100)).join("\n")).toContain("Library entry");
      panel.handleInput("\x1b"); panel.render(100);
      expect(position.scroll).toBe(scroll);
      for (const [width, rows] of [[40, 14], [20, 8], [100, 40]]) {
        size.rows = rows!;
        const frame = panel.render(width!);
        expect(frame.length).toBeLessThanOrEqual(rows!);
        expect(frame.every((line) => visibleWidth(line) <= width!)).toBe(true);
      }
      expect(run).not.toHaveBeenCalled();
    } finally { picker.dispose(); }
  });
});
