import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";
import { stripVTControlCharacters } from "node:util";
import { expect, it } from "vitest";
import { getKeybindings, TuiAltScreen, TuiMainScreen, type Terminal } from "@earendil-works/pi-tui";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { PreviewPanel } from "../src/preview.js";
import { RefineWorkspace } from "../src/workspace.js";

// Opt-in measurement with real scheduling and real Pi renderers. This measures
// input callback -> terminal.write, not physical display latency or key repeat.
// REFINE_BENCHMARK=1 npm test -- test/settings-performance.test.ts
it.skipIf(!process.env.REFINE_BENCHMARK)("measures workspace navigation latency and terminal traffic", async () => {
  const results: object[] = [];
  for (const mode of ["regular", "fullscreen"] as const) {
    for (const scene of ["context", "optimizer", "preview"] as const) {
      for (const [columns, rows] of [[40, 24], [80, 40], [100, 40]]) {
        let input = (_data: string) => {};
        let onWrite: (() => void) | undefined;
        let bytes = 0;
        const terminal: Terminal = {
          rows, columns, kittyProtocolActive: true,
          start: (callback) => { input = callback; }, stop() {},
          write: (data) => { bytes += Buffer.byteLength(data); onWrite?.(); },
          async drainInput() {}, moveBy() {}, hideCursor() {}, showCursor() {},
          clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
        };
        const tui = mode === "regular" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
        const theme = getThemeByName("dark")!;
        const panel = new PreviewPanel({ state: { phase: scene === "preview" ? "ready" : "idle", requestId: 0, pendingSend: false },
          candidateText: scene === "preview" ? Array.from({ length: 500 }, (_, i) => `Line ${i}: **Keep the task constraints** and \`commands\` intact.`).join("\n\n") : undefined,
          contextLabel: "", elapsedSeconds: 0, openHint: "", canRestore: false,
        }, theme, () => rows, () => tui.requestRender());
        const workspace = new RefineWorkspace(panel, tui, theme, getKeybindings(), {
          context: () => ({ instructions: "always" as const, tree: true, skills: false }), contextEnabled: () => true,
          optimizer: () => ({ model: "provider/long-model-identifier-with-extra-details", thinking: "high · Extension setting", thinkingEnabled: true }),
          chooseModel() {}, editSystemPrompt() {}, saveContext: async () => ({ message: "Saved", persisted: true }), submit: () => undefined,
        });
        const component = {
          render: (width: number) => workspace.render(width), invalidate: () => workspace.invalidate(),
          handleInput(data: string) {
            if (workspace.handleInput(data)) return;
            panel.scrollBy(data === "\x1b[B" ? 1 : -1);
          },
        };
        tui.addChild(component);
        tui.setFocus(component);
        if (scene !== "preview") workspace.openSettings(undefined, scene === "optimizer" ? 3 : 0);
        const latency: number[] = [], traffic: number[] = [], changedLines: number[] = [];
        try {
          tui.start();
          tui.renderNow();
          await new Promise((resolve) => setTimeout(resolve, 20));
          const redraws = tui.fullRedraws;
          let previous = workspace.render(columns).map(stripVTControlCharacters);
          for (let i = 0; i < 120; i++) {
            bytes = 0;
            const elapsed = await new Promise<number>((resolve, reject) => {
              const timeout = setTimeout(() => reject(new Error("No frame written after navigation")), 1_000);
              const start = performance.now();
              onWrite = () => {
                onWrite = undefined;
                clearTimeout(timeout);
                resolve(performance.now() - start);
              };
              input(i % 10 < 5 ? "\x1b[B" : "\x1b[A");
            });
            const current = workspace.render(columns).map(stripVTControlCharacters);
            if (i >= 20) {
              latency.push(elapsed);
              traffic.push(bytes);
              changedLines.push(current.filter((line, index) => line !== previous[index]).length);
            }
            previous = current;
          }
          latency.sort((a, b) => a - b);
          const mean = (values: number[]) => +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(2);
          results.push({ mode, scene, columns, rows, samples: latency.length,
            medianMs: +latency[49]!.toFixed(3), p95Ms: +latency[94]!.toFixed(3),
            bytesPerKey: mean(traffic), changedLinesPerKey: mean(changedLines), fullRedraws: tui.fullRedraws - redraws });
          expect(tui.fullRedraws).toBe(redraws);
        } finally {
          onWrite = undefined;
          workspace.dispose();
          tui.stop();
        }
      }
    }
  }
  if (process.env.REFINE_BENCHMARK_OUTPUT) await writeFile(process.env.REFINE_BENCHMARK_OUTPUT, JSON.stringify(results, null, 2) + "\n");
  else console.log(JSON.stringify(results, null, 2));
}, 30_000);
