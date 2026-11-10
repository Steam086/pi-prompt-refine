import { getKeybindings, TuiAltScreen, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters as strip } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { TaskPanel, type TaskPanelPosition } from "../../src/task-panel.js";
import { workspaceLayout } from "../../src/workspace-overlay.js";
import { getThemeByName } from "../support/pi-theme.js";
import { createRecordingTerminal } from "../support/recording-terminal.js";
import { record } from "../support/task-panel.js";

// Exercise the connected tree through both real Pi renderer paths.
describe.each(["regular", "fullscreen"] as const)("task tree rendering (%s)", (mode) => {
  it.each(["dark", "light"])("retains connected guides, selection and action targets through focus and resize (%s)", (name) => {
    vi.useFakeTimers();
    const { terminal, writes, input } = createRecordingTerminal({ rows: 60, columns: 160 });
    const tui = mode === "regular" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
    const theme = getThemeByName(name)!;
    const bold = vi.spyOn(theme, "bold").mockImplementation((text) => `\x1b[1m${text}\x1b[22m`);
    const records = [record(1), record(2), record(3, 2)];
    for (const record of records) record.archivedAt = 1;
    records[0]!.input.draft = "Original 中文😀\x1b[2J";
    records[1]!.input.model.id = "模型😀\x1b[2J";
    const position: TaskPanelPosition = { selectedTaskId: 1 };
    const accept = vi.fn();
    const run = vi.fn();
    const remove = vi.fn(() => true);
    const panel = new TaskPanel({ records: () => records, appliedId: () => undefined, activate: () => false,
      run, stop() {}, accept, deleteRecords: remove }, theme, () => terminal.rows, getKeybindings(), true, position,
      (width) => workspaceLayout(width, terminal.rows));
    const view = { render: (width: number) => panel.render(width), invalidate: () => panel.invalidate(),
      handleInput: (data: string) => { panel.handleInput(data); tui.requestRender(); } };
    const render = () => {
      tui.renderNow();
      const frame = panel.render(terminal.columns);
      expect(frame).toHaveLength(workspaceLayout(terminal.columns, terminal.rows).height);
      expect(frame.every((line) => visibleWidth(line) <= terminal.columns)).toBe(true);
      expect(frame.join("\n")).not.toContain("\x1b[2J");
      return frame;
    };
    const left = (frame: string[]) => frame.filter((line) => line.includes(theme.fg("muted", " │ ")))
      .map((line) => strip(line.split(theme.fg("muted", " │ "))[0]!).trimEnd());
    tui.addChild(view); tui.setFocus(view);
    try {
      tui.start();
      const initial = render();
      const root = left(initial).findIndex((line) => line.includes("› ▾ Earlier · Original prompt"));
      expect(root).toBeGreaterThanOrEqual(0);
      expect(left(initial)[root + 1]).toContain("  │ Original 中文😀");
      expect(left(initial)[root + 2]!.trim()).toBe("│");
      expect(strip(writes.join(""))).toContain("├─ 模型😀");
      input("\x1b[B");
      const selected = render();
      const active = selected.findIndex((line) => strip(line).includes("› ├─ 模型😀"));
      expect(selected[active]).toContain(theme.fg("muted", "├─ "));
      expect(selected[active]).toContain(theme.bg("selectedBg", "probe").split("probe")[0]);
      expect(strip(selected[active + 1]!)).toContain("  │  Run #2");
      expect(position.selectedId).toBe(2);
      input("\t"); render();
      input("\x1b[B"); render(); // Scroll the summary, not the selected run.
      expect(position.selectedId).toBe(2);
      input("\t"); input("\x1b[B");
      const last = left(render());
      const lastAt = last.findIndex((line) => line.includes("› └─ model-1"));
      expect(last[lastAt + 1]!.trimStart()).toBe("Run #1 · openai-codex · 23s");
      expect(last[lastAt + 2]!.trim()).toBe("");
      for (const [columns, rows] of [[45, 14], [160, 14], [100, 40], [160, 60]]) {
        Object.assign(terminal, { columns, rows }); view.invalidate(); render();
        expect(position.selectedId).toBe(1);
        expect(position.selectedTaskId).toBeUndefined();
      }
      const redraws = tui.fullRedraws;
      writes.length = 0;
      input("\x1b[A"); render();
      input("d");
      expect(strip(render().join("\n"))).toContain("Delete run #2?");
      input("n"); render();
      input("a"); render();
      expect(accept).toHaveBeenCalledExactlyOnceWith(2);
      expect(remove).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(tui.fullRedraws).toBe(redraws);
      expect(writes.join("")).not.toMatch(/\x1b\[(?:2J|3J)/);
    } finally { tui.stop(); bold.mockRestore(); vi.useRealTimers(); }
  });
});
