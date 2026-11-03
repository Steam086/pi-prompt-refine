import { describe, expect, it, vi } from "vitest";
import { stripVTControlCharacters } from "node:util";
import { CURSOR_MARKER, getKeybindings, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { PreviewPanel, type PreviewOptions } from "../src/preview.js";
import { RefineWorkspace } from "../src/workspace.js";
import { panelLayout } from "../src/panel-layout.js";
import { formatKeyHint } from "../src/key-hints.js";

const options: PreviewOptions = {
  state: { phase: "ready", requestId: 1, pendingSend: false },
  candidateText: Array.from({ length: 80 }, (_, i) => `Result ${i}`).join("\n"),
  draft: "Original draft", contextLabel: "Draft only", elapsedSeconds: 0, openHint: "ctrl+\\", canRestore: false,
};

function create(rows = 40, themeName = "dark", optimizer = false) {
  const terminal = { rows, columns: 80 };
  const tui = { terminal, requestRender: vi.fn() } as unknown as TUI;
  const theme = getThemeByName(themeName)!;
  const panel = new PreviewPanel(options, theme, () => terminal.rows, () => tui.requestRender());
  const actions = {
    context: () => ({ instructions: "always" as const, tree: true, skills: false }), contextEnabled: () => true,
    ...(optimizer ? {
      optimizer: () => ({ model: "provider/long-model-identifier-with-extra-details", thinking: "high · Extension setting", thinkingEnabled: true }),
      chooseModel: vi.fn(), editSystemPrompt: vi.fn(), cycleThinking: vi.fn(async () => "Thinking level saved"),
    } : {}),
    saveContext: vi.fn(async () => "Context saved"),
    submit: vi.fn((_text: string): string | undefined => undefined),
    revision: vi.fn((): { key: string; submit(text: string): string | undefined } | undefined => undefined),
  };
  const workspace = new RefineWorkspace(panel, tui, theme, getKeybindings(), actions);
  workspace.focused = true;
  return { workspace, panel, terminal, actions, theme };
}

const textOf = (lines: string[]) => lines.join("\n");

describe("shared refine workspace", () => {
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
    expect(textOf(workspace.render(100))).toContain(formatKeyHint(["←/→", "Group"], theme));
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

  it("switches groups without applying pending context and remembers each selection", () => {
    const { workspace, actions } = create(40, "dark", true);
    workspace.openSettings();
    workspace.handleInput("\r");
    workspace.handleInput("\x1b[B");
    workspace.handleInput("\x1b[C");
    expect(stripVTControlCharacters(textOf(workspace.render(100)))).toContain("› Model");
    workspace.handleInput("\x1b[B");
    workspace.handleInput("\x1b[D");
    expect(stripVTControlCharacters(textOf(workspace.render(100)))).toContain("› Directory tree");
    expect(textOf(workspace.render(100))).toContain("Unsaved context changes");
    workspace.handleInput("\x1b[C");
    expect(stripVTControlCharacters(textOf(workspace.render(100)))).toContain("› Thinking");
    expect(actions.saveContext).not.toHaveBeenCalled();
    expect(actions.cycleThinking).not.toHaveBeenCalled();
    expect(actions.chooseModel).not.toHaveBeenCalled();
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
    expect(settings[4]).toContain(theme.bg("toolPendingBg", theme.fg("text", theme.bold(" Context "))));
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
    workspace.handleInput("\x1b[C");
    expect(textOf(workspace.render(100))).toContain("provider/updated-model");
    workspace.handleInput("\x1b[D");
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

  it("explains each group's save behavior and keeps dirty context visible in both", () => {
    const { workspace } = create(40, "dark", true);
    workspace.openSettings();
    expect(textOf(workspace.render(100))).toContain("Ctrl+S to save · Applies to future requests");
    workspace.handleInput("\x1b[C");
    expect(textOf(workspace.render(100))).toContain("Changes save on confirmation");
    workspace.handleInput("\x1b[D");
    workspace.handleInput(" ");
    for (let i = 0; i < 2; i++) {
      expect(textOf(workspace.render(100))).toContain("Unsaved context changes");
      expect(textOf(workspace.render(100))).toContain("Discard context changes");
      workspace.handleInput("\x1b[C");
    }
  });

  it("keeps disabled context warnings visible and omits unavailable groups", () => {
    const { workspace, actions } = create();
    actions.contextEnabled = () => false;
    workspace.openSettings();
    const before = workspace.render(100);
    expect(textOf(before)).toContain("Disabled by projectContext.enabled=false");
    expect(textOf(before)).not.toContain("Optimizer");
    workspace.handleInput("\x1b[C");
    workspace.handleInput("\x1b[D");
    expect(workspace.render(100)).toEqual(before);
  });

  it.each(["dark", "light"])("shares footer key styles with the reading and input pages in %s", (name) => {
    const { workspace, panel, theme } = create(40, name, true);
    const main = textOf(workspace.render(100));
    for (const hint of [["a", "Accept"], ["e", "Edit"], ["f", "Revise"], ["q", "Back"], ["?", "Help"]] as const) {
      expect(main).toContain(formatKeyHint(hint, theme));
    }
    panel.toggleHelp();
    expect(textOf(workspace.render(100))).toContain(formatKeyHint(["r", "Refine current draft (model call)"], theme));
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
        workspace.handleInput("\x1b[C");
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
    for (const [open, back] of [["\x1b[C", "\x1b"], ["i", "\x1b"]]) {
      workspace.handleInput(open!);
      workspace.render(80);
      workspace.handleInput(back!);
      expect(workspace.render(80)).toEqual(before);
    }
    panel.toggleOriginal();
    const original = workspace.render(80);
    workspace.handleInput("\x1b[C");
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

  it("does not let input arrows or action letters navigate or execute main actions", () => {
    const { workspace, actions } = create();
    workspace.handleInput("i");
    for (const key of ["i", "q", "r", "a", "s", "\x1b[D", "\x1b[C"]) expect(workspace.handleInput(key)).toBe(true);
    expect(textOf(workspace.render(80))).toContain("iqras");
    expect(actions.submit).not.toHaveBeenCalled();
    expect(actions.saveContext).not.toHaveBeenCalled();
  });

  it("expands bracketed paste exactly and preserves failed input for retry", () => {
    const { workspace, actions } = create();
    const draft = "  第一行\n\n" + "Long pasted text\n".repeat(20);
    actions.submit.mockReturnValueOnce("No model configured");
    workspace.handleInput("i");
    workspace.handleInput(`\x1b[200~${draft}\x1b[201~`);
    expect(actions.submit).not.toHaveBeenCalled();
    workspace.handleInput("\r");
    expect(actions.submit).toHaveBeenLastCalledWith(draft);
    expect(textOf(workspace.render(80))).toContain("No model configured");
    workspace.handleInput("\r");
    expect(actions.submit).toHaveBeenLastCalledWith(draft);
    expect(textOf(workspace.render(80))).toContain("Prompt refine");
  });

  it("keeps selected settings visible in a tiny viewport and retains their cursor", () => {
    const { workspace } = create(8);
    workspace.handleInput("\x1b[C");
    for (const label of ["Project instructions: Always", "Directory tree: [x] On", "Skill metadata: [ ] Off"]) {
      expect(stripVTControlCharacters(textOf(workspace.render(40)))).toContain(`› ${label}`);
      workspace.handleInput("\x1b[B");
    }
    workspace.handleInput("\x1b[B");
    workspace.handleInput("q");
    workspace.handleInput("\x1b[C");
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
    if (cursor >= 3) workspace.handleInput("\x1b[C");
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
    expect(textOf(workspace.render(100))).not.toContain("Ctrl+S to save");
    workspace.openSettings();
    expect(stripVTControlCharacters(textOf(workspace.render(100)))).toMatch(/› Project instructions +Always/);
    expect(textOf(workspace.render(100))).not.toContain("Unsaved context changes");
    expect(actions.saveContext).not.toHaveBeenCalled();
  });

  it.each([8, 12, 40])("retains context selections and visible save errors for retry at %i rows", async (rows) => {
    const { workspace, actions } = create(rows);
    actions.saveContext.mockRejectedValueOnce(new Error("write failed"));
    workspace.openSettings();
    workspace.handleInput("\r");
    workspace.handleInput("\x13");
    await vi.waitFor(() => expect(textOf(workspace.render(100))).toContain("Could not save context"));
    expect(stripVTControlCharacters(textOf(workspace.render(100)))).toMatch(/› Project instructions +Off/);
    workspace.handleInput("\x13");
    await vi.waitFor(() => expect(actions.saveContext).toHaveBeenCalledTimes(2));
    expect(actions.saveContext).toHaveBeenLastCalledWith({ instructions: "off", tree: true, skills: false });
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
    for (const key of ["\r", " ", "\x1b[C", "\x1b[Z"]) workspace.handleInput(key);
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
    workspace.handleInput("\x1b[C");
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
