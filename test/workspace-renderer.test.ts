import { describe, expect, it, vi } from "vitest";
import { getKeybindings, TuiAltScreen, TuiMainScreen, type Terminal } from "@earendil-works/pi-tui";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { PreviewPanel } from "../src/preview.js";
import { RefineWorkspace } from "../src/workspace.js";
import type { RefineRecord } from "../src/history.js";
import { selectHistory } from "../src/context.js";

// Exercise the real Pi diff renderers, not just component snapshots. Terminal I/O
// is captured, so these tests make no claims about a physical terminal's latency/IME.
describe("workspace terminal rendering", () => {
  it.each([
    ["regular", 20, 12, "dark"], ["regular", 40, 24, "dark"], ["regular", 80, 40, "dark"], ["regular", 100, 40, "light"],
    ["fullscreen", 20, 12, "dark"], ["fullscreen", 40, 24, "dark"], ["fullscreen", 80, 40, "dark"], ["fullscreen", 100, 40, "light"],
  ] as const)("switches without full redraw or screen clearing in %s at %ix%i (%s)", async (mode, columns, rows, themeName) => {
    vi.useFakeTimers();
    let input = (_data: string) => {};
    const writes: string[] = [];
    const terminal: Terminal = {
      rows, columns, kittyProtocolActive: true,
      start: (onInput) => { input = onInput; }, stop() {}, write: (data) => { writes.push(data); },
      async drainInput() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {},
      clearScreen: vi.fn(), setTitle() {}, setProgress() {}, setProgramStatus() {},
    };
    const tui = mode === "regular" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
    const theme = getThemeByName(themeName)!;
    const panel = new PreviewPanel({
      state: { phase: "ready", requestId: 1, pendingSend: false },
      candidateText: "A short result", contextLabel: "Draft only", elapsedSeconds: 0, openHint: "ctrl+\\", canRestore: false,
    }, theme, () => terminal.rows, () => tui.requestRender());
    const requestInput = { draft: "Historical draft 中文😀 ".repeat(8), model: { provider: "provider", id: "long-model-identifier-中文" },
      sessionId: "session", branchLeafId: "leaf", systemPrompt: "Policy", history: selectHistory([], 12, 100) };
    const records: RefineRecord[] = Array.from({ length: 30 }, (_, index) => ({
      id: index + 1, taskId: 1, kind: "refine", createdAt: 1, input: requestInput,
      status: index % 3 === 0 ? "error" : "generated", elapsedSeconds: index,
      usage: index % 3 === 0 ? undefined : { totalTokens: index * 1200, input: index * 1000, output: index * 200 },
      candidate: index % 3 === 0 ? undefined : { ...requestInput, requestId: index + 1, version: index + 1, generation: 0, text: "Candidate 中文😀\n".repeat(50) },
    }));
    const workspace = new RefineWorkspace(panel, tui, theme, getKeybindings(), {
      preferences: { key: "f2", maxChars: 16000, repository: {
        load: async () => ({ errors: {}, entries: [{ id: "one", version: 1, scope: "global", name: "Keep commands 中文", body: "Preserve literals\n".repeat(100) }] }),
        save: async () => { throw new Error("Read-only fixture"); }, remove: async () => {},
      } },
      context: () => ({ instructions: "always" as const, tree: true, skills: false }), contextEnabled: () => true,
      optimizer: () => ({ model: "provider/long-model-identifier-with-extra-details", thinking: "high · Extension setting", thinkingEnabled: true }),
      chooseModel() {}, editSystemPrompt() {}, history: () => records,
      tasks: { records: () => records, appliedId: () => records[1]!.id,
        activate: (id) => !!records.find((record) => record.id === id)?.candidate, run() {}, stop() {} },
      saveContext: async () => "Saved", submit: () => undefined,
      revision: () => ({ key: "source-1", label: "model · Run #1", submit: () => "Validation notice" }),
    });
    tui.addChild(workspace);
    tui.setFocus(workspace);
    try {
      tui.start();
      tui.renderNow();
      const initialHeight = workspace.render(columns).length;
      const initialRedraws = tui.fullRedraws;
      const clearCalls = vi.mocked(terminal.clearScreen).mock.calls.length;
      writes.length = 0;
      for (let repeat = 0; repeat < 10; repeat++) {
        panel.update({
          state: { phase: "generating", requestId: repeat + 2, pendingSend: false },
          draft: "Submitted 原文😀\n".repeat(200), draftChanged: true,
          contextLabel: "Draft only", elapsedSeconds: 0, openHint: "ctrl+\\", canRestore: false,
        });
        tui.requestRender();
        tui.renderNow();
        panel.scrollBy(10000);
        tui.requestRender();
        tui.renderNow();
        expect(workspace.render(columns)).toHaveLength(initialHeight);
        for (const key of [
          "\t", "\x1b[6~", "\t", "\x1b[B", "\r", "\x1b[6~", "f", "中文😀", "\r", "keep", "\x05", "\x05", "\x13", "\x1b", "o", "\x1b", // Task browser and applied result
          "\x1b[C", "\x1b[B", "\t", "\x1b[6~", "\r", "\x1b", // Unified Usage and Apply
          "\x1b[C", ...Array<string>(6).fill("\x1b[B"), ...Array<string>(6).fill("\x1b[A"), "\t", ...Array<string>(3).fill("\x1b[B"), "\t", "\x1b", "i", "\x1b",
        ]) {
          input(key);
          tui.renderNow();
          expect(workspace.render(columns)).toHaveLength(initialHeight);
        }
        panel.update({
          state: { phase: "ready", requestId: repeat + 2, pendingSend: false },
          candidateText: "Completed result", draft: "Submitted 原文😀\n".repeat(200),
          contextLabel: "Draft only", elapsedSeconds: 1, openHint: "ctrl+\\", canRestore: false,
        });
        tui.requestRender();
        tui.renderNow();
        expect(workspace.render(columns)).toHaveLength(initialHeight);
      }
      workspace.openResult(); input("f"); input("\x1bOQ");
      await Promise.resolve();
      for (const key of ["\r", " ", "\r", "\x1b[6~", "\x1b", "\t", "\t", "\t", "\t", "\t", "\r", "Saved name", "\t", "\r", "中文", "\x13", "\x1b", "n", "\x1b", "y", "\x1b"]) {
        input(key); tui.renderNow();
        expect(workspace.render(columns)).toHaveLength(initialHeight);
      }
      expect(writes.length).toBeGreaterThan(0);
      expect(tui.fullRedraws).toBe(initialRedraws);
      expect(terminal.clearScreen).toHaveBeenCalledTimes(clearCalls);
      expect(writes.join("")).not.toMatch(/\x1b\[(?:2J|3J|\?1049[hl])/);
    } finally {
      workspace.dispose();
      tui.stop();
      vi.useRealTimers();
    }
  });
});
