import { describe, expect, it, vi } from "vitest";
import { stripVTControlCharacters } from "node:util";
import { CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { PreviewPanel, type PreviewOptions } from "../src/preview.js";
import { RefineWorkspace } from "../src/workspace.js";
import { panelLayout } from "../src/panel-layout.js";
import { formatKeyHint } from "../src/key-hints.js";
import type { RefineRecord } from "../src/history.js";
import { selectHistory } from "../src/context.js";

const options: PreviewOptions = {
  state: { phase: "ready", requestId: 1, pendingSend: false },
  candidateText: Array.from({ length: 80 }, (_, i) => `Result ${i}`).join("\n"),
  draft: "Original draft", contextLabel: "Draft only", elapsedSeconds: 0, openHint: "ctrl+\\", canRestore: false,
};

function create(rows = 40, themeName = "dark", optimizer = false, inputText = "") {
  const terminal = { rows, columns: 80 };
  const tui = { terminal, requestRender: vi.fn() } as unknown as TUI;
  const theme = getThemeByName(themeName)!;
  const panel = new PreviewPanel(options, theme, () => terminal.rows, () => tui.requestRender());
  const actions = {
    inputDraft: { text: inputText, save: vi.fn() },
    history: vi.fn((): RefineRecord[] => []),
    context: () => ({ instructions: "always" as const, tree: true, skills: false }), contextEnabled: () => true,
    ...(optimizer ? {
      optimizer: () => ({ model: "provider/long-model-identifier-with-extra-details", thinking: "high · Extension setting", thinkingEnabled: true }),
      chooseModel: vi.fn(), editSystemPrompt: vi.fn(), cycleThinking: vi.fn(async () => "Thinking level saved"),
    } : {}),
    saveContext: vi.fn(async () => "Context saved"),
    submit: vi.fn((_text: string): string | undefined => undefined),
    revision: vi.fn((): { key: string; submit(text: string): string | undefined } | undefined => undefined),
  };
  const keys = new KeybindingsManager({
    ...TUI_KEYBINDINGS,
    "app.thinking.cycle": { defaultKeys: "shift+tab", description: "Cycle thinking level" },
  });
  const workspace = new RefineWorkspace(panel, tui, theme, keys, actions);
  workspace.focused = true;
  return { workspace, panel, terminal, actions, theme };
}

const textOf = (lines: string[]) => lines.join("\n");

describe("shared refine workspace", () => {
  it.each(["dark", "light"])("cycles pages and Settings groups in both directions with shared chrome in %s", (name) => {
    const { workspace, actions, theme } = create(40, name, true);
    const height = workspace.render(100).length;
    for (const [key, pages] of [
      ["\x1b[C", ["Usage", "Settings", "Settings", "Preview"]],
      ["\x1b[D", ["Settings", "Settings", "Usage", "Preview"]],
    ] as const) {
      for (const page of pages) {
        expect(workspace.handleInput(key)).toBe(true);
        const lines = workspace.render(100);
        expect(lines).toHaveLength(height);
        const strip = lines[4]!;
        expect(strip).toContain(theme.bg("toolPendingBg", theme.fg("text", theme.bold(` ${page} `))));
        for (const label of ["Preview", "Usage", "Settings", "←", "→"]) expect(strip).toContain(label);
        expect(strip).not.toMatch(/h History|u Usage|→ Settings/);
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
    for (let i = 0; i < 3; i++) workspace.handleInput("\x1b[C");
    expect(workspace.render(100)).toEqual(settings);
    expect(textOf(settings)).toContain("Unsaved context changes");
    expect(stripVTControlCharacters(textOf(settings))).toContain("› Thinking");
    expect(actions.saveContext).not.toHaveBeenCalled();
    workspace.handleInput("\x1b");
    workspace.handleInput("\x1b[D");
    expect(textOf(workspace.render(100))).not.toContain("Unsaved context changes");
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
    expect(workspace.render(100)).toEqual(preview);
    expect(actions.submit).not.toHaveBeenCalled();
    expect(actions.saveContext).not.toHaveBeenCalled();
  });

  it.each(["dark", "light"])("bounds every top-level page and retains compact active tabs in %s", (name) => {
    for (const rows of [5, 8, 12, 16, 24, 40]) {
      for (const width of [1, 8, 12, 20, 40, 100]) {
        const { workspace } = create(rows, name, true);
        for (const page of ["Usage", "Settings", "Settings", "Preview"]) {
          workspace.handleInput("\x1b[C");
          const lines = workspace.render(width);
          expect(lines).toHaveLength(panelLayout(width, rows).height);
          for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
          if (width >= 20 && rows >= 16) {
            const strip = lines.map(stripVTControlCharacters).find((line) => line.includes("←") && line.includes(page));
            expect(strip).toBeDefined();
          }
        }
      }
    }
  });

  it.each([20, 40, 80])("keeps instruction values readable at %i columns", (width) => {
    const { workspace } = create();
    for (const [instructions, value] of [["first", "First"], ["always", "Always"], ["off", "Off"]] as const) {
      workspace.openSettings({ instructions, tree: true, skills: false });
      const selected = workspace.render(width).map(stripVTControlCharacters).find((line) => line.includes("› "));
      expect(selected).toContain(value);
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

  it.each(["dark", "light"])("renders aligned columns, group tabs and full row focus in %s", (name) => {
    const { workspace, theme } = create(40, name, true);
    workspace.openSettings();
    const rendered = workspace.render(100);
    const lines = rendered.map(stripVTControlCharacters);
    expect(rendered[1]).toContain(theme.fg("text", theme.bold("Settings")));
    expect(textOf(rendered)).toContain(theme.bg("toolPendingBg", theme.fg("text", theme.bold(" Context "))));
    const rules = lines.find((line) => line.includes("Project instructions"))!;
    const tree = lines.find((line) => line.includes("Directory tree"))!;
    const skills = lines.find((line) => line.includes("Skill metadata"))!;
    expect(rules.indexOf("Always")).toBe(tree.indexOf("[x] On"));
    expect(tree.indexOf("[x] On")).toBe(skills.indexOf("[ ] Off"));
    expect(rules.indexOf("Include rules")).toBe(tree.indexOf("Include the default"));
    expect(tree.indexOf("Include the default")).toBe(skills.indexOf("Include skill"));
    expect(textOf(lines)).not.toContain("Model");
    const before = lines.findIndex((line) => line.includes("Directory tree"));
    workspace.handleInput("\x1b[B");
    expect(workspace.render(100).findIndex((line) => line.includes("Directory tree"))).toBe(before);
    expect(textOf(workspace.render(100))).toContain(formatKeyHint(["Tab", "Group"], theme));
  });

  it.each(["dark", "light"])("keeps a continuous highlight around clipped Unicode values in %s", (name) => {
    const { workspace, actions, theme } = create(40, name, true);
    actions.optimizer = () => ({ model: "provider/中文😀é".repeat(12), thinking: "high", thinkingEnabled: true });
    workspace.openSettings(undefined, 3);
    for (const width of [40, 80, 100]) {
      const row = workspace.render(width).find((line) => stripVTControlCharacters(line).includes("› Model"))!;
      expect(row).toContain("…");
      expect(row).not.toContain("\x1b[0m");
      expect(row).toContain(theme.bg("selectedBg", "").split("\x1b[49m")[0]);
      expect(visibleWidth(row)).toBe(panelLayout(width, 40).innerWidth + panelLayout(width, 40).inset);
    }
  });

  it.each([
    ["Tab", "\t", "\t"],
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
    workspace.handleInput(previous);
    expect(stripVTControlCharacters(textOf(workspace.render(100)))).toContain("› Directory tree");
    expect(textOf(workspace.render(100))).toContain("Unsaved context changes");
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
      expect(stripVTControlCharacters(textOf(context))).toContain(width < 40 ? "› Skill metadat…" : "› Skill metadata");
      for (const line of [...context, ...optimizer]) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      if (rows === 40 && width === 100) {
        expect(textOf(context)).toContain(formatKeyHint(["←", "Usage"], theme));
        expect(textOf(context)).toContain(formatKeyHint(["→", "Optimizer"], theme));
        expect(textOf(optimizer)).toContain(formatKeyHint(["←", "Context"], theme));
        expect(textOf(optimizer)).toContain(formatKeyHint(["→", "Preview"], theme));
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
      expect(stripVTControlCharacters(workspace.render(100)[1]!)).toBe("  Usage · All rounds");
      workspace.handleInput("\x1b[C");
      expect(stripVTControlCharacters(textOf(workspace.render(100)))).toContain("› Project instructions");
      if (optimizer) {
        workspace.handleInput("\x1b[C");
        expect(stripVTControlCharacters(textOf(workspace.render(100)))).toContain("› Model");
      }
      workspace.handleInput("\x1b[C");
      expect(stripVTControlCharacters(workspace.render(100)[1]!)).toBe("  Prompt refine");
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
    expect(paint).not.toHaveBeenCalled();
    expect(optimizer).toHaveBeenCalledOnce();
    paint.mockRestore();
    optimizer.mockRestore();
  });

  it("wraps up/down within the current group and restores the requested optimizer row", () => {
    const { workspace } = create(40, "dark", true);
    workspace.openSettings();
    workspace.handleInput("\x1b[A");
    expect(stripVTControlCharacters(textOf(workspace.render(100)))).toContain("› Skill metadata");
    workspace.handleInput("\x1b[B");
    expect(stripVTControlCharacters(textOf(workspace.render(100)))).toContain("› Project instructions");
    workspace.openSettings(undefined, 5);
    expect(stripVTControlCharacters(textOf(workspace.render(100)))).toContain("› Optimization prompt");
    workspace.handleInput("\x1b[B");
    expect(stripVTControlCharacters(textOf(workspace.render(100)))).toContain("› Model");
  });

  it.each(["dark", "light"])("shares title, group strip and key styles between Main and Settings in %s", (name) => {
    const { workspace, theme } = create(40, name, true);
    const main = workspace.render(100);
    workspace.openSettings();
    const settings = workspace.render(100);
    expect(main[1]).toContain(theme.fg("text", theme.bold("Prompt refine")));
    expect(settings[1]).toContain(theme.fg("text", theme.bold("Settings")));
    expect(main[4]).toContain(theme.bg("toolPendingBg", theme.fg("text", theme.bold(" Preview "))));
    expect(settings[4]).toContain(theme.bg("toolPendingBg", theme.fg("text", theme.bold(" Settings "))));
    expect(textOf(settings)).toContain(theme.bg("toolPendingBg", theme.fg("text", theme.bold(" Context "))));
    expect(main.at(-2)).toContain(formatKeyHint(["a", "Accept"], theme));
    expect(settings.at(-2)).toContain(formatKeyHint(["Enter", "Change"], theme));
    expect(main).toHaveLength(settings.length);
  });

  it("reuses settings frames without re-querying the optimizer on arrow input", () => {
    const { workspace, actions, theme } = create(40, "dark", true);
    const optimizer = vi.spyOn(actions, "optimizer");
    const paint = vi.spyOn(theme, "fg");
    workspace.openSettings();
    for (let i = 0; i < 3; i++) { workspace.render(100); workspace.handleInput("\x1b[B"); }
    paint.mockClear();
    for (let i = 0; i < 12; i++) { workspace.render(100); workspace.handleInput("\x1b[B"); }
    expect(paint).not.toHaveBeenCalled();
    expect(optimizer).toHaveBeenCalledOnce();
    paint.mockRestore();
    optimizer.mockReturnValue({ model: "provider/updated-model", thinking: "low", thinkingEnabled: true });
    workspace.refreshSettings();
    workspace.handleInput("\t");
    expect(textOf(workspace.render(100))).toContain("provider/updated-model");
    workspace.handleInput("\t");
    workspace.handleInput(" ");
    expect(textOf(workspace.render(100))).toContain("Unsaved context changes");
    expect(stripVTControlCharacters(textOf(workspace.render(100)))).toMatch(/Project instructions +Off/);
    optimizer.mockRestore();
  });

  it.each([80, 100])("only changes the old and new context focus rows at %i columns", (width) => {
    const { workspace } = create(40, "dark", true);
    workspace.openSettings();
    let previous = workspace.render(width);
    for (let i = 0; i < 6; i++) {
      workspace.handleInput("\x1b[B");
      const current = workspace.render(width);
      expect(current.filter((line, index) => line !== previous[index])).toHaveLength(2);
      previous = current;
    }
  });

  it("refreshes cached settings after theme invalidation and viewport resize", () => {
    const { workspace, actions, theme } = create(40, "dark", true);
    workspace.openSettings();
    const before = workspace.render(100);
    actions.contextEnabled = () => false;
    workspace.refreshSettings();
    expect(textOf(workspace.render(100))).toContain("Disabled by projectContext.enabled=false");
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

  it.each(["dark", "light"])("keeps optimizer values and detail bounded across widths in %s", (theme) => {
    for (const rows of [8, 16, 24, 40]) {
      for (const width of [12, 20, 40, 80, 160]) {
        const { workspace } = create(rows, theme, true);
        workspace.openSettings({ instructions: "off", tree: true, skills: false }, 3);
        for (const cursor of [3, 4]) {
          if (cursor === 4) workspace.handleInput("\x1b[B");
          const lines = workspace.render(width);
          expect(lines).toHaveLength(panelLayout(width, rows).height);
          for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(Math.min(width, 100));
          if (width >= 20) expect(textOf(lines)).toContain(cursor === 3 ? "Model" : "Thinking");
        }
      }
    }
  });

  it("shows a full model value below the table and keeps long rows fixed", () => {
    const { workspace } = create(40, "dark", true);
    workspace.openSettings(undefined, 3);
    expect(workspace.render(100).at(-5)).toContain("Model: provider/long-model-identifier-with-extra-details");
    const lines = workspace.render(40).map(stripVTControlCharacters);
    const model = lines.findIndex((line) => line.includes("› Model:"));
    expect(lines[model]).toContain("…");
    expect(lines[model]?.trimEnd()).toMatch(/›$/);
    expect(lines[model + 1]).toContain("Thinking:");
    workspace.handleInput("\x1b[B");
    expect(workspace.render(40).findIndex((line) => line.includes("Model:"))).toBe(model);
  });

  it.each(["dark", "light"])("keeps the Settings hint stable across groups and widths in %s", (name) => {
    const { workspace, theme } = create(40, name, true);
    workspace.openSettings();
    for (const width of [20, 40, 100]) {
      const header = workspace.render(width).slice(0, 3);
      if (width >= 40) expect(header[2]).toBe("  " + theme.fg("muted", "Applies to future requests"));
      for (const key of ["\x1b[C", "\x1b[D", "\t", "\t"]) {
        workspace.handleInput(key);
        const lines = workspace.render(width);
        expect(lines.slice(0, 3)).toEqual(header);
        expect(textOf(lines)).not.toMatch(/Ctrl\+S to save|Changes save on confirmation/);
        if (width === 100) expect(textOf(lines)).toContain(formatKeyHint(["Ctrl+S", "Save context"], theme));
      }
    }
    workspace.handleInput(" ");
    for (const key of ["\x1b[C", "\x1b[D", "\t", "\t"]) {
      workspace.handleInput(key);
      const lines = workspace.render(100);
      expect(lines[2]).toBe("  " + theme.fg("warning", "Unsaved context changes"));
      expect(textOf(lines)).not.toContain("Applies to future requests");
      expect(textOf(lines)).toContain("Discard context changes");
    }
  });

  it.each([0, 3])("aligns Settings action and navigation rows at cursor %i", (cursor) => {
    const { workspace } = create(40, "dark", true);
    workspace.openSettings(undefined, cursor);
    const [top, bottom] = workspace.render(100).slice(-2).map((line) => stripVTControlCharacters(line).trim());
    expect(top).toBe(`Ctrl+S Save context · Enter Change${cursor === 0 ? " · Space Change" : ""}`);
    expect(bottom!.split(" · ")).toEqual([
      "Esc Back".padEnd(19), "Tab Group".padEnd(12),
      cursor === 0 ? "← Usage".padEnd(12) : "← Context",
      cursor === 0 ? "→ Optimizer" : "→ Preview", "↑↓ Select",
    ]);
  });

  it.each(["dark", "light"])("aligns Settings footers across groups, dirty/disabled states and resize in %s", (name) => {
    const starts = (line: string) => {
      let column = 0;
      return line.split(" · ").map((cell) => {
        const start = column;
        column += visibleWidth(cell) + 3;
        return start;
      });
    };
    for (const optimizer of [false, true]) {
      const { workspace, actions, theme } = create(40, name, optimizer);
      if (optimizer) actions.optimizer = () => ({ model: "Not configured", thinking: "Unavailable", thinkingEnabled: false });
      for (const dirty of [false, true]) for (const cursor of optimizer ? [0, 3, 4, 5] : [0, 1, 2]) {
        workspace.openSettings({ ...actions.context(), tree: !dirty }, cursor);
        for (const width of [34, 40, 60, 80, 100, 160]) {
          const lines = workspace.render(width);
          const footer = lines.slice(-2);
          const [top, bottom] = footer.map(stripVTControlCharacters);
          const count = Math.min(starts(top!).length, starts(bottom!).length);
          expect(starts(top!).slice(0, count)).toEqual(starts(bottom!).slice(0, count));
          expect(top).toContain("Ctrl+S Save context");
          expect(bottom).toContain(dirty ? "Esc Discard context changes" : "Esc Back");
          expect(footer[0]).toContain(formatKeyHint(["Ctrl+S", "Save context"], theme));
          expect(footer[1]).toContain(formatKeyHint(["Esc", dirty ? "Discard context changes" : "Back"], theme));
          expect(footer.join("\n")).not.toContain("\t");
          expect(lines).toHaveLength(panelLayout(width, 40).height);
          for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(Math.min(width, 100));
          if (width >= 100) {
            expect(top).toContain(`Enter ${cursor === 4 ? "Unavailable" : "Change"}`);
            expect(top!.includes("Space Change")).toBe(cursor < 3);
            expect(bottom!.includes("Tab Group")).toBe(optimizer);
            expect(bottom).toContain(optimizer && cursor >= 3 ? "← Context" : "← Usage");
            expect(bottom).toContain(optimizer && cursor < 3 ? "→ Optimizer" : "→ Preview");
          }
          // Cache hits must retain the aligned frame unchanged.
          expect(workspace.render(width)).toEqual(lines);
        }
      }
      expect(actions.saveContext).not.toHaveBeenCalled();
      expect(actions.submit).not.toHaveBeenCalled();
    }
  });

  it("preserves compact and single-line Settings footer fallbacks", () => {
    const { workspace, terminal } = create(40, "dark", true);
    for (const cursor of [0, 3]) {
      workspace.openSettings(undefined, cursor);
      for (const width of [12, 20, 24, 30]) {
        const footer = workspace.render(width).slice(-2).map(stripVTControlCharacters);
        expect(footer[0]).toContain("^S Context");
        expect(footer[1]).toContain("Esc Back");
        for (const line of footer) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
      workspace.openSettings({ instructions: "always", tree: false, skills: false }, cursor);
      expect(stripVTControlCharacters(workspace.render(24).at(-1)!)).toContain("Esc Discard context");
    }
    terminal.rows = 8;
    expect(stripVTControlCharacters(workspace.render(100).at(-1)!).trim()).toBe("^S Context · Esc Discard context · ↵ Change");
    workspace.openSettings();
    expect(stripVTControlCharacters(workspace.render(100).at(-1)!).trim()).toBe("^S Context · Esc Back · ↵ Change");
    expect(stripVTControlCharacters(workspace.render(12).at(-1)!).trim()).toBe("^S Context");
  });

  it("keeps disabled context warnings visible and omits unavailable groups", () => {
    const { workspace, actions } = create();
    actions.contextEnabled = () => false;
    workspace.openSettings();
    const before = workspace.render(100);
    expect(textOf(before)).toContain("Disabled by projectContext.enabled=false");
    expect(textOf(before)).not.toContain("Optimizer");
    workspace.handleInput("\t");
    expect(workspace.render(100)).toEqual(before);
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
    expect(textOf(workspace.render(100))).toContain(formatKeyHint(["Ctrl+S", "Save context"], theme));
    workspace.handleInput("q");
    workspace.handleInput("i");
    expect(textOf(workspace.render(100))).toContain(formatKeyHint(["Enter", "Refine"], theme));
  });

  it.each([[24, 16], [32, 21], [40, 24], [60, 24]])("budgets %i terminal rows as %i panel rows", (rows, height) => {
    expect(panelLayout(80, rows).height).toBe(height);
    expect(panelLayout(80, rows).bodyHeight).toBe(height - 6);
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
          for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(Math.min(width, 100));
        }
        expect(textOf(input)).toContain(CURSOR_MARKER);
        expect(terminal.rows).toBe(rows); // Editor facade must not mutate the host.
        if (width >= 40 && rows >= 16) {
          expect(stripVTControlCharacters(textOf(input))).toContain("Esc Back");
          expect(stripVTControlCharacters(textOf(input))).toContain("Enter Refine");
          expect(stripVTControlCharacters(textOf(context))).toContain("Ctrl+S Save context");
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
    expect(textOf(workspace.render(100))).toContain(formatKeyHint(["Enter", "Revise"], theme));
    workspace.handleInput("\r");
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

  it("keeps selected settings visible in a tiny viewport and retains their cursor", () => {
    const { workspace } = create(8);
    workspace.handleInput("\x1b[D");
    for (const label of ["Project instructions: Always", "Directory tree: [x] On", "Skill metadata: [ ] Off"]) {
      expect(stripVTControlCharacters(textOf(workspace.render(40)))).toContain(`› ${label}`);
      workspace.handleInput("\x1b[B");
    }
    workspace.handleInput("\x1b[B");
    workspace.handleInput("q");
    workspace.handleInput("\x1b[D");
    expect(stripVTControlCharacters(textOf(workspace.render(40)))).toContain("› Directory tree: [x] On");
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

  it.each([0, 1, 2, 3, 4, 5])("saves context with the same shortcut at cursor %i", async (cursor) => {
    const { workspace, actions } = create(40, "dark", true);
    workspace.openSettings();
    workspace.handleInput("\r");
    expect(actions.saveContext).not.toHaveBeenCalled();
    expect(stripVTControlCharacters(textOf(workspace.render(100)))).toMatch(/› Project instructions +Off/);
    if (cursor >= 3) workspace.handleInput("\t");
    for (let i = 0; i < cursor % 3; i++) workspace.handleInput("\x1b[B");
    expect(textOf(workspace.render(100))).toContain("Ctrl+S");
    workspace.handleInput("\x13");
    expect(actions.saveContext).toHaveBeenCalledExactlyOnceWith({ instructions: "off", tree: true, skills: false });
    expect(actions.chooseModel).not.toHaveBeenCalled();
    expect(actions.cycleThinking).not.toHaveBeenCalled();
    expect(actions.editSystemPrompt).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(textOf(workspace.render(100))).toContain("Context saved"));
  });

  it.each(["\x1b", "q", "\x1c"])("discards only pending context when returning with %j", (key) => {
    const { workspace, actions } = create(40, "dark", true);
    workspace.openSettings();
    workspace.handleInput("\r");
    workspace.handleInput(key);
    expect(stripVTControlCharacters(workspace.render(100)[1]!)).toBe("  Prompt refine");
    workspace.openSettings();
    expect(stripVTControlCharacters(textOf(workspace.render(100)))).toMatch(/› Project instructions +Always/);
    expect(textOf(workspace.render(100))).not.toContain("Unsaved context changes");
    expect(actions.saveContext).not.toHaveBeenCalled();
  });

  it.each([8, 12, 40])("retains context selections and visible save errors for retry at %i rows", async (rows) => {
    const { workspace, actions } = create(rows, "dark", true);
    actions.saveContext.mockRejectedValueOnce(new Error("write failed"));
    workspace.openSettings();
    workspace.handleInput("\r");
    workspace.handleInput("\x13");
    await vi.waitFor(() => expect(textOf(workspace.render(100))).toContain("Could not save context"));
    for (const key of ["\x1b[C", "\x1b[D"]) {
      workspace.handleInput(key);
      const text = textOf(workspace.render(100));
      expect(text).toContain("Could not save context");
      expect(text).toContain("Unsaved context changes");
      expect(text).not.toContain("Applies to future requests");
    }
    expect(stripVTControlCharacters(textOf(workspace.render(100)))).toMatch(/› Project instructions +Off/);
    workspace.handleInput("\x13");
    await vi.waitFor(() => expect(actions.saveContext).toHaveBeenCalledTimes(2));
    expect(actions.saveContext).toHaveBeenLastCalledWith({ instructions: "off", tree: true, skills: false });
  });

  it("keeps Shift+Tab for thinking and blocks group/page navigation while saving", async () => {
    const { workspace, actions } = create(40, "dark", true);
    let resolve!: (notice: string) => void;
    actions.cycleThinking!.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    workspace.openSettings();
    workspace.handleInput("\x1b[C");
    workspace.handleInput("\x1b[Z");
    expect(actions.cycleThinking).toHaveBeenCalledOnce();
    const saving = workspace.render(100);
    expect(stripVTControlCharacters(textOf(saving))).toContain("› Model");
    expect(textOf(saving)).toContain("Saving...");
    expect(textOf(saving)).not.toContain("Applies to future requests");
    for (const key of ["\x1b[D", "\x1b[C", "\t"]) {
      workspace.handleInput(key);
      expect(workspace.render(100)).toEqual(saving);
    }
    resolve("Thinking level saved");
    await vi.waitFor(() => expect(textOf(workspace.render(100))).toContain("Thinking level saved"));
    const status = workspace.render(100)[2];
    expect(status).not.toContain("Applies to future requests");
    workspace.handleInput("\x1b[D");
    expect(workspace.render(100)[2]).toBe(status);
    expect(stripVTControlCharacters(textOf(workspace.render(100)))).toContain("› Project instructions");
    expect(actions.saveContext).not.toHaveBeenCalled();
    expect(actions.chooseModel).not.toHaveBeenCalled();
    expect(actions.editSystemPrompt).not.toHaveBeenCalled();
  });

  it("keeps thinking save feedback visible above a short viewport", async () => {
    const { workspace } = create(12, "dark", true);
    workspace.openSettings(undefined, 4);
    workspace.handleInput("\r");
    await vi.waitFor(() => expect(textOf(workspace.render(80))).toContain("Thinking level saved"));
  });

  it("renders disabled thinking without offering or executing a change", () => {
    const { workspace, actions, theme } = create(40, "dark", true);
    actions.optimizer = () => ({ model: "Not configured", thinking: "Unavailable — select model first", thinkingEnabled: false });
    workspace.openSettings(undefined, 4);
    const output = textOf(workspace.render(100));
    expect(stripVTControlCharacters(output)).toContain("Unavailable — select model first");
    expect(output).toContain(theme.fg("dim", "Thinking              "));
    expect(output).toContain("Enter");
    expect(output).not.toContain("Cycle");
    for (const key of ["\r", " ", "\x1b[Z"]) workspace.handleInput(key);
    expect(actions.cycleThinking).not.toHaveBeenCalled();
    expect(actions.saveContext).not.toHaveBeenCalled();
  });

  it.each(["dark", "light"])("highlights one full-width focus row in %s", (name) => {
    const { workspace, theme } = create(40, name, true);
    workspace.openSettings();
    const bg = vi.spyOn(theme, "bg");
    workspace.render(100);
    const focus = bg.mock.calls.filter(([color]) => color === "selectedBg");
    expect(focus).toHaveLength(1);
    expect(visibleWidth(focus[0]![1])).toBe(panelLayout(100, 40).innerWidth);
    bg.mockRestore();
  });

  it("keeps the focused context option and its explanation together on short screens", () => {
    const { workspace } = create(12, "dark", true);
    workspace.openSettings(undefined, 2);
    const output = stripVTControlCharacters(textOf(workspace.render(80)));
    expect(output).toContain("› Skill metadata");
    expect(output).toContain("Include skill descriptions; never run skills.");
  });

  it("ignores late save completion and stale input after disposal", async () => {
    const { workspace, actions } = create();
    let resolve!: (notice: string) => void;
    actions.saveContext.mockImplementation(() => new Promise((done) => { resolve = done; }));
    workspace.handleInput("\x1b[D");
    workspace.handleInput(" ");
    expect(textOf(workspace.render(80))).toContain("Unsaved context changes");
    workspace.handleInput("\x13");
    workspace.handleInput("\x13");
    expect(actions.saveContext).toHaveBeenCalledTimes(1);
    workspace.dispose();
    resolve("saved");
    await Promise.resolve();
    expect(textOf(workspace.render(80))).toContain("Settings");
    workspace.handleInput("i");
    workspace.handleInput("\r");
    expect(actions.submit).not.toHaveBeenCalled();
  });
});
