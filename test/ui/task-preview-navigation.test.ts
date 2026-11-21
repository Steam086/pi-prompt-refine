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
});
