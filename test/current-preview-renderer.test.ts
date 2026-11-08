import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { getKeybindings, TuiAltScreen, TuiMainScreen, visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { selectHistory } from "../src/context.js";
import type { RefineRecord } from "../src/history.js";
import { PreviewPanel } from "../src/preview.js";
import { RefineWorkspace } from "../src/workspace.js";

describe.each(["regular", "fullscreen"] as const)("current-round Preview (%s)", (mode) => {
  it.each(["dark", "light"])("keeps an archived view stable and history reachable through resize (%s)", (themeName) => {
    vi.useFakeTimers();
    let input = (_data: string) => {};
    const writes: string[] = [];
    const terminal: Terminal = {
      rows: 40, columns: 100, kittyProtocolActive: true,
      start: (onInput) => { input = onInput; }, stop() {}, write: (data) => { writes.push(data); },
      async drainInput() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {},
      clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
    };
    const tui = mode === "regular" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
    const theme = getThemeByName(themeName)!;
    const request = { draft: "Original 中文😀\x1b[2J", sessionId: "s", branchLeafId: null, roundId: 1,
      model: { provider: "p", id: "model" }, systemPrompt: "Policy", history: selectHistory([], 0, 0) };
    const source: RefineRecord = { id: 1, taskId: 1, kind: "refine", status: "generated", createdAt: 1, input: request,
      candidate: { ...request, requestId: 1, recordId: 1, generation: 0, version: 1, text: "Result 中文😀\n".repeat(40) } };
    const records = [source];
    const position = { selectedId: 1 };
    const usagePosition = { selectedId: 2, selectedTaskId: undefined as number | undefined };
    const run = vi.fn();
    const panel = new PreviewPanel({ state: { phase: "ready", requestId: 1, pendingSend: false },
      contextLabel: "Draft only", elapsedSeconds: 0, openHint: "ctrl+\\", canRestore: false }, theme, () => terminal.rows, () => tui.requestRender());
    const workspace = new RefineWorkspace(panel, tui, theme, getKeybindings(), {
      tasks: { records: () => records.map((record) => structuredClone(record)), appliedId: () => 1, activate: () => false, run, stop() {} },
      history: () => records, taskPosition: position, usagePosition,
      context: () => ({ instructions: "always", tree: false, skills: false }), contextEnabled: () => true,
      saveContext: async () => ({ message: "Saved", persisted: true }), submit: () => undefined,
    });
    tui.addChild(workspace); tui.setFocus(workspace);
    const render = () => {
      tui.requestRender(); tui.renderNow();
      const frame = workspace.render(terminal.columns);
      expect(frame.length).toBeLessThanOrEqual(terminal.rows - 4);
      expect(frame.every((line) => visibleWidth(line) <= terminal.columns)).toBe(true);
      expect(frame.join("\n")).not.toContain("\x1b[2J");
      return stripVTControlCharacters(frame.join("\n"));
    };
    try {
      tui.start(); render(); input("\r"); input("\x1b[6~"); render();
      const scroll = structuredClone(position);
      source.archivedAt = 1;
      records.push({ ...structuredClone(source), id: 2, taskId: 2, archivedAt: undefined,
        input: { ...request, draft: "NEW CURRENT" }, candidate: { ...source.candidate!, text: "NEW RESULT" } });
      const redraws = tui.fullRedraws;
      for (const [columns, rows] of [[100, 40], [40, 24], [20, 12], [180, 80], [100, 40]]) {
        Object.assign(terminal, { columns, rows }); workspace.invalidate();
        const text = render();
        expect(position).toEqual(scroll);
        if (columns! >= 40) expect(text).toContain("Earlier");
        expect(text).not.toContain("NEW RESULT");
      }
      expect(workspace.render(100).join("\n")).toContain(theme.fg("muted", "Earlier · kept open · Esc returns to current · History in Usage →"));
      input("\x1b[C"); expect(render()).toContain("Current + history");
      expect(usagePosition.selectedId).toBe(1);
      expect(usagePosition.selectedTaskId).toBeUndefined();
      input("\x1b[D"); expect(render()).toContain("Earlier · kept open");
      input("\x1b"); expect(render()).toContain("NEW CURRENT");
      expect(render()).not.toContain("Earlier · kept open");
      input("\x1b[C"); expect(render()).toContain("Usage");
      expect(render()).toContain("Earlier ·");
      expect(run).not.toHaveBeenCalled();
      // Resizes may redraw; ordinary archival/navigation must not add screen clearing.
      const settled = tui.fullRedraws;
      writes.length = 0;
      input("\x1b[D"); render(); input("\x1b[C"); render();
      expect(tui.fullRedraws).toBe(settled);
      expect(settled).toBeGreaterThanOrEqual(redraws);
      expect(writes.join("")).not.toMatch(/\x1b\[(?:2J|3J)/);
    } finally { workspace.dispose(); tui.stop(); vi.useRealTimers(); }
  });
});
