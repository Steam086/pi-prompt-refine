import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters as strip } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { InlinePreferences } from "../../src/inline-preferences.js";
import { formatKeyHint, wrappedKeyHints, type KeyHint } from "../../src/key-hints.js";
import { workspaceTabs } from "../../src/panel-layout.js";
import { TaskPanel } from "../../src/task-panel.js";
import { workspaceLayout } from "../../src/workspace-overlay.js";
import { create, record } from "../support/task-panel.js";

describe("Tasks shortcut hierarchy", () => {
  it.each(["dark", "light"])("keeps all Unsent hints muted and compact across widths (%s)", (name) => {
    const source = { ...record(), status: "unsent" as const, candidate: undefined };
    source.input.draft = "Original 中文😀\x1b[2J\n".repeat(60);
    const f = create(name, false, [source]);
    f.actions.launchModel = () => "provider/模型😀\x1b[2J";
    const bold = vi.spyOn(f.theme, "bold").mockImplementation((text) => `\x1b[1m${text}\x1b[22m`);
    const keys = getKeybindings();
    const picker = new InlinePreferences({ load: async () => ({ entries: [], errors: {} }), save: vi.fn(), remove: vi.fn() },
      () => ({ selected: [], save: () => undefined }), f.theme, keys, () => {});
    const panel = new TaskPanel({ ...f.actions, inlinePreferences: picker, deleteRecords: () => true }, f.theme,
      () => f.size.rows, keys, false, f.position, (width) => workspaceLayout(width, f.size.rows));
    const expected = [["Enter", "Optimize"], ["Tab", "Preferences"], ["o", "Read original"], ["Esc", "Back"], ["?", "All shortcuts"]] as const;
    try {
      for (const [width, rows, hintRows] of [[160, 40, 1], [120, 40, 1], [100, 40, 1], [80, 40, 2], [40, 24, 2], [160, 40, 1]] as const) {
        f.size.rows = rows;
        const layout = workspaceLayout(width, rows);
        const frame = panel.render(width);
        const lines = frame.map(strip);
        const start = lines.findIndex((line) => /Enter: Optimize|↵ Optimize/.test(line));
        const end = lines.findIndex((line, index) => index > start && line.trim().startsWith("─"));
        const hints = frame.slice(start, end).join("\n");
        expect(end - start).toBe(hintRows);
        expect(strip(hints)).not.toMatch(/(?:p|i|n|m|d):/);
        expect(hints).not.toContain("\x1b[1m");
        if (width === 40) {
          for (const hint of [["Esc", "Back"], ["↵", "Optimize"], ["?", "Help"], ["Tab", "Preferences"]] as const) {
            expect(hints).toContain(formatKeyHint(hint, f.theme, 1, "secondary-compact"));
          }
        } else {
          for (const hint of expected) expect(hints).toContain(formatKeyHint(hint, f.theme, 1, "secondary"));
        }
        const tabs = lines.findIndex((line) => line.includes(" Preview "));
        expect(start).toBe(tabs + 1); // No trailing blank tab row.
        const oldBodyStart = layout.headerHeight + workspaceTabs(layout, "Preview", f.theme).length + layout.footerHeight + layout.separatorHeight;
        if (width >= 80) expect(end + 1).toBeLessThan(oldBodyStart);
        expect(frame).toHaveLength(layout.height);
        expect(frame.every((line) => visibleWidth(line) <= width)).toBe(true);
        expect(frame.join("\n")).toContain(f.theme.fg("text", f.theme.bold("Prompt refine · Tasks")));
        expect(frame.join("\n")).toContain(workspaceTabs(layout, "Preview", f.theme).find((line) => strip(line).includes("Preview"))!);
        expect(frame.join("\n")).toContain(f.theme.fg("muted", "Refine model: ") + f.theme.fg("text", "provider/模型😀�[2J"));
        expect(frame.join("\n")).not.toContain("\x1b[2J");
        expect(f.position.selectedTaskId).toBe(1);
      }
      panel.handleInput("?");
      const help = strip(panel.render(100).join("\n"));
      for (const action of ["p Manage / more", "i Edit original", "n New", "m Run model", "d Delete"]) expect(help).toContain(action);
      panel.handleInput("\x1b");
      panel.handleInput("o"); panel.render(100); panel.handleInput("\x1b[6~"); panel.render(100);
      expect(f.position.scroll).toBeGreaterThan(0);
      panel.handleInput("i"); expect(f.actions.editOriginal).toHaveBeenCalledExactlyOnceWith(1);
      expect(f.actions.run).not.toHaveBeenCalled();
      panel.handleInput("\r"); expect(f.actions.run).toHaveBeenCalledExactlyOnceWith(1);
    } finally { picker.dispose(); bold.mockRestore(); }
  });

  it.each(["dark", "light"])("keeps Usage browsing hints passive and adjacent to its tabs through resize and focus (%s)", (name) => {
    const f = create(name, true);
    f.records[0]!.archivedAt = 1;
    f.records[0]!.candidate!.text = "Literal 中文😀 **body**\x1b[2J\n".repeat(80);
    const storage = { state: "saved" as const, savedIds: [1], memoryOnlyIds: [], omittedIds: [] };
    const remove = vi.fn(() => true);
    const actions = { ...f.actions, historyStorage: () => storage, deleteRecords: remove };
    const bold = vi.spyOn(f.theme, "bold").mockImplementation((text) => `\x1b[1m${text}\x1b[22m`);
    const panel = new TaskPanel(actions, f.theme, () => f.size.rows, getKeybindings(), true, f.position,
      (width) => workspaceLayout(width, f.size.rows));
    try {
      for (const [width, rows] of [[160, 40], [100, 40], [80, 24], [40, 24], [160, 40]]) {
        f.size.rows = rows;
        for (const reading of [false, true]) {
          const frame = panel.render(width);
          const plain = frame.map(strip);
          const tab = plain.findIndex((line) => line.includes(" Preview "));
          const end = plain.findIndex((line, index) => index > tab && line.trim().startsWith("─"));
          const hints = frame.slice(tab + 1, end);
          const expected: KeyHint[] = [["Enter", "Inspect"], ["Tab", reading ? "Select" : "Read  "],
            ["Esc", "Back"], ["?", width === 40 ? "Help" : "All shortcuts"]];
          expect(hints).toEqual(wrappedKeyHints(expected, workspaceLayout(width, rows).innerWidth, f.theme)
            .map((line) => " ".repeat(workspaceLayout(width, rows).inset) + line));
          expect(hints).toHaveLength(width === 40 ? 2 : 1);
          expect(hints.join("\n")).not.toContain("\x1b[1m");
          expect(plain[tab - 1]!.trim()).toBe(""); // Retain the gap above, never below, the tabs.
          expect(plain[end + 1]!.trim()).not.toBe("");
          expect(frame).toHaveLength(workspaceLayout(width, rows).height);
          expect(frame.every((line) => visibleWidth(line) <= width)).toBe(true);
          expect(frame.join("\n")).not.toContain("\x1b[2J");
          expect(f.position.selectedId).toBe(1);
          panel.handleInput("\t");
        }
      }
      panel.handleInput("\t"); panel.render(100); panel.handleInput("\x1b[B"); panel.render(100);
      expect(f.position.scroll).toBeGreaterThan(0);
      expect(f.position.selectedId).toBe(1);
      panel.handleInput("?");
      const help = strip(panel.render(100).join("\n"));
      for (const action of ["a Accept", "d Delete", "f Revise", "b History storage status and file location", "← / → Switch Preview, Usage and Settings"]) expect(help).toContain(action);
      panel.handleInput("\x1b");
      panel.handleInput("b");
      expect(strip(panel.render(100).join("\n"))).toContain("Confirmed saved runs");
      panel.handleInput("\x1b");
      panel.handleInput("d"); panel.handleInput("n");
      expect(remove).not.toHaveBeenCalled();
      expect(f.actions.run).not.toHaveBeenCalled();
      expect(f.actions.accept).not.toHaveBeenCalled();
      expect(f.actions.activate).not.toHaveBeenCalled();
    } finally { bold.mockRestore(); }
  });

  it.each(["dark", "light"])("retains a passive Back hint in tiny Tasks and Usage canvases (%s)", (name) => {
    for (const usage of [false, true]) {
      const f = create(name, usage);
      const bold = vi.spyOn(f.theme, "bold").mockImplementation((text) => `\x1b[1m${text}\x1b[22m`);
      const panel = new TaskPanel(f.actions, f.theme, () => f.size.rows, getKeybindings(), usage, f.position,
        (width) => workspaceLayout(width, f.size.rows));
      try {
        for (const [width, rows] of [[10, 8], [12, 8], [20, 8], [40, 8], [40, 12], [10, 8]]) {
          f.size.rows = rows;
          const frame = panel.render(width);
          const back = frame.find((line) => /Esc:? Back/.test(strip(line)))!;
          expect(back).toBeDefined();
          expect(back).not.toContain("\x1b[1m");
          expect(frame).toHaveLength(workspaceLayout(width, rows).height);
          expect(frame.every((line) => visibleWidth(line) <= width)).toBe(true);
          expect(f.position.selectedId).toBe(1);
        }
        expect(f.actions.run).not.toHaveBeenCalled();
        expect(f.actions.accept).not.toHaveBeenCalled();
      } finally { bold.mockRestore(); }
    }
  });

  it.each(["dark", "light"])("keeps Stop available for pending runs in Preview and Usage (%s)", (name) => {
    for (const usage of [false, true]) for (const status of ["queued", "generating"] as const) {
      const f = create(name, usage, [{ ...record(), status, candidate: undefined }]);
      expect(f.panel.render(100).join("\n")).toContain(formatKeyHint(["x", "Stop"], f.theme, 1, "secondary"));
      expect(f.text()).not.toContain("a: Accept");
      expect(f.text()).not.toContain("Refine model:");
      f.size.rows = 8;
      const short = f.text(32);
      for (const hint of ["Esc Back", "x Stop", "? Help"]) expect(short).toContain(hint);
      f.panel.handleInput("x");
      expect(f.actions.stop).toHaveBeenCalledExactlyOnceWith(1);
    }
  });

  it.each(["dark", "light"])("keeps details and confirmation hints in their existing style (%s)", (name) => {
    for (const usage of [false, true]) {
      const f = create(name, usage);
      const bold = vi.spyOn(f.theme, "bold").mockImplementation((text) => `\x1b[1m${text}\x1b[22m`);
      try {
        f.panel.handleInput("\r");
        expect(f.panel.render(100).join("\n")).toContain(formatKeyHint(["Esc", "Back"], f.theme));
        Object.assign(f.actions, { deleteRecords: () => true });
        f.panel.handleInput("d");
        const confirmation = f.panel.render(100).join("\n");
        expect(confirmation).toContain(formatKeyHint(["Esc / n", "Cancel"], f.theme));
        f.panel.handleInput("\x1b");
        expect(f.actions.run).not.toHaveBeenCalled();
      } finally { bold.mockRestore(); }
    }
  });
});
