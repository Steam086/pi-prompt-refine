import { getKeybindings, TuiAltScreen, TuiMainScreen, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { stripVTControlCharacters as strip } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { selectHistory } from "../../src/context.js";
import type { RefineRecord } from "../../src/history.js";
import { formatKeyHint } from "../../src/key-hints.js";
import { renderModelPicker, type ModelPickerOptions } from "../../src/model-picker.js";
import { panelLayout } from "../../src/panel-layout.js";
import { PreviewPanel } from "../../src/preview.js";
import { TaskPanel, type TaskPanelPosition } from "../../src/task-panel.js";
import { workspaceHeight } from "../../src/workspace-overlay.js";
import { RefineWorkspace } from "../../src/workspace.js";
import { getThemeByName } from "../support/pi-theme.js";
import { createRecordingTerminal } from "../support/recording-terminal.js";

describe.each(["regular", "fullscreen"] as const)("TUI layout regressions (%s)", (mode) => {
  it.each(["dark", "light"])("bounds picker, validation and comparison through resize (%s)", (name) => {
    vi.useFakeTimers();
    const { terminal, writes, input } = createRecordingTerminal({ rows: 40, columns: 100 });
    const tui = mode === "regular" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
    const theme = getThemeByName(name)!;
    const bold = vi.spyOn(theme, "bold").mockImplementation((text) => `\x1b[1m${text}\x1b[22m`);
    const options: ModelPickerOptions = {
      items: Array.from({ length: 30 }, (_, i) => ({ value: `provider/model-${i}`, label: `model-${i} [thinking]`, description: `Model ${i} 中文😀` })),
      selectedKey: "provider/model-12", query: "", title: "Choose optimizer model", subtitle: "Optimizer only · Main session unchanged",
      thinkingStatus: "Thinking level: high · Last used for this model", thinkingKeys: "Shift+Tab", run: false,
    };
    const preview = new PreviewPanel({ state: { phase: "idle", requestId: 0, pendingSend: false },
      contextLabel: "", elapsedSeconds: 0, openHint: "", canRestore: false }, theme, () => terminal.rows, () => tui.requestRender());
    const submit = vi.fn(() => "Rejected 中文😀\x1b[31m");
    const workspace = new RefineWorkspace(preview, tui, theme, getKeybindings(), {
      context: () => ({ instructions: "off", tree: false, skills: false }), contextEnabled: () => true,
      submit, saveContext: async () => ({ message: "Saved", persisted: true }),
    });
    workspace.focused = true;
    const request = { draft: "Original 中文😀", sessionId: "s", branchLeafId: null,
      model: { provider: "p", id: "模型😀\x1b[31m".repeat(20) }, systemPrompt: "Policy", history: selectHistory([], 0, 0) };
    const records: RefineRecord[] = [1, 2].map((id) => ({ id, taskId: 1, kind: "refine", status: "generated", createdAt: id, input: request,
      candidate: { ...request, requestId: id, recordId: id, generation: 0, version: 1, text: `Result ${id} 中文😀\n`.repeat(60) } }));
    const position: TaskPanelPosition = { selectedId: 1 };
    const accept = vi.fn();
    const tasks = new TaskPanel({ records: () => records, appliedId: () => 1, activate: () => true, run() {}, stop() {}, accept },
      theme, () => terminal.rows, getKeybindings(), false, position);
    let view: Component = { render: (width) => renderModelPicker(options, width, terminal.rows, theme), invalidate() {} };
    const component = { render: (width: number) => view.render(width), handleInput: (data: string) => view.handleInput?.(data),
      invalidate: () => view.invalidate(), focused: true };
    tui.addChild(component); tui.setFocus(component);
    const render = () => {
      tui.requestRender(); tui.renderNow();
      const lines = component.render(terminal.columns);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.length).toBeLessThanOrEqual(view === workspace ? workspaceHeight(terminal.rows) : panelLayout(terminal.columns, terminal.rows).height);
      expect(lines.every((line) => visibleWidth(line) <= (view === workspace ? terminal.columns : Math.min(terminal.columns, 100)))).toBe(true);
      expect(lines.join("\n")).not.toContain("\x1b[31m");
      return lines.join("\n");
    };
    try {
      tui.start(); render();
      for (const [columns, rows] of [[100, 40], [20, 8], [40, 12], [180, 80], [100, 40]] as const) {
        Object.assign(terminal, { columns, rows });
        let output = render();
        if (columns >= 40) expect(strip(output)).toContain("Model 12 中文😀");
        if (columns >= 100) {
          const lines = strip(output).split("\n");
          expect(lines.filter((line) => line.includes("provider/model-"))).toHaveLength(7);
          expect(lines.findIndex((line) => line.includes("Thinking level:")) -
            lines.findIndex((line) => line.includes("More models"))).toBe(2);
        }
        expect(output).toContain(formatKeyHint(["Esc", "Cancel"], theme));
        options.selectedKey = "provider/model-13"; options.thinkingStatus = "Thinking level: medium";
        output = render();
        if (columns >= 40) expect(strip(output)).toContain("Model 13 中文😀");
        options.selectedKey = "provider/model-12";
      }
      expect(render()).toContain(theme.fg("text", theme.bold(options.title)));
      expect(render()).toContain(theme.fg("muted", options.thinkingStatus));
      const redraws = tui.fullRedraws;
      view = workspace;
      input("i"); input("Retained 中文😀"); input("\r");
      for (const rows of [40, 8, 9, 12, 40]) {
        Object.assign(terminal, { rows });
        const output = render();
        expect(strip(output)).toContain("Rejected");
        expect(output).toContain(theme.fg("warning", "").split("\x1b[39m")[0]);
        expect(output).toContain(formatKeyHint(["Esc", "Back"], theme));
      }
      expect(submit).toHaveBeenCalledExactlyOnceWith("Retained 中文😀");
      view = tasks; input("\r");
      expect(render()).toContain(formatKeyHint(["o", "Reference"], theme));
      input("c");
      for (const [columns, rows] of [[100, 40], [40, 24], [28, 12], [180, 80], [100, 40]] as const) {
        Object.assign(terminal, { columns, rows });
        const output = render();
        expect(strip(output)).toContain(columns < 40 ? "A#1" : "A · Run #1");
        expect(strip(output)).toContain(columns < 40 ? "B#2" : "B · Run #2");
        expect(position.selectedId).toBe(1);
      }
      input("\x1b[B"); render();
      const firstScroll = position.scroll;
      expect(firstScroll).toBeGreaterThan(0);
      input("\t"); expect(position.selectedId).toBe(2);
      expect(strip(render())).toContain("Result 2 中文😀");
      input("a"); expect(accept).toHaveBeenLastCalledWith(2);
      input("\t"); render();
      expect(position.selectedId).toBe(1);
      expect(position.scroll).toBe(firstScroll);
      expect(tui.fullRedraws).toBeGreaterThanOrEqual(redraws); // Resizes may redraw; stable input must not.
      const settled = tui.fullRedraws;
      writes.length = 0;
      input("\t"); render(); input("\t"); render();
      expect(tui.fullRedraws).toBe(settled);
      expect(writes.join("")).not.toMatch(/\x1b\[(?:2J|3J)/);
    } finally { workspace.dispose(); tui.stop(); bold.mockRestore(); vi.useRealTimers(); }
  });
});
