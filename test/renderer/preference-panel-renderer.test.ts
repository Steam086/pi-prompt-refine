import { getKeybindings, TuiAltScreen, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { panelLayout } from "../../src/panel-layout.js";
import { PreferencePanel } from "../../src/preference-panel.js";
import { selectPreference, type PreferenceRepository, type RevisionPreference } from "../../src/revision-preferences.js";
import { getThemeByName } from "../support/pi-theme.js";
import { createRecordingTerminal } from "../support/recording-terminal.js";

// Captured renderer I/O is not human visual or IME validation.
describe.each(["regular", "fullscreen"] as const)("preference selection terminal rendering (%s)", (mode) => {
  it.each(["dark", "light"])("keeps project toggles separate from request selection through resize and focus (%s)", async (themeName) => {
    vi.useFakeTimers();
    const { terminal, writes, input } = createRecordingTerminal({ rows: 40, columns: 100 });
    const tui = mode === "regular" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
    const theme = getThemeByName(themeName)!;
    const entry: RevisionPreference = { id: "default", scope: "global", version: 1,
      name: "Default 中文😀\x1b]52;c;unsafe\x07", body: "Keep literal task requirements.\n".repeat(40) };
    let enabled = false;
    const library = () => ({ entries: [entry], errors: {}, projectDefaults: enabled ? ["global:default"] : [] });
    const setProjectDefault = vi.fn(async (_entry, value) => { enabled = value; return library(); });
    const close = vi.fn();
    const panel = new PreferencePanel(tui, theme, getKeybindings(), {
      load: async () => library(), setProjectDefault, save: vi.fn(), remove: vi.fn(),
    }, [selectPreference(entry)], "", 16000, close);
    const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
    const render = () => {
      tui.renderNow();
      const lines = panel.render(terminal.columns);
      expect(lines).toHaveLength(panelLayout(terminal.columns, terminal.rows).height);
      expect(lines.every((line) => visibleWidth(line) <= terminal.columns)).toBe(true);
      expect(lines.join("\n")).not.toContain("\x1b]52;c;unsafe");
      return stripVTControlCharacters(lines.join("\n"));
    };
    try {
      tui.addChild(panel); tui.setFocus(panel); tui.start(); await settle(); render();
      input("g"); await settle(); expect(render()).toContain("Project default enabled");
      expect(panel.render(100).join("\n")).toContain(theme.fg("muted", "* "));
      input(" "); expect(render()).toContain("[ ] * Default");
      input("\r"); input("\x1b[6~"); render(); input("\x1b[5~"); input("\x1b");
      for (const [columns, rows] of [[100, 40], [40, 16], [20, 8], [12, 6], [100, 40]]) {
        Object.assign(terminal, { columns, rows }); panel.invalidate(); render();
        input("\t"); render(); input("\x1b[Z"); render();
      }
      input(" "); input("c"); input("\x1b[13;3u");
      expect(close).toHaveBeenCalledWith([]); expect(enabled).toBe(true);
      expect(setProjectDefault).toHaveBeenCalledTimes(1);
      expect(writes.join("")).not.toContain("\x1b]52;c;unsafe");
    } finally { panel.dispose(); tui.stop(); vi.useRealTimers(); }
  });

  it.each(["dark", "light"])("keeps external Edit names inert through failed saves, focus, resize and confirmation (%s)", async (themeName) => {
    vi.useFakeTimers();
    const { terminal, writes, input } = createRecordingTerminal({ rows: 40, columns: 100 });
    const tui = mode === "regular" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
    const theme = getThemeByName(themeName)!;
    const original: RevisionPreference = { id: "unsafe-name", version: 1, scope: "global",
      name: "中文😀\t\x1b[999C\x1b]52;c;edit-name\x07\n\u009dC1\u009c", body: "Keep literal commands." };
    let current = structuredClone(original);
    const save = vi.fn<PreferenceRepository["save"]>(async (scope, value, expected) => {
      current = { ...value, scope, id: expected!.id, version: expected!.version + 1 };
      return current;
    }).mockRejectedValueOnce(new Error("Write conflict 中文😀"));
    const close = vi.fn();
    const panel = new PreferencePanel(tui, theme, getKeybindings(), {
      load: async () => ({ errors: {}, entries: [structuredClone(current)] }), save, remove: async () => {},
    }, [], "", 16000, close);
    tui.addChild(panel); tui.setFocus(panel);
    const render = () => {
      tui.renderNow();
      const lines = panel.render(terminal.columns);
      expect(lines).toHaveLength(panelLayout(terminal.columns, terminal.rows).height);
      expect(lines.every((line) => visibleWidth(line) <= terminal.columns)).toBe(true);
      for (const output of [lines.join("\n"), writes.join("")]) {
        for (const unsafe of ["\x1b[999C", "\x1b]52;c;edit-name", "\u009d", "\u009c"]) expect(output).not.toContain(unsafe);
      }
      return stripVTControlCharacters(lines.join("\n"));
    };
    const settled = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
    try {
      tui.start(); await settled(); render();
      input("e"); render();
      expect(writes.join("")).toContain("�]52;c;edit-name�");
      input("\x1b"); expect(render()).not.toContain("Discard unsaved form?");
      expect(save).not.toHaveBeenCalled();
      input("e"); input("\x1b[Z"); input("\r"); await settled();
      expect(render()).toContain("Write conflict");
      expect(save).toHaveBeenLastCalledWith(original.scope, { name: original.name, body: original.body }, original);
      for (let field = 0; field < 6; field++) {
        for (const [columns, rows] of [[100, 40], [40, 16], [20, 8], [12, 6], [100, 40]]) {
          Object.assign(terminal, { columns, rows }); panel.invalidate(); render();
          expect(panel.render(columns!).join("\n")).toContain(theme.fg("error", "⚠").split("⚠")[0] + "⚠");
        }
        input("\t");
      }
      input("\r"); await settled(); render(); // Retry from Save, without changing the name.
      expect(save).toHaveBeenCalledTimes(2);
      expect(current).toEqual({ ...original, version: 2 });
      const expected = structuredClone(current);
      input("e"); input("\x05"); input("\x15"); input("Renamed 中文😀"); render();
      input("\x1b"); expect(render()).toContain("Discard unsaved form?");
      input("n"); expect(render()).toContain("Renamed 中文😀");
      expect(save).toHaveBeenCalledTimes(2);
      input("\x1b[Z"); input("\r"); await settled(); render();
      expect(save).toHaveBeenLastCalledWith(original.scope, { name: "Renamed 中文😀", body: original.body }, expected);
      expect(close).not.toHaveBeenCalled();
    } finally {
      panel.dispose(); tui.stop(); vi.useRealTimers();
    }
  });

  it.each(["dark", "light"])("audits selections and reveals a new save through narrow/short resize (%s)", async (themeName) => {
    vi.useFakeTimers();
    const { terminal, writes, input } = createRecordingTerminal({ rows: 40, columns: 100 });
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
      let versionLimit = false;
      panel = new PreferencePanel(tui, theme, getKeybindings(), {
        load: async () => ({ errors: {}, entries: structuredClone(current) }),
        save: async (scope, value, expected) => {
          if (versionLimit) throw new Error("Use Add and copy the text into a new entry; this entry's version limit was reached.");
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
      // Storage recovery names the real Add action, including in a short warning row.
      versionLimit = true;
      input("e"); input("\x05"); input("\x15"); input("Unsaved 中文😀"); input("\x1b[Z"); input("\r");
      for (let i = 0; i < 4; i++) await Promise.resolve();
      for (const [columns, rows] of [[100, 40], [20, 8], [100, 40]]) {
        Object.assign(terminal, { columns, rows }); panel.invalidate();
        expect(render()).toContain("Use Add");
        expect(panel.render(columns!).join("\n")).toContain(theme.fg("error", "⚠").split("⚠")[0] + "⚠");
      }
      expect(render()).toContain("Unsaved");
      input("\x1b"); input("y"); // Explicitly discard only the failed form.
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
