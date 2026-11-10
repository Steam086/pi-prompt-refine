import { CURSOR_MARKER, getKeybindings, Input, Text, TuiAltScreen, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
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
      expect(bounds.width).toBe(Math.max(1, Math.floor(terminal.columns * 0.98)));
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
});
