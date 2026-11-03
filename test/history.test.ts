import { describe, expect, it, vi } from "vitest";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { RefineHistory, type RefineRecord } from "../src/history.js";
import { HistoryPanel } from "../src/history-panel.js";
import { panelLayout } from "../src/panel-layout.js";
import { selectHistory } from "../src/context.js";
import type { Candidate, RefineRequestInput } from "../src/controller.js";

const input: RefineRequestInput = {
  draft: "Original 原文😀", model: { provider: "provider", id: "model" }, sessionId: "session", branchLeafId: "leaf",
  history: selectHistory([], 12, 100), systemPrompt: "Policy",
};

function record(id: number): RefineRecord {
  return { id, taskId: 1, kind: "refine", createdAt: 1, input, status: "generated", usage: { totalTokens: 12 },
    candidate: { ...input, requestId: id, version: id, generation: 0, recordId: id, text: `Result ${id}\n` + "正文 中文😀\n".repeat(100) } };
}

describe("runtime request journal", () => {
  it("bounds records, freezes snapshots and isolates sessions", () => {
    const history = new RefineHistory(2);
    const mutable = structuredClone(input);
    const first = history.start(1, mutable);
    mutable.draft = "Changed";
    expect(history.list("session")[0]?.input.draft).toBe(input.draft);
    history.captureInput(first, "Exact packet");
    const candidate: Candidate = record(1).candidate!;
    history.update(first, { status: "generated", candidate, acceptedAt: 10 });
    candidate.text = "Changed externally";
    expect(history.list("session")[0]?.candidate?.text).toContain("Result 1");
    expect(history.list("session")[0]?.input.preparedInput).toBe("Exact packet");
    history.start(2, input);
    history.start(3, { ...input, sessionId: "other" });
    expect(history.list("session").map((record) => record.taskId)).toEqual([2]);
    expect(history.list("other")).toHaveLength(1);
  });
});

describe("read-only History / Usage", () => {
  it("keeps navigation local, ignores mutation keys, and filters manual edits from Usage", () => {
    const back = vi.fn();
    const records = [record(1), { ...record(2), kind: "edit" as const }, { ...record(3), candidate: undefined, status: "error" as const }];
    const before = structuredClone(records);
    const panel = new HistoryPanel(records, getThemeByName("dark")!, () => 40, getKeybindings(), back);
    expect(panel.render(100).join("\n")).toContain("#2");
    panel.handleInput("\r");
    expect(panel.render(100).join("\n")).toContain("Result 2");
    for (const key of ["a", "e", "f", "s", "m", "c", "g", "r", "x", "h", "u", "\t"]) panel.handleInput(key);
    expect(records).toEqual(before);
    expect(back).not.toHaveBeenCalled();
    panel.handleInput("o");
    expect(panel.render(100).join("\n")).toContain("Original 原文");
    panel.handleInput("\x1b");
    const usagePanel = new HistoryPanel(records, getThemeByName("dark")!, () => 40, getKeybindings(), back, true);
    const usage = usagePanel.render(100).join("\n");
    expect(usage).toContain("#3");
    expect(usage).not.toContain("#2");
    expect(usage).toContain("total 12");
    panel.handleInput("q");
    expect(back).toHaveBeenCalledTimes(1);
  });

  it.each(["dark", "light"])("bounds list/detail, scroll and resize in %s", (name) => {
    let rows = 40;
    const panel = new HistoryPanel(Array.from({ length: 30 }, (_, i) => record(i + 1)), getThemeByName(name)!, () => rows, getKeybindings(), vi.fn());
    for (rows of [40, 16, 8, 5]) {
      for (const width of [1, 12, 20, 40, 100]) {
        for (const key of ["\x1b", "\x1b[B", "\x1b[6~", "\r", "\x1b[6~", "]", "o"]) {
          panel.handleInput(key);
          const lines = panel.render(width);
          expect(lines).toHaveLength(panelLayout(width, rows).height);
          for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        }
      }
    }
  });
});
