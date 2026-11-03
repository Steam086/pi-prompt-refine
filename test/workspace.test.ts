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
    context: () => [true, true, false], contextEnabled: () => true,
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
  it.each(["dark", "light"])("keeps optimizer settings readable across widths in %s", (theme) => {
    for (const rows of [8, 16, 24, 40]) {
      for (const width of [12, 20, 40, 80, 160]) {
        const { workspace } = create(rows, theme, true);
        workspace.openSettings([false, true, false], 3);
        for (const cursor of [3, 4]) {
          if (cursor === 4) workspace.handleInput("\x1b[B");
          const lines = workspace.render(width);
          expect(lines).toHaveLength(panelLayout(width, rows).height);
          for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(Math.min(width, 100));
          if (width >= 20) expect(textOf(lines)).toContain(cursor === 3 ? "Model:" : "Thinking");
        }
      }
    }
  });

  it("keeps tab positions fixed and distinguishes the active page from row focus", () => {
    const { workspace } = create();
    const theme = getThemeByName("dark")!;
    const main = textOf(workspace.render(80));
    workspace.handleInput("\x1b[C");
    const settings = textOf(workspace.render(80));
    for (const output of [main, settings]) {
      const navigation = stripVTControlCharacters(output.split("\n")[1]!);
      expect(navigation).toContain("Prompt refine");
      expect(navigation).toContain("Settings");
      expect(navigation).not.toMatch(/[\[\]]/);
    }
    expect(main).toContain(theme.fg("accent", theme.underline(theme.bold("Prompt refine"))));
    expect(settings).toContain(theme.fg("accent", theme.underline(theme.bold("Settings"))));
    expect(settings.split("\n")[1]).not.toContain("›");
    expect(settings.split("\n")[1]).not.toContain(theme.bg("selectedBg", "Settings"));
    workspace.handleInput("\x1b[D");
    expect(workspace.render(80)[1]).toBe(main.split("\n")[1]);
  });
  it("prioritizes the active page label in narrow terminals", () => {
    const { workspace } = create();
    expect(workspace.render(20)[1]).toContain("Prompt refine");
    workspace.openSettings();
    expect(workspace.render(20)[1]).toContain("Settings");
  });

  it.each(["dark", "light"])("separates optimizer labels, values and selection in %s", (name) => {
    const { workspace, theme } = create(40, name, true);
    workspace.openSettings([true, true, false], 4);
    const bold = vi.spyOn(theme, "bold");
    const lines = workspace.render(100);
    const boldCalls = bold.mock.calls.map(([text]) => text);
    bold.mockRestore();
    const thinking = lines.find((line) => line.includes("Thinking:"))!;
    expect(thinking).toContain(theme.fg("muted", "Thinking:"));
    expect(thinking).toContain(theme.fg("text", "high · Extension setting"));
    expect(thinking).toContain(theme.fg("accent", "› "));
    expect(boldCalls).toEqual(["Settings", "Context", "Optimizer", "Ctrl+S", "Enter", "Esc", "↑↓"]);
    expect(textOf(lines)).not.toContain("Change");
    const model = lines.find((line) => line.includes("Model:"))!;
    expect(model).toContain(theme.fg("muted", "Model:"));
    expect(model).toContain(theme.fg("text", "provider/long-model-identifier-with-extra-details"));
    expect(lines.join("\n")).toContain(theme.bold("Optimizer"));
    expect(lines.join("\n")).not.toContain("Auto-save on change/confirmation");
    expect(lines.join("\n")).not.toContain("Optimizer only · Main session unchanged");
  });

  it.each([false, true])("labels manual context saving separately from optimizer auto-save (optimizer: %s)", (optimizer) => {
    const { workspace } = create(40, "dark", optimizer);
    workspace.openSettings();
    const lines = workspace.render(100).map(stripVTControlCharacters);
    expect(lines[2]?.trim()).toBe("");
    const content = lines.slice(0, -2).join("\n");
    expect(content).toContain("Context");
    expect(content).toContain("Manual save · Next refinement only");
    expect(lines.slice(-2).join("\n")).toContain("Ctrl+S Save context");
    expect(lines.slice(-2).join("\n")).toContain("Enter Toggle");
    workspace.handleInput(" ");
    expect(textOf(workspace.render(100))).toContain("Unsaved context changes");
    expect(textOf(workspace.render(100))).toContain("Discard context changes");
    expect(textOf(workspace.render(100))).not.toContain("Back (discard)");
  });

  it.each(["dark", "light"])("shares footer key and description styles across all pages in %s", (name) => {
    const { workspace, panel, theme } = create(40, name, true);
    expect(textOf(workspace.render(100))).toContain(formatKeyHint(["q", "Back"], theme));
    panel.toggleHelp();
    expect(textOf(workspace.render(100))).toContain(formatKeyHint(["r", "Refine current draft (model call)"], theme));
    workspace.openSettings();
    expect(textOf(workspace.render(100))).toContain(formatKeyHint(["Ctrl+S", "Save context"], theme));
    workspace.handleInput("q");
    workspace.handleInput("i");
    expect(textOf(workspace.render(100))).toContain(formatKeyHint(["Enter", "Refine"], theme));
    expect(textOf(workspace.render(20))).toContain(formatKeyHint(["↵", "Refine"], theme));
  });

  it.each(["dark", "light"])("keeps section hints attached and spacing stable across all selections in %s", (name) => {
    for (const width of [80, 100]) {
      const { workspace, theme } = create(40, name, true);
      workspace.openSettings();
      let anchors: number[] | undefined;
      for (let cursor = 0; cursor < 6; cursor++) {
        const rendered = workspace.render(width);
        const lines = rendered.map(stripVTControlCharacters);
        const position = (text: string) => lines.findIndex((line) => line.includes(text));
        const current = ["Context", "Include project instructions", "[x] Directory tree", "Skill metadata", "Optimizer", "Model:", "Thinking:", "Optimization prompt"].map(position);
        expect(current.every((index) => index >= 0)).toBe(true);
        if (anchors) expect(current).toEqual(anchors);
        else anchors = current;
        for (const [option, description] of [
          ["Include project instructions", "Use rules supplied by Pi (e.g. AGENTS.md)."],
          ["[x] Directory tree", "Default tree only; @directory references are separate."],
          ["Skill metadata", "Include skill descriptions; never run skills."],
        ]) {
          expect(lines[position(option!) + 1]).toContain(description);
          expect(lines[position(option!) + 1]).toMatch(/^ {4}\S/);
        }
        expect(position("Model:")).toBe(position("Optimizer") + 1);
        expect(rendered[position("Use rules supplied by Pi")]).toContain(theme.fg("muted", "Use rules supplied by Pi (e.g. AGENTS.md)."));
        const gaps = lines.flatMap((line, i) => i >= current[0]! && i < position("Model:") && !line.trim() ? [i] : []);
        expect(gaps).toEqual([position("Optimizer") - 1]);
        expect(rendered).toHaveLength(panelLayout(width, 40).height);
        for (const line of rendered) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        workspace.handleInput("\x1b[B");
      }
    }
  });

  it("keeps context explanations and disabled warnings inside Context without an optimizer", () => {
    const { workspace, actions } = create();
    actions.contextEnabled = () => false;
    workspace.openSettings();
    for (let cursor = 0; cursor < 3; cursor++) {
      const lines = workspace.render(100).map(stripVTControlCharacters);
      const context = lines.findIndex((line) => line.trim() === "Context");
      const warning = lines.findIndex((line) => line.includes("Disabled by projectContext.enabled=false"));
      expect(lines.slice(context, warning + 1).every((line) => line.trim())).toBe(true);
      expect(lines[warning - 1]).toContain("Include skill descriptions; never run skills.");
      expect(lines.join("\n")).not.toContain("Optimizer");
      workspace.handleInput("\x1b[B");
    }
  });

  it("shows full model details only when the selected navigation row truncates", () => {
    const { workspace } = create(40, "dark", true);
    workspace.openSettings([true, true, false], 3);
    expect(textOf(workspace.render(100)).match(/Model:/g)).toHaveLength(1);
    expect(textOf(workspace.render(40)).match(/Model:/g)).toHaveLength(2);
  });

  it("keeps long optimizer identifiers on one navigation row", () => {
    const { workspace } = create(40, "dark", true);
    workspace.openSettings([true, true, false], 3);
    const lines = workspace.render(40);
    const modelRow = lines.findIndex((line) => line.includes("Model:"));
    expect(lines[modelRow]).toContain("…");
    expect(lines[modelRow + 1]).toContain("Model:"); // Full value follows the focused row.
    expect(stripVTControlCharacters(lines[modelRow]!)).toMatch(/›$/);
    workspace.handleInput("\x1b[B");
    expect(textOf(workspace.render(40))).toContain("Thinking:");
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
        workspace.handleInput("\x1b[D");
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
    for (const [open, back] of [["\x1b[C", "\x1b[D"], ["i", "\x1b"]]) {
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
    for (const label of ["Include project instructions", "Directory tree", "Skill metadata"]) {
      expect(stripVTControlCharacters(textOf(workspace.render(40)))).toContain(`› [${label === "Skill metadata" ? " " : "x"}] ${label}`);
      workspace.handleInput("\x1b[B");
    }
    workspace.handleInput("\x1b[B");
    workspace.handleInput("q");
    workspace.handleInput("\x1b[C");
    expect(stripVTControlCharacters(textOf(workspace.render(40)))).toContain("› [x] Directory tree");
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
    expect(stripVTControlCharacters(textOf(workspace.render(100)))).toContain("› [ ] Include project instructions");
    for (let i = 0; i < cursor; i++) workspace.handleInput("\x1b[B");
    expect(textOf(workspace.render(100))).toContain("Ctrl+S");
    workspace.handleInput("\x13");
    expect(actions.saveContext).toHaveBeenCalledExactlyOnceWith([false, true, false]);
    expect(actions.chooseModel).not.toHaveBeenCalled();
    expect(actions.cycleThinking).not.toHaveBeenCalled();
    expect(actions.editSystemPrompt).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(textOf(workspace.render(100))).toContain("Context saved"));
  });

  it.each(["\x1b", "q", "\x1b[D", "\x1c"])("discards only pending context when returning with %j", (key) => {
    const { workspace, actions } = create(40, "dark", true);
    workspace.openSettings();
    workspace.handleInput("\r");
    workspace.handleInput(key);
    expect(textOf(workspace.render(100))).not.toContain("Manual save");
    workspace.openSettings();
    expect(stripVTControlCharacters(textOf(workspace.render(100)))).toContain("› [x] Include project instructions");
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
    expect(stripVTControlCharacters(textOf(workspace.render(100)))).toContain("› [ ] Include project instructions");
    workspace.handleInput("\x13");
    await vi.waitFor(() => expect(actions.saveContext).toHaveBeenCalledTimes(2));
    expect(actions.saveContext).toHaveBeenLastCalledWith([false, true, false]);
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
    expect(output).toContain(theme.fg("dim", "Unavailable — select model first"));
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
    expect(bg.mock.calls).toHaveLength(1);
    expect(bg.mock.calls[0]![0]).toBe("selectedBg");
    expect(visibleWidth(bg.mock.calls[0]![1])).toBe(panelLayout(100, 40).innerWidth);
    bg.mockRestore();
  });

  it("keeps the focused context option and its explanation together on short screens", () => {
    const { workspace } = create(12, "dark", true);
    workspace.openSettings(undefined, 2);
    const output = stripVTControlCharacters(textOf(workspace.render(80)));
    expect(output).toContain("› [ ] Skill metadata");
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
