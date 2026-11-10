import { CURSOR_MARKER, getKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PromptInput } from "../../src/prompt-input.js";
import type { RevisionDraft } from "../../src/revision-preferences.js";
import { RevisePage } from "../../src/ui/revise-page.js";
import { panelLayout } from "../../src/panel-layout.js";
import { getThemeByName } from "../support/pi-theme.js";

afterEach(() => vi.restoreAllMocks());

describe("RevisePage focus seam", () => {
  it.each(["dark", "light"])("consumes requirement-reading input and isolates candidate editor undo in %s", (name) => {
    const theme = getThemeByName(name)!;
    vi.spyOn(theme, "bold").mockImplementation((text) => `\x1b[1m${text}\x1b[22m`);
    const tui = { terminal: { rows: 40, columns: 100 }, requestRender: vi.fn() } as unknown as TUI;
    const inputs: PromptInput[] = [];
    const drafts = new Map<string, RevisionDraft>();
    const submit = vi.fn(() => "Retain requirements");
    const back = vi.fn();
    const page = new RevisePage(theme, getKeybindings(), {
      preferences: false, preferencesKeyNotice: "", openPreferences: vi.fn(), back, submitted: vi.fn(),
    }, drafts, () => {
      const input = new PromptInput(tui, { borderColor: (text) => text, selectList: {
        selectedPrefix: (text) => text, selectedText: (text) => text, description: (text) => text,
        scrollInfo: (text) => text, noMatch: (text) => text,
      } });
      inputs.push(input);
      return input;
    }, (width) => panelLayout(width, tui.terminal.rows), tui);
    page.open({ key: "run-1", label: "Run #1", submit }, undefined);
    page.focused = true;
    page.handleInput("Keep 中文😀 **literal**");
    const editor = inputs.at(-1)!;
    expect(editor.editor.focused).toBe(true);
    expect(page.render(100).join("\n")).toContain(CURSOR_MARKER);
    page.handleInput("\t");
    expect(editor.editor.focused).toBe(false);
    page.handleInput("\r");
    expect(page.render(100).join("\n")).toContain(theme.fg("text", "Keep 中文😀 **literal**"));
    for (const key of ["\x13", "\r", "\t", "\x1b[C"]) page.handleInput(key);
    expect(submit).not.toHaveBeenCalled();
    expect(back).not.toHaveBeenCalled();
    page.handleInput("\x1b");
    expect(editor.editor.focused).toBe(true);
    expect(page.render(100).join("\n")).toContain(CURSOR_MARKER);
    page.handleInput("\x13");
    expect(submit).toHaveBeenCalledExactlyOnceWith("Keep 中文😀 **literal**");
    expect(drafts.get("run-1")?.freeText).toBe("Keep 中文😀 **literal**");
    page.open({ key: "run-2", submit }, undefined);
    page.focused = true;
    expect(inputs.at(-1)).not.toBe(editor);
    expect(editor.editor.focused).toBe(false);
    expect(inputs.at(-1)!.editor.getExpandedText()).toBe("");
    expect(drafts.get("run-1")?.freeText).toBe("Keep 中文😀 **literal**");
  });
});
