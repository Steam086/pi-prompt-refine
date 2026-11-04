import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getKeybindings, Text, visibleWidth } from "@earendil-works/pi-tui";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { selectHistory } from "../src/context.js";
import type { RefineRecord } from "../src/history.js";
import { panelLayout } from "../src/panel-layout.js";
import { TaskPanel, type TaskPanelPosition } from "../src/task-panel.js";

function record(id = 1, taskId = 1): RefineRecord {
  const input = { draft: "本项目的原始要求", model: { provider: "openai-codex", id: `model-${id}` }, thinkingLevel: "xhigh" as const,
    sessionId: "session", branchLeafId: "private-branch", roundId: 1, systemPrompt: "Policy", history: selectHistory([], 12, 100) };
  return { id, taskId, kind: "refine", input, status: "generated", createdAt: id, elapsedSeconds: 23,
    usage: { totalTokens: 2989, input: 2319, output: 670, cacheRead: 0, cacheWrite: 0, reasoning: 585 },
    candidate: { ...input, requestId: id, version: 1, generation: 0, recordId: id, text: `Result ${id}\n正文 中文😀\nAnother line` } };
}
function create(name = "dark", usage = false, records = [record()]) {
  const theme = getThemeByName(name)!;
  const size = { rows: 40 };
  const position: TaskPanelPosition = { selectedId: records[0]?.id };
  const actions = { records: () => records, appliedId: () => undefined, activate: vi.fn(() => true), run: vi.fn(), stop: vi.fn(), copy: vi.fn(),
    editOriginal: vi.fn(), chooseModel: vi.fn(), accept: vi.fn(), launchModel: () => "Default model" };
  const panel = new TaskPanel(actions, theme, () => size.rows, getKeybindings(), usage, position);
  const text = (width = 100) => stripVTControlCharacters(panel.render(width).join("\n"));
  return { panel, theme, size, position, actions, records, text };
}
afterEach(() => vi.restoreAllMocks());

