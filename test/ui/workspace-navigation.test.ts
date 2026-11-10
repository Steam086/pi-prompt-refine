import { visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { selectHistory } from "../../src/context.js";
import type { RefineRecord } from "../../src/history.js";
import { formatKeyHint } from "../../src/key-hints.js";
import { create, textOf } from "../support/workspace.js";

describe("shared refine workspace", () => {

  it.each(["dark", "light"])("cycles pages and Settings groups in both directions with shared chrome in %s", (name) => {
    const { workspace, actions, theme } = create(40, name, true);
    const height = workspace.render(100).length;
    for (const [key, pages] of [
      ["\x1b[C", ["Usage", "Settings", "Settings", "Settings", "Preview"]],
      ["\x1b[D", ["Settings", "Settings", "Settings", "Usage", "Preview"]],
    ] as const) {
      for (const page of pages) {
        expect(workspace.handleInput(key)).toBe(true);
        const lines = workspace.render(100);
        expect(lines).toHaveLength(height);
        const strip = lines[4]!;
        expect(strip).toContain(theme.bg("toolPendingBg", theme.fg("text", theme.bold(` ${page} `))));
        for (const label of ["Preview", "Usage", "Settings"]) expect(strip).toContain(label);
        expect(strip).not.toMatch(/h History|u Usage|←|→/);
        expect(stripVTControlCharacters(lines[1]!)).toContain(page === "Preview" ? "Prompt refine" : page);
        for (const obsolete of ["h", "u"]) {
          workspace.handleInput(obsolete);
          expect(workspace.render(100)).toEqual(lines);
        }
      }
    }
    expect(actions.submit).not.toHaveBeenCalled();
    expect(actions.saveContext).not.toHaveBeenCalled();
    expect(actions.chooseModel).not.toHaveBeenCalled();
    expect(actions.cycleThinking).not.toHaveBeenCalled();
  });

  it("preserves unsaved Context across page arrows, but Esc from Settings still discards it", () => {
    const { workspace, actions } = create(40, "dark", true);
    workspace.handleInput("\x1b[D"); // Preview -> Settings, wrapping left.
    workspace.handleInput(" ");
    workspace.handleInput("\t");
    workspace.handleInput("\x1b[B");
    const settings = workspace.render(100);
    for (const key of ["\x1b[C", "\x1b[D", "\x1b[D", "\x1b[D", "\x1b[C", "\x1b[C"]) workspace.handleInput(key);
    expect(workspace.render(100)).toEqual(settings);
    expect(textOf(settings)).toContain("Unsaved settings changes");
    expect(stripVTControlCharacters(textOf(settings))).toContain("› Thinking");
    expect(actions.saveContext).not.toHaveBeenCalled();
    workspace.handleInput("\x1b");
    workspace.handleInput("\x1b[D");
    expect(textOf(workspace.render(100))).not.toContain("Unsaved settings changes");
    workspace.handleInput("\t");
    workspace.handleInput("\t");
    expect(stripVTControlCharacters(textOf(workspace.render(100)))).toMatch(/Project instructions +Always/);
  });

  it("switches away from Usage with arrows and keeps Preview's reading state", () => {
    const { workspace, actions, panel } = create(40, "dark", true);
    const input = { draft: "Original", model: { provider: "p", id: "m" }, sessionId: "session", branchLeafId: "leaf", systemPrompt: "Policy", history: selectHistory([], 12, 100) };
    const records: RefineRecord[] = [{ id: 1, taskId: 1, kind: "refine", createdAt: 1, status: "generated", input,
      candidate: { ...input, requestId: 1, version: 1, generation: 0, text: "Historical candidate" } }];
    actions.history.mockReturnValue(records);
    panel.toggleSource();
    workspace.render(100);
    panel.scrollBy(20);
    const preview = workspace.render(100);
    workspace.handleInput("\x1b[C");
    workspace.handleInput("\x1b[B"); // Original root → model run.
    workspace.handleInput("\r");
    expect(textOf(workspace.render(100))).toContain("Historical candidate");
    workspace.handleInput("\x1b[C");
    expect(stripVTControlCharacters(workspace.render(100)[1]!)).toContain("Settings");
    workspace.handleInput("\x1b[C");
    expect(stripVTControlCharacters(textOf(workspace.render(100)))).toContain("› Model");
    workspace.handleInput("\x1b[C");
    expect(stripVTControlCharacters(textOf(workspace.render(100)))).toContain("› Draft character limit");
    workspace.handleInput("\x1b[C");
    expect(workspace.render(100)).toEqual(preview);
    expect(actions.submit).not.toHaveBeenCalled();
    expect(actions.saveContext).not.toHaveBeenCalled();
  });

  it.each(["dark", "light"])("bounds every top-level page and retains compact active tabs in %s", (name) => {
    for (const rows of [5, 8, 12, 16, 24, 40]) {
      for (const width of [1, 8, 12, 20, 40, 100]) {
        const { workspace } = create(rows, name, true);
        const openingHeight = workspace.render(width).length;
        for (const page of ["Usage", "Settings", "Settings", "Settings", "Preview"]) {
          workspace.handleInput("\x1b[C");
          const lines = workspace.render(width);
          expect(lines).toHaveLength(openingHeight);
          for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
          if (width >= 20 && rows >= 16) {
            const strip = lines.find((line) => line.includes(` ${page} `));
            expect(strip).toBeDefined();
          }
        }
      }
    }
  });

  it.each(["\r", " "])("cycles context without saving or moving rows using %j", (key) => {
    const { workspace, actions } = create(40, "dark", true);
    workspace.openSettings({ instructions: "first", tree: true, skills: false });
    const position = () => workspace.render(80).findIndex((line) => line.includes("Directory tree"));
    const originalPosition = position();
    for (const mode of ["Always", "Off", "First request only"]) {
      workspace.handleInput(key);
      expect(stripVTControlCharacters(textOf(workspace.render(80)))).toMatch(new RegExp(`› Project instructions +${mode}`));
      expect(position()).toBe(originalPosition);
      expect(actions.saveContext).not.toHaveBeenCalled();
    }
    workspace.handleInput("\x13");
    expect(actions.saveContext).toHaveBeenCalledWith({ instructions: "first", tree: true, skills: false });
  });

  it.each([
    ["Tab", "\t", "\t\t"],
    ["arrows", "\x1b[C", "\x1b[D"],
    ["Kitty arrows", "\x1b[1;1C", "\x1b[1;1D"],
  ])("switches groups with %s without applying pending context and remembers each selection", (_name, next, previous) => {
    const { workspace, actions } = create(40, "dark", true);
    workspace.openSettings();
    workspace.handleInput("\r");
    workspace.handleInput("\x1b[B");
    workspace.handleInput(next);
    expect(stripVTControlCharacters(textOf(workspace.render(100)))).toContain("› Model");
    workspace.handleInput("\x1b[B");
    if (previous === "\t\t") { workspace.handleInput("\t"); workspace.handleInput("\t"); }
    else workspace.handleInput(previous);
    expect(stripVTControlCharacters(textOf(workspace.render(100)))).toContain("› Directory tree");
    expect(textOf(workspace.render(100))).toContain("Unsaved settings changes");
    workspace.handleInput(next);
    expect(stripVTControlCharacters(textOf(workspace.render(100)))).toContain("› Thinking");
    expect(actions.saveContext).not.toHaveBeenCalled();
    expect(actions.cycleThinking).not.toHaveBeenCalled();
    expect(actions.chooseModel).not.toHaveBeenCalled();
  });

  it.each([8, 16, 40])("keeps the selected group row visible after arrow navigation at %i rows", (rows) => {
    const { workspace, theme } = create(rows, "dark", true);
    workspace.openSettings(undefined, 2);
    for (const width of [20, 40, 100]) {
      workspace.render(width);
      workspace.handleInput("\x1b[C");
      const optimizer = workspace.render(width);
      expect(stripVTControlCharacters(textOf(optimizer))).toContain("› Model");
      workspace.handleInput("\x1b[D");
      const context = workspace.render(width);
      expect(stripVTControlCharacters(textOf(context))).toContain(width < 40 ? "› Skill meta" : "› Skill metadata");
      for (const line of [...context, ...optimizer]) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      if (rows === 40 && width === 100) {
        expect(textOf(context)).toContain(formatKeyHint(["←", "Usage"], theme));
        expect(textOf(context)).toContain(formatKeyHint(["→", "Optimizer"], theme));
        expect(textOf(optimizer)).toContain(formatKeyHint(["←", "Context"], theme));
        expect(textOf(optimizer)).toContain(formatKeyHint(["→", "Advanced"], theme));
        expect(textOf(context)).toContain(theme.bg("toolPendingBg", theme.fg("text", theme.bold(" Context "))));
        expect(textOf(optimizer)).toContain(theme.bg("toolPendingBg", theme.fg("text", theme.bold(" Optimizer "))));
      }
    }
  });

  it("keeps page navigation at Settings group boundaries and when Optimizer is unavailable", () => {
    for (const optimizer of [false, true]) {
      const { workspace } = create(40, "dark", optimizer);
      workspace.openSettings();
      workspace.handleInput("\x1b[D");
      expect(stripVTControlCharacters(workspace.render(100)[1]!)).toContain("Usage · All rounds");
      workspace.handleInput("\x1b[C");
      expect(stripVTControlCharacters(textOf(workspace.render(100)))).toContain("› Project instructions");
      if (optimizer) {
        workspace.handleInput("\x1b[C");
        expect(stripVTControlCharacters(textOf(workspace.render(100)))).toContain("› Model");
      }
      workspace.handleInput("\x1b[C");
      expect(stripVTControlCharacters(textOf(workspace.render(100)))).toContain("› Draft character limit");
      workspace.handleInput("\x1b[C");
      expect(stripVTControlCharacters(workspace.render(100)[1]!)).toContain("Prompt refine");
    }
  });

  it("switches groups with arrows using cached frames without refreshing optimizer state", () => {
    const { workspace, actions, theme } = create(40, "dark", true);
    const optimizer = vi.spyOn(actions, "optimizer");
    workspace.openSettings();
    const context = workspace.render(100);
    workspace.handleInput("\x1b[C");
    const settings = workspace.render(100);
    const paint = vi.spyOn(theme, "fg");
    for (let i = 0; i < 3; i++) {
      workspace.handleInput("\x1b[D");
      expect(workspace.render(100)).toEqual(context);
      workspace.handleInput("\x1b[C");
      expect(workspace.render(100)).toEqual(settings);
    }
    expect(paint.mock.calls.filter(([color]) => color !== "borderMuted")).toEqual([]);
    expect(optimizer).toHaveBeenCalledOnce();
    paint.mockRestore();
    optimizer.mockRestore();
  });

  it("wraps up/down within the current group and restores the requested optimizer row", () => {
    const { workspace } = create(40, "dark", true);
    workspace.openSettings();
    workspace.handleInput("\x1b[A");
    expect(stripVTControlCharacters(textOf(workspace.render(100)))).toContain("› History characters");
    workspace.handleInput("\x1b[B");
    expect(stripVTControlCharacters(textOf(workspace.render(100)))).toContain("› Project instructions");
    workspace.openSettings(undefined, 5);
    expect(stripVTControlCharacters(textOf(workspace.render(100)))).toContain("› Optimization prompt");
    workspace.handleInput("\x1b[B");
    expect(stripVTControlCharacters(textOf(workspace.render(100)))).toContain("› Output token limit");
    workspace.openSettings(undefined, 11);
    workspace.handleInput("\x1b[B");
    expect(stripVTControlCharacters(textOf(workspace.render(100)))).toContain("› Model");
  });

  it("reuses settings frames without re-querying the optimizer on arrow input", () => {
    const { workspace, actions, theme } = create(40, "dark", true);
    const optimizer = vi.spyOn(actions, "optimizer");
    const paint = vi.spyOn(theme, "fg");
    workspace.openSettings();
    for (let i = 0; i < 7; i++) { workspace.render(100); workspace.handleInput("\x1b[B"); }
    paint.mockClear();
    for (let i = 0; i < 14; i++) { workspace.render(100); workspace.handleInput("\x1b[B"); }
    expect(paint.mock.calls.filter(([color]) => color !== "borderMuted")).toEqual([]);
    expect(optimizer).toHaveBeenCalledOnce();
    paint.mockRestore();
    optimizer.mockReturnValue({ model: "provider/updated-model", thinking: "low", thinkingEnabled: true });
    workspace.refreshSettings();
    workspace.handleInput("\t");
    expect(textOf(workspace.render(100))).toContain("provider/updated-model");
    workspace.handleInput("\t");
    workspace.handleInput("\t");
    workspace.handleInput(" ");
    expect(textOf(workspace.render(100))).toContain("Unsaved settings changes");
    expect(stripVTControlCharacters(textOf(workspace.render(100)))).toMatch(/Project instructions +Off/);
    optimizer.mockRestore();
  });

  it.each([80, 100])("only repaints focus and bounded explanations at %i columns", (width) => {
    const { workspace } = create(40, "dark", true);
    workspace.openSettings();
    let previous = workspace.render(width);
    for (let i = 0; i < 6; i++) {
      workspace.handleInput("\x1b[B");
      const current = workspace.render(width);
      expect(current.filter((line, index) => line !== previous[index]).length).toBeLessThanOrEqual(6);
      previous = current;
    }
  });

  it("refreshes cached settings after theme invalidation and viewport resize", () => {
    const { workspace, actions, theme } = create(40, "dark", true);
    workspace.openSettings();
    const before = workspace.render(100);
    actions.contextEnabled = () => false;
    workspace.refreshSettings();
    expect(textOf(workspace.render(100))).toContain("Project context is off");
    const paint = vi.spyOn(theme, "fg");
    workspace.invalidate();
    workspace.render(100);
    expect(paint).toHaveBeenCalled();
    paint.mockRestore();
    for (const line of workspace.render(40)) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    actions.contextEnabled = () => true;
    workspace.refreshSettings();
    expect(workspace.render(100)).toEqual(before);
  });
});
