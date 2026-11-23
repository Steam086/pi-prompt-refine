import { CURSOR_MARKER, getKeybindings, Input, sliceByColumn, Text, TuiAltScreen, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters as strip } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { selectHistory } from "../../src/context.js";
import type { RefineRecord } from "../../src/history.js";
import { PreviewPanel } from "../../src/preview.js";
import type { TaskPanelPosition } from "../../src/task-panel.js";
import { REFINE_OVERLAY_OPTIONS, workspaceHeight } from "../../src/workspace-overlay.js";
import { RefineWorkspace } from "../../src/workspace.js";
import { getThemeByName } from "../support/pi-theme.js";
import { createRecordingTerminal } from "../support/recording-terminal.js";
import { record } from "../support/task-panel.js";

// Real overlay compositing in both Pi renderers. This is not human IME validation.
describe.each(["regular", "fullscreen"] as const)("native Refine overlay (%s)", (mode) => {
  it.each(["dark", "light"])("keeps a complete aligned shell, isolated focus and the host draft (%s)", (name) => {
    vi.useFakeTimers();
    const { terminal, writes, input } = createRecordingTerminal({ rows: 60, columns: 120 }, vi.fn());
    const tui = mode === "regular" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
    const theme = getThemeByName(name)!;
    vi.spyOn(theme, "bold").mockImplementation((value) => `\x1b[1m${value}\x1b[22m`);
    const request = { draft: "Original 中文😀\x1b[2J", model: { provider: "p", id: "m" }, sessionId: "s", branchLeafId: null,
      systemPrompt: "Policy", history: selectHistory([], 0, 0) };
    const records: RefineRecord[] = [{ id: 1, taskId: 1, kind: "refine", status: "generated", createdAt: 1, input: request,
      candidate: { ...request, requestId: 1, version: 1, generation: 0, text: "Result 中文😀\n".repeat(100) } }];
    const position: TaskPanelPosition = { selectedId: 1 };
    const accept = vi.fn();
    const panel = new PreviewPanel({ state: { phase: "idle", requestId: 0, pendingSend: false }, contextLabel: "None",
      elapsedSeconds: 0, canRestore: false, openHint: "ctrl+\\" }, theme, () => terminal.rows, () => tui.requestRender());
    const workspace = new RefineWorkspace(panel, tui, theme, getKeybindings(), {
      tasks: { records: () => records, appliedId: () => undefined, activate: () => true, run() {}, stop() {}, accept, deleteRecords: () => true },
      taskPosition: position, history: () => records,
      context: () => ({ instructions: "always", tree: false, skills: false }), contextEnabled: () => true,
      saveContext: async () => ({ message: "Saved", persisted: true }), submit: () => undefined,
      revision: () => ({ key: "s:1", label: "Run #1 · p/m", submit: () => "Rejected 中文😀" }),
      preferences: { key: "alt+p", maxChars: 16000, repository: { load: async () => ({ errors: {}, entries: [] }), save: vi.fn(), remove: vi.fn() } },
    });
    const hostEditor = new Input(); hostEditor.setValue("Host draft 中文😀");
    tui.addChild(new Text("Earlier transcript 中文😀\n".repeat(65), 0, 0));
    tui.addChild(hostEditor); tui.setFocus(hostEditor);
    const overlay = tui.showOverlay(workspace, REFINE_OVERLAY_OPTIONS);
    const render = () => {
      tui.renderNow();
      const bounds = overlay.getBounds()!;
      expect(bounds.width).toBe(Math.max(1, Math.floor(terminal.columns * 0.96)));
      expect(bounds.height).toBe(workspaceHeight(terminal.rows));
      const lines = workspace.render(bounds.width);
      expect(lines.every((line) => visibleWidth(line) === bounds.width)).toBe(true);
      expect(lines.join("\n")).not.toContain("\x1b[2J");
      if (bounds.width >= 8 && bounds.height >= 6) {
        expect(strip(lines[0]!)).toMatch(/^╭─+╮$/);
        expect(strip(lines.at(-1)!)).toMatch(/^╰─+╯$/);
      }
      return lines;
    };
    try {
      tui.start(); render();
      expect(overlay.isFocused()).toBe(true);
      expect(hostEditor.focused).toBe(false);
      const redraws = tui.fullRedraws; const clears = vi.mocked(terminal.clearScreen).mock.calls.length;
      writes.length = 0;
      for (const key of ["\r", "\x1b[6~", "o", "\x1b[6~", "f", "Keep 中文😀", "\x05", "\x05", "\x13", "\x1b", "d", "\x1b"]) {
        input(key); render();
      }
      expect(hostEditor.getValue()).toBe("Host draft 中文😀");
      expect(tui.fullRedraws).toBe(redraws);
      expect(terminal.clearScreen).toHaveBeenCalledTimes(clears);
      expect(writes.join("" )).not.toMatch(/\x1b\[(?:2J|3J|\?1049[hl])/);
      for (const [columns, rows] of [[40, 24], [20, 12], [8, 5], [180, 80], [120, 60]] as const) {
        Object.assign(terminal, { columns, rows }); workspace.invalidate(); render();
        input("f"); input("more");
        expect(render().join("\n")).toContain(CURSOR_MARKER);
        input("\x1b"); render();
      }
      overlay.hide(); tui.renderNow();
      expect(hostEditor.focused).toBe(true);
      input("!"); tui.renderNow();
      expect(hostEditor.getValue()).toBe("!Host draft 中文😀");
    } finally { workspace.dispose(); tui.stop(); vi.restoreAllMocks(); vi.useRealTimers(); }
  });

  it("keeps centered bounds across pages, records, states and resize while reading Usage", () => {
    vi.useFakeTimers();
    const { terminal, input } = createRecordingTerminal({ columns: 160, rows: 48 });
    const tui = mode === "regular" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
    const theme = getThemeByName("dark")!;
    const first = record(1);
    first.input.draft = "Original start\n" + "Original 中文😀\n".repeat(25) + "Original end";
    first.candidate!.text = "Result start\n" + "Result 中文😀\n".repeat(25) + "Result end";
    const second = record(2);
    const records = [first, second];
    const usagePosition: TaskPanelPosition = { selectedId: 1 };
    const accept = vi.fn();
    const preview = new PreviewPanel({ state: { phase: "idle", requestId: 0, pendingSend: false }, contextLabel: "None",
      elapsedSeconds: 0, canRestore: false, openHint: "" }, theme, () => terminal.rows, () => tui.requestRender());
    const workspace = new RefineWorkspace(preview, tui, theme, getKeybindings(), {
      tasks: { records: () => records, appliedId: () => undefined, activate: () => false, run() {}, stop() {}, accept },
      taskPosition: { selectedId: 1 }, usagePosition, history: () => records,
      context: () => ({ instructions: "always", tree: false, skills: false }), contextEnabled: () => true,
      saveContext: async () => ({ message: "Saved", persisted: true }), submit: () => undefined,
    });
    const editor = new Input(); editor.setValue("Pi draft 中文😀");
    tui.addChild(new Text("Pi transcript\n".repeat(60), 0, 0));
    tui.addChild(editor); tui.setFocus(editor);
    const overlay = tui.showOverlay(workspace, REFINE_OVERLAY_OPTIONS);
    const sizes = [[160, 48, 153, 36], [120, 40, 115, 30], [80, 24, 76, 18], [60, 20, 57, 15], [40, 12, 38, 9]] as const;
    let size: typeof sizes[number] = sizes[0];
    function frame() {
      const [columns, rows, width, height] = size;
      const col = Math.floor((columns - width) / 2), row = Math.floor((rows - height) / 2);
      const label = `${columns}×${rows}`;
      tui.renderNow();
      expect(overlay.getBounds(), label).toEqual({ col, row, width, height });
      expect(overlay.isFocused(), label).toBe(true);
      const screen = tui.mode === "fullscreen" ? tui.getScreenLines() : (() => {
        const { previousLines, previousViewportTop } = tui.captureRenderState();
        return previousLines.slice(previousViewportTop, previousViewportTop + rows);
      })();
      expect(screen.every((line) => visibleWidth(line) <= columns), label).toBe(true);
      expect(strip(screen.slice(0, row).join("\n")), label).toContain("Pi transcript");
      expect(strip(screen.slice(row + height).join("\n")), label).toContain("Pi draft 中文😀");
      const lines = screen.slice(row, row + height).map((line) => strip(sliceByColumn(line, col, width)));
      expect(lines[0], label).toBe(`╭${"─".repeat(width - 2)}╮`);
      expect(lines.at(-1), label).toBe(`╰${"─".repeat(width - 2)}╯`);
      expect(lines.slice(1, -1).every((line) => /^│.*│$/u.test(line) && visibleWidth(line) === width), label).toBe(true);
      return lines.join("\n");
    }
    function pageTo(marker: string, direction: "up" | "down" = "down") {
      let view = frame();
      for (let i = 0; i < 40 && !view.includes(marker); i++) {
        input(direction === "up" ? "\x1b[5~" : "\x1b[6~");
        view = frame();
      }
      expect(view, `${terminal.columns}×${terminal.rows}`).toContain(marker);
    }
    try {
      tui.start();
      for (const dimensions of sizes) {
        size = dimensions;
        const [columns, rows] = size;
        Object.assign(terminal, { columns, rows });
        const resized = frame();
        if (dimensions !== sizes[0]) {
          // Resize keeps the Usage reading focus; PageUp must not select another run.
          expect(resized).toMatch(/\n│ +Usage/);
          pageTo("Result start", "up");
          expect(usagePosition.selectedId).toBe(1);
          input("\t"); input("\x1b[D");
        }
        expect(frame()).toMatch(/\n│ +Prompt refine/);
        input("\r");
        pageTo("Result end");
        input("o");
        pageTo("Original end");
        input("\x1b");
        input("\x1b[C");
        expect(frame()).toMatch(/\n│ +Usage/);
        input("\x1b[C");
        expect(frame()).toMatch(/\n│ +Settings/);
        input("\x1b[D"); frame();
        input("\x1b[A");
        expect(frame()).toContain("model-2");
        expect(usagePosition.selectedId).toBe(2);
        const candidate = second.candidate;
        for (const [status, badge] of [["generating", "Running"], ["error", "Failed"], ["generated", "Done"]] as const) {
          second.status = status;
          second.candidate = status === "generated" ? candidate : undefined;
          expect(frame()).toContain(badge);
          expect(usagePosition.selectedId).toBe(2);
        }
        input("\x1b[B"); frame();
        expect(usagePosition.selectedId).toBe(1);
        input("\t");
        pageTo("Result start", "up");
        pageTo("Result end");
        expect(usagePosition.selectedId).toBe(1);
        // Stay in the Usage reading pane for the next resize.
      }
      overlay.hide(); tui.renderNow();
      expect(editor.focused).toBe(true);
      expect(editor.getValue()).toBe("Pi draft 中文😀");
      expect(accept).not.toHaveBeenCalled();
    } finally { workspace.dispose(); tui.stop(); vi.useRealTimers(); }
  });
});
