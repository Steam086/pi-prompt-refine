import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { formatKeyHint } from "../../src/key-hints.js";
import { create, footer, options, panelLayout, textOf } from "../support/workspace.js";

describe("shared refine workspace", () => {

  it.each(["dark", "light"])("keeps rejected input visible in tiny viewports without hiding Back (%s)", (name) => {
    const { workspace, terminal, actions, theme } = create(40, name);
    actions.submit.mockReturnValue("Rejected 中文😀\x1b[31m");
    workspace.handleInput("i"); workspace.handleInput("Retained draft 中文😀"); workspace.handleInput("\r");
    for (const rows of [5, 8, 9, 12, 40, 8]) for (const width of [20, 40, 100]) {
      terminal.rows = rows;
      const lines = workspace.render(width);
      expect(lines).toHaveLength(panelLayout(width, rows).height);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(stripVTControlCharacters(lines.join("\n"))).toContain("Rejected");
      expect(lines.join("\n")).toContain(theme.fg("warning", "").split("\x1b[39m")[0]);
      expect(lines.join("\n")).not.toContain("\x1b[31m");
      if (rows >= 8) expect(footer(lines).at(-1)).toContain(formatKeyHint(["Esc", "Back"], theme));
    }
    terminal.rows = 40;
    expect(textOf(workspace.render(100))).toContain("Retained draft 中文😀");
    expect(actions.submit).toHaveBeenCalledExactlyOnceWith("Retained draft 中文😀");
  });

  it.each(["dark", "light"])("shares footer key styles with the reading and input pages in %s", (name) => {
    const { workspace, panel, theme } = create(40, name, true);
    const main = textOf(workspace.render(100));
    for (const hint of [["a", "Accept"], ["e", "Edit"], ["f", "Revise"], ["q", "Back"], ["?", "Help"]] as const) {
      expect(main).toContain(formatKeyHint(hint, theme));
    }
    panel.toggleHelp();
    expect(textOf(workspace.render(100))).toContain(formatKeyHint(["r", "Refine current draft in this round (model call)"], theme));
    workspace.openSettings();
    expect(textOf(workspace.render(100))).toContain(formatKeyHint(["Ctrl+S", "Save settings"], theme));
    workspace.handleInput("q");
    workspace.handleInput("i");
    expect(textOf(workspace.render(100))).toContain(formatKeyHint(["Enter", "Refine"], theme));
  });

  it.each([[24, 23], [32, 30], [40, 38], [60, 57]])("budgets %i terminal rows as %i panel rows", (rows, height) => {
    expect(panelLayout(80, rows).height).toBe(height);
    expect(panelLayout(80, rows).bodyHeight).toBe(height - 7);
  });

  it.each(["dark", "light"])("keeps geometry, cursor and controls bounded in %s theme", (theme) => {
    for (const rows of [5, 8, 12, 16, 24, 32, 40, 60]) {
      for (const width of [1, 2, 12, 20, 40, 80, 160]) {
        const { workspace, terminal } = create(rows, theme);
        const layout = panelLayout(width, rows);
        const main = workspace.render(width);
        workspace.handleInput("\x1b[D");
        const context = workspace.render(width);
        workspace.handleInput("\x1b");
        workspace.handleInput("i");
        const input = workspace.render(width);
        for (const lines of [main, context, input]) {
          expect(lines).toHaveLength(layout.height);
          if (layout.topSeparatorHeight) expect(lines[0]).toContain("─".repeat(layout.innerWidth));
          for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        }
        expect(textOf(input)).toContain(CURSOR_MARKER);
        expect(terminal.rows).toBe(rows); // Editor facade must not mutate the host.
        if (width >= 40 && rows >= 16) {
          expect(stripVTControlCharacters(textOf(input))).toContain("Esc Back");
          expect(stripVTControlCharacters(textOf(input))).toContain("Enter Refine");
          expect(stripVTControlCharacters(textOf(context))).toContain("Ctrl+S Save settings");
        }
      }
    }
  });

  it("retains reading position and expansions through both secondary states", () => {
    const { workspace, panel } = create();
    panel.toggleSource();
    workspace.render(80);
    panel.page(1);
    const before = workspace.render(80);
    for (const [open, back] of [["\x1b[D", "\x1b"], ["i", "\x1b"]]) {
      workspace.handleInput(open!);
      workspace.render(80);
      workspace.handleInput(back!);
      expect(workspace.render(80)).toEqual(before);
    }
    panel.toggleOriginal();
    const original = workspace.render(80);
    workspace.handleInput("\x1b[D");
    workspace.handleInput("q");
    expect(workspace.render(80)).toEqual(original);
  });

  it("fills the input viewport, follows its cursor on resize and retains draft/focus", () => {
    const { workspace, terminal, actions } = create();
    workspace.handleInput("i");
    for (let i = 0; i < 45; i++) {
      workspace.handleInput(`中文 😀 é line ${i}`);
      workspace.handleInput("\x1b[13;2u"); // Kitty Shift+Enter, not submission.
    }
    expect(actions.submit).not.toHaveBeenCalled();
    for (const rows of [40, 24, 12, 8, 5, 32, 60]) {
      terminal.rows = rows;
      for (const width of [20, 80]) {
        const lines = workspace.render(width);
        const layout = panelLayout(width, rows);
        expect(lines).toHaveLength(layout.height);
        const bodyStart = layout.topSeparatorHeight + layout.headerHeight;
        const body = lines.slice(bodyStart, bodyStart + layout.bodyHeight);
        expect(body.filter((line) => line.trim())).toHaveLength(layout.bodyHeight);
        expect(textOf(body)).toContain(CURSOR_MARKER);
        for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
    const before = workspace.render(80);
    workspace.focused = false;
    expect(textOf(workspace.render(80))).not.toContain(CURSOR_MARKER);
    workspace.focused = true;
    expect(workspace.render(80)).toEqual(before);
    workspace.handleInput("\x1b");
    expect(textOf(workspace.render(80))).not.toContain(CURSOR_MARKER);
    workspace.handleInput("i");
    expect(workspace.render(80)).toEqual(before);
    workspace.handleInput("\r");
    expect(actions.submit).toHaveBeenCalledWith(expect.stringContaining("中文 😀 é line 44\n"));
    expect(textOf(workspace.render(80))).not.toContain(CURSOR_MARKER);
  });

  it.each(["dark", "light"])("keeps revision input focused, bounded and distinct from new drafts in %s", (name) => {
    const { workspace, actions, terminal, theme } = create(40, name);
    const revise = vi.fn((_text: string): string | undefined => "Revision failed validation");
    actions.revision.mockReturnValue({ key: "result-1", submit: revise });
    workspace.handleInput("i");
    workspace.handleInput("New draft text");
    workspace.handleInput("\x1b");
    workspace.handleInput("f");
    expect(textOf(workspace.render(80))).not.toContain("New draft text");
    workspace.handleInput("Shorter, keep 中文 😀 commands");
    for (const rows of [5, 8, 16, 40]) {
      terminal.rows = rows;
      for (const width of [12, 20, 40, 100]) {
        const lines = workspace.render(width);
        expect(lines).toHaveLength(panelLayout(width, rows).height);
        expect(textOf(lines)).toContain(CURSOR_MARKER);
        for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
    expect(textOf(workspace.render(100))).toContain(formatKeyHint(["Ctrl+S", "Revise"], theme));
    workspace.handleInput("\x13");
    expect(revise).toHaveBeenCalledWith("Shorter, keep 中文 😀 commands");
    expect(actions.submit).not.toHaveBeenCalled();
    expect(textOf(workspace.render(100))).toContain("Revision failed validation");
    workspace.handleInput("\x1b");
    workspace.handleInput("f");
    expect(textOf(workspace.render(100))).toContain("Shorter, keep");
    workspace.handleInput("\x1b");
    actions.revision.mockReturnValue({ key: "result-2", submit: revise });
    workspace.handleInput("f");
    expect(textOf(workspace.render(100))).not.toContain("Shorter, keep");
    workspace.handleInput("\x1b");
    actions.revision.mockReturnValue({ key: "result-1", submit: revise });
    workspace.handleInput("f");
    expect(textOf(workspace.render(100))).toContain("Shorter, keep");
    workspace.handleInput("\x1b");
    workspace.handleInput("i");
    expect(textOf(workspace.render(100))).toContain("New draft text");
  });

  it.each(["i", "f"])("does not let input arrows or action letters navigate or execute main actions in %s", (open) => {
    const { workspace, actions } = create(40, "dark", true);
    const revise = vi.fn(() => undefined);
    actions.revision.mockReturnValue({ key: "result-1", submit: revise });
    workspace.handleInput(open);
    for (const key of ["i", "q", "r", "a", "s", "\x1b[D", "\x1b[C"]) expect(workspace.handleInput(key)).toBe(true);
    expect(textOf(workspace.render(80))).toContain("iqras");
    expect(textOf(workspace.render(80))).toContain(CURSOR_MARKER);
    expect(actions.submit).not.toHaveBeenCalled();
    expect(revise).not.toHaveBeenCalled();
    expect(actions.saveContext).not.toHaveBeenCalled();
  });

  it("hydrates the independent draft and saves only edits, including an explicit clear", () => {
    const { workspace, actions } = create(40, "dark", false, "Retained input");
    expect(textOf(workspace.render(100))).not.toContain("Retained input");
    workspace.handleInput("i");
    expect(textOf(workspace.render(100))).toContain("Retained input");
    workspace.handleInput("\x1b[D");
    workspace.handleInput("\x1b[C");
    workspace.handleInput("\r");
    expect(actions.submit).toHaveBeenCalledWith("Retained input");
    expect(actions.inputDraft.save).not.toHaveBeenCalled();
    workspace.handleInput("i");
    expect(textOf(workspace.render(100))).toContain("Retained input");
    workspace.handleInput("\x15"); // Ctrl+U at end of the single line.
    expect(actions.inputDraft.save).toHaveBeenLastCalledWith("");
    workspace.handleInput("\r"); // Validation belongs to the host; even submission keeps the clear.
    workspace.handleInput("i");
    expect(textOf(workspace.render(100))).not.toContain("Retained input");
  });

  it("expands bracketed paste exactly and preserves failed input for retry", () => {
    const { workspace, actions } = create();
    const draft = "  第一行\n\n" + "Long pasted text\n".repeat(20);
    actions.submit.mockReturnValueOnce("No model configured");
    workspace.handleInput("i");
    workspace.handleInput(`\x1b[200~${draft}\x1b[201~`);
    expect(actions.submit).not.toHaveBeenCalled();
    expect(actions.inputDraft.save).toHaveBeenLastCalledWith(draft);
    const saves = actions.inputDraft.save.mock.calls.length;
    workspace.handleInput("\r");
    expect(actions.submit).toHaveBeenLastCalledWith(draft);
    expect(textOf(workspace.render(80))).toContain("No model configured");
    workspace.handleInput("\r");
    expect(actions.submit).toHaveBeenLastCalledWith(draft);
    expect(textOf(workspace.render(80))).toContain("Prompt refine");
    expect(actions.inputDraft.save).toHaveBeenCalledTimes(saves);
    workspace.handleInput("i");
    workspace.handleInput("\r");
    expect(actions.submit).toHaveBeenLastCalledWith(draft);
  });

  it("does not steal input focus when background results arrive", () => {
    const { workspace, panel } = create();
    workspace.handleInput("i");
    workspace.handleInput("draft in progress");
    const before = workspace.render(80);
    panel.update({ ...options, candidateText: "Background result", state: { ...options.state, requestId: 2 } });
    expect(workspace.render(80)).toEqual(before);
    workspace.handleInput("\x1b");
    expect(textOf(workspace.render(80))).toContain("Background result");
  });

  it("keeps history storage and help read-only, including page arrows and submission keys", () => {
    const { workspace, actions } = create();
    Object.assign(actions, { historyStorage: () => ({ state: "no-session-file", savedIds: [], memoryOnlyIds: [], omittedIds: [] }) });
    workspace.openUsage(); workspace.handleInput("b");
    expect(textOf(workspace.render(100))).toContain("History storage");
    expect(textOf(workspace.render(100))).toContain("No session file");
    for (const key of ["\x1b[C", "\x1b[D", "\r", "a", "s", "f", "i", "d"]) {
      workspace.handleInput(key);
      expect(textOf(workspace.render(100))).toContain("History storage");
    }
    workspace.handleInput("\x1b"); expect(textOf(workspace.render(100))).toContain("Usage · All rounds");
    workspace.handleInput("?");
    workspace.handleInput("\x1b[C"); expect(textOf(workspace.render(100))).toContain("Available actions");
    workspace.handleInput("\x1b"); expect(textOf(workspace.render(100))).toContain("Usage · All rounds");
    expect(actions.submit).not.toHaveBeenCalled(); expect(actions.saveContext).not.toHaveBeenCalled();
  });
});
