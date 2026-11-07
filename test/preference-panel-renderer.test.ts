import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { getKeybindings, TuiAltScreen, TuiMainScreen, visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { PreferencePanel } from "../src/preference-panel.js";
import { panelLayout } from "../src/panel-layout.js";
import { selectPreference, type RevisionPreference } from "../src/revision-preferences.js";

// Captured renderer I/O is not human visual or IME validation.
describe.each(["regular", "fullscreen"] as const)("preference selection terminal rendering (%s)", (mode) => {
  it.each(["dark", "light"])("audits selections and reveals a new save through narrow/short resize (%s)", async (themeName) => {
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
    const first: RevisionPreference = { id: "first", version: 1, scope: "project", name: "Keep 中文😀 \x1b]52;c;payload\x07", body: "Original snapshot" };
    const second: RevisionPreference = { id: "second", version: 1, scope: "global", name: "Second", body: "Another snapshot" };
    const entries = [first, second, { ...first, id: "duplicate", scope: "global" as const, name: "Copy 中文😀" }];
    const close = vi.fn();
    let panel = new PreferencePanel(tui, theme, getKeybindings(), {
      load: async () => ({ errors: {}, entries: structuredClone(entries) }),
      save: async (scope, value) => {
        const saved = { ...value, scope, id: "returned-identity", version: 1 };
        entries.unshift(saved); // Reveal must use identity, not an assumed append position.
        return saved;
      }, remove: async () => {},
    }, [selectPreference(second), selectPreference(first)], "Reusable 中文 body", 16000, close);
    tui.addChild(panel); tui.setFocus(panel);
    const render = () => {
      tui.renderNow();
      const lines = panel.render(terminal.columns);
      expect(lines).toHaveLength(panelLayout(terminal.columns, terminal.rows).height);
      expect(lines.every((line) => visibleWidth(line) <= terminal.columns)).toBe(true);
      expect(lines.join("\n")).not.toContain("\x1b]52;c;payload");
      return stripVTControlCharacters(lines.join("\n"));
    };
    try {
      tui.start(); await Promise.resolve(); render();
      input("/"); input("Copy"); input("\r"); input(" ");
      expect(render()).toContain("Same requirements already selected");
      expect(render()).toContain("2 selected");
      for (const [columns, rows] of [[40, 16], [20, 8], [100, 40]]) {
        Object.assign(terminal, { columns, rows }); panel.invalidate();
        expect(render()).toContain("Same requirem");
        expect(panel.render(columns!).join("\n")).toContain(theme.fg("warning", "⚠").split("⚠")[0] + "⚠");
      }
      input("/"); input("\x15"); input("Second"); input("\r"); input("s");
      expect(render()).toContain("Preferences · Selected only");
      const full = render();
      expect(full.indexOf("[x] Second")).toBeLessThan(full.indexOf("[x] Keep"));
      const initialRedraws = tui.fullRedraws;
      for (const key of ["\r", "\x1b[6~", "\x1b[5~", "\x1b", "s", "s"]) { input(key); render(); }
      expect(tui.fullRedraws).toBe(initialRedraws);
      for (const [columns, rows] of [[100, 40], [31, 16], [32, 16], [20, 10], [100, 40]]) {
        Object.assign(terminal, { columns, rows });
        panel.invalidate(); tui.requestRender(); render();
        const layout = panelLayout(columns!, rows!);
        const listWidth = columns === 100 ? 41 : layout.innerWidth;
        const labels = listWidth >= 28 ? [" Global", "Project"] : ["G", "P"];
        const lines = panel.render(columns!);
        for (const label of labels) {
          const source = theme.fg("muted", label);
          const row = lines.find((line) => line.includes(source))!;
          expect(row).toBeDefined();
          expect(visibleWidth(row.slice(0, row.indexOf(source))) + visibleWidth(label)).toBe(layout.inset + listWidth);
        }
        const focused = lines.find((line) => stripVTControlCharacters(line).includes("› [x]"))!;
        expect(focused).toContain(theme.bg("selectedBg", "").split("\x1b[49m")[0]);
      }
      input("n"); input("Saved 中文😀");
      for (const field of ["Name", "Instruction", "Scope", "Type", "Description", "Save"]) {
        Object.assign(terminal, { columns: 100, rows: 40 }); panel.invalidate();
        expect(render()).toContain(`Focus: ${field}`);
        expect(render()).not.toContain("Adoption:");
        if (field === "Save") expect(panel.render(100).join("\n")).toContain(theme.fg("muted", "Save to library"));
        for (const [columns, rows] of [[40, 16], [20, 8], [100, 40]]) {
          Object.assign(terminal, { columns, rows }); panel.invalidate(); render();
        }
        if (field !== "Save") input("\t");
      }
      expect(close).not.toHaveBeenCalled();
      input("\r");
      for (let i = 0; i < 4; i++) await Promise.resolve();
      expect(render()).toContain("Filters reset to All.");
      expect(render()).toContain("Focus: Library");
      expect(render()).toContain("› [ ] Saved 中文😀");
      expect(entries.find((entry) => entry.id === "returned-identity")?.metadata).toEqual({
        kind: "task", description: "Saved 中文😀", activation: "manual",
      });
      input("\r"); expect(render()).toContain("project · returned-identity");
      input("\x1b"); input("\x1b[13;3u");
      expect(close).toHaveBeenCalledWith([selectPreference(second), selectPreference(first)]);
      // The same real renderer hosts management-only access with frozen snapshots.
      panel.dispose(); tui.removeChild(panel);
      const manageClose = vi.fn();
      let current = [{ ...first, version: 2, body: "Current library 中文😀" }];
      panel = new PreferencePanel(tui, theme, getKeybindings(), {
        load: async () => ({ errors: {}, entries: structuredClone(current) }),
        save: async (scope, value, expected) => {
          const saved = { ...value, scope, id: expected!.id, version: expected!.version + 1 };
          current = [saved]; return saved;
        },
        remove: async () => { current = []; },
      }, [selectPreference(first)], "", 16000, manageClose, "manage");
      tui.addChild(panel); tui.setFocus(panel); await Promise.resolve();
      expect(render()).toContain("1 frozen snapshots");
      expect(render()).not.toContain("Bring back"); expect(render()).not.toContain("Space Select");
      input(" "); input("\x1b[13;3u"); expect(manageClose).not.toHaveBeenCalled();
      input("s"); input("\r");
      expect(render()).toContain("Selected snapshot"); expect(render()).toContain("Current library entry");
      expect(panel.render(100).join("\n")).toContain(theme.fg("text", first.body));
      for (const [columns, rows] of [[40, 16], [20, 8], [100, 40]]) {
        Object.assign(terminal, { columns, rows }); panel.invalidate();
        input("\x1b[6~"); render(); input("\x1b[5~"); render();
      }
      input("\x1b"); input("e"); input("Edited "); input("\x1b[Z"); input("\r");
      for (let i = 0; i < 4; i++) await Promise.resolve();
      expect(render()).toContain("Saved to library");
      input("d"); expect(render()).toContain("Delete library entry?");
      input("n"); expect(current).toHaveLength(1);
      input("d"); input("y"); for (let i = 0; i < 4; i++) await Promise.resolve();
      input("\r"); expect(render()).toContain("Source deleted"); expect(render()).toContain(first.body);
      input("\x1b"); input("\x1b"); expect(manageClose.mock.calls).toEqual([[]]);
      expect(writes.length).toBeGreaterThan(0);
      expect(writes.join("")).not.toContain("\x1b]52;c;payload");
    } finally {
      panel.dispose(); tui.stop(); vi.useRealTimers();
    }
  });
});
