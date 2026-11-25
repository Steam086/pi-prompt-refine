import { getKeybindings } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { TaskPanel } from "../../src/task-panel.js";
import { workspaceLayout } from "../../src/workspace-overlay.js";
import { describe, expect, it } from "vitest";
import { create, record } from "../support/task-panel.js";

describe.each(["dark", "light"])("run preview navigation (%s)", theme => {
  it("keeps the selected prompt, provider, status and result together across resize", () => {
    const done = record(3, 2), running = record(2, 2), failed = record(1, 1);
    const prefix = "Please review these requested changes to ";
    for (const run of [done, running, failed]) {
      run.input.draft = prefix + (run.taskId === 2 ? "billing" : "privacy");
      run.input.model = { id: "shared", provider: run === running ? "beta" : "alpha" };
    }
    running.status = "generating"; delete running.candidate;
    failed.status = "error"; failed.error = "Model unavailable"; delete failed.candidate;
    const f = create(theme, false, [done, running, failed]);
    const { size, position } = f;
    const panel = new TaskPanel(f.actions, f.theme, () => size.rows, getKeybindings(), false, position,
      width => workspaceLayout(width, size.rows));
    const text = (width: number) => stripVTControlCharacters(panel.render(width).join("\n"));
    size.rows = 20;
    const frame = () => text(84);
    expect(frame()).toMatch(/›[^\n]*#3[^\n]*✓ Done/);
    expect(frame()).toContain("billing");
    expect(frame()).toContain("#3 · alpha");
    expect(panel.render(84).join("\n")).toContain(f.theme.fg("text", "#3") + f.theme.fg("muted", " · alpha"));
    expect(frame()).toContain("Result 3");
    expect(frame()).toContain("a: Editor only");
    expect(frame()).not.toContain("Thinking xhigh");
    panel.handleInput("\x1b[B");
    expect(frame()).toMatch(/›[^\n]*#2[^\n]*◌ Running/);
    expect(frame()).toContain("beta · Thinking");
    expect(frame()).not.toContain("a: Editor only");
    panel.handleInput("\x1b[B"); panel.handleInput("\x1b[B");
    expect(frame()).toMatch(/›[^\n]*! Failed/);
    expect(frame()).toContain("privacy");
    expect(frame()).toContain("Error: Model unavailable");
    expect(frame()).not.toContain("Result 3");
    panel.handleInput("\t");
    expect(text(60)).toContain("Error: Model unavailable");
    expect(position.selectedId).toBe(1);
    size.rows = 45;
    const wide = text(160).split("\n");
    const at = wide.findIndex(line => /›.*shared.*Failed/.test(line));
    expect(at).toBeGreaterThan(0);
    expect(wide[at + 1]).toContain("#1 · alpha");
    expect(wide.slice(0, at).join("\n")).toContain("privacy");
  });

  it("keeps the original's wide Preview excerpt stable on its run, without changing Usage", () => {
    const run = record(3);
    run.input.draft = "先检查这个显示问题，再区分原稿摘要和请求结果。😀\x1b[2J ".repeat(5);
    run.input.draft = `原稿开头 ${run.input.draft} 原稿结尾`;
    for (const usage of [false, true]) {
      const f = create(theme, usage, [run]);
      f.position.selectedTaskId = run.taskId;
      const panel = new TaskPanel(f.actions, f.theme, () => f.size.rows, getKeybindings(), usage, f.position,
        width => workspaceLayout(width, f.size.rows));
      for (const [columns, rows, spacious] of [[160, 50, true], [100, 24, false], [118, 40, true], [160, 50, true]] as const) {
        f.size.rows = rows;
        const split = f.theme.fg("muted", " │ ");
        const left = () => panel.render(columns).filter(line => line.includes(split)).map(line => line.split(split)[0]!);
        const parent = left();
        panel.handleInput("\x1b[B");
        const child = left();
        panel.handleInput("\x1b[A");
        expect(left()).toEqual(parent);
        const plain = (lines: string[]) => lines.map(line => stripVTControlCharacters(line).trim());
        const first = plain(parent), second = plain(child);
        for (const row of [...parent, ...child]) expect(row).not.toContain("\x1b[2J");
        const runAt = spacious ? 3 : 1;
        expect(first[runAt]).toContain("model-3");
        expect(second[runAt]).toMatch(/^› └─ model-3/);
        if (!spacious) continue;
        expect(first[0]).toMatch(/^› ▾ Original prompt/);
        expect(first.slice(1, 3)).toEqual(second.slice(1, 3));
        if (usage) expect(first[2]).toBe("│");
        else {
          expect(first[2]).toMatch(/^│ \S/);
          expect(parent[2]).toContain(f.theme.bg("selectedBg", "probe").split("probe")[0]);
        }
      }
      expect(f.actions.run).not.toHaveBeenCalled();
      expect(f.actions.activate).not.toHaveBeenCalled();
    }
  });
});
