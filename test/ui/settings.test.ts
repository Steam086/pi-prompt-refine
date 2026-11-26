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
      expect(wide).toContain(formatKeyHint(["Ctrl+S", "Save"], f.theme, 1, "secondary"));
      for (const rows of [40, 12, 8, 5, 40]) for (const width of [1, 12, 20, 40, 100, 160]) {
        f.terminal.rows = rows;
        const frame = f.workspace.render(width);
        expect(frame).toHaveLength(workspaceHeight(rows));
        expect(frame.every((line) => visibleWidth(line) <= width)).toBe(true);
        if (width >= 40 && rows >= 8) {
          const short = NUMBER_SETTINGS[cursor]?.shortLabel;
          expect(stripVTControlCharacters(frame.join("\n"))).toMatch(new RegExp(`› (?:${label}${short ? `|${short}` : ""})`));
        }
        expect(frame.join("\n")).not.toContain("\x1b[31m");
      }
    }
    expect(f.actions.submit).not.toHaveBeenCalled();
  });

  it.each(["dark", "light"])("puts all five active fields ahead of muted help and presets (%s)", (name) => {
    const f = fixture(name);
    for (const [cursor, spec] of Object.entries(NUMBER_SETTINGS)) {
      f.workspace.openSettings(undefined, Number(cursor));
      f.workspace.handleInput("\r");
      const value = String(f.saved[spec.field]! / spec.scale);
      for (const [width, rows] of [[160, 40], [60, 20], [32, 9], [160, 40]] as const) {
        f.terminal.rows = rows;
        const frame = f.workspace.render(width);
        const field = frame.findIndex((line) => line.includes(CURSOR_MARKER));
        const divider = frame.findIndex((line) => /^[│ ]*─+[│ ]*$/u.test(stripVTControlCharacters(line)));
        expect(field).toBeGreaterThan(0);
        expect(frame[field]).toContain(f.theme.bg("selectedBg", f.theme.fg("text", f.theme.bold("› Value:"))) + " " + f.theme.getFgAnsi("text") + value);
        if (divider >= 0) expect(field).toBe(divider + 1);
        expect(frame.slice(0, field).join("\n")).not.toContain("Presets:");
        if (width === 160) expect(frame.slice(field + 1).join("\n")).toContain(f.theme.fg("muted", `Presets: ${spec.presets.join(" / ")}`));
      }
      f.workspace.handleInput("\x1b");
    }
    expect(f.actions.saveContext).not.toHaveBeenCalled();
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
    expect(f.saved[spec.field]).not.toBe(spec.min * spec.scale);
    f.workspace.handleInput("\x13");
    expect(f.actions.saveContext).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ [spec.field]: spec.min * spec.scale }));
    await vi.waitFor(() => expect(f.text()).toContain("Settings saved"));
    expect(f.text()).toContain(`› ${spec.label}`);
    expect(f.text()).toContain("Esc: Close");
    expect(f.text()).not.toContain("Unsaved settings changes");
    expect(f.saved[spec.field]).toBe(spec.min * spec.scale);
    f.workspace.handleInput("\r");
    f.value(String(spec.max));
    f.workspace.handleInput("\r");
    expect(f.text()).toContain("Unsaved settings changes");
    expect(f.workspace.handleInput("\x1b")).toBe(true);
    expect(f.text()).toContain("Discard unsaved settings?");
    expect(f.workspace.handleInput("y")).toBe("close");
    expect(f.saved[spec.field]).toBe(spec.min * spec.scale);
    f.workspace.openSettings(undefined, Number(cursor));
    expect(f.text()).not.toContain("Unsaved settings changes");
    expect(f.actions.saveContext).toHaveBeenCalledTimes(1);
    expect(f.actions.submit).not.toHaveBeenCalled();
  });

  it.each(Object.entries(NUMBER_SETTINGS))("cycles every preset for %s without persisting or submitting", (cursor, spec) => {
    const f = fixture();
    f.workspace.openSettings(undefined, Number(cursor));
    for (const preset of spec.presets) {
      f.workspace.handleInput("\r");
      f.value("invalid");
      f.workspace.handleInput("\x1b[B");
      expect(f.text()).toContain("Value: invalid");
      for (let i = 0; i < spec.presets.indexOf(preset); i++) f.workspace.handleInput("\x1b[B");
      expect(f.text()).toContain(`› Preset: ${preset}`);
      f.workspace.handleInput(" ");
      expect(f.text()).toContain(`› Value: ${preset}`);
      f.workspace.handleInput("\r");
      const row = f.workspace.render(100).map(stripVTControlCharacters).find((line) => line.includes(`› ${spec.label}`));
      expect(row).toContain(preset === 0 ? "Off" : `${preset} ${spec.unit}`);
    }
    expect(f.actions.saveContext).not.toHaveBeenCalled();
    expect(f.actions.submit).not.toHaveBeenCalled();
    f.workspace.handleInput("\x13");
    expect(f.actions.saveContext).toHaveBeenCalledWith(expect.objectContaining({ [spec.field]: spec.presets.at(-1)! * spec.scale }));
  });

  it.each(["dark", "light"])("highlights the preset at short heights and retains the numeric edit after a failed save (%s)", async (name) => {
    const f = fixture(name);
    const { workspace, theme, terminal, actions } = f;
    workspace.openSettings(undefined, 8);
    workspace.handleInput("\r");
    f.value("23");
    workspace.handleInput("\t");
    for (const [columns, rows] of [[100, 40], [24, 8], [100, 40]]) {
      Object.assign(terminal, { columns, rows });
      expect(workspace.render(columns!).join("\n")).toContain(theme.bg("selectedBg", theme.fg("text", theme.bold("› Preset: 0 (1/5)"))));
    }
    workspace.handleInput("\x1b");
    expect(f.text()).toContain("› Value: 23");
    workspace.handleInput("\x1b[B");
    expect(f.text()).toContain("› Preset: 0");
    actions.saveContext.mockRejectedValueOnce(new Error("Unavailable"));
    workspace.handleInput("\x13");
    await vi.waitFor(() => expect(f.text()).toContain("Could not save settings"));
    expect(f.text()).toContain("› Value: 23");
    expect(actions.saveContext).toHaveBeenLastCalledWith(expect.objectContaining({ maxMessages: 23 }));
    workspace.handleInput("\x1b");
    expect(f.text()).toContain("Could not save settings");
    expect(f.text()).toContain("Unsaved settings changes");
    workspace.handleInput("\x13");
    await vi.waitFor(() => expect(f.text()).toContain("Settings saved"));
    expect(actions.saveContext).toHaveBeenCalledTimes(2);
    expect(f.saved.maxMessages).toBe(23);
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
        const style = stripVTControlCharacters(frame.join("\n")).includes("Esc: Cancel") ? "secondary" : "secondary-compact";
        expect(frame.join("\n")).toContain(formatKeyHint(["Esc", width < 24 ? "" : "Cancel"], f.theme, 1, style));
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

  it.each(["dark", "light"])("shows inactive child choices without disabling history or edits (%s)", (name) => {
    const f = fixture(name);
    Object.assign(f.saved, { instructions: "first", tree: true, skills: true, enabled: false });
    f.workspace.openSettings(undefined, 6);
    const rows = f.workspace.render(100);
    const row = (label: string) => rows.find((line) => stripVTControlCharacters(line).includes(label))!;
    expect(rows.indexOf(row("Project context"))).toBeLessThan(rows.indexOf(row("Project instructions")));
    for (const label of ["Project instructions", "Directory tree", "Skill metadata", "Directory references"]) {
      expect(row(label)).toContain(f.theme.fg("dim", label.padEnd(22)));
      expect(stripVTControlCharacters(row(label))).toContain(" · inactive");
    }
    expect(row("History messages")).toContain(f.theme.fg("text", "History messages".padEnd(22)));
    expect(stripVTControlCharacters(row("History messages"))).toContain("12 messages");
    expect(f.text()).toContain("Project context is off. Conversation history is unaffected.");
    f.workspace.handleInput(" ");
    expect(f.text()).not.toContain("inactive");
    expect(f.text()).toMatch(/Directory references +\[x\] On/);
    expect(f.actions.saveContext).not.toHaveBeenCalled();
    expect(f.actions.submit).not.toHaveBeenCalled();
  });

  it("identifies AGENTS.md inline and explains first-request rules on narrow and wide screens", () => {
    const f = fixture();
    f.workspace.openSettings({ ...f.saved, instructions: "first" }, 0);
    expect(f.text(80).split("\n").find((line) => line.includes("Project instructions"))).toContain("AGENTS.md");
    expect(f.text(60)).toContain("AGENTS.md");
    expect(f.text()).toContain("first request per task, not Revise");
    expect(f.text(120)).toContain("Main agent unchanged");
    f.workspace.handleInput(" ");
    expect(f.text()).toContain("even in Revise");
    f.workspace.handleInput(" ");
    expect(f.text()).toContain("No Pi-loaded rules (e.g. AGENTS.md) are sent to the optimizer");
    for (const cursor of [8, 9]) {
      f.workspace.openSettings(undefined, cursor);
      expect(f.text(60)).toContain("Either limit set to 0 turns off history");
    }
  });

  it("stages switches independently, preserves them across child actions and discards them on Back", () => {
    const f = fixture();
    f.workspace.openSettings(undefined, 6);
    f.workspace.handleInput(" ");
    expect(f.text()).toContain("Project context is off");
    for (let i = 0; i < 4; i++) f.workspace.handleInput("\x1b[B");
    expect(f.text()).toContain("› Directory references");
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
    f.workspace.handleInput("\x1b[B"); f.workspace.handleInput("\x1b[B");
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