describe("prompt tree and inspection", () => {
  it.each(["dark", "light"])("prioritizes readable content and bold duration in %s", (name) => {
    const { panel, records, theme, text } = create(name);
    const result = records[0]!;
    const output = panel.render(100).join("\n");
    expect(output).toContain(theme.fg("text", theme.bold("23s")));
    expect(text()).toContain("2,989 tokens");
    expect(text()).toContain("Thinking xhigh");
    for (const hidden of ["Branch", "Frozen context", "Applied", "Round 1", "Cache read"]) expect(text()).not.toContain(hidden);
    result.status = "generating";
    result.candidate = undefined;
    expect(panel.render(100).join("\n")).toContain(theme.fg("accent", theme.bold("23s")));
    result.status = "queued";
    expect(text()).not.toContain("23s");
    expect(text()).toContain("Queued");
  });

  it("orders tasks and runs newest first, keeps archived work last and preserves selection", () => {
    const older = { ...record(9, 3), archivedAt: 1 };
    const { panel, position, records, text } = create("dark", false, [record(1), record(2, 2), record(3), older]);
    const output = text();
    const left = output.split("\n").filter((line) => line.includes(" │ ")).map((line) => line.split(" │ ")[0]).join("\n");
    expect(left.indexOf("model-3")).toBeLessThan(left.indexOf("model-1"));
    expect(left.indexOf("model-1")).toBeLessThan(left.indexOf("model-2"));
    expect(left.indexOf("model-2")).toBeLessThan(left.indexOf("model-9"));
    records.push(record(10, 4));
    expect(text()).toContain("Result 1");
    expect(position.selectedId).toBe(1);
    records[0]!.archivedAt = 1;
    expect(text()).toContain("Uses earlier conversation context");
    const fg = vi.spyOn(getThemeByName("dark")!, "fg");
    expect(text()).toContain("正文 中文😀");
    expect(fg).not.toHaveBeenCalledWith("dim", records[0]!.candidate!.text);
  });

  it("uses selectable original roots; Enter runs unsent and otherwise inspects without Apply", () => {
    const draft: RefineRecord = { ...record(), status: "unsent", candidate: undefined };
    const { panel, actions, text, position } = create("dark", false, [draft]);
    expect(text()).toContain("Original prompt");
    expect(position.selectedTaskId).toBe(1);
    panel.handleInput("i"); panel.handleInput("e"); panel.handleInput("n"); panel.handleInput("m");
    expect(actions.editOriginal.mock.calls).toEqual([[1], [1], []]);
    expect(actions.chooseModel).toHaveBeenCalledWith(1);
    panel.handleInput("\r");
    expect(actions.run).toHaveBeenCalledWith(1);
    draft.status = "generated";
    panel.handleInput("\r");
    expect(text()).toContain("Prompt details");
    expect(actions.activate).not.toHaveBeenCalled();
  });

  it("directly accepts/stops only the selected child, never its siblings or parent", () => {
    const { panel, actions, records, position } = create("dark", false, [record(), record(2)]);
    panel.handleInput("a");
    expect(actions.accept).toHaveBeenCalledWith(1);
    panel.handleInput("x");
    expect(actions.stop).not.toHaveBeenCalled();
    records[0]!.status = "generating";
    panel.handleInput("x");
    expect(actions.stop).toHaveBeenCalledWith(1);
    position.selectedTaskId = 1;
    panel.handleInput("a"); panel.handleInput("x");
    expect(actions.accept).toHaveBeenCalledTimes(1);
    expect(actions.stop).toHaveBeenCalledTimes(1);
    for (const key of ["s", "f", "g", "c", "[", "]", "d", "z"]) expect(panel.handleInput(key)).toBe(true);
    expect(actions.activate).not.toHaveBeenCalled();
  });

  it("inspects failed and active runs, and only applies on an explicit result action", () => {
    const { panel, actions, records, text } = create();
    records[0]!.status = "error"; records[0]!.error = "timeout"; records[0]!.candidate = undefined;
    panel.handleInput("\r");
    expect(text()).toContain("Timed out");
    expect(text()).toContain("Prompt details");
    panel.handleInput("e");
    expect(actions.activate).not.toHaveBeenCalled();
    records[0] = record();
    expect(panel.handleInput("f")).toBe(false);
    expect(actions.activate).toHaveBeenCalledWith(1);
  });

  it("compares sibling outputs and makes Tab change the exact acceptance target", () => {
    const { panel, text, actions, position } = create("dark", false, [record(), record(2)]);
    panel.handleInput("\r"); panel.handleInput("c");
    expect(text()).toContain("Compare results");
    expect(text()).toContain("Result 1");
    expect(text()).toContain("Result 2");
    panel.handleInput("\t"); panel.handleInput("a");
    expect(position.selectedId).toBe(2);
    expect(actions.accept).toHaveBeenCalledWith(2);
    expect(text(40)).toContain("Result 2");
    expect(text(40)).not.toContain("Result 1");
    panel.handleInput("\t");
    expect(text(40)).toContain("Result 1");
    panel.handleInput("\x1b");
    expect(text()).toContain("Prompt refine · Tasks");
  });

  it("pins the summary and remembers scroll separately for each result", () => {
    const { panel, records, text } = create("dark", false, [record(), record(2)]);
    records.forEach((r) => { r.candidate!.text += "\n" + Array.from({ length: 100 }, (_, i) => `Line ${i}`).join("\n"); });
    text();
    panel.handleInput("\t"); panel.handleInput("\x1b[6~");
    const scrolled = text();
    expect(scrolled).toContain("23s");
    expect(scrolled).not.toContain("Result 1");
    panel.handleInput("\t"); panel.handleInput("\x1b[A");
    expect(text()).toContain("Result 2");
    panel.handleInput("\x1b[B");
    expect(text().split("\n").filter((line) => line.includes(" │ "))).toEqual(scrolled.split("\n").filter((line) => line.includes(" │ ")));
  });

  it("keeps usage complete and distinguishes missing counts from explicit zero", () => {
    const { panel, text, records } = create("dark", true);
    records[0]!.candidate!.text = "Short";
    records[0]!.usage = { input: 100, output: 20, reasoning: 10, cacheWrite: 0 };
    panel.handleInput("\r");
    let all = "";
    for (let i = 0; i < 5; i++) { all += text() + "\n"; panel.handleInput("\x1b[6~"); }
    expect(all).toMatch(/Cache write\s+0/);
    expect(all).toMatch(/Cache read\s+—/);
    expect(all).toMatch(/Total\s+—/);
    expect(all).toMatch(/Reasoning\s+10/);
    expect(all).not.toContain("120 tokens");
    expect(all).not.toContain("private-branch");
  });

  it("does not rebuild the result body for elapsed-time ticks or scrolling", () => {
    const { panel, records } = create();
    records[0]!.status = "generating";
    const render = vi.spyOn(Text.prototype, "render");
    panel.render(100);
    render.mockClear();
    records[0]!.elapsedSeconds = 24;
    panel.render(100);
    expect(render).toHaveBeenCalledTimes(1); // Changed metric only.
    render.mockClear();
    panel.handleInput("\t"); panel.handleInput("\x1b[B"); panel.render(100);
    expect(render).not.toHaveBeenCalled();
  });

  it.each(["dark", "light"])("bounds tree, details and comparison at every viewport in %s", (name) => {
    const { panel, size } = create(name, false, [record(), record(2)]);
    for (size.rows of [40, 16, 8, 5]) for (const width of [1, 2, 12, 20, 40, 80, 100, 200]) {
      for (const key of ["\t", "\r", "c", "\t", "\x1b"]) {
        panel.handleInput(key);
        const lines = panel.render(width);
        expect(lines).toHaveLength(panelLayout(width, size.rows).height);
        for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it("sanitizes external data while preserving literal markdown", () => {
    const { panel, records, theme } = create();
    const unsafe = "unsafe\x1b[2J\x1b]52;c;payload\x07";
    records[0]!.input.model.id = unsafe;
    records[0]!.input.draft = unsafe;
    records[0]!.error = unsafe;
    records[0]!.candidate!.text = "# Literal heading\n**literal emphasis**\n" + unsafe;
    const fg = vi.spyOn(theme, "fg");
    panel.handleInput("\r");
    for (let i = 0; i < 5; i++) {
      const output = panel.render(100).join("\n");
      expect(output).not.toContain("\x1b[2J"); expect(output).not.toContain("\x1b]52");
      panel.handleInput("\x1b[6~");
    }
    expect(fg.mock.calls.some(([color, value]) => color === "text" && value.startsWith("# Literal heading\n**literal emphasis**"))).toBe(true);
  });

  it("truncates long model names without escaping its own ANSI resets or hiding the status", () => {
    const { records, text } = create();
    records[0]!.input.model.id = "claude-sonnet-long-model-name";
    records[0]!.status = "generating";
    records[0]!.candidate = undefined;
    const output = text(80);
    const child = output.split("\n").find((line) => line.includes("› └"))!;
    expect(child.split(" │ ")[0]).toContain("Running");
    expect(output).not.toContain("�");
    expect(output).not.toContain("[0m");
  });
});
