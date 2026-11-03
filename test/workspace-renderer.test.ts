import { describe, expect, it, vi } from "vitest";
import { getKeybindings, TuiAltScreen, TuiMainScreen, type Terminal } from "@earendil-works/pi-tui";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { PreviewPanel } from "../src/preview.js";
import { RefineWorkspace } from "../src/workspace.js";

// Exercise the real Pi diff renderers, not just component snapshots. Terminal I/O
// is captured, so these tests make no claims about a physical terminal's latency/IME.
describe("workspace terminal rendering", () => {
  it.each([
    ["regular", 20, 12], ["regular", 40, 24], ["regular", 80, 40],
    ["fullscreen", 20, 12], ["fullscreen", 40, 24], ["fullscreen", 80, 40],
  ] as const)("switches without full redraw or screen clearing in %s at %ix%i", (mode, columns, rows) => {
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
    const theme = getThemeByName("dark")!;
    const panel = new PreviewPanel({
      state: { phase: "ready", requestId: 1, pendingSend: false },
      candidateText: "A short result", contextLabel: "Draft only", elapsedSeconds: 0, openHint: "ctrl+\\", canRestore: false,
    }, theme, () => terminal.rows, () => tui.requestRender());
    const workspace = new RefineWorkspace(panel, tui, theme, getKeybindings(), {
      context: () => ({ instructions: "always" as const, tree: true, skills: false }), contextEnabled: () => true,
      optimizer: () => ({ model: "provider/long-model-identifier-with-extra-details", thinking: "high · Extension setting", thinkingEnabled: true }),
      chooseModel() {}, editSystemPrompt() {},
      saveContext: async () => "Saved", submit: () => undefined,
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
        for (const key of ["\x1b[C", ...Array<string>(6).fill("\x1b[B"), ...Array<string>(6).fill("\x1b[A"), "\x1b[D", "i", "\x1b"]) {
          input(key);
          tui.renderNow();
          expect(workspace.render(columns)).toHaveLength(initialHeight);
        }
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
