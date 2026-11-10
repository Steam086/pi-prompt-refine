import { getKeybindings, type TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { panelLayout } from "../../src/panel-layout.js";
import { PromptInput } from "../../src/prompt-input.js";
import { SettingsPage } from "../../src/ui/settings-page.js";
import { getThemeByName } from "../support/pi-theme.js";

describe("SettingsPage navigation seam", () => {
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
