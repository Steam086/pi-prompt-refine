import { getKeybindings, TuiAltScreen, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { selectHistory } from "../../src/context.js";
import { RefineController } from "../../src/controller.js";
import { InlinePreferences } from "../../src/inline-preferences.js";
import { formatKeyHint } from "../../src/key-hints.js";
import { panelLayout } from "../../src/panel-layout.js";
import { sanitizeTerminalText } from "../../src/presentation.js";
import { selectPreference, type RevisionPreference } from "../../src/revision-preferences.js";
import { TaskPanel } from "../../src/task-panel.js";
import { workspaceLayout } from "../../src/workspace-overlay.js";
import { getThemeByName } from "../support/pi-theme.js";
import { createRecordingTerminal } from "../support/recording-terminal.js";
import { record } from "../support/task-panel.js";

// Actual Pi renderers, not a substitute for human visual/IME verification.
describe.each(["regular", "fullscreen"] as const)("inline preference rendering (%s)", (mode) => {
  it.each(["dark", "light"])("renders spacious current items and returns to compact cells on resize (%s)", async (themeName) => {
    vi.useFakeTimers();
    const { terminal, writes, input } = createRecordingTerminal({ rows: 60, columns: 160 });
    const tui = mode === "regular" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
    const theme = getThemeByName(themeName)!;
    vi.spyOn(theme, "bold").mockImplementation((text) => `\x1b[1m${text}\x1b[22m`);
    const source = record(); source.status = "unsent"; source.candidate = undefined;
    source.input.draft = "Current 中文😀\x1b[2J";
    const entries: RevisionPreference[] = Array.from({ length: 8 }, (_, i) => ({
      id: `choice-${i}`, version: 1, scope: "project", name: `Choice ${i} 中文😀`, body: `Literal requirement ${i}`,
      metadata: { kind: "rewrite", activation: "manual", description: `Summary ${i} 中文😀\x1b[2J` },
    }));
    const load = vi.fn(async () => ({ entries, errors: {} }));
    const save = vi.fn((selected) => { source.input.preferences = selected; return undefined; });
    const picker = new InlinePreferences({ load, save: vi.fn(), remove: vi.fn() },
      () => ({ selected: source.input.preferences ?? [], save }), theme, getKeybindings(), () => tui.requestRender());
    const run = vi.fn();
    const panel = new TaskPanel({ records: () => [source], appliedId: () => undefined, activate: () => false,
      run, stop() {}, preferences() {}, inlinePreferences: picker }, theme, () => terminal.rows, getKeybindings(),
      false, { selectedTaskId: 1 }, (width) => workspaceLayout(width, terminal.rows));
    const view = { render: (width: number) => panel.render(width),
      set focused(value: boolean) { picker.focused = value; },
      handleInput: (data: string) => { panel.handleInput(data); tui.requestRender(); },
      invalidate: () => { panel.invalidate(); picker.invalidate(); } };
    const render = () => {
      tui.renderNow();
      const frame = panel.render(terminal.columns);
      expect(frame).toHaveLength(workspaceLayout(terminal.columns, terminal.rows).height);
      expect(frame.every((line) => visibleWidth(line) <= terminal.columns)).toBe(true);
      expect(frame.join("\n")).not.toContain("\x1b[2J");
      return frame;
    };
    tui.addChild(view); tui.setFocus(view);
    try {
      tui.start(); render(); await Promise.resolve();
      const initial = render();
      const plain = initial.map(stripVTControlCharacters);
      const selectedAt = plain.findIndex((line) => line.includes("› ○ Unsent"));
      expect(plain[selectedAt]).toContain("Original prompt");
      expect(plain[selectedAt + 1]).toContain("Current 中文😀");
      expect(initial.join("\n")).toContain(theme.fg("muted", sanitizeTerminalText(entries[0]!.metadata!.description!)));
      const tabs = initial.find((line) => line.includes(" Preview "))!;
      expect(stripVTControlCharacters(tabs)).not.toMatch(/[←→]/);
      const redraws = tui.fullRedraws;
      writes.length = 0; // Exclude the renderer's initial fullscreen clear.
      input("\t"); input(" ");
      const selecting = render();
      expect(selecting.find((line) => line.includes(" Preview "))).toBe(tabs);
      for (const key of ["\x1b[D", "\x1b[C"]) {
        input(key);
        expect(render().find((line) => line.includes(" Preview "))).toBe(tabs);
      }
      expect(stripVTControlCharacters(selecting.join("\n"))).toContain("› [x] Choice 0");
      expect(stripVTControlCharacters(selecting.join("\n"))).toContain("Literal requirement 0");
      input("\x1b");
      expect(render().find((line) => line.includes(" Preview "))).toBe(tabs);
      expect(tui.fullRedraws).toBe(redraws);
      expect(writes.join("")).not.toContain("\x1b[2J");
      for (const [columns, rows] of [[45, 14], [160, 14], [160, 60]]) {
        Object.assign(terminal, { columns, rows }); view.invalidate(); render();
      }
      expect(stripVTControlCharacters(render().join("\n"))).toContain("Preferences · 1 selected");
      expect(save).toHaveBeenCalledTimes(1);
      expect(load).toHaveBeenCalledTimes(1);
      expect(run).not.toHaveBeenCalled();
    } finally { picker.dispose(); tui.stop(); vi.restoreAllMocks(); vi.useRealTimers(); }
  });
  it.each(["dark", "light"])("keeps selection, scrolling, focus and warning output bounded through resize (%s)", async (themeName) => {
    vi.useFakeTimers();
    const { terminal, writes, input } = createRecordingTerminal({ rows: 40, columns: 100 });
    const tui = mode === "regular" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
    const theme = getThemeByName(themeName)!;
    // Exercise weight boundaries even when Chalk disables bold outside a TTY.
    vi.spyOn(theme, "bold").mockImplementation((value) => `\x1b[1m${value}\x1b[22m`);
    const keys = getKeybindings();
    const entries: RevisionPreference[] = Array.from({ length: 18 }, (_, index) => ({
      id: `item-${index}`, scope: index % 2 ? "global" : "project", version: 1,
      name: `Item ${String(index).padStart(2, "0")} 中文😀 \x1b]52;c;payload\x07`, body: `Requirement ${index} **literal**\n${"Reference 中文😀\x1b[2J\n".repeat(30)}`,
      metadata: { kind: index < 9 ? "rewrite" : "task",
        description: `Description ${index} 中文😀 \x1b[2J: use clear explanations that wrap naturally across the available reading width.\nKeep literal **requirements** readable.\nSummary ending ${index}.`, activation: "manual" },
    }));
    const complete = vi.fn(async () => ({ text: "Result", stopReason: "stop" as const }));
    const controller = new RefineController({ complete, maxDraftChars: 16000, timeoutMs: 1000, onState() {} }, { provider: "p", id: "m" });
    controller.setSession("s");
    controller.createDraft({ draft: "ORIGINAL 中文😀\n".repeat(30), model: { provider: "p", id: "m" }, sessionId: "s", branchLeafId: null,
      systemPrompt: "Policy", history: selectHistory([], 0, 0) });
    const original = controller.getHistory()[0]!;
    // Deliberately load task entries first; the UI must prioritize rewriting.
    const load = vi.fn(async () => ({ entries: [...entries.slice(9), ...entries.slice(0, 9)], errors: {} }));
    const picker = new InlinePreferences({ load, save: vi.fn(), remove: vi.fn() }, (id) => {
      const source = controller.getRecord(id);
      return source ? { selected: source.input.preferences ?? [], save: source.status === "unsent" ? (selected) => controller.updateDraftPreferences(source, selected) : undefined } : undefined;
    }, theme, keys, () => tui.requestRender());
    const run = vi.fn((id: number) => { controller.startRecord(id); });
    let useWorkspaceLayout = false;
    const layout = (width: number) => useWorkspaceLayout ? workspaceLayout(width, terminal.rows) : panelLayout(width, terminal.rows);
    const panel = new TaskPanel({ records: () => controller.getHistory(), appliedId: () => undefined, activate: () => false,
      run, stop() {}, preferences() {}, inlinePreferences: picker }, theme, () => terminal.rows, keys, false, { selectedTaskId: original.taskId }, layout);
    const view = {
      set focused(value: boolean) { picker.focused = value; },
      render: (width: number) => panel.render(width),
      handleInput: (data: string) => { panel.handleInput(data); tui.requestRender(); },
      invalidate: () => { panel.invalidate(); picker.invalidate(); },
    };
    tui.addChild(view); tui.setFocus(view);
    const render = () => {
      tui.renderNow();
      const lines = panel.render(terminal.columns);
      expect(lines).toHaveLength(layout(terminal.columns).height);
      expect(lines.every((line) => visibleWidth(line) <= terminal.columns)).toBe(true);
      expect(lines.join("\n")).not.toContain("\x1b]52;c;payload");
      return stripVTControlCharacters(lines.join("\n"));
    };
    try {
      tui.start(); render(); await Promise.resolve();
      expect(render()).toContain("Preferences · 0 selected");
      input("\t"); input(" ");
      expect(render()).toContain("Focus: Preferences");
      expect(render()).toContain("› [x] Item 00");
      expect(panel.render(100).join("\n")).toContain(formatKeyHint(["Enter", "Optimize"], theme));
      expect(panel.render(100).join("\n")).toContain(formatKeyHint(["o", "Read"], theme));
      expect(panel.render(100).join("\n")).toContain(formatKeyHint(["Esc", "Back to tasks"], theme));
      expect(panel.render(100).join("\n")).toContain(formatKeyHint(["Tab", "Back"], theme));
      const columns = () => panel.render(100).map(stripVTControlCharacters).filter((line) => line.includes(" │ "));
      expect(columns().filter((line) => /Item \d+/.test(line.split(" │ ")[0]!)).length).toBeGreaterThanOrEqual(8);
      expect(columns().map((line) => line.split(" │ ")[0]).join("\n")).not.toContain("Unsent");
      expect(columns().map((line) => line.split(" │ ")[0]).join("\n")).toContain("Prompt rewriting");
      const reference = () => columns().map((line) => line.split(" │ ")[1]).join("\n");
      expect(reference()).toContain("ORIGINAL 中文😀");
      expect(reference()).toContain("Selected · 1");
      expect(reference()).toContain("Item 00");
      const styledReference = panel.render(100).map((line) => line.split(theme.fg("muted", " │ "))[1] ?? "").join("\n");
      expect(styledReference).toContain(theme.fg("text", theme.bold("Original prompt")));
      expect(styledReference).toContain(theme.fg("muted", "Selected · 1"));
      expect(styledReference).not.toContain(theme.bold("Selected"));
      const selectedLine = styledReference.split("\n").find((line) => stripVTControlCharacters(line).startsWith("· Item 00"));
      expect(selectedLine).toContain(theme.fg("muted", "· ") + theme.fg("text", sanitizeTerminalText(entries[0]!.name).replace(/\s+/gu, " ")));
      expect(selectedLine).not.toContain("\x1b[1m");
      expect(reference()).toContain("Description 0 中文😀");
      expect(reference()).toContain("Requirement 0 **literal**");
      expect(reference()).toContain("o Read full");
      const descriptionLine = styledReference.split("\n").find((line) => stripVTControlCharacters(line).startsWith("Description 0"))!;
      expect(descriptionLine).toBe(theme.fg("muted", stripVTControlCharacters(descriptionLine)));
      const instructionLine = styledReference.split("\n").find((line) => stripVTControlCharacters(line).startsWith("Requirement 0"))!;
      expect(instructionLine).toBe(theme.fg("text", "Requirement 0 **literal**"));
      expect(instructionLine).not.toContain("\x1b[1m");
      const originalLine = styledReference.split("\n").find((line) => stripVTControlCharacters(line).startsWith("ORIGINAL"))!;
      expect(originalLine).toContain(theme.fg("text", "ORIGINAL 中文😀").split("\x1b[39m")[0]);
      expect(originalLine).not.toContain("\x1b[1m");
      expect(columns().map((line) => line.split(" │ ")[0]).join("\n")).not.toContain("Description");
      expect(panel.render(100).join("\n")).not.toContain("\x1b[2J");
      const beforeBrowsing = reference();
      const checkedBeforeBrowsing = controller.getRecord(original.id)!.input.preferences;
      const initialRedraws = tui.fullRedraws;
      input("\x1b[B"); render();
      expect(reference()).not.toBe(beforeBrowsing);
      expect(reference()).toContain("Description 1 中文😀");
      expect(reference()).toContain("Requirement 1 **literal**");
      expect(reference()).not.toContain("Requirement 0 **literal**");
      expect(reference()).not.toContain("Description 0 中文😀");
      expect(reference().slice(reference().indexOf("Selected ·"))).toBe(beforeBrowsing.slice(beforeBrowsing.indexOf("Selected ·")));
      expect(controller.getRecord(original.id)!.input.preferences).toEqual(checkedBeforeBrowsing);
      input(" "); render();
      expect(reference()).toContain("Selected · 2");
      expect(reference()).toContain("Item 01");
      input("o"); render();
      expect(panel.render(100).join("\n")).not.toContain(formatKeyHint(["Enter", "Optimize"], theme));
      expect(panel.render(100).map(stripVTControlCharacters).join("\n")).not.toContain(" │ ");
      for (const key of ["\r", "\t", "\x1b[Z", "\x1b[6~", "\x1b[5~", "\x1b", "\t", "\x1b[Z"]) { input(key); render(); }
      expect(tui.fullRedraws).toBe(initialRedraws);
      expect(complete).not.toHaveBeenCalled();
      for (const [columns, rows] of [[100, 40], [45, 30], [45, 14], [20, 10], [12, 8], [100, 40]]) {
        Object.assign(terminal, { columns, rows }); view.invalidate();
        render(); input("\x1b[F"); render();
        const frame = panel.render(columns!);
        if (rows! >= 10 && columns! >= 20) {
          const active = frame.find((line) => stripVTControlCharacters(line).includes("› [ ]"));
          expect(active).toBeDefined();
          expect(active).toContain(theme.bg("selectedBg", "").split("\x1b[49m")[0]);
        }
        input("\x1b[H"); render();
        if (rows! >= 14 && columns! >= 45) {
          if (columns === 45 && rows! >= 24) {
            expect(render()).toContain("Description 0 中文😀");
            expect(panel.render(columns!).map(stripVTControlCharacters).join("\n")).not.toContain(" │ ");
          }
          for (let i = 0; i < entries.length; i++) {
            const frame = render();
            expect(frame).toContain(`› [${i < 2 ? "x" : " "}] Item ${String(i).padStart(2, "0")}`);
            if (i + 1 < entries.length) expect(frame).toContain(`Item ${String(i + 1).padStart(2, "0")}`);
            input("\x1b[B");
          }
          input("\x1b[H"); render();
        }
      }
      expect(panel.render(100).join("\n")).toContain(theme.fg("text", theme.bold(sanitizeTerminalText(entries[0]!.name))));
      // Search owns ordinary action keys, including p, and arrows never escape into page navigation.
      input("/"); input("Item 17"); render(); input("\r"); input(" ");
      expect(render()).toContain("› [x] Item 17");
      expect(load).toHaveBeenCalledTimes(1);
      const chosen = controller.getRecord(original.id)!.input.preferences!;
      // Selected feedback follows selection order, not the library's purpose order.
      const taskFirst = [...entries.slice(9), ...entries.slice(0, 9)];
      expect(controller.updateDraftPreferences(controller.getRecord(original.id)!, taskFirst.map(selectPreference))).toBeUndefined();
      render();
      expect(reference()).toContain("Selected · 18");
      expect(reference()).toMatch(/… \d+ more/);
      const selectedFeedback = reference().slice(reference().indexOf("Selected ·"));
      expect(selectedFeedback).toContain("Item 08");
      expect(selectedFeedback).not.toContain("Item 17");
      expect(controller.getRecord(original.id)!.input.preferences!.map((entry) => entry.id)).toEqual(taskFirst.map((entry) => entry.id));
      expect(controller.updateDraftPreferences(controller.getRecord(original.id)!, chosen)).toBeUndefined();
      render();
      // Use the expanded workspace canvas, including wide/short and narrow layouts.
      useWorkspaceLayout = true;
      input("/"); input("\x15"); input("\r"); input("\x1b[H");
      for (const [columns, rows] of [[160, 60], [130, 40], [160, 14], [45, 24], [160, 60]]) {
        Object.assign(terminal, { columns, rows }); view.invalidate(); render();
        const frame = panel.render(columns!);
        const divided = frame.filter((line) => stripVTControlCharacters(line).includes(" │ "));
        if (rows! >= 40) {
          const left = divided.map((line) => line.split(theme.fg("muted", " │ "))[0]!);
          const leftWidth = visibleWidth(left[0]!) - layout(columns!).inset;
          expect(leftWidth).toBeGreaterThan(36);
          expect(leftWidth).toBeLessThanOrEqual(48);
          const right = divided.map((line) => line.split(theme.fg("muted", " │ "))[1] ?? "");
          const content = stripVTControlCharacters(right.join("\n"));
          expect(content.match(/ORIGINAL 中文😀/g)?.length).toBeLessThanOrEqual(4);
          expect(content.match(/Reference 中文😀/g)!.length).toBeGreaterThan(2);
          expect(content).toContain("Selected · 3");
          expect(content.indexOf("ORIGINAL")).toBeLessThan(content.indexOf("Requirement 0"));
          expect(content.indexOf("Requirement 0")).toBeLessThan(content.indexOf("Selected ·"));
          const description = right.find((line) => stripVTControlCharacters(line).startsWith("Keep literal **requirements** readable."))!;
          expect(description).toBeDefined();
          expect(description).toBe(theme.fg("muted", stripVTControlCharacters(description)));
        } else if (columns === 45) expect(divided).toHaveLength(0);
      }
      expect(load).toHaveBeenCalledTimes(1);
      expect(complete).not.toHaveBeenCalled();
      useWorkspaceLayout = false;
      Object.assign(terminal, { columns: 100, rows: 40 }); view.invalidate(); render();
      // Refresh failure leaves selected snapshots, a semantic warning and a usable cancel path.
      load.mockRejectedValueOnce(new Error("Permission denied"));
      await picker.refresh();
      for (const [columns, rows] of [[100, 40], [20, 8], [12, 6]]) {
        Object.assign(terminal, { columns, rows }); view.invalidate(); render();
        expect(panel.render(columns!).join("\n")).toContain(theme.fg("warning", "⚠").split("⚠")[0] + "⚠");
      }
      Object.assign(terminal, { columns: 100, rows: 40 }); render();
      input("\r");
      expect(run).toHaveBeenCalledExactlyOnceWith(original.id);
      expect(controller.getRecord(original.id)!.input.preferences?.map((entry) => entry.id)).toEqual(["item-0", "item-1", "item-17"]);
      expect(writes.join("")).not.toContain("\x1b]52;c;payload");
    } finally {
      picker.dispose(); controller.setSession("other"); tui.stop(); vi.restoreAllMocks(); vi.useRealTimers();
    }
  });
});
