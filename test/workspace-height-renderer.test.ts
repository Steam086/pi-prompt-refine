import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { getKeybindings, Text, TuiAltScreen, TuiMainScreen, visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { PreviewPanel } from "../src/preview.js";
import { RefineWorkspace } from "../src/workspace.js";
import { selectHistory } from "../src/context.js";
import type { RefineRecord } from "../src/history.js";
import type { TaskPanelPosition } from "../src/task-panel.js";

// Actual Pi renderers with a transcript above the workspace. Captured I/O does
// not establish physical-terminal appearance, latency or IME behavior.
describe.each(["regular", "fullscreen"] as const)("adaptive height rendering (%s)", (mode) => {
  it.each(["dark", "light"])("keeps bounded styled chrome through expansion, resize and confirmation (%s)", (name) => {
    vi.useFakeTimers();
    let input = (_data: string) => {};
    const writes: string[] = [];
    const terminal: Terminal = {
      rows: 60, columns: 100, kittyProtocolActive: true,
      start: (handler) => { input = handler; }, stop() {}, write: (data) => { writes.push(data); },
      async drainInput() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {},
      clearScreen: vi.fn(), setTitle() {}, setProgress() {}, setProgramStatus() {},
    };
    const tui = mode === "regular" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
    const theme = getThemeByName(name)!;
    vi.spyOn(theme, "bold").mockImplementation((value) => `\x1b[1m${value}\x1b[22m`);
    const request = { draft: "Original 中文😀\x1b[2J", model: { provider: "p", id: "m" }, sessionId: "s", branchLeafId: null,
      systemPrompt: "Policy", history: selectHistory([], 0, 0) };
    const records: RefineRecord[] = [{ id: 1, taskId: 1, kind: "refine", status: "generated", createdAt: 1, input: request,
      candidate: { ...request, requestId: 1, version: 1, generation: 0, text: Array.from({ length: 90 }, (_, i) => `Result ${i} 中文😀`).join("\n") } }];
    const position: TaskPanelPosition = { selectedTaskId: 1 };
    const accept = vi.fn();
    const panel = new PreviewPanel({ state: { phase: "idle", requestId: 0, pendingSend: false }, contextLabel: "None",
      elapsedSeconds: 0, canRestore: false, openHint: "ctrl+\\" }, theme, () => terminal.rows, () => tui.requestRender());
    const workspace = new RefineWorkspace(panel, tui, theme, getKeybindings(), {
      tasks: { records: () => records, appliedId: () => undefined, activate: () => true, run() {}, stop() {}, accept, deleteRecords: () => true },
      taskPosition: position, history: () => records,
      context: () => ({ instructions: "always", tree: false, skills: false }), contextEnabled: () => true,
      saveContext: async () => ({ message: "Saved", persisted: true }), submit: () => undefined,
    });
    tui.addChild(new Text("Earlier transcript 中文😀\n".repeat(5), 0, 0));
    tui.addChild(workspace); tui.setFocus(workspace);
    const render = () => {
      tui.renderNow();
      const lines = workspace.render(terminal.columns);
      expect(lines.length).toBeLessThanOrEqual(Math.max(1, terminal.rows - 4));
      expect(lines.every((line) => visibleWidth(line) <= terminal.columns)).toBe(true);
      expect(lines.join("\n")).not.toContain("\x1b[2J");
      expect(stripVTControlCharacters(lines.slice(-2).join("\n"))).toMatch(/Esc|Back/);
      return lines;
    };
    try {
      tui.start();
      const compact = render();
      expect(compact).toHaveLength(18);
      expect(compact.join("\n")).toContain(theme.fg("text", theme.bold("Ctrl+E")) + " " + theme.fg("muted", "Expand"));
      const initialRedraws = tui.fullRedraws;
      const initialClears = vi.mocked(terminal.clearScreen).mock.calls.length;
      writes.length = 0;
      // Selection alone never expands, even when the selected result is long.
      input("\x1b[B"); input("\r"); render();
      for (let i = 0; i < 15; i++) { input("\x1b[6~"); render(); }
      const before = render();
      input("\x05"); expect(render()).toHaveLength(51);
      expect(position.selectedId).toBe(1);
      input("\x05"); expect(render()).toEqual(before);
      expect(tui.fullRedraws).toBe(initialRedraws);
      expect(vi.mocked(terminal.clearScreen).mock.calls.length).toBe(initialClears);
      expect(writes.join("")).not.toMatch(/\x1b\[(?:2J|3J|\?1049[hl])/);
      input("a"); expect(accept).toHaveBeenCalledExactlyOnceWith(1);
      input("\x05"); render();
      for (const [columns, rows] of [[40, 24], [20, 12], [100, 60], [180, 80]] as const) {
        Object.assign(terminal, { columns, rows }); workspace.invalidate();
        const height = render().length;
        for (const key of ["o", "\x1b[5~", "\x1b[C", "\x1b[C", "\x1b[C", "d", "\x05", "\x1b"]) {
          input(key); expect(render()).toHaveLength(height);
        }
      }
      Object.assign(terminal, { columns: 100, rows: 60 }); workspace.openTasks(); render();
      input("\x05"); expect(render().length).toBeLessThanOrEqual(24);
      expect(render().join("\n")).toContain(theme.fg("text", theme.bold("Ctrl+E")) + " " + theme.fg("muted", "Expand"));
    } finally {
      workspace.dispose(); tui.stop(); vi.restoreAllMocks(); vi.useRealTimers();
    }
  });
});
