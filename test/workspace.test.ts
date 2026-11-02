import { describe, expect, it, vi } from "vitest";
import { CURSOR_MARKER, getKeybindings, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { PreviewPanel, type PreviewOptions } from "../src/preview.js";
import { RefineWorkspace } from "../src/workspace.js";
import { panelLayout } from "../src/panel-layout.js";

const options: PreviewOptions = {
  state: { phase: "ready", requestId: 1, pendingSend: false },
  candidateText: Array.from({ length: 80 }, (_, i) => `Result ${i}`).join("\n"),
  draft: "Original draft", contextLabel: "Draft only", elapsedSeconds: 0, openHint: "ctrl+\\", canRestore: false,
};

function create(rows = 40, themeName = "dark") {
  const terminal = { rows, columns: 80 };
  const tui = { terminal, requestRender: vi.fn() } as unknown as TUI;
  const theme = getThemeByName(themeName)!;
  const panel = new PreviewPanel(options, theme, () => terminal.rows, () => tui.requestRender());
  const actions = {
    context: () => [true, true, false], contextEnabled: () => true,
    saveContext: vi.fn(async () => "Context saved"),
    submit: vi.fn((_text: string): string | undefined => undefined),
  };
  const workspace = new RefineWorkspace(panel, tui, theme, getKeybindings(), actions);
  workspace.focused = true;
  return { workspace, panel, terminal, actions };
}

const textOf = (lines: string[]) => lines.join("\n");

describe("shared refine workspace", () => {
  it.each([[24, 16], [32, 21], [40, 24], [60, 24]])("budgets %i terminal rows as %i panel rows", (rows, height) => {
    expect(panelLayout(80, rows).height).toBe(height);
    expect(panelLayout(80, rows).bodyHeight).toBe(height - 5);
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
          for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(Math.min(width, 100));
        }
        expect(textOf(input)).toContain(CURSOR_MARKER);
        expect(terminal.rows).toBe(rows); // Editor facade must not mutate the host.
        if (width >= 40 && rows >= 16) {
          expect(textOf(input)).toContain("Esc Back");
          expect(textOf(input)).toContain("Enter Refine");
          expect(textOf(context)).toContain("Enter Save");
          expect(textOf(context)).toContain("discard");
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
        const body = lines.slice(layout.headerHeight, layout.headerHeight + layout.bodyHeight);
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
    expect(textOf(workspace.render(80))).toContain("Main");
  });

  it("keeps selected settings visible in a tiny viewport and retains their cursor", () => {
    const { workspace } = create(8);
    workspace.handleInput("\x1b[C");
    for (const label of ["AGENTS.md", "tree", "skills"]) {
      expect(textOf(workspace.render(40))).toContain(`› [${label === "skills" ? " " : "x"}] ${label}`);
      workspace.handleInput("\x1b[B");
    }
    workspace.handleInput("\x1b[B");
    workspace.handleInput("q");
    workspace.handleInput("\x1b[C");
    expect(textOf(workspace.render(40))).toContain("› [x] tree");
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

  it("ignores late save completion and stale input after disposal", async () => {
    const { workspace, actions } = create();
    let resolve!: (notice: string) => void;
    actions.saveContext.mockImplementation(() => new Promise((done) => { resolve = done; }));
    workspace.handleInput("\x1b[C");
    workspace.handleInput(" ");
    expect(textOf(workspace.render(80))).toContain("Unsaved changes");
    workspace.handleInput("\r");
    workspace.handleInput("\r");
    expect(actions.saveContext).toHaveBeenCalledTimes(1);
    workspace.dispose();
    resolve("saved");
    await Promise.resolve();
    expect(textOf(workspace.render(80))).toContain("Context ·");
    workspace.handleInput("i");
    workspace.handleInput("\r");
    expect(actions.submit).not.toHaveBeenCalled();
  });
});
