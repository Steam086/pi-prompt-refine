import { CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { formatKeyHint } from "../../src/key-hints.js";
import { PreviewPanel } from "../../src/preview.js";
import { NUMBER_SETTINGS, type ContextSettings } from "../../src/settings.js";
import { workspaceHeight } from "../../src/workspace-overlay.js";
import { RefineWorkspace } from "../../src/workspace.js";
import { getThemeByName } from "../support/pi-theme.js";

function fixture(name = "dark") {
  const terminal = { rows: 40, columns: 100 };
  const tui = { terminal, requestRender: vi.fn() } as unknown as TUI;
  const theme = getThemeByName(name)!;
  const saved: ContextSettings = { instructions: "off", tree: false, skills: false, enabled: true,
    referencedDirectories: true, maxMessages: 12, historyMaxChars: 16000, maxOutputTokens: 8192, timeoutMs: 60000, maxDraftChars: 16000 };
  const actions = {
    context: () => ({ ...saved }), contextEnabled: () => saved.enabled!,
    optimizer: () => ({ model: "provider/中文😀\x1b[31m", thinking: "high", thinkingEnabled: true }),
    chooseModel: vi.fn(), editSystemPrompt: vi.fn(), cycleThinking: vi.fn(), submit: vi.fn(),
    saveContext: vi.fn(async (selected: ContextSettings) => { Object.assign(saved, selected); return { message: "Settings saved", persisted: true }; }),
  };
  const panel = new PreviewPanel({ state: { phase: "idle", requestId: 0, pendingSend: false },
    contextLabel: "Draft only", elapsedSeconds: 0, openHint: "ctrl+\\", canRestore: false }, theme, () => terminal.rows, () => tui.requestRender());
  const workspace = new RefineWorkspace(panel, tui, theme, new KeybindingsManager(TUI_KEYBINDINGS), actions);
  workspace.focused = true;
  const text = (width = 100) => stripVTControlCharacters(workspace.render(width).join("\n"));
  const value = (text: string) => { workspace.handleInput("\x15"); workspace.handleInput(text); }; // Ctrl+U replaces the current value.
  return { workspace, terminal, theme, actions, saved, text, value };
}

describe("Settings budgets and limits", () => {
  it.each(["dark", "light"])("renders all seven additions with neutral headings and stable bounds (%s)", (name) => {
    const f = fixture(name);
    for (const [cursor, label] of [[6, "Project context"], [7, "Directory references"], [8, "History messages"],
      [9, "History characters"], [10, "Output token limit"], [11, "Request timeout"], [12, "Draft character limit"]] as const) {
      f.workspace.openSettings(undefined, cursor);
      const wide = f.workspace.render(100).join("\n");
      expect(wide).toContain(f.theme.fg("text", f.theme.bold(label.padEnd(22))));
      expect(wide).toContain(formatKeyHint(["Ctrl+S", "Save settings"], f.theme));
      for (const rows of [40, 12, 8, 5, 40]) for (const width of [1, 12, 20, 40, 100, 160]) {
        f.terminal.rows = rows;
        const frame = f.workspace.render(width);
        expect(frame).toHaveLength(workspaceHeight(rows));
        expect(frame.every((line) => visibleWidth(line) <= width)).toBe(true);
        if (width >= 40 && rows >= 8) expect(stripVTControlCharacters(frame.join("\n"))).toContain(`› ${label}`);
        expect(frame.join("\n")).not.toContain("\x1b[31m");
      }
    }
    expect(f.actions.submit).not.toHaveBeenCalled();
  });

  it.each(Object.entries(NUMBER_SETTINGS))("edits %s using presets, custom values and explicit saving", async (cursor, spec) => {
    const f = fixture();
    f.workspace.openSettings(undefined, Number(cursor));
    f.workspace.handleInput("\r");
    expect(f.text()).toContain(spec.label);
    expect(f.text()).toContain("Presets:");
    f.workspace.handleInput("\t");
    expect(f.actions.saveContext).not.toHaveBeenCalled();
    f.workspace.handleInput("\x1b[Z");
    f.value(String(spec.min));
    f.workspace.handleInput("\r");
    expect(f.text()).toContain("Unsaved settings changes");
    expect(f.saved[spec.field]).not.toBe(spec.min * spec.scale);
    f.workspace.handleInput("\x13");
    expect(f.actions.saveContext).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ [spec.field]: spec.min * spec.scale }));
    await vi.waitFor(() => expect(f.text()).toContain("Settings saved"));
    expect(f.saved[spec.field]).toBe(spec.min * spec.scale);
    expect(f.actions.submit).not.toHaveBeenCalled();
  });

  it.each(Object.entries(NUMBER_SETTINGS))("cycles every preset for %s without persisting or submitting", (cursor, spec) => {
    const f = fixture();
    f.workspace.openSettings(undefined, Number(cursor));
    for (const preset of spec.presets) {
      f.workspace.handleInput("\r");
      f.value("invalid");
      // Unknown custom values start at the first preset; continue to this preset.
      for (let i = 0; i <= spec.presets.indexOf(preset); i++) f.workspace.handleInput("\t");
      f.workspace.handleInput("\r");
      const row = f.workspace.render(100).map(stripVTControlCharacters).find((line) => line.includes(`› ${spec.label}`));
      expect(row).toContain(preset === 0 ? "Off" : `${preset} ${spec.unit}`);
    }
    expect(f.actions.saveContext).not.toHaveBeenCalled();
    expect(f.actions.submit).not.toHaveBeenCalled();
    f.workspace.handleInput("\x13");
    expect(f.actions.saveContext).toHaveBeenCalledWith(expect.objectContaining({ [spec.field]: spec.presets.at(-1)! * spec.scale }));
  });

  it.each(Object.entries(NUMBER_SETTINGS))("validates both boundaries and retains invalid input for %s", (_cursor, spec) => {
    const f = fixture();
    f.workspace.openSettings(undefined, Number(_cursor));
    f.workspace.handleInput("\r");
    for (const invalid of ["", "-1", String(spec.max + 1), "NaN", "1e3", "中文😀", "12\n34", ...(spec.scale === 1 ? ["1.5"] : ["1.0001"])]) {
      f.value(invalid);
      f.workspace.handleInput("\r");
      expect(f.text()).toContain(`Enter ${spec.min}–${spec.max}`);
      expect(f.actions.saveContext).not.toHaveBeenCalled();
      f.workspace.handleInput("\x13");
      expect(f.actions.saveContext).not.toHaveBeenCalled();
      // Ctrl+U clears only the current line; re-open to reset pasted multiline input.
      f.workspace.handleInput("\x1b");
      f.workspace.handleInput("\r");
    }
    f.value(String(spec.max));
    f.workspace.handleInput("\r");
    expect(f.text()).toContain("Unsaved settings changes");
    f.workspace.handleInput("\x13");
    expect(f.actions.saveContext).toHaveBeenCalledWith(expect.objectContaining({ [spec.field]: spec.max * spec.scale }));
  });

  it.each(["dark", "light"])("keeps numeric focus, warnings and Cancel visible after resize (%s)", (name) => {
    const f = fixture(name);
    f.workspace.openSettings(undefined, 10);
    f.workspace.handleInput("\r");
    f.value("中文😀\x1b[31m");
    f.workspace.handleInput("\r");
    for (const rows of [40, 8, 5, 12, 40]) for (const width of [1, 12, 20, 40, 100]) {
      f.terminal.rows = rows;
      f.workspace.invalidate();
      const frame = f.workspace.render(width);
      expect(frame).toHaveLength(workspaceHeight(rows));
      expect(frame.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(frame.join("\n")).toContain(CURSOR_MARKER);
      if (width >= 20) {
        expect(frame.join("\n")).toContain(formatKeyHint(["Esc", "Cancel"], f.theme));
        expect(frame.join("\n")).toContain(f.theme.fg("warning", "").split("\x1b[39m")[0]);
        expect(stripVTControlCharacters(frame.join("\n"))).toContain("Enter 16–65536");
      }
      expect(frame.join("\n")).not.toContain("\x1b[31m");
    }
    f.workspace.handleInput("q");
    expect(f.text()).toContain("Output token limit"); // Text keys edit the value rather than navigating out.
    expect(f.actions.submit).not.toHaveBeenCalled();
    f.workspace.handleInput("\x1b");
    expect(f.text()).toContain("› Output token limit");
    expect(f.text()).not.toContain("Unsaved settings changes");
  });

  it("stages switches independently, preserves them across child actions and discards them on Back", () => {
    const f = fixture();
    f.workspace.openSettings(undefined, 6);
    f.workspace.handleInput(" ");
    expect(f.text()).toContain("Project context is off");
    f.workspace.handleInput("\x1b[B");
    f.workspace.handleInput(" ");
    f.workspace.handleInput("\t");
    f.workspace.handleInput("\r");
    expect(f.actions.chooseModel).toHaveBeenCalledWith(expect.objectContaining({ enabled: false, referencedDirectories: false }));
    f.workspace.handleInput("\t");
    f.workspace.handleInput("\r");
    f.value("9999");
    f.workspace.handleInput("\x1b");
    f.workspace.handleInput("\x1b");
    f.workspace.openSettings(undefined, 6);
    expect(f.text()).not.toContain("Unsaved settings changes");
    expect(f.saved).toMatchObject({ enabled: true, referencedDirectories: true, maxDraftChars: 16000 });
    expect(f.actions.saveContext).not.toHaveBeenCalled();
    expect(f.actions.submit).not.toHaveBeenCalled();
  });

  it("retains all staged limits after a save failure and retries from another group", async () => {
    const f = fixture();
    f.actions.saveContext.mockResolvedValueOnce({ message: "Not persisted", persisted: false });
    f.workspace.openSettings(undefined, 10);
    f.workspace.handleInput("\r"); f.value("12345"); f.workspace.handleInput("\r");
    f.workspace.handleInput("\t");
    f.workspace.handleInput("\r"); f.value("54321"); f.workspace.handleInput("\r");
    f.workspace.handleInput("\x13");
    await vi.waitFor(() => expect(f.text()).toContain("Not persisted"));
    f.workspace.handleInput("\t");
    f.workspace.handleInput("\x13");
    await vi.waitFor(() => expect(f.text()).toContain("Settings saved"));
    expect(f.actions.saveContext).toHaveBeenCalledTimes(2);
    expect(f.saved).toMatchObject({ maxOutputTokens: 12345, maxDraftChars: 54321 });
  });
});
