import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getKeybindings, Text, visibleWidth } from "@earendil-works/pi-tui";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { selectHistory } from "../src/context.js";
import type { RefineRecord } from "../src/history.js";
import { panelLayout } from "../src/panel-layout.js";
import { TaskPanel, type TaskPanelPosition } from "../src/task-panel.js";

function record(): RefineRecord {
  const input = {
    draft: "本项目在进行多轮请求，请说明上下文和缓存的复用方式。",
    model: { provider: "openai-codex", id: "gpt-6.1-sol" }, thinkingLevel: "xhigh" as const,
    sessionId: "session", branchLeafId: "b1c8ef9a", roundId: 1, systemPrompt: "Policy",
    history: selectHistory([], 12, 100),
  };
  return {
    id: 1, taskId: 1, kind: "refine", input, status: "generated",
    createdAt: new Date("2026-11-03T23:44:55").getTime(),
    sentAt: new Date("2026-11-03T23:45:25").getTime(), archivedAt: 1, elapsedSeconds: 23,
    usage: { totalTokens: 2989, input: 2319, output: 670, cacheRead: 0, cacheWrite: 0, reasoning: 585 },
    candidate: { ...input, requestId: 1, version: 1, generation: 0, recordId: 1, text: [
      "请结合本项目当前实现说明：", "1. 多轮请求之间的 cache 复用情况如何？",
      "2. 上下文中的 assistant/user 消息是逐轮累积，还是用过即弃？", "3. 默认会选取最近多少条消息作为上下文？",
    ].join("\n") },
  };
}

function create(name = "dark", usage = false) {
  const selected = record();
  const theme = getThemeByName(name)!;
  const size = { rows: 40 };
  const position: TaskPanelPosition = {};
  const actions = {
    records: () => [selected], appliedId: (): number | undefined => 1,
    activate: () => true, run() {}, stop() {}, copy() {}, launchModel: () => "openai-codex/gpt-6.1-sol",
  };
  const panel = new TaskPanel(actions, theme, () => size.rows, getKeybindings(), usage, position);
  return { panel, selected, theme, size, position, actions };
}

const plain = (lines: string[]) => lines.map(stripVTControlCharacters);
const details = (lines: string[]) => plain(lines).flatMap((line) => line.includes(" │ ") ? [line.split(" │ ")[1]!.trimEnd()] : []);
const stops = (line: string) => {
  let column = 0;
  return line.split(" · ").map((cell) => {
    const start = column;
    column += visibleWidth(cell) + 3;
    return start;
  });
};

afterEach(() => vi.restoreAllMocks());

