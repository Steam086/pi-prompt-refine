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
  it.each([false, true])("makes revisions explicit and exposes their source texts (usage: %s)", (usage) => {
    const revised = record(2);
    revised.kind = "revise"; revised.parentId = 1;
    revised.input.revision = { instruction: "Keep **literal** commands", previousCandidate: "BEFORE_REVISION" };
    const { panel, text } = create("dark", usage, [revised]);
    panel.handleInput("\r");
    expect(text()).toContain("✓ Revised"); expect(text()).toContain("Revision of run #1");
    expect(text()).toContain("Revised result");
    if (!usage) panel.handleInput("o"); // Scroll the reference column, not the result.
    let all = "";
    for (let i = 0; i < 8; i++) { all += text() + "\n"; panel.handleInput("\x1b[6~"); }
    for (const expected of ["Original prompt", revised.input.draft, "Revision instruction", "Keep **literal** commands", "Before revision", "BEFORE_REVISION"]) expect(all).toContain(expected);
    if (usage) expect(all.indexOf("Revision instruction")).toBeLessThan(all.indexOf("Usage · tokens"));
    else expect(all).not.toContain("Usage · tokens");
    if (usage) panel.handleInput("o");
    else for (let i = 0; i < 8; i++) panel.handleInput("\x1b[5~");
    expect(text()).toContain(revised.input.draft);
  });

  it.each(["dark", "light"])("uses a 65/35 Preview with compact metadata in %s", (name) => {
    const revised = record(2);
    revised.kind = "revise";
    revised.input.revision = { instruction: "Keep commands 中文😀", previousCandidate: "Previous result" };
    const { panel, text } = create(name, false, [revised]);
    panel.handleInput("\r");
    const output = text(100);
    expect(output).toContain("model-2 · ✓ Revised");
    expect(output).toContain("openai-codex · Thinking xhigh · 23s · ↑2.3k ↓670 · Cost —");
    const columns = output.split("\n").filter((line) => line.includes(" │ "));
    const left = columns.map((line) => line.split(" │ ")[0]!).join("\n");
    const right = columns.map((line) => line.split(" │ ")[1]!).join("\n");
    expect(visibleWidth(columns[0]!.split(" │ ")[0]!) - 2).toBe(Math.floor((panelLayout(100, 40).innerWidth - 3) * 0.65));
    expect(left).toContain("Revised result");
    expect(left).toContain("Result 2");
    expect(left).not.toContain("Original prompt");
    expect(right).toContain(revised.input.draft);
    expect(right).toContain("Revision instruction");
    expect(right).toContain("Keep commands 中文😀");
    for (const hidden of ["Usage · tokens", "Cache read", "Reference cost · USD", "Preferences"]) expect(output).not.toContain(hidden);
    const narrow = text(80);
    expect(narrow).not.toContain(" │ ");
    expect(narrow).toContain("Result 2");
    expect(narrow).not.toContain(revised.input.draft);
    panel.handleInput("o");
    expect(text(80)).toContain(revised.input.draft);
    expect(text(80)).toContain("Keep commands 中文😀");
    expect(text(80)).not.toContain("Result 2");
    panel.handleInput("o");
    expect(text(80)).toContain("Result 2");
  });

  it("scrolls result and reference independently across resize and snapshots without changing action targets", () => {
    const revised = record(2);
    revised.kind = "revise";
    revised.input.draft = Array.from({ length: 70 }, (_, i) => `Original line ${i}`).join("\n");
    revised.input.revision = { instruction: "REFERENCE_END", previousCandidate: "BEFORE_END" };
    revised.candidate!.text = Array.from({ length: 70 }, (_, i) => `Result line ${i}`).join("\n");
    const { panel, text, actions } = create("dark", false, [revised]);
    panel.handleInput("\r");
    text();
    panel.handleInput("\x1b[6~");
    const resultPage = text().split("\n").filter((line) => line.includes(" │ ")).map((line) => line.split(" │ ")[0]);
    expect(text()).not.toContain("Result line 0");
    expect(text()).toContain("Original line 0");
    panel.handleInput("o");
    let references = "";
    for (let i = 0; i < 10; i++) { references += text(); panel.handleInput("\x1b[6~"); }
    expect(references).toContain("REFERENCE_END");
    expect(references).toContain("BEFORE_END");
    expect(text().split("\n").filter((line) => line.includes(" │ ")).map((line) => line.split(" │ ")[0])).toEqual(resultPage);
    expect(text(80)).toContain("REFERENCE_END");
    const frozen = panel.snapshot();
    expect(frozen.render(100)).toEqual(panel.render(100));
    panel.handleInput("o");
    expect(text(80)).not.toContain("Result line 0");
    panel.handleInput("a");
    expect(actions.accept).toHaveBeenCalledWith(2);
    expect(actions.activate).not.toHaveBeenCalled();
    panel.handleInput("o"); panel.handleInput("\x1b");
    expect(text()).toContain("Prompt refine · Tasks");
    expect(text().split("\n").filter((line) => line.includes(" │ ")).map((line) => line.split(" │ ")[1]).join("\n")).not.toContain("Original line 0");
  });

  it.each(["dark", "light"])("bounds revised references at the split breakpoint and sanitizes literal text in %s", (name) => {
    const revised = record(2);
    revised.kind = "revise";
    const unsafe = "中文😀 **literal**\x1b[2J\x1b]52;c;payload\x07";
    revised.input.draft = unsafe.repeat(30);
    revised.input.revision = { instruction: unsafe.repeat(30), previousCandidate: unsafe.repeat(30) };
    const { panel, size } = create(name, false, [revised]);
    panel.handleInput("\r");
    for (size.rows of [40, 16, 8, 5]) for (const width of [1, 12, 40, 80, 93, 94, 100, 200]) {
      for (const key of ["o", "\x1b[6~", "o", "\x1b[5~"]) {
        panel.handleInput(key);
        const lines = panel.render(width);
        expect(lines).toHaveLength(panelLayout(width, size.rows).height);
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
        expect(lines.join("\n")).not.toContain("\x1b[2J");
        expect(lines.join("\n")).not.toContain("\x1b]52");
      }
    }
  });

  it("labels unsuccessful revisions without claiming they produced a revised result", () => {
    const revised = record(2);
    revised.kind = "revise"; revised.parentId = 1; revised.status = "error"; revised.error = "timeout"; revised.candidate = undefined;
    revised.input.revision = { instruction: "Keep commands", previousCandidate: "BEFORE_REVISION" };
    const { panel, text } = create("dark", true, [revised]); panel.handleInput("\r");
    expect(text()).toContain("Timed out"); expect(text()).toContain("Revision of run #1");
    expect(text()).not.toContain("Revised result"); expect(text()).toContain(revised.input.draft);
  });
  it.each(["dark", "light"])("prioritizes readable content and bold duration in %s", (name) => {
    const { panel, records, theme, text } = create(name);
    const result = records[0]!;
    const output = panel.render(100).join("\n");
    expect(output).toContain(theme.fg("text", theme.bold("23s")));
    expect(text()).toContain("↑2.3k ↓670 · Cost —");
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
    expect(text()).not.toContain("Uses earlier conversation context");
    expect(text()).toContain("Earlier ·");
    panel.handleInput("\r");
    panel.handleInput("o");
    let details = "";
    for (let i = 0; i < 6; i++) { details += text(80); panel.handleInput("\x1b[6~"); }
    expect(details).toContain("Earlier context");
    for (let i = 0; i < 6; i++) panel.handleInput("\x1b[5~");
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

  it("explains reasoning-only truncation even for restored runs without a budget snapshot", () => {
    const failed: RefineRecord = { ...record(), status: "error", error: "truncated", candidate: undefined,
      usage: { input: 1513, cacheRead: 256, cacheWrite: 0, output: 2048, reasoning: 2048, totalTokens: 3817 } };
    failed.input.contextUnavailable = true;
    const { panel, text } = create("dark", true, [failed]);
    panel.handleInput("\r");
    const output = text(120);
    expect(output).toContain("All reported output tokens were reasoning.");
    expect(output).toContain("Increase maxOutputTokens or lower/disable thinking");
    expect(output).toMatch(/Output \(total\)\s+2,048/);
    expect(output).not.toContain("Background reduced");
  });

  it("does not label an advisory budget warning as background trimming", () => {
    const r = record();
    r.input.budget = { status: "ok", inputTokens: 100, outputTokens: 2048, safetyTokens: 4096,
      contextWindow: 128000, outputLimit: 2048, removedMessages: 0, removedProjectParts: [],
      message: "DeepSeek thinking shares the output limit." };
    const { text } = create("dark", true, [r]);
    expect(text(140)).toContain("Shared output limit");
    expect(text(140)).not.toContain("Background reduced");
    expect(text(140)).toContain("⚠");
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

  it("keeps cache and reference-cost explanations in Usage details, not the summary", () => {
    const { panel, records, text } = create("dark", true);
    records[0]!.usage = { input: 200, cacheRead: 800, cacheWrite: 0, output: 300, cost: { total: 0.012, cacheRead: 0.001 }, subscription: true };
    expect(text()).toContain("↑1k ↓300 · ≈$0.012 (sub)");
    expect(text()).not.toContain("Cache hit");
    panel.handleInput("\r");
    let details = "";
    for (let i = 0; i < 7; i++) { details += text(); panel.handleInput("\x1b[6~"); }
    expect(details).toContain("80.0%");
    expect(details).toContain("Cache read: $0.001000");
    expect(details).toContain("not actual billing or subscription quota");
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

  it.each([80, 100, 160])("right-aligns variable statuses without reserving a fixed column at %s", (width) => {
    const { records, text } = create("dark", false, [record(1), record(2), record(3)]);
    records[0]!.input.model.id = "模型😀";
    records[1]!.acceptedAt = 1;
    records[2]!.status = "generating";
    const children = text(width).split("\n").filter((line) => /[├└]/.test(line)).map((line) => line.split(" │ ")[0]!.trimEnd());
    expect(children).toHaveLength(3);
    expect(new Set(children.map(visibleWidth)).size).toBe(1);
    expect(children.some((line) => line.includes("模型😀"))).toBe(true);
    expect(children.every((line) => !line.includes(" · "))).toBe(true);
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

describe("delete confirmation", () => {
  it("requires explicit confirmation and captures the selected run", () => {
    const { panel, actions, text, position } = create();
    const remove = vi.fn(() => true);
    Object.assign(actions, { deleteRecords: remove });
    expect(text()).toContain("Delete");
    panel.handleInput("d");
    expect(text()).toContain("Delete run #1?");
    expect(text()).toContain("Running requests will be stopped");
    panel.handleInput("\r");
    panel.handleInput("\x1b[B");
    expect(remove).not.toHaveBeenCalled();
    expect(position.selectedId).toBe(1);
    panel.handleInput("\x1b");
    expect(panel.isConfirmingDelete()).toBe(false);
    panel.handleInput("d");
    panel.handleInput("y");
    expect(remove).toHaveBeenCalledWith([1]);
  });

  it("confirms the original's entire group without including later additions", () => {
    const { panel, actions, position, records, text } = create("dark", false, [record(1), record(2)]);
    const remove = vi.fn(() => true);
    Object.assign(actions, { deleteRecords: remove });
    position.selectedTaskId = 1;
    panel.handleInput("d");
    expect(text()).toContain("all 2 request(s)");
    records.push(record(3));
    panel.handleInput("y");
    expect(remove).toHaveBeenCalledWith([1, 2]);
  });
});

describe("stable Read/Select footer", () => {
  it.each(["dark", "light"])("keeps hint columns and visibility fixed across Tab toggles in %s", (name) => {
    const { panel } = create(name);
    for (let width = 20; width <= 140; width++) {
      const footer = () => panel.render(width).slice(-2).map(stripVTControlCharacters);
      const before = footer();
      panel.handleInput("\t");
      const after = footer();
      expect(after[0], `primary footer at width ${width}`).toBe(before[0]);
      expect(after[1]?.replace("Tab Select", "Tab Read  ").trimEnd(), `secondary footer at width ${width}`)
        .toBe(before[1]?.trimEnd());
      panel.handleInput("\t");
      expect(footer()).toEqual(before);
    }
  });
});
