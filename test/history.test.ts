import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { RefineHistory, type RefineRecord } from "../src/history.js";
import { TaskPanel, type TaskPanelPosition } from "../src/task-panel.js";
import { panelLayout } from "../src/panel-layout.js";
import { selectHistory } from "../src/context.js";
import type { RefineRequestInput } from "../src/controller.js";

const input: RefineRequestInput = {
  draft: "Original 原文😀", model: { provider: "provider", id: "model" }, sessionId: "session", branchLeafId: "leaf",
  history: selectHistory([], 12, 100), systemPrompt: "Policy", roundId: 1,
};
function record(id: number): RefineRecord {
  return { id, taskId: id, kind: "refine", createdAt: 1, input, status: "generated", usage: { totalTokens: 12 },
    candidate: { ...input, requestId: id, version: id, generation: 0, recordId: id, text: `Result ${id}\n` + "正文 中文😀\n".repeat(100) } };
}
function panel(records: RefineRecord[], usage = false, position: TaskPanelPosition = {}) {
  const actions = { records: () => records, appliedId: () => undefined, activate: vi.fn(() => true), run: vi.fn(), stop: vi.fn(), copy: vi.fn() };
  const theme = getThemeByName("dark")!;
  const instance = new TaskPanel(actions, theme, () => 40, getKeybindings(), usage, position);
  return { instance, actions, text: () => stripVTControlCharacters(instance.render(100).join("\n")) };
}

describe("runtime request journal", () => {
  it("bounds records, freezes snapshots and isolates sessions", () => {
    const history = new RefineHistory(2);
    const mutable = structuredClone(input);
    const first = history.start(1, mutable);
    mutable.draft = "Changed";
    expect(history.list("session")[0]?.input.draft).toBe(input.draft);
    history.captureInput(first, "Exact packet");
    const candidate = record(1).candidate!;
    history.update(first, { status: "generated", candidate, acceptedAt: 10 });
    candidate.text = "Changed externally";
    expect(history.list("session")[0]?.candidate?.text).toContain("Result 1");
    expect(history.list("session")[0]?.input.preparedInput).toBe("Exact packet");
    history.start(2, input);
    history.start(3, { ...input, sessionId: "other" });
    expect(history.list("session").map((record) => record.taskId)).toEqual([2]);
    expect(history.list("other")).toHaveLength(1);
  });
  it("never evicts unsent, queued or running work and archives only the matching round/session", () => {
    const history = new RefineHistory(3);
    history.start(1, input, undefined, "refine", "unsent");
    history.start(2, { ...input, roundId: 2 }, undefined, "refine", "queued");
    history.start(3, { ...input, sessionId: "other" });
    expect(history.canStart()).toBe(false);
    expect(() => history.start(4, input)).toThrow("full");
    history.archive("session", 1);
    expect(history.list("session").map((r) => r.archivedAt !== undefined)).toEqual([true, false]);
    expect(history.list("other")[0]?.archivedAt).toBeUndefined();
  });
});

describe("unified task / Usage browser", () => {
  it("browses without applying, Enter dispatches the selected ID, and exposes explicit run/stop/copy", () => {
    const records = [record(1), { ...record(2), status: "unsent" as const, candidate: undefined }];
    const before = structuredClone(records);
    const { instance, actions, text } = panel(records);
    expect(text()).toContain("Result 1");
    instance.handleInput("\x1b[B");
    expect(text()).toContain("Unsent");
    expect(actions.activate).not.toHaveBeenCalled();
    instance.handleInput("\r");
    expect(actions.activate).toHaveBeenCalledWith(2);
    for (const key of ["g", "x", "n"]) instance.handleInput(key);
    for (const action of [actions.run, actions.stop, actions.copy]) expect(action).toHaveBeenCalledWith(2);
    expect(records).toEqual(before);
  });
  it("keeps ID selection when requests finish, append or archive; older entries are dim but detail is legible", () => {
    const records = [record(1), record(2)];
    const position = { selectedId: 2 };
    const { instance, actions, text } = panel(records, true, position);
    text();
    records[0]!.archivedAt = 1;
    records.push(record(3));
    expect(text()).toContain("Result 2");
    instance.handleInput("\r");
    expect(actions.activate).toHaveBeenLastCalledWith(2);
    instance.handleInput("\x1b[A");
    expect(text()).toContain("Earlier context");
    expect(instance.render(100).join("\n")).toContain(getThemeByName("dark")!.fg("dim", "R1 · Earlier · Original 原文😀"));
  });
  it("shows manual edits and full reported usage without inventing totals", () => {
    const records = [{ ...record(1), usage: { input: 100, output: 20, reasoning: 10, cacheWrite: 0 } },
      { ...record(2), kind: "edit" as const }];
    const { instance, text } = panel(records, true);
    expect(text()).toContain("in 100 · out 20 · write 0 · think(out) 10");
    expect(text()).not.toContain("total 120");
    instance.handleInput("\x1b[B");
    expect(text()).toContain("Manual edit · no model call");
  });
  it("switches narrow terminals between list and readable detail and scrolls the whole result", () => {
    const { instance } = panel([record(1)]);
    expect(instance.render(40).join("\n")).not.toContain("Result 1");
    instance.handleInput("\t");
    expect(instance.render(40).join("\n")).toContain("Result 1");
    instance.handleInput("\x1b[6~");
    expect(instance.render(40).join("\n")).toContain("正文");
  });
  it.each(["dark", "light"])("bounds split/list/detail across resize and sanitizes controls in %s", (name) => {
    let rows = 40;
    const records = Array.from({ length: 30 }, (_, i) => ({ ...record(i + 1), input: { ...input, draft: "Safe\x1b[2J 中文😀".repeat(30) } }));
    const instance = new TaskPanel({ records: () => records, appliedId: () => undefined, activate: () => false, run() {}, stop() {}, copy() {} },
      getThemeByName(name)!, () => rows, getKeybindings());
    for (rows of [40, 16, 8, 5]) for (const width of [1, 2, 12, 20, 40, 80, 100, 200]) {
      for (const key of ["\x1b[B", "\t", "\x1b[6~", "o", "h"]) {
        instance.handleInput(key);
        const lines = instance.render(width);
        expect(lines).toHaveLength(panelLayout(width, rows).height);
        for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        expect(lines.join("\n")).not.toContain("\x1b[2J");
      }
    }
  });
});