describe("Tasks / Usage presentation", () => {
  it.each(["dark", "light"])("uses neutral bold headings, quiet metadata and legible archived prose in %s", (name) => {
    const { panel, selected, theme } = create(name);
    const fg = vi.spyOn(theme, "fg");
    const bold = vi.spyOn(theme, "bold");
    const lines = panel.render(100);
    const output = lines.join("\n");
    for (const heading of ["Round 1 · Task 1 · #1 refine", "Result"]) {
      expect(output).toContain(theme.fg("text", theme.bold(heading)));
    }
    expect(output).toContain(theme.fg("muted", "openai-codex/gpt-6.1-sol · thinking xhigh"));
    expect(output).toContain(theme.fg("success", "✓ Applied"));
    expect(output).toContain(theme.fg("muted", " · Earlier context · Archived"));
    expect(fg).toHaveBeenCalledWith("text", selected.candidate!.text);
    expect(fg).not.toHaveBeenCalledWith("dim", selected.candidate!.text);
    expect(bold).not.toHaveBeenCalledWith(selected.candidate!.text);
    expect(bold).not.toHaveBeenCalledWith("openai-codex/gpt-6.1-sol · thinking xhigh");
    const body = details(lines);
    const heading = body.indexOf("Result");
    expect(body[heading - 1]).toBe("");
    expect(body[heading + 1]).toBe("");
    // The screenshot-sized viewport still shows all four lines of the short result.
    expect(body.slice(heading + 2, heading + 6)).toEqual(selected.candidate!.text.split("\n"));
    expect(plain(lines).join("\n")).toContain("1 entry ·");
    panel.handleInput("o");
    expect(panel.render(100).join("\n")).toContain(theme.fg("text", theme.bold("Original prompt")));
    expect(fg).toHaveBeenCalledWith("text", selected.input.draft);
  });

  it.each([
    ["unsent", undefined, "warning", "○ Unsent"],
    ["queued", undefined, "accent", "… Queued"],
    ["generating", undefined, "accent", "◌ Running"],
    ["cancelled", undefined, "warning", "× Cancelled"],
    ["error", "timeout", "error", "! Timed out"],
    ["error", "provider failure", "error", "! Failed"],
    ["generated", undefined, "success", "✓ Done"],
  ] as const)("retains a textual and semantic status for %s / %s", (status, error, color, label) => {
    const { panel, selected, theme, actions } = create();
    actions.appliedId = () => undefined;
    Object.assign(selected, { status, error, archivedAt: undefined });
    selected.input.projectDiagnostics = { warnings: ["Directory listing omitted"], referencedDirectoryCount: 0 };
    const output = panel.render(100).join("\n");
    expect(output).toContain(theme.fg(color, label));
    expect(output).toContain(theme.fg("muted", " · Frozen context"));
    expect(output).toContain(theme.fg("warning", "Context warning: Directory listing omitted"));
    if (error) expect(output).toContain(theme.fg("error", `Error: ${error}`));
  });

  it.each([76, 80, 100])("wraps usage at item boundaries without orphan counts at width %i", (width) => {
    const { panel } = create();
    const body = details(panel.render(width));
    for (const metric of ["Tokens: total 2989", "in 2319", "out 670", "read 0", "write 0", "think(out) 585"]) {
      expect(body.some((line) => line.includes(metric))).toBe(true);
    }
    expect(body).not.toContain("0");
    expect(body.some((line) => line.endsWith(" ·") || line.startsWith("· "))).toBe(false);
  });

  it.each([false, true])("shares footer tab stops through resize, selection states and read mode (Usage: %s)", (usage) => {
    const { panel, selected, theme } = create("light", usage);
    for (const status of ["generated", "unsent", "error"] as const) {
      selected.status = status;
      if (status !== "generated") selected.candidate = undefined;
      for (const reading of [false, true]) {
        if (reading) panel.handleInput("\t");
        for (const width of [12, 20, 40, 60, 80, 100, 200]) {
          const styled = panel.render(width).slice(-2);
          const [top, bottom] = plain(styled);
          expect(stops(bottom!)).toEqual(stops(top!).slice(0, stops(bottom!).length));
          expect(bottom).toContain("Esc Back");
          if (status === "unsent") expect(top).toContain(width >= 80 ? "Refine (old context)" : "Refine old");
          expect(styled.join("\n")).toContain(theme.fg("text", theme.bold("Esc")));
          expect(styled.join("\n")).toContain(theme.fg("muted", "Back"));
          expect(styled.join("\n")).not.toContain("\t");
          for (const line of styled) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
          if (width >= 80) {
            for (const hint of ["Tab", "g", "x", "o"]) expect(top).toContain(hint);
            for (const hint of ["m Model", "i Input", "n"]) expect(bottom).toContain(hint);
            expect(bottom!.includes("h Earlier")).toBe(!usage);
          }
        }
        if (reading) panel.handleInput("\t");
      }
    }
  });

  it("prioritizes Back in a one-line footer and reflects the current Tab action", () => {
    const { panel, size } = create();
    size.rows = 8;
    for (const width of [12, 20, 40, 100]) {
      const lines = plain(panel.render(width));
      expect(lines).toHaveLength(panelLayout(width, size.rows).height);
      expect(lines.at(-1)?.trimStart()).toMatch(/^Esc Back/);
    }
    expect(plain(panel.render(100)).at(-1)).toContain("Tab Read");
    panel.handleInput("\t");
    expect(plain(panel.render(100)).at(-1)).toContain("Tab Select");
  });

  it("keeps cached layout while reading, and refreshes content, state and theme", () => {
    const { panel, selected, theme, actions } = create();
    selected.candidate!.text += "\n正文 中文😀".repeat(100);
    const render = vi.spyOn(Text.prototype, "render");
    panel.render(100);
    expect(render).toHaveBeenCalledTimes(1);
    panel.handleInput("\t");
    panel.handleInput("\x1b[B");
    panel.setNotice("Notice");
    panel.render(100);
    expect(render).toHaveBeenCalledTimes(1);
    panel.handleInput("\x1b[A");
    selected.usage!.cacheWrite = 5;
    expect(details(panel.render(100)).join("\n")).toContain("write 5");
    actions.appliedId = () => undefined;
    expect(details(panel.render(100)).join("\n")).toContain("✓ Done");
    const light = getThemeByName("light")!;
    vi.spyOn(theme, "fg").mockImplementation(light.fg.bind(light));
    panel.invalidate();
    expect(panel.render(100).join("\n")).toContain(light.fg("muted", "openai-codex/gpt-6.1-sol · thinking xhigh"));
    selected.candidate!.text = "Updated result";
    expect(details(panel.render(100)).join("\n")).toContain("Updated result");
  });

  it("sanitizes external fields before styling and retains literal prompt text", () => {
    const { panel, selected, actions, theme } = create();
    const unsafe = "unsafe\x1b[2J\x1b]52;c;payload\x07";
    selected.input.model.id = unsafe;
    selected.input.branchLeafId = unsafe;
    selected.input.draft = unsafe;
    selected.input.revision = { instruction: unsafe, previousCandidate: unsafe };
    selected.input.projectDiagnostics = { warnings: [unsafe], referencedDirectoryCount: 0 };
    selected.error = unsafe;
    selected.candidate!.text = "# Literal heading\n**literal emphasis**\n" + unsafe;
    actions.launchModel = () => unsafe;
    const fg = vi.spyOn(theme, "fg");
    panel.render(100);
    panel.handleInput("\t");
    for (let i = 0; i < 6; i++) {
      const output = panel.render(100).join("\n");
      expect(output).not.toContain("\x1b[2J");
      expect(output).not.toContain("\x1b]52");
      panel.handleInput("\x1b[6~");
    }
    // User-provided Markdown stays literal in this inspection pane.
    expect(fg.mock.calls.some(([color, value]) => color === "text" && value.startsWith("# Literal heading\n**literal emphasis**"))).toBe(true);
    for (const [, value] of fg.mock.calls) {
      expect(value).not.toContain("\x1b[2J");
      expect(value).not.toContain("\x1b]52");
    }
  });
});
