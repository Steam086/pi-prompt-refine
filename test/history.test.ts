import { stripVTControlCharacters } from "node:util";
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
    expect(stripVTControlCharacters(panel.render(100).join("\n"))).toContain("Edited");
    panel.handleInput("\r");
    expect(panel.render(100).join("\n")).toContain("Result 2");
    for (const key of ["a", "e", "f", "s", "m", "c", "g", "r", "x", "h", "u", "\t"]) panel.handleInput(key);
    expect(records).toEqual(before);
    expect(back).not.toHaveBeenCalled();
    panel.handleInput("o");
    expect(panel.render(100).join("\n")).toContain("Original 原文");
    panel.handleInput("\x1b");
    const usagePanel = new HistoryPanel(records, getThemeByName("dark")!, () => 40, getKeybindings(), back, true);
    const usage = stripVTControlCharacters(usagePanel.render(100).join("\n"));
    expect(usage).toContain("Failed");
    expect(usage).not.toContain("Edited");
    expect(usage).toMatch(/Done +— +12 +model/);
    panel.handleInput("q");
    expect(back).toHaveBeenCalledTimes(1);
  });

  it.each(["dark", "light"])("uses one-line summaries, right-aligned models and a single state label in %s", (name) => {
    const theme = getThemeByName(name)!;
    const bold = vi.spyOn(theme, "bold");
    const bg = vi.spyOn(theme, "bg");
    const records = [record(1), record(2), record(3)].map((entry, index) => ({ ...entry,
      input: { ...entry.input, draft: `Draft ${index + 1} 中文😀\n  continuation`, model: { provider: "hidden-provider", id: ["short", "模型😀", "model-name"][index]! } },
      ...(index === 1 ? { acceptedAt: 10 } : {}), ...(index === 2 ? { acceptedAt: 11, sentAt: 12 } : {}),
    }));
    const panel = new HistoryPanel(records, theme, () => 40, getKeybindings(), vi.fn());
    const lines = panel.render(100);
    const plain = lines.map(stripVTControlCharacters);
    const items = plain.filter((line) => line.includes("Draft "));
    expect(items).toHaveLength(3);
    expect(items[0]).toMatch(/› Draft 3 中文😀 continuation +Send accepted +model-name$/);
    expect(items[1]).toMatch(/Draft 2 中文😀 continuation +Accepted +模型😀$/);
    expect(items[2]).toMatch(/Draft 1 中文😀 continuation +Ready +short$/);
    for (const line of items) expect(visibleWidth(line)).toBe(98);
    expect(plain.join("\n")).not.toMatch(/T1|#\d|hidden-provider/);
    expect(plain.find((line) => line.includes("Request"))).toMatch(/Request +State +Model$/);
    expect(bold).toHaveBeenCalledWith("Draft 3 中文😀 continuation");
    expect(bold).not.toHaveBeenCalledWith("model-name");
    const highlighted = bg.mock.calls.find(([color]) => color === "selectedBg")![1];
    expect(visibleWidth(highlighted)).toBe(panelLayout(100, 40).innerWidth);
    expect(stripVTControlCharacters(highlighted)).toContain("Send accepted");
    // Within the viewport only the old and new selection rows change.
    panel.handleInput("\x1b[B");
    const next = panel.render(100);
    expect(next.filter((line, index) => line !== lines[index])).toHaveLength(2);
    panel.handleInput("\r");
    const details = stripVTControlCharacters(panel.render(100).join("\n"));
    expect(details).toContain("Task 1 · #2 refine");
    expect(details).toContain("hidden-provider/模型😀");
    expect(details).toContain("accepted into editor");
  });

  it.each([false, true])("fills the viewport, pages by visible rows and backfills after resize (usage=%s)", (usage) => {
    let rows = 40;
    const records = Array.from({ length: 30 }, (_, index) => ({ ...record(index + 1), input: { ...input, draft: `Request-${index + 1}` } }));
    const panel = new HistoryPanel(records, getThemeByName("dark")!, () => rows, getKeybindings(), vi.fn(), usage);
    const render = () => panel.render(100).map(stripVTControlCharacters);
    const first = render();
    const capacity = first.filter((line) => line.includes("Request-")).length;
    expect(capacity).toBe(14);
    expect(first.join("\n")).toContain("1–14/30");
    panel.handleInput("\x1b[6~");
    expect(render().find((line) => line.includes("› "))).toContain(`Request-${30 - capacity}`);
    panel.handleInput("\x1b[5~");
    expect(render().find((line) => line.includes("› "))).toContain("Request-30");
    rows = 16;
    render();
    for (let i = 0; i < 30; i++) { panel.handleInput("\x1b[B"); render(); }
    expect(render().find((line) => line.includes("› "))).toMatch(/Request-1 +/);
    rows = 40;
    const expanded = render();
    expect(expanded.filter((line) => line.includes("Request-"))).toHaveLength(capacity);
    expect(expanded.join("\n")).toContain("17–30/30");
    panel.handleInput("\r");
    panel.render(100);
    panel.handleInput("\x1b[6~");
    const scrolled = render().join("\n");
    expect(scrolled).toContain("↑↓ 16–30/");
    panel.handleInput("\x1b");
    expect(render().find((line) => line.includes("› "))).toMatch(/Request-1 +/);
  });

  it("aligns Usage metrics, distinguishes missing from zero, and keeps the full breakdown in details", () => {
    const records: RefineRecord[] = [
      { ...record(1), input: { ...input, draft: "Partial" }, usage: { input: 100, output: 20, reasoning: 10 } },
      { ...record(2), input: { ...input, draft: "Zero" }, usage: { totalTokens: 0 }, elapsedSeconds: 0 },
      { ...record(3), input: { ...input, draft: "Failure" }, candidate: undefined, status: "error", error: "timeout", usage: undefined },
      { ...record(4), input: { ...input, draft: "Cancelled" }, candidate: undefined, status: "cancelled", usage: { totalTokens: 23 }, elapsedSeconds: 2 },
      { ...record(5), input: { ...input, draft: "Running" }, candidate: undefined, status: "generating", usage: undefined },
      { ...record(6), input: { ...input, draft: "Complete" }, elapsedSeconds: 12, usage: { totalTokens: 12345, input: 12000, output: 345, cacheRead: 50, cacheWrite: 0, reasoning: 100 } },
    ];
    const panel = new HistoryPanel(records, getThemeByName("dark")!, () => 40, getKeybindings(), vi.fn(), true);
    const lines = panel.render(100).map(stripVTControlCharacters);
    expect(lines.find((line) => line.includes("Request"))).toMatch(/Request +State +Time +Total tok +Model$/);
    expect(lines.find((line) => line.includes("Partial"))).toMatch(/Partial +Done +— +— +model$/);
    expect(lines.find((line) => line.includes("Zero"))).toMatch(/Zero +Done +0s +0 +model$/);
    expect(lines.find((line) => line.includes("Failure"))).toMatch(/Failure +Timed out +— +— +model$/);
    expect(lines.find((line) => line.includes("Cancelled"))).toMatch(/Cancelled +Cancelled +2s +23 +model$/);
    expect(lines.find((line) => line.includes("Running"))).toMatch(/Running +Running +— +— +model$/);
    expect(lines.find((line) => line.includes("Complete"))).toMatch(/Complete +Done +12s +12,345 +model$/);
    expect(lines.join("\n")).toContain("— not reported");
    const header = lines.find((line) => line.includes("Total tok"))!;
    const columnEnd = header.indexOf("Total tok") + "Total tok".length;
    for (const [draft, value] of [["Complete", "12,345"], ["Zero", "0"], ["Cancelled", "23"]]) {
      const line = lines.find((line) => line.includes(draft))!;
      expect(line.indexOf(value, line.indexOf("s ") + 2) + value.length).toBe(columnEnd);
    }
    panel.handleInput("\r");
    const details = stripVTControlCharacters(panel.render(100).join("\n"));
    expect(details).toContain("total 12345 · in 12000 · out 345 · read 50 · write 0 · think(out) 100");
  });

  it.each([false, true])("truncates long Unicode summaries/models and sheds columns without wrapping (usage=%s)", (usage) => {
    const panel = new HistoryPanel([{ ...record(1), input: { ...input, draft: "Summary 中文😀é ".repeat(40), model: { provider: "provider", id: "模型-name-".repeat(30) } } }],
      getThemeByName("dark")!, () => 40, getKeybindings(), vi.fn(), usage);
    for (const width of [100, 88, 80, 72, 64, 48, 40, 32, 24]) {
      const lines = panel.render(width).map(stripVTControlCharacters);
      expect(lines.filter((line) => line.includes("Summary"))).toHaveLength(1);
      const item = lines.find((line) => line.includes("Summary"))!;
      expect(item).toContain("…");
      expect(visibleWidth(item)).toBe(width - 2);
      if (width === 40) expect(item).not.toContain("Ready");
      if (width === 24) expect(item).not.toContain("模型");
    }
  });

  it("sanitizes terminal controls in every list cell and preserves the raw snapshot", () => {
    const entry = { ...record(1), input: { ...input, draft: "Safe\x1b[31m\n\ttext", model: { provider: "p", id: "model\n\x1b[2J" } } };
    const before = structuredClone(entry);
    const panel = new HistoryPanel([entry], getThemeByName("dark")!, () => 40, getKeybindings(), vi.fn());
    const row = panel.render(100).map(stripVTControlCharacters).find((line) => line.includes("Safe"))!;
    expect(row).toContain("Safe�[31m text");
    expect(row).toContain("model �[2J");
    panel.handleInput("\r");
    expect(stripVTControlCharacters(panel.render(100).join("\n"))).toContain("model");
    expect(entry).toEqual(before);
  });

  it.each([false, true])("shows a quiet empty state without a table (usage=%s)", (usage) => {
    const back = vi.fn();
    const panel = new HistoryPanel([], getThemeByName("dark")!, () => 40, getKeybindings(), back, usage);
    const text = stripVTControlCharacters(panel.render(100).join("\n"));
    expect(text).toContain(usage ? "No model requests yet." : "No candidates yet.");
    expect(text).not.toContain("Model");
    for (const key of ["\r", "\x1b[6~", "\x1b[B", "o", "]"]) panel.handleInput(key);
    expect(stripVTControlCharacters(panel.render(100).join("\n"))).toBe(text);
    panel.handleInput("q");
    expect(back).toHaveBeenCalledOnce();
  });

  it.each(["dark", "light"])("bounds list/detail, scroll and resize in %s", (name) => {
    let rows = 40;
    for (const usage of [false, true]) {
      const panel = new HistoryPanel(Array.from({ length: 30 }, (_, i) => record(i + 1)), getThemeByName(name)!, () => rows, getKeybindings(), vi.fn(), usage);
      for (rows of [40, 16, 8, 5]) {
        for (const width of [1, 2, 12, 20, 40, 100]) {
          for (const key of ["\x1b", "\x1b[B", "\x1b[6~", "\r", "\x1b[6~", "]", "o"]) {
            panel.handleInput(key);
            const lines = panel.render(width);
            expect(lines).toHaveLength(panelLayout(width, rows).height);
            for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
          }
        }
      }
    }
  });
});
