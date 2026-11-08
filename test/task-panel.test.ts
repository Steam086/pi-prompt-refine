import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getKeybindings, Text, visibleWidth } from "@earendil-works/pi-tui";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { selectHistory } from "../src/context.js";
import type { RefineRecord } from "../src/history.js";
import { panelLayout } from "../src/panel-layout.js";
import { TaskPanel, type TaskPanelPosition } from "../src/task-panel.js";
import { sanitizeTerminalText } from "../src/presentation.js";

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
    editOriginal: vi.fn(), chooseModel: vi.fn(), accept: vi.fn(), revise: vi.fn(), preferences: vi.fn(), preferencesKey: "alt+p" as const, launchModel: () => "Default model" };
  const panel = new TaskPanel(actions, theme, () => size.rows, getKeybindings(), usage, position);
  const text = (width = 100) => stripVTControlCharacters(panel.render(width).join("\n"));
  return { panel, theme, size, position, actions, records, text };
}
afterEach(() => vi.restoreAllMocks());

describe("prompt tree and inspection", () => {
  it.each(["dark", "light"])("keeps neighbouring runs visible without moving the action target on resize (%s)", (name) => {
    const f = create(name, false, Array.from({ length: 24 }, (_, i) => record(24 - i)));
    for (const [width, rows] of [[100, 40], [45, 14], [100, 20]]) {
      f.size.rows = rows!; f.position.selectedTaskId = undefined; f.position.selectedId = 24;
      for (let id = 24; id >= 1; id--) {
        const frame = f.panel.render(width!);
        const left = frame.map((line) => stripVTControlCharacters(line).split("│")[0]).join("\n");
        expect(left).toMatch(new RegExp(`model-${id}(?!\\d)`));
        if (id > 1) expect(left).toMatch(new RegExp(`model-${id - 1}(?!\\d)`));
        const active = frame.find((line) => stripVTControlCharacters(line).includes("›"))!;
        expect(active).toContain(f.theme.bg("selectedBg", "probe").split("probe")[0]);
        expect(frame.every((line) => visibleWidth(line) <= width!)).toBe(true);
        expect(f.panel.render(width!)).toEqual(frame);
        expect(f.position.selectedId).toBe(id);
        f.panel.handleInput("\x1b[B");
      }
      for (let id = 2; id <= 24; id++) {
        f.panel.handleInput("\x1b[A");
        const left = f.text(width!).split("\n").map((line) => line.split("│")[0]).join("\n");
        expect(f.position.selectedId).toBe(id);
        if (id < 24) expect(left).toMatch(new RegExp(`model-${id + 1}(?!\\d)`));
      }
    }
    expect(f.actions.activate).not.toHaveBeenCalled();
    expect(f.actions.run).not.toHaveBeenCalled();
  });

  it.each(["dark", "light"])("follows only an explicitly submitted run in %s, including queued starts and resize", (name) => {
    for (const usage of [false, true]) for (const status of ["generating", "queued"] as const) {
      const draft = record(2, 2);
      draft.status = "unsent"; draft.candidate = undefined;
      draft.input.draft = "Draft 中文😀\x1b[2J";
      const f = create(name, usage, [draft, record(1)]);
      Object.assign(f.position, { selectedTaskId: 2, scroll: 8, scrolls: { "task-2": 8 } });
      f.actions.run.mockImplementation(() => { draft.status = status; });
      f.panel.handleInput("\r");
      expect(f.actions.run).toHaveBeenCalledExactlyOnceWith(2);
      expect(f.position.selectedId).toBe(2);
      expect(f.position.selectedTaskId).toBeUndefined();
      expect(f.position.scroll).toBe(0);
      expect(f.position.scrolls?.["task-2"]).toBe(8);
      for (const [width, rows] of [[100, 40], [40, 12], [120, 50]]) {
        f.size.rows = rows!;
        const lines = f.panel.render(width!);
        expect(lines.length).toBeLessThanOrEqual(rows!);
        for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width!);
        const selected = lines.find((line) => stripVTControlCharacters(line).includes("›"))!;
        expect(stripVTControlCharacters(selected)).toContain("└ model-2");
        const selectionStyle = f.theme.bg("selectedBg", "probe").split("probe")[0]!;
        expect(selectionStyle).toMatch(/\x1b\[/);
        expect(selected).toContain(selectionStyle);
        expect(lines.join("\n")).not.toContain("\x1b[2J");
      }
      f.panel.handleInput("\x1b[B"); // Browse another original before completion.
      const position = structuredClone(f.position);
      draft.status = "generated"; draft.candidate = record(2, 2).candidate;
      f.panel.render(100);
      expect(f.position).toEqual(position);
      expect(f.actions.activate).not.toHaveBeenCalled();
    }
  });

  it("keeps the Unsent original selected when explicit startup is rejected", () => {
    const draft = record(); draft.status = "unsent"; draft.candidate = undefined;
    const f = create("dark", false, [draft]);
    Object.assign(f.position, { selectedTaskId: draft.taskId, scroll: 3 });
    f.panel.handleInput("\r");
    expect(f.actions.run).toHaveBeenCalledExactlyOnceWith(draft.id);
    expect(f.position.selectedTaskId).toBe(draft.taskId);
    expect(f.position.scroll).toBe(3);
    expect(f.text()).toContain("› ○ Unsent");
  });

  it("opens selected result details before direct Revise and blocks removed shortcuts", () => {
    const { panel, actions, text, position, records } = create("dark", false, [record(1), record(2)]);
    position.selectedId = 2;
    panel.handleInput("e"); expect(actions.editOriginal).not.toHaveBeenCalled();
    panel.handleInput("f");
    expect(actions.revise).toHaveBeenCalledExactlyOnceWith(2);
    expect(text()).toContain("Prompt details");
    expect(actions.activate).not.toHaveBeenCalled();
    for (const key of ["n", "g", "p", "r", "z", "v", "[", "]"]) expect(panel.handleInput(key)).toBe(true);
    expect(actions.editOriginal).not.toHaveBeenCalled(); expect(actions.run).not.toHaveBeenCalled();
    panel.handleInput("\x1b"); expect(text()).toContain("Prompt refine · Tasks");
    records[1]!.input.contextUnavailable = true;
    panel.handleInput("f"); expect(text()).toContain("Background not saved");
    expect(actions.revise).toHaveBeenCalledTimes(1);
    position.selectedTaskId = 1; panel.handleInput("f");
    expect(actions.revise).toHaveBeenCalledTimes(1);
  });

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
    for (const hidden of ["Usage · tokens", "Cache read", "Reference cost · USD"]) expect(output).not.toContain(hidden);
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

  it.each(["dark", "light"])("keeps Prompt details typography semantic in %s across focus and resize", (name) => {
    const revised = record(2);
    revised.kind = "revise"; revised.parentId = 1;
    revised.input.model.id = "模型😀\x1b[1m";
    revised.input.draft = "Original 中文😀";
    revised.input.revision = { instruction: "Keep **literal**", previousCandidate: "Before 中文" };
    revised.candidate!.text = "Result **literal**\x1b[1m";
    const { panel, theme, size, position, actions } = create(name, false, [revised, record(1)]);
    Object.assign(actions, { deleteRecords: vi.fn(() => true) });
    // Chalk disables attributes in a non-TTY test process; exercise real SGR weight boundaries.
    vi.spyOn(theme, "bold").mockImplementation((value) => `\x1b[1m${value}\x1b[22m`);
    panel.handleInput("\r");
    const heading = (text: string) => theme.fg("text", theme.bold(text));
    const muted = (text: string) => theme.fg("muted", text);
    const output = panel.render(100).join("\n");
    for (const label of ["Prompt details", "#2 模型😀�[1m", "Revised result", "Original prompt", "Revision instruction"]) {
      expect(output).toContain(heading(label));
    }
    expect(output).toContain(theme.bg("toolPendingBg", heading(" Preview ")));
    for (const label of ["Selected: ", " Usage ", " Settings ", "openai-codex · Thinking xhigh", "23s", "Revision of run #1", " │ ", " · "]) {
      expect(output).toContain(muted(label));
    }
    expect(output).toContain(muted("─".repeat(panelLayout(100, size.rows).innerWidth)));
    expect(output).toContain(theme.fg("text", "模型😀�[1m") + muted(" · ") + theme.fg("success", "✓ Revised"));
    expect(output).not.toContain(theme.bold("23s"));
    for (const label of ["Result **literal**�[1m", revised.input.draft, revised.input.revision.instruction]) {
      expect(output).toContain(theme.fg("text", label));
      expect(output).not.toContain(theme.bold(label));
    }
    for (const [key, label] of [["↑↓", "scroll result"], ["o", "Reference"], ["i", "Edit original"], ["a", "Accept"], ["s", "Send to Pi"]] as const) {
      expect(output).toContain(heading(key));
      expect(output).toContain(muted(label));
      expect(output).not.toContain(theme.bold(label));
    }
    panel.handleInput("o");
    const narrow = panel.render(80).join("\n");
    expect(narrow).toContain(heading("o") + " " + muted("Result"));
    expect(narrow).toContain(theme.fg("text", revised.input.draft));
    expect(position.selectedId).toBe(2);
    panel.handleInput("\x1b[6~"); panel.render(80);
    panel.handleInput("\x1b[5~");
    expect(panel.render(100).join("\n")).toContain(heading("Revision instruction"));
    for (const [width, rows] of [[28, 40], [40, 8]] as const) {
      size.rows = rows;
      const lines = panel.render(width);
      expect(lines).toHaveLength(panelLayout(width, rows).height);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(lines.at(-1)).toContain(heading("Esc") + " " + muted("Back"));
    }
    size.rows = 40;
    panel.handleInput("d");
    const confirmation = panel.render(100).join("\n");
    expect(confirmation).toContain(heading("Delete request"));
    expect(confirmation).toContain(theme.fg("warning", "Delete run #2?"));
    expect(confirmation).toContain(heading("Esc / n") + " " + muted("Cancel"));
    panel.handleInput("\x1b");
    expect(panel.render(100).join("\n")).toContain(heading("Prompt details"));
  });

  it.each([80, 94, 100, 180])("gives list, Enter details and Compare exactly one split owner at width %s", (width) => {
    const revised = record(1);
    revised.kind = "revise";
    revised.input.revision = { instruction: "REVISION_REFERENCE", previousCandidate: "Before" };
    const { panel, text } = create("dark", false, [revised, record(2)]);
    const columns = () => {
      const lines = text(width).split("\n");
      expect(lines.every((line) => line.split(" │ ").length <= 2)).toBe(true);
      return lines.filter((line) => line.includes(" │ "));
    };
    let panes = columns();
    expect(panes.some((line) => /[├└]/.test(line.split(" │ ")[0]!))).toBe(true);
    expect(panes.map((line) => line.split(" │ ")[1]).join("\n")).not.toContain("REVISION_REFERENCE");
    panel.handleInput("\r");
    panes = columns();
    if (width >= 94) {
      expect(panes[0]).toContain("Revised result");
      expect(panes[0]).toContain("Original prompt");
      expect(panes.some((line) => /[├└]/.test(line))).toBe(false);
      expect(panes.map((line) => line.split(" │ ")[1]).join("\n")).toContain("REVISION_REFERENCE");
    } else {
      expect(panes).toHaveLength(0);
      panel.handleInput("o");
      expect(text(width)).toContain("REVISION_REFERENCE");
    }
    panel.handleInput("c");
    panes = columns();
    expect(text(width)).toContain("Compare results");
    expect(panes.map((line) => line.split(" │ ")[0]).join("\n")).toContain("model-1");
    expect(panes.map((line) => line.split(" │ ")[1]).join("\n")).toContain("model-2");
    panel.handleInput("\x1b");
    expect(text(width)).toContain("Prompt refine · Tasks");
    expect(columns().some((line) => /[├└]/.test(line))).toBe(true);
  });

  it("does not render an unused full-width pane before rendering Compare", () => {
    const { panel } = create("dark", false, [record(), record(2)]);
    panel.handleInput("\r"); panel.handleInput("c");
    const render = vi.spyOn(Text.prototype, "render");
    panel.render(100);
    expect(render).toHaveBeenCalled();
    expect(render.mock.calls.map(([width]) => width)).not.toContain(panelLayout(100, 40).innerWidth);
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

  it("orders all Usage tasks and runs newest first, keeps archived work last and preserves selection", () => {
    const older = { ...record(9, 3), archivedAt: 1 };
    const { panel, position, records, text } = create("dark", true, [record(1), record(2, 2), record(3), older]);
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
    let details = "";
    for (let i = 0; i < 6; i++) { details += text(80); panel.handleInput("\x1b[6~"); }
    expect(details).toContain("Earlier context");
    for (let i = 0; i < 6; i++) panel.handleInput("\x1b[5~");
    const fg = vi.spyOn(getThemeByName("dark")!, "fg");
    expect(text()).toContain("正文 中文😀");
    expect(fg).not.toHaveBeenCalledWith("dim", records[0]!.candidate!.text);
  });

  it.each(["dark", "light"])("keeps archived and restored trees out of Preview, including stale remembered selections (%s)", (name) => {
    const old = { ...record(9, 3), archivedAt: 1 };
    const restored = { ...record(10, 4), archivedAt: 2, input: { ...record(10, 4).input, contextUnavailable: true } };
    const f = create(name, false, [old, restored, record(2, 2)]);
    expect(f.text()).toContain("model-2");
    expect(f.text()).not.toContain("model-9");
    expect(f.text()).not.toContain("model-10");
    expect(f.position.selectedTaskId).toBe(2);
    f.panel.handleInput("\x1b[B"); f.panel.handleInput("a");
    expect(f.actions.accept).toHaveBeenCalledExactlyOnceWith(2);
    const usage = create(name, true, f.records);
    expect(usage.text()).toContain("Earlier ·");
    expect(usage.text()).toContain("model-9");
    expect(usage.text()).toContain("model-10");
  });

  it.each(["dark", "light"])("retains only an open archived view until explicit Back, without following late completions (%s)", (name) => {
    for (const inspecting of [false, true]) {
      const f = create(name, false, [record(1), record(2, 2)]);
      f.text(); // Establish a live viewing target, not merely a stale saved position.
      if (inspecting) f.panel.handleInput("\r");
      const archived = f.records[0]!;
      archived.archivedAt = 1;
      f.records[1]!.archivedAt = 1;
      f.records.push(record(3, 3));
      const saved = structuredClone(f.position);
      for (const [width, rows] of [[100, 40], [40, 24], [20, 12], [100, 40]]) {
        f.size.rows = rows!;
        const frame = f.panel.render(width!);
        expect(frame.every((line) => visibleWidth(line) <= width!)).toBe(true);
        expect(f.position.selectedId).toBe(saved.selectedId);
        expect(f.position.selectedTaskId).toBe(saved.selectedTaskId);
        expect(f.position.scroll).toBe(saved.scroll);
        if (width! >= 40) {
          expect(stripVTControlCharacters(frame.join("\n"))).toContain("Earlier");
          expect(stripVTControlCharacters(frame.join("\n"))).toContain("Result 1");
        }
      }
      f.records[1]!.candidate!.text = "Late old result";
      expect(f.text()).not.toContain("Late old result");
      expect(f.text()).not.toContain("model-2");
      f.panel.handleInput("a");
      expect(f.actions.accept).toHaveBeenCalledExactlyOnceWith(1);
      f.panel.handleInput("\x1b");
      expect(f.text()).toContain("model-3");
      expect(f.text()).not.toContain("Earlier · kept open");
      expect(f.position.selectedId).toBe(3);
      expect(f.actions.run).not.toHaveBeenCalled();
    }
  });

  it("exposes archived background work in Usage without restoring it to Preview", () => {
    const running: RefineRecord = { ...record(1), archivedAt: 1, status: "generating", candidate: undefined };
    const f = create("dark", false, [running, record(2, 2)]);
    expect(f.text()).toContain("Earlier: 1 running / queued");
    expect(f.text()).not.toContain("model-1");
    const usage = create("dark", true, f.records);
    usage.panel.handleInput("x");
    expect(usage.actions.stop).toHaveBeenCalledExactlyOnceWith(1);
    running.status = "generated";
    running.candidate = record(1).candidate;
    expect(f.text()).not.toContain("Earlier: 1");
    expect(f.text()).toContain("model-2");
    expect(f.position.selectedId).toBe(2);
  });

  it("does not submit or edit an Unsent whose open view has just been archived", () => {
    const source: RefineRecord = { ...record(), status: "unsent", candidate: undefined };
    const f = create("dark", false, [source]);
    f.text(); source.archivedAt = 1;
    f.panel.handleInput("\r");
    expect(f.text()).toContain("Earlier");
    expect(f.text()).not.toContain("Enter Run");
    expect(f.actions.run).not.toHaveBeenCalled();
    f.panel.handleInput("\x1b");
    expect(f.text()).not.toContain("Original prompt");
  });

  it("uses selectable original roots; Enter runs unsent and otherwise inspects without Apply", () => {
    const draft: RefineRecord = { ...record(), status: "unsent", candidate: undefined };
    const { panel, actions, text, position } = create("dark", false, [draft]);
    expect(text()).toContain("Original prompt");
    expect(position.selectedTaskId).toBe(1);
    panel.handleInput("i"); panel.handleInput("e"); panel.handleInput("n"); panel.handleInput("m");
    expect(actions.editOriginal.mock.calls).toEqual([[1], []]);
    expect(actions.chooseModel).toHaveBeenCalledWith(1);
    panel.handleInput("\r");
    expect(actions.run).toHaveBeenCalledWith(1);
    draft.status = "generated";
    panel.handleInput("\r");
    expect(text()).toContain("Prompt details");
    expect(actions.activate).not.toHaveBeenCalled();
  });

  it("opens Preferences for empty, original and child rows, equally before and after Inspect", () => {
    for (const status of ["unsent", "queued", "generating", "generated"] as const) {
      for (const contextUnavailable of [false, true]) {
        const source = { ...record(), status, input: { ...record().input, contextUnavailable } };
        const f = create("dark", false, [source]);
        f.position.selectedTaskId = 1;
        f.panel.handleInput("p"); f.panel.handleInput("\x1bp");
        expect(f.actions.preferences.mock.calls).toEqual([[1, true], [1, true]]);
        f.panel.handleInput("?"); expect(f.text()).toContain("p Preferences");
        f.panel.handleInput("p"); expect(f.actions.preferences).toHaveBeenCalledTimes(2);
        f.panel.handleInput("\x1b");
        if (status !== "unsent") {
          for (const original of [true, false]) {
            f.position.selectedTaskId = original ? 1 : undefined; f.position.selectedId = 1;
            f.panel.handleInput("p"); f.panel.handleInput("\r"); f.panel.handleInput("p");
            expect(f.actions.preferences.mock.calls.slice(-2)).toEqual([[1, original], [1, original]]);
            expect(f.text()).toContain("p Preferences");
            f.panel.handleInput("\x1b");
          }
        }
        expect(f.actions.run).not.toHaveBeenCalled(); expect(f.actions.activate).not.toHaveBeenCalled();
      }
    }
    const f = create("light", false, []);
    expect(f.text()).toContain("p Preferences");
    f.panel.handleInput("p"); expect(f.actions.preferences).toHaveBeenCalledWith(undefined, undefined);
  });

  it.each(["dark", "light"])("shows selected Unsent snapshots with neutral semantic styling and bounded %s layouts", (name) => {
    const source = { ...record(), status: "unsent" as const, candidate: undefined };
    source.input.preferences = [{ id: "a", scope: "project", version: 1, name: "Bullets 中文😀\x1b[2J", body: "Keep **literal** 中文😀", sourceBody: "Keep **literal** 中文😀" }];
    source.input.editingInstruction = source.input.preferences[0]!.body;
    const f = create(name, false, [source]);
    const full = f.panel.render(100).join("\n");
    expect(full).toContain(f.theme.fg("muted", sanitizeTerminalText(`Preferences: 1 · ${source.input.preferences[0]!.name}`)));
    expect(f.text()).toContain("p Preferences");
    expect(full).not.toContain("\x1b[2J");
    for (const [width, rows] of [[100, 40], [40, 16], [20, 8], [12, 6], [100, 40]]) {
      f.size.rows = rows!;
      for (const key of ["\t", "\x1b[B", "\x1b[6~", "\x1b[5~", "\t"]) {
        f.panel.handleInput(key);
        const lines = f.panel.render(width!);
        expect(lines).toHaveLength(panelLayout(width!, rows!).height);
        for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width!);
        expect(lines.join("\n")).not.toContain("\x1b[2J");
      }
    }
    expect(f.text(40)).toContain("P:1");
    expect(f.actions.run).not.toHaveBeenCalled();
    f.panel.handleInput("\r"); expect(f.actions.run).toHaveBeenCalledExactlyOnceWith(1);
  });

  it.each(["dark", "light"])("keeps submitted initial requirements literal in result references and Usage (%s)", (name) => {
    const source = record();
    source.input.editingInstruction = "Keep **literal** 中文😀";
    for (const usage of [false, true]) {
      const f = create(name, usage, [source]);
      f.panel.handleInput("\r");
      if (!usage) f.panel.handleInput("o");
      const full = f.panel.render(100).join("\n");
      expect(full).toContain(f.theme.fg("text", source.input.editingInstruction));
      expect(f.text()).toContain("Initial editing instruction");
      const narrow = f.panel.render(80);
      expect(narrow).toHaveLength(panelLayout(80, f.size.rows).height);
      expect(stripVTControlCharacters(narrow.join("\n"))).toContain(source.input.editingInstruction);
      expect(f.actions.run).not.toHaveBeenCalled();
    }
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
    expect(panel.handleInput("e")).toBe(false);
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

describe("short and narrow feedback", () => {
  it.each(["dark", "light"])("keeps overflow diagnostics scrollable in %s", (name) => {
    const failed = record();
    failed.status = "error"; failed.error = "truncated"; failed.candidate = undefined;
    failed.usage = { output: 2048, reasoning: 2048 };
    const { panel, size, theme } = create(name, false, [failed]);
    panel.handleInput("\r");
    for (const [width, rows] of [[100, 12], [40, 8], [20, 12], [100, 40]] as const) {
      size.rows = rows;
      let all = "";
      for (let i = 0; i < 100; i++) {
        const lines = panel.render(width);
        expect(lines).toHaveLength(panelLayout(width, rows).height);
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
        all += stripVTControlCharacters(lines.join("\n")).replace(/\n\s*/g, "") + "\n";
        panel.handleInput("\x1b[B");
      }
      expect(all).toContain("Error: truncated");
      expect(all.replace(/\s+/g, " ")).toContain("maxOutputTokens");
      for (let i = 0; i < 100; i++) panel.handleInput("\x1b[5~");
    }
    size.rows = 12;
    panel.render(100);
    const frames = panel.render(100).join("\n");
    expect(frames).toContain(theme.fg("error", "Error: truncated"));
  });

  it.each(["dark", "light"])("keeps short-layout notices visible and full feedback readable in %s", (name) => {
    const restored = record(); restored.input.contextUnavailable = true;
    const { panel, size, position, actions, text } = create(name, false, [restored]);
    size.rows = 12;
    panel.handleInput("m");
    expect(text(100)).toContain("Background not saved");
    panel.handleInput("\x1b[B");
    expect(text(100)).toContain("Background not saved");
    size.rows = 8;
    expect(text(40)).toContain("Background not saved");
    expect(text(40)).toContain("? Help");
    panel.handleInput("?");
    let all = "";
    for (let i = 0; i < 40; i++) {
      // At eight terminal rows the document viewport is one line, so assemble
      // that viewport rather than inserting repeated frame chrome into the text.
      all += stripVTControlCharacters(panel.render(40)[2]!).trim() + " ";
      panel.handleInput("\x1b[B");
    }
    expect(all).toContain("Press i to copy into current round");
    for (const key of ["a", "s", "f", "d", "m", "i", "\x1b[C", "\x1b[D"]) panel.handleInput(key);
    expect(actions.accept).not.toHaveBeenCalled(); expect(actions.activate).not.toHaveBeenCalled();
    expect(actions.chooseModel).not.toHaveBeenCalled(); expect(actions.editOriginal).not.toHaveBeenCalled();
    expect(position.selectedId).toBe(1);
    panel.handleInput("\x1b");
    expect(text(100)).toContain("Background not saved");
  });

  it.each(["dark", "light"])("prioritizes core actions and offers complete read-only help in %s", (name) => {
    const { panel, text, size, position, actions, theme } = create(name);
    vi.spyOn(theme, "bold").mockImplementation((value) => `\x1b[1m${value}\x1b[22m`);
    panel.handleInput("\r");
    for (const width of [20, 40, 80, 100]) {
      const output = text(width);
      expect(output).toContain("a Accept");
      expect(output).toMatch(/s Send(?: to Pi)?/);
      expect(output).toMatch(/\? (Help|Actions)/);
      expect(output).toContain("Esc Back");
      const styled = panel.render(width).join("\n");
      for (const [key, label] of [["a", "Accept"], ["s", width < 60 ? "Send" : "Send to Pi"], ["Esc", "Back"]]) {
        expect(styled).toContain(theme.fg("text", theme.bold(key!)) + " " + theme.fg("muted", label!));
        expect(styled).not.toContain(theme.bold(label!));
      }
    }
    panel.handleInput("?");
    let all = "";
    for (let i = 0; i < 50; i++) { all += text(40); panel.handleInput("\x1b[B"); }
    for (const action of ["Accept", "Send to Pi", "Edit result", "Revise"]) expect(all).toContain(action);
    for (const key of ["a", "s", "f", "m"]) panel.handleInput(key);
    expect(actions.accept).not.toHaveBeenCalled(); expect(actions.activate).not.toHaveBeenCalled();
    expect(position.selectedId).toBe(1);
    panel.handleInput("\x1b");
    size.rows = 8;
    expect(text(40)).toContain("a Accept"); expect(text(40)).toContain("s Send");
    expect(text(40)).toContain("? Help"); expect(text(40)).not.toContain("Enter Inspect");
    panel.handleInput("a"); expect(actions.accept).toHaveBeenCalledWith(1);
  });

  it("only advertises comparison focus switching when a comparison is active", () => {
    const { panel, text } = create("dark", false, [record(1), record(2)]);
    panel.handleInput("\r"); panel.handleInput("?");
    let help = "";
    for (let i = 0; i < 20; i++) { help += text(); panel.handleInput("\x1b[B"); }
    expect(help).not.toContain("Switch compared result");
    panel.handleInput("\x1b"); panel.handleInput("c"); panel.handleInput("?");
    help = "";
    for (let i = 0; i < 20; i++) { help += text(); panel.handleInput("\x1b[B"); }
    expect(help).toContain("Switch compared result");
  });

  it("describes the current arrow-key focus without changing the selected target", () => {
    const { panel, text, position } = create();
    expect(text(40)).toContain("↑↓ select");
    panel.handleInput("\t");
    expect(text(40)).toContain("↑↓ scroll"); expect(text(100)).toContain("↑↓ scroll");
    panel.handleInput("\x1b[B");
    expect(position.selectedId).toBe(1);
    panel.handleInput("\t"); expect(text(40)).toContain("↑↓ select");
  });
});

describe("history storage details", () => {
  it.each(["dark", "light"])("shows live status, saved IDs, omissions and a sanitized path in %s", (name) => {
    const { panel, actions, size, position, text, theme } = create(name, true);
    const status = { state: "saved" as "saved" | "save-error", path: "/项目/中文😀\x1b[2J/session.jsonl.prompt-refine.json", savedIds: [1], memoryOnlyIds: [2], omittedIds: [2] };
    Object.assign(actions, { historyStorage: () => status });
    expect(text(40)).toContain("b Storage");
    panel.handleInput("b");
    const first = panel.render(100).join("\n");
    expect(first).toContain("Confirmed saved runs"); expect(first).toContain("#1");
    expect(first).toContain("Memory-only / pending runs"); expect(first).toContain("#2");
    expect(first).not.toContain("\x1b[2J");
    status.state = "save-error";
    expect(panel.render(100).join("\n")).toContain(theme.fg("error", "Save failed · saving paused until reload"));
    for (const [width, rows] of [[20, 12], [40, 8], [100, 40]] as const) {
      size.rows = rows;
      for (const key of ["\x1b[H", "\x1b[6~", "\x1b[F"]) {
        panel.handleInput(key);
        const lines = panel.render(width);
        expect(lines).toHaveLength(panelLayout(width, rows).height);
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      }
    }
    panel.handleInput("a"); panel.handleInput("m"); panel.handleInput("d");
    expect(actions.accept).not.toHaveBeenCalled(); expect(actions.chooseModel).not.toHaveBeenCalled();
    panel.handleInput("\x1b"); expect(position.selectedId).toBe(1);
    expect(text()).toContain("Usage · All rounds");
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
