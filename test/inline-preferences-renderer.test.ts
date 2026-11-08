import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { getKeybindings, TuiAltScreen, TuiMainScreen, visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { InlinePreferences } from "../src/inline-preferences.js";
import { RefineController } from "../src/controller.js";
import { TaskPanel } from "../src/task-panel.js";
import { selectHistory } from "../src/context.js";
import { panelLayout } from "../src/panel-layout.js";
import { sanitizeTerminalText } from "../src/presentation.js";
import { formatKeyHint } from "../src/key-hints.js";
import { selectPreference, type RevisionPreference } from "../src/revision-preferences.js";

// Actual Pi renderers, not a substitute for human visual/IME verification.
describe.each(["regular", "fullscreen"] as const)("inline preference rendering (%s)", (mode) => {
  it.each(["dark", "light"])("keeps selection, scrolling, focus and warning output bounded through resize (%s)", async (themeName) => {
    vi.useFakeTimers();
    let input = (_data: string) => {};
    const writes: string[] = [];
    const terminal: Terminal = {
      rows: 40, columns: 100, kittyProtocolActive: true,
      start: (onInput) => { input = onInput; }, stop() {}, write: (data) => { writes.push(data); },
      async drainInput() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {},
      clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
    };
    const tui = mode === "regular" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
    const theme = getThemeByName(themeName)!;
    const keys = getKeybindings();
    const entries: RevisionPreference[] = Array.from({ length: 18 }, (_, index) => ({
      id: `item-${index}`, scope: index % 2 ? "global" : "project", version: 1,
      name: `Item ${String(index).padStart(2, "0")} 中文😀 \x1b]52;c;payload\x07`, body: `Requirement ${index}\n${"Reference 中文😀\n".repeat(30)}`,
      metadata: { kind: index < 9 ? "task" : "rewrite",
        description: `Description ${index} 中文😀 \x1b[2J: use clear explanations that wrap naturally across the available reading width.\nKeep literal **requirements** readable.\nSummary ending ${index}.`, activation: "manual" },
    }));
    const complete = vi.fn(async () => ({ text: "Result", stopReason: "stop" as const }));
    const controller = new RefineController({ complete, maxDraftChars: 16000, timeoutMs: 1000, onState() {} }, { provider: "p", id: "m" });
    controller.setSession("s");
    controller.createDraft({ draft: "ORIGINAL 中文😀\n".repeat(30), model: { provider: "p", id: "m" }, sessionId: "s", branchLeafId: null,
      systemPrompt: "Policy", history: selectHistory([], 0, 0) });
    const original = controller.getHistory()[0]!;
    const load = vi.fn(async () => ({ entries, errors: {} }));
    const picker = new InlinePreferences({ load, save: vi.fn(), remove: vi.fn() }, (id) => {
      const source = controller.getRecord(id);
      return source ? { selected: source.input.preferences ?? [], save: source.status === "unsent" ? (selected) => controller.updateDraftPreferences(source, selected) : undefined } : undefined;
    }, theme, keys, () => tui.requestRender());
    const run = vi.fn((id: number) => { controller.startRecord(id); });
    const panel = new TaskPanel({ records: () => controller.getHistory(), appliedId: () => undefined, activate: () => false,
      run, stop() {}, preferences() {}, inlinePreferences: picker }, theme, () => terminal.rows, keys, false, { selectedTaskId: original.taskId });
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
      expect(lines).toHaveLength(panelLayout(terminal.columns, terminal.rows).height);
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
      const reference = () => columns().map((line) => line.split(" │ ")[1]).join("\n");
      expect(reference()).toContain("ORIGINAL 中文😀");
      expect(reference()).toContain("Selected · 1");
      expect(reference()).toContain("Item 00");
      expect(reference()).toContain("Description 0 中文😀");
      expect(reference()).toContain("Summary ending 0.");
      expect(columns().map((line) => line.split(" │ ")[0]).join("\n")).not.toContain("Description");
      expect(panel.render(100).join("\n")).not.toContain("\x1b[2J");
      expect(panel.render(100).join("\n")).toContain(theme.fg("muted", "Keep literal **requirements** readable."));
      const beforeBrowsing = reference();
      const checkedBeforeBrowsing = controller.getRecord(original.id)!.input.preferences;
      const initialRedraws = tui.fullRedraws;
      input("\x1b[B"); render();
      expect(reference()).not.toBe(beforeBrowsing);
      expect(reference()).toContain("Description 1 中文😀");
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
      expect(controller.updateDraftPreferences(controller.getRecord(original.id)!, entries.map(selectPreference))).toBeUndefined();
      render();
      expect(reference()).toContain("Selected · 18");
      expect(reference()).toMatch(/… \d+ more/);
      expect(reference()).toContain("Item 17");
      expect(controller.getRecord(original.id)!.input.preferences!.map((entry) => entry.id)).toEqual(entries.map((entry) => entry.id));
      expect(controller.updateDraftPreferences(controller.getRecord(original.id)!, chosen)).toBeUndefined();
      render();
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
      picker.dispose(); controller.setSession("other"); tui.stop(); vi.useRealTimers();
    }
  });
});
