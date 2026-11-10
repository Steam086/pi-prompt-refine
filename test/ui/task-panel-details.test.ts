import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RefineRecord } from "../../src/history.js";
import { formatKeyHint } from "../../src/key-hints.js";
import { panelLayout } from "../../src/panel-layout.js";
import { create, record } from "../support/task-panel.js";

afterEach(() => vi.restoreAllMocks());
describe("prompt tree and inspection", () => {

  it.each(["dark", "light"])("reserves detail navigation beside long Unicode model identities (%s)", (name) => {
    const source = record(); source.input.model.id = "模型😀\x1b[31m".repeat(20);
    const { panel, theme, position } = create(name, false, [source]);
    panel.handleInput("\r");
    for (const width of [20, 28, 40, 80, 100, 160, 40]) {
      const lines = panel.render(width);
      const subtitle = lines[2]!;
      expect(stripVTControlCharacters(subtitle)).toContain("#1");
      expect(stripVTControlCharacters(subtitle)).toContain("…");
      expect(subtitle).toContain(formatKeyHint(["o", width === 20 ? "Ref" : "Reference"], theme));
      expect(lines.every((line) => visibleWidth(line) <= Math.min(width, 100))).toBe(true);
      expect(lines.join("\n")).not.toContain("\x1b[31m");
      expect(position.selectedId).toBe(1);
    }
  });

  it.each(["dark", "light"])("identifies both compared runs across narrow layouts and target switches (%s)", (name) => {
    const records = [record(1), record(2)];
    records[1]!.input.model.id = records[0]!.input.model.id; // Same model, distinct runs.
    const { panel, theme, position, actions, size } = create(name, false, records);
    panel.handleInput("\r"); panel.handleInput("c");
    for (const selected of [1, 2, 1]) {
      for (const width of [100, 60, 40, 28, 20, 100]) {
        const lines = panel.render(width);
        const output = stripVTControlCharacters(lines.join("\n"));
        expect(output).toContain("Compare results");
        expect(output).toContain(width < 40 ? "A#1" : "A · Run #1");
        expect(output).toContain(width < 40 ? "B#2" : "B · Run #2");
        expect(lines).toHaveLength(panelLayout(width, size.rows).height);
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
        expect(position.selectedId).toBe(selected);
        if (width < 76) {
          expect(output).toContain(`Result ${selected}`);
          expect(output).not.toContain(`Result ${3 - selected}`);
          const peer = selected === 1 ? "B" : "A";
          expect(lines.join("\n")).toContain(formatKeyHint(["Tab", width < 40 ? `${peer}#${3 - selected}` : `${peer} · Run #${3 - selected}`], theme));
        } else {
          expect(output).toContain("Result 1"); expect(output).toContain("Result 2");
        }
      }
      panel.handleInput("a"); expect(actions.accept).toHaveBeenLastCalledWith(selected);
      panel.handleInput("\t");
    }
    expect(actions.activate).not.toHaveBeenCalled();
    expect(actions.run).not.toHaveBeenCalled();
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
      expect(lines.some((line) => line.includes(heading("Esc") + " " + muted("Back")))).toBe(true);
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
});
