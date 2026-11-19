import { CURSOR_MARKER, getKeybindings, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { stripVTControlCharacters as strip } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { formatKeyHint } from "../../src/key-hints.js";
import { panelLayout } from "../../src/panel-layout.js";
import { PromptInput } from "../../src/prompt-input.js";
import { SettingsPage } from "../../src/ui/settings-page.js";
import { getThemeByName } from "../support/pi-theme.js";
import { create, footer } from "../support/workspace.js";

describe("SettingsPage navigation seam", () => {
  it.each(["dark", "light"])("keeps the Settings strip passive, complete and compact across widths (%s)", (name) => {
    const { workspace, theme, actions } = create(40, name, true);
    const bold = vi.spyOn(theme, "bold").mockImplementation((text) => `\x1b[1m${text}\x1b[22m`);
    workspace.openSettings();
    try {
      for (const [width, count] of [[160, 1], [120, 1], [100, 1], [80, 1], [60, 1], [40, 2], [160, 1]] as const) {
        const frame = workspace.render(width);
        const hints = footer(frame);
        const output = hints.join("\n");
        expect(hints).toHaveLength(count);
        expect(strip(output)).not.toMatch(/(?:Space|←|→|↑↓):/);
        for (const hint of [["Ctrl+S", "Save"], ["Enter", "Change"], ["Esc", "Back"], ["Tab", "Group"]] as const) {
          expect(output).toContain(formatKeyHint(hint, theme, 1, "secondary"));
          expect(output).not.toContain(theme.bold(hint[0]));
        }
        const tab = frame.findIndex((line) => line.includes(theme.bg("selectedBg", theme.fg("text", theme.bold(" Settings ")))));
        const hintRow = frame.findIndex((line) => line.includes(formatKeyHint(["Ctrl+S", "Save"], theme, 1, "secondary")));
        expect(hintRow).toBeGreaterThanOrEqual(tab);
        expect(frame.every((line) => visibleWidth(line) <= width)).toBe(true);
        expect(frame.join("\n")).toContain(theme.fg("text", theme.bold("Settings")));
        expect(frame.join("\n")).toContain(theme.bg("selectedBg", theme.fg("text", theme.bold(" Context "))));
        expect(workspace.render(width)).toEqual(frame); // Cached frames preserve geometry and style.
      }
      workspace.handleInput(" ");
      expect(workspace.render(160).join("\n")).toContain(theme.fg("warning", "Unsaved settings changes"));
      expect(footer(workspace.render(160)).join("\n")).toContain(formatKeyHint(["Esc", "Discard"], theme, 1, "secondary"));
      expect(actions.saveContext).not.toHaveBeenCalled();
      expect(actions.submit).not.toHaveBeenCalled();
    } finally { bold.mockRestore(); workspace.dispose(); }
  });

  it.each(["dark", "light"])("uses the same passive strip in numeric editing, including tiny fallbacks (%s)", (name) => {
    const { workspace, theme, terminal, actions } = create(40, name, true);
    const bold = vi.spyOn(theme, "bold").mockImplementation((text) => `\x1b[1m${text}\x1b[22m`);
    workspace.openSettings(undefined, 8); workspace.handleInput("\r");
    try {
      for (const width of [160, 100, 40, 20, 12, 160]) {
        const frame = workspace.render(width);
        const hints = footer(frame);
        const shortcutText = hints.map(strip).join("").replace(/[│\s·]/g, "");
        expect(shortcutText).toBe(width <= 20 ? "EscCancel↵Apply" : "Esc:CancelEnter:ApplyTab:Preset");
        expect(hints.join("\n")).not.toContain("\x1b[1m");
        if (width >= 100) expect(hints).toHaveLength(1);
        expect(frame.join("\n")).toContain(CURSOR_MARKER);
        expect(frame.every((line) => visibleWidth(line) <= width)).toBe(true);
      }
      for (const rows of [8, 5]) {
        terminal.rows = rows;
        const frame = workspace.render(20);
        expect(frame.join("\n")).toContain(formatKeyHint(["Esc", "Cancel"], theme, 1, "secondary-compact"));
        expect(frame.join("\n")).toContain(CURSOR_MARKER);
        expect(frame.every((line) => visibleWidth(line) <= 20)).toBe(true);
      }
      expect(actions.saveContext).not.toHaveBeenCalled();
      expect(actions.submit).not.toHaveBeenCalled();
    } finally { bold.mockRestore(); workspace.dispose(); }
  });

  it("delegates only outer group arrows while numeric editing consumes navigation and save", () => {
    const tui = { terminal: { rows: 40, columns: 100 }, requestRender: vi.fn() } as unknown as TUI;
    const inputs: PromptInput[] = [];
    const optimizer = vi.fn(() => ({ model: "model", thinking: "high", thinkingEnabled: true }));
    const saveContext = vi.fn(async () => ({ message: "Saved", persisted: true }));
    const page = new SettingsPage(getThemeByName("dark")!, getKeybindings(), {
      context: () => ({ instructions: "always", tree: true, skills: false }), contextEnabled: () => true,
      optimizer, saveContext, close: vi.fn(),
    }, () => {
      const input = new PromptInput(tui, { borderColor: (text) => text, selectList: {
        selectedPrefix: (text) => text, selectedText: (text) => text, description: (text) => text,
        scrollInfo: (text) => text, noMatch: (text) => text,
      } });
      inputs.push(input);
      return input;
    }, (width) => panelLayout(width, tui.terminal.rows), tui);
    page.open();
    page.focused = true;
    expect(page.handleInput("\x1b[D")).toBe(false);
    expect(page.handleInput("\x1b[C")).toBe(true);
    expect(page.handleInput("\x1b[C")).toBe(true);
    expect(page.handleInput("\x1b[C")).toBe(false);
    expect(optimizer).toHaveBeenCalledTimes(1);
    page.handleInput("\r");
    const editor = inputs.at(-1)!.editor;
    expect(page.editingNumber).toBe(true);
    expect(editor.focused).toBe(true);
    const text = editor.getExpandedText();
    expect(page.handleInput("\x1b[D")).toBe(true);
    expect(page.handleInput("\x13")).toBe(true);
    expect(editor.getExpandedText()).toBe(text);
    expect(saveContext).not.toHaveBeenCalled();
    page.focused = false;
    expect(editor.focused).toBe(false);
    page.focused = true;
    expect(editor.focused).toBe(true);
    page.handleInput("\x1b");
    expect(page.editingNumber).toBe(false);
    expect(editor.focused).toBe(false);
    expect(page.handleInput("\x1b[C")).toBe(false);
    page.dispose();
  });
});
