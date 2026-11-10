import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";
// Test-only access to the installed Pi palettes; production uses the injected theme.
import { Markdown, Text, visibleWidth } from "@earendil-works/pi-tui";
import { panelLayout, panelTabs } from "../../src/panel-layout.js";
import { READING_WIDTH } from "../../src/presentation.js";
import { PreviewPanel, type PreviewOptions } from "../../src/preview.js";
import { getThemeByName } from "../support/pi-theme.js";

const identity = (text: string) => text;
const plainTheme = { bg: (_color: string, text: string) => text, fg: (_color: string, text: string) => text, bold: identity, italic: identity, underline: identity, strikethrough: identity };
const options: PreviewOptions = {
  state: { phase: "ready", requestId: 1, pendingSend: false, model: { provider: "openai-codex", id: "example-model" } },
  candidateText: "请优化本项目的 UI 视觉效果。\n\n## 重点\n- 保留 **用户目标** 与约束。\n- 让内容清晰、美观、易读。",
  draft: "这是原始草稿。",
  contextLabel: "Draft only",
  elapsedSeconds: 0,
  openHint: "ctrl+\\",
  canRestore: false,
};

function create(overrides: Partial<PreviewOptions> = {}, rows = 40) {
  return new PreviewPanel({ ...options, ...overrides }, plainTheme, () => rows, vi.fn());
}

describe("result reading panel", () => {
  it.each(["dark", "light"])("keeps editor-change feedback visible in compact scrolled references (%s)", (name) => {
    const theme = getThemeByName(name)!;
    const panel = new PreviewPanel({ ...options, draftChanged: true, candidateText: "Result\n".repeat(60), draft: "Original\n".repeat(60) },
      theme, () => 40, vi.fn());
    panel.setLayoutProvider((width) => panelLayout(width, 40, 18));
    panel.render(100); panel.toggleOriginal();
    for (const width of [100, 40, 20]) {
      const frame = panel.render(width);
      expect(frame).toHaveLength(18);
      expect(frame[2]).toContain(theme.fg("warning", "Editor changed"));
      panel.page(1);
      expect(panel.render(width)[2]).toContain(theme.fg("warning", "Editor changed"));
    }
  });

  it("keeps completed candidate metadata separate from a single action footer", () => {
    const panel = create({
      navigation: { index: 1, count: 2, label: "#5 refine" }, thinkingLevel: "xhigh",
      state: { ...options.state, usage: { totalTokens: 5969, input: 5634, output: 335, cacheRead: 0, cacheWrite: 0, reasoning: 315 } },
      contextLabel: "6 msgs · 6467 char · assistant · 2 rules · 0 skills",
    });
    const lines = panel.render(100);
    const text = lines.join("\n");
    expect(lines.find((line) => line.includes("#5 refine"))?.trim()).toBe("1/2 · #5 refine");
    expect(lines[2]).toContain("openai-codex/example-model · xhigh");
    expect(text.match(/xhigh/g)).toHaveLength(1);
    expect(lines[2]).not.toContain("6 msgs");
    expect(text).toContain("↑5.6k ↓335 · Cost —");
    expect(text).not.toContain("read 0");
    expect(text).not.toContain("think(out)");
    for (const hint of ["a Accept", "e Edit", "f Revise", "s Send", "i Input", "m Model", "g Same input", "q Back", "? Help"]) {
      expect(text.split(hint)).toHaveLength(2);
      expect(lines.slice(-2).join("\n")).toContain(hint);
    }
    for (const hint of ["c Cycle", "g Generate", "←/→ Page", "Candidates", "Accept puts"]) expect(text).not.toContain(hint);
    panel.toggleHelp();
    const help = panel.render(100).join("\n");
    panel.scrollBy(10);
    let fullHelp = help + "\n" + panel.render(100).join("\n");
    panel.scrollBy(10);
    fullHelp += "\n" + panel.render(100).join("\n");
    for (const hint of ["Accept puts", "Previous / next candidate", "c Cycle", "g Generate from the same frozen input", "6 msgs", "read 0", "think(out) 315"]) {
      expect(fullHelp).toContain(hint);
    }
  });

  it.each([12, 20, 40, 80, 100])("keeps comparison hints bounded and nonduplicated at %i columns", (width) => {
    const panel = create({ navigation: { index: 1, count: 2, label: "#5 refine" } });
    const lines = panel.render(width);
    expect(lines).toHaveLength(panelLayout(width, 40).height);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    const text = lines.join("\n");
    for (const hint of ["m Model", "g Same input", "i Input"]) expect(text.split(hint).length).toBeLessThanOrEqual(2);
    expect(text).not.toContain("←/→ Page");
    expect(lines.slice(-2).join("\n")).toContain("q Back");
    if (width >= 40) expect(lines.slice(-2).join("\n")).toContain("? Help");
  });

  it.each(["dark", "light"])("shows initial editing requirements as literal references and refreshes their cached body (%s)", (name) => {
    const theme = getThemeByName(name)!;
    const instruction = "Keep **literal** 中文😀";
    const initial = { ...options, candidateText: "Result", draft: "Original", editingInstruction: instruction };
    const panel = new PreviewPanel(initial, theme, () => 40, vi.fn());
    expect(stripVTControlCharacters(panel.render(100).join("\n"))).not.toContain("Initial editing instruction");
    panel.toggleOriginal();
    const shown = panel.render(100).join("\n");
    expect(shown).toContain(theme.fg("text", instruction));
    expect(stripVTControlCharacters(shown)).toContain("Initial editing instruction");
    panel.update({ ...initial, editingInstruction: "Updated requirements" });
    expect(stripVTControlCharacters(panel.render(100).join("\n"))).toContain("Updated requirements");
    panel.update({ ...initial, state: { ...initial.state, phase: "generating" }, candidateText: undefined });
    for (const width of [100, 40, 20, 12, 80]) {
      const lines = panel.render(width);
      expect(lines).toHaveLength(panelLayout(width, 40).height);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
    expect(stripVTControlCharacters(panel.render(100).join("\n"))).toContain(instruction);
  });

  it("remembers candidate reading positions across navigation and model-picker reopen", () => {
    const positions = new Map<string, number>();
    const first = { ...options, viewKey: "record-1", candidateText: Array.from({ length: 100 }, (_, i) => `A line ${i}`).join("\n") };
    const second = { ...options, viewKey: "record-2", candidateText: "B result" };
    const panel = new PreviewPanel(first, plainTheme, () => 40, vi.fn(), positions);
    panel.render(80);
    panel.scrollBy(25);
    const scrolled = panel.render(80);
    panel.update(second);
    expect(panel.render(80).join("\n")).toContain("B result");
    panel.update(first);
    expect(panel.render(80)).toEqual(scrolled);
    panel.rememberPosition();
    const reopened = new PreviewPanel(first, plainTheme, () => 40, vi.fn(), positions);
    expect(reopened.render(80)).toEqual(scrolled);
  });

  it("shows the literal submitted source while generating, then defaults to the result", () => {
    const draft = "## 原文\n保留 **字面符号** 与 `命令`。";
    const pending = { ...options, state: { ...options.state, phase: "generating" as const }, candidateText: undefined, draft };
    const panel = create(pending);
    const text = panel.render(80).join("\n");
    expect(text).toContain("Submitted original");
    expect(text).toContain(`${draft.length} chars`);
    expect(text).toContain("## 原文");
    expect(text).toContain("**字面符号**");
    panel.toggleOriginal(); // Already visible; must not queue a jump on completion.
    panel.update({ ...pending, draft: "B" });
    expect(panel.render(80).join("\n")).not.toContain("字面符号");
    panel.update({ ...options, draft, candidateText: "Completed result" });
    expect(panel.render(80).join("\n")).toContain("Completed result");
    expect(panel.render(80).join("\n")).not.toContain("字面符号");
    panel.toggleOriginal();
    expect(panel.render(80).join("\n")).toContain("**字面符号**");
  });

  it.each(["dark", "light"])("bounds and scrolls long submitted sources across resize in %s", (name) => {
    const draft = "START 中文😀 é 👩‍💻\n" + "一段很长的原文😀".repeat(1000) + "\n\nLAST 原文终点";
    let rows = 40;
    const panel = new PreviewPanel({ ...options, state: { ...options.state, phase: "generating" }, candidateText: undefined, draft },
      getThemeByName(name)!, () => rows, vi.fn());
    for (rows of [40, 16, 8, 5]) {
      for (const width of [1, 12, 20, 40, 100]) {
        panel.scrollBy(-100000);
        const lines = panel.render(width);
        expect(lines).toHaveLength(panelLayout(width, rows).height);
        for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        panel.scrollBy(100000);
        const end = panel.render(width);
        for (const line of end) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        if (rows >= 16 && width >= 40) {
          expect(lines.join("\n")).toContain("START");
          expect(lines.join("\n")).not.toContain("LAST");
          expect(end.join("\n")).toContain("LAST");
          expect(end.join("\n")).toContain("↑↓");
          expect(end.join("\n")).toContain("Refining");
          for (const label of ["Stop", "Back"]) expect(end.slice(-2).join("\n")).toContain(label);
        }
      }
    }
    rows = 40;
    panel.toggleHelp();
    panel.update({ ...options, state: { ...options.state, requestId: 2, phase: "generating" }, candidateText: undefined, draft: "New source B" });
    const fresh = panel.render(80).join("\n");
    expect(fresh).toContain("New source B");
    expect(fresh).not.toContain("LAST");
    expect(fresh).not.toContain("Keyboard reference");
  });

  it("distinguishes unsent editor edits and includes the actual revision instruction", () => {
    const panel = create({ state: { ...options.state, phase: "generating" }, candidateText: undefined,
      draft: "Original A", draftChanged: true, revisionInstruction: "Keep **literal** instructions\x1b[2J\x07" });
    const text = panel.render(100).join("\n");
    expect(text).toContain("Main editor differs");
    expect(text).toContain("Original task");
    expect(text).toContain("Original A");
    expect(text).toContain("Submitted revision instruction");
    expect(text).toContain("**literal**");
    expect(text).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
  });

  it.each([40, 100])("shows revision provenance and original by default, with a direct original jump at width %s", (width) => {
    const panel = create({ draft: "ORIGINAL_TASK **literal**", candidateText: "REVISED_OUTPUT\n".repeat(30),
      revisionInstruction: "INSTRUCTION **literal**\x1b[2J", previousCandidate: "BEFORE_REVISION **literal**" });
    expect(panel.render(width).join("\n")).toContain("Revised prompt");
    let all = "";
    for (let i = 0; i < 10; i++) { all += panel.render(width).join("\n") + "\n"; panel.page(1); }
    for (const text of ["REVISED_OUTPUT", "Original draft", "ORIGINAL_TASK **literal**", "Revision instruction", "INSTRUCTION **literal**", "Before revision", "BEFORE_REVISION **literal**"]) {
      expect(all).toContain(text);
    }
    expect(all).not.toContain("\x1b[2J");
    panel.toggleOriginal();
    expect(panel.render(width).join("\n")).toContain("ORIGINAL_TASK **literal**");
  });

  it("keeps restored revision provenance without pretending the missing previous candidate was saved", () => {
    const panel = create({ draft: "Restored original", candidateText: "Restored revision", revisionInstruction: "Shorter", previousCandidate: "", contextUnavailable: true });
    let all = "";
    for (let i = 0; i < 4; i++) { all += panel.render(100).join("\n"); panel.page(1); }
    expect(all).toContain("Revised prompt"); expect(all).toContain("Restored original");
    expect(all).toContain("Revision instruction"); expect(all).toContain("Before-revision text was not retained");
  });

  it("returns to failure feedback instead of leaving a long source scrolled to its end", () => {
    const pending = { ...options, state: { ...options.state, phase: "generating" as const }, candidateText: undefined, draft: "Source A\n".repeat(100) };
    const panel = create(pending);
    panel.render(80);
    panel.scrollBy(10000);
    panel.render(80);
    panel.update({ ...pending, state: { ...pending.state, phase: "error" }, errorLabel: "Request timed out. Retry." });
    const text = panel.render(80).join("\n");
    expect(text).toContain("Request timed out");
    expect(text).toContain("Submitted original");
    expect(text).toContain("Source A");
  });

  it("keeps the source readable at narrow widths without the long waiting message", () => {
    const panel = create({ state: { ...options.state, phase: "generating" }, candidateText: undefined, draft: "A 原文", draftChanged: true }, 24);
    expect(panel.render(20).join("\n")).toContain("A 原文");
    expect(panel.render(20).join("\n")).not.toContain("work continues");
  });

  it.each([8, 20, 40])("reserves a stable viewport across content and help at %i rows", (rows) => {
    const panel = create({ candidateText: undefined }, rows);
    for (const width of [12, 40, 100]) {
      const height = panelLayout(width, rows).height;
      expect(panel.render(width)).toHaveLength(height);
      panel.toggleHelp();
      expect(panel.render(width)).toHaveLength(height);
      panel.toggleHelp();
      panel.update({ ...options, candidateText: "Long result\n".repeat(80) });
      expect(panel.render(width)).toHaveLength(height);
      panel.update({ ...options, candidateText: undefined });
    }
  });

  it("styles help headings and keys without bolding descriptions", () => {
    const bold = vi.fn((text: string) => `\x1b[1m${text}\x1b[22m`);
    const theme = { ...plainTheme, bold };
    const panel = new PreviewPanel(options, theme, () => 40, vi.fn());
    panel.toggleHelp();
    const text = panel.render(100).join("\n");
    expect(text).toContain(theme.bold("Help · Keyboard reference"));
    expect(text).toContain(theme.fg("muted", "Refine & navigate"));
    expect(bold.mock.calls.map(([value]) => value)).not.toContain("Refine & navigate");
    expect(text).toContain(theme.bold("a"));
    expect(text).not.toContain(theme.bold("Accept into editor (no send)"));
  });
  it("shows pending session metadata separately and hides it in accepted snapshots", () => {
    const panel = create({ sessionTitle: "路径解析修复" });
    const text = panel.render(100).join("\n");
    expect(text).toContain("Title on accept: 路径解析修复");
    expect(text).toContain("Refined prompt");
    panel.toggleSource();
    expect(panel.render(100).join("\n")).toContain("Title on accept: 路径解析修复");
    panel.update({ ...options, sessionTitle: "路径解析修复", accepted: { editorChanged: false } });
    expect(panel.render(100).join("\n")).not.toContain("Title on accept:");
  });
  it("puts the result first and hides the original and secondary actions by default", () => {
    const panel = create();
    const text = panel.render(100).join("\n");
    expect(text).toContain("✓ Done · 0s");
    expect(text).toContain("Refined prompt");
    expect(text).toContain("用户目标");
    expect(text).not.toContain("**用户目标**");
    expect(text).not.toContain(options.draft);
    expect(text).not.toContain("Cycle favorites");
    expect(text).not.toContain("o Original");
    expect(text).toContain("? Help");
    expect(text).not.toContain("Enter won't send");
    expect(text).not.toContain("Accept puts the result in the editor; s sends directly.");
    expect(panel.render(100).slice(-2)).toEqual([
      "  a Accept · e Edit · f Revise · s Send",
      "  q Back   · ? Help · i Input  · m Model",
    ]);
    expect(text.match(/Prompt refine/g)).toHaveLength(1);
    panel.toggleOriginal();
    expect(panel.render(100).join("\n")).toContain(options.draft);
    panel.toggleOriginal();
    expect(panel.render(100).join("\n")).not.toContain(options.draft);
  });

  it.each([false, true])("distinguishes an accepted snapshot from the current editor (changed: %s)", (editorChanged) => {
    const panel = create({ state: { ...options.state, phase: "idle" }, accepted: { editorChanged }, canRestore: true });
    const text = panel.render(100).join("\n");
    expect(text).toContain("✓ Accepted · 0s");
    expect(text).toContain("read-only");
    expect(text).toContain("r Refine draft");
    expect(text).not.toContain("a Accept");
    expect(text).not.toContain("e Edit");
    expect(text).not.toContain("f Revise");
    expect(text).not.toContain("s Send");
    expect(text).not.toContain("s sends directly");
    expect(text).toContain(editorChanged ? "excludes later edits" : "no model call");
    panel.toggleHelp();
    expect(panel.render(100).join("\n")).toContain("a/e/f/s disabled");
  });

  it("separates the workspace and keeps idle chrome free of duplicate or unavailable actions", () => {
    const panel = create({ candidateText: undefined, state: { ...options.state, phase: "idle" }, thinkingLevel: "high", contextLabel: "Context: not captured" });
    const lines = panel.render(100);
    expect(lines[0]).toBe("  " + "─".repeat(96));
    expect(lines[1]).toBe("  Prompt refine");
    expect(lines[2]?.trim()).toBe("openai-codex/example-model · high");
    const layout = panelLayout(100, 40);
    const tabHeight = panelTabs(layout, ["Preview", "→ Settings"], 0, plainTheme).length;
    const emptyRow = layout.topSeparatorHeight + layout.headerHeight + tabHeight + Math.floor((layout.bodyHeight - tabHeight - 1) / 2);
    expect(lines[emptyRow]?.trim()).toBe("No result yet.");
    expect(lines.slice(layout.topSeparatorHeight + layout.headerHeight + tabHeight, -3).filter((line) => line.trim())).toEqual([lines[emptyRow]]);
    expect(lines[emptyRow]).toBe(" ".repeat(layout.inset + Math.floor((layout.innerWidth - "No result yet.".length) / 2)) + "No result yet.");
    expect(lines.slice(-2)).toEqual([
      "  r Refine · m Model · i Input",
      "  q Back   · ? Help",
    ]);
    const text = lines.join("\n");
    expect(text.match(/r Refine/g)).toHaveLength(1);
    for (const redundant of ["Refine · Prompt Refine", "Context: not captured", "x Cancel", "Enter won't send"]) {
      expect(text).not.toContain(redundant);
    }
    const theme = getThemeByName("dark")!;
    const styled = new PreviewPanel(options, theme, () => 40, vi.fn()).render(100);
    expect(styled[0]).toContain(theme.fg("borderMuted", "─".repeat(96)));
    expect(styled[1]).toContain(theme.bold("Prompt refine"));
  });

  it.each(["generating", "error", "ready"] as const)("keeps useful %s status without repeating the brand", (phase) => {
    const panel = create({ state: { ...options.state, phase }, candidateText: phase === "ready" ? options.candidateText : undefined });
    const lines = panel.render(100);
    const text = lines.join("\n");
    expect(text.match(/Prompt refine/gi)).toHaveLength(1);
    expect(lines[2]).toContain(phase === "generating" ? "Refining" : phase === "error" ? "Failed" : "Done");
    if (phase === "generating") {
      expect(text).toContain("x Stop");
      expect(text).toContain("q returns to editing; work continues.");
      expect(text).not.toContain("Restart");
    }
    if (phase === "error") expect(text.match(/r Retry/g)).toHaveLength(1);
    if (phase === "ready") expect(text).toContain("s Send");
    else expect(text).not.toContain("s Send");
    expect(text).not.toContain("s sends directly");
    expect(text).not.toContain("Enter won't send");
  });

  it.each(["dark", "light"])("keeps empty-state styling and resize bounded in %s", (name) => {
    const theme = getThemeByName(name)!;
    let rows = 40;
    const panel = new PreviewPanel({ ...options, state: { ...options.state, phase: "idle" }, candidateText: undefined }, theme, () => rows, vi.fn());
    for (rows of [5, 8, 16, 40]) {
      for (const width of [1, 12, 20, 40, 100]) {
        const lines = panel.render(width);
        expect(lines).toHaveLength(panelLayout(width, rows).height);
        for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
    const lines = panel.render(100);
    expect(lines.join("\n")).toContain(theme.fg("muted", "No result yet."));
    expect(lines.join("\n")).toContain(theme.fg("muted", "openai-codex/example-model"));
    panel.setNotice("Context saved");
    expect(panel.render(100)[2]).toContain("Context saved");
    panel.toggleHelp();
    expect(panel.render(100)[6]).toContain("Help");
  });

  it("keeps model guidance in the empty block when no model is selected", () => {
    const panel = create({ state: { phase: "idle", requestId: 1, pendingSend: false }, candidateText: undefined });
    expect(panel.render(100).join("\n")).toContain("No model selected");
    expect(panel.render(100).slice(-2).join("\n")).toContain("m Model");
  });

  it("offers a literal view without modifying the candidate", () => {
    const panel = create();
    panel.toggleSource();
    const text = panel.render(100).join("\n");
    expect(text).toContain("## 重点");
    expect(text).toContain("**用户目标**");
    expect(text).toContain("source");
    panel.toggleSource();
    expect(panel.render(100).join("\n")).not.toContain("**用户目标**");
    expect(options.candidateText).toContain("**用户目标**");
  });

  it("shows the complete keyboard reference on demand", () => {
    const panel = create();
    panel.toggleHelp();
    const first = panel.render(100).join("\n");
    panel.page(1);
    const text = first + "\n" + panel.render(100).join("\n");
    for (const hint of ["follow-up", "Edit candidate (no model call)", "x/d Stop request / discard result", "z Restore", "r Refine", "m Model", "c Cycle task models + favorites", "o Original", "v Formatted/source", "i Input", "←/→ Page", "Tab Settings group", "Enter won't send", "Nothing to restore"]) {
      expect(text).toContain(hint);
    }
    panel.toggleHelp();
    expect(panel.render(100).join("\n")).not.toContain("Keys");
  });

  it.each([1, 2, 10, 20, 40, 80, 100, 160])("bounds Unicode, Markdown and chrome at %i columns", (width) => {
    const panel = create({ candidateText: "## 中文 😀 é\n\n" + "- **👩‍💻 保留目标** [link](https://example.com)\n".repeat(100) });
    for (const rows of [8, 16, 24, 40]) {
      const bounded = new PreviewPanel({ ...options, sessionTitle: "任务名称😀".repeat(10), candidateText: "中文😀".repeat(500) }, plainTheme, () => rows, vi.fn());
      const lines = bounded.render(width);
      expect(lines.length).toBeLessThanOrEqual(rows);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(Math.min(width, READING_WIDTH));
    }
    for (const line of panel.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(Math.min(width, READING_WIDTH));
  });

  it("scrolls in a bounded viewport, keeps actions visible and clamps after resize", () => {
    let rows = 24;
    const panel = new PreviewPanel({ ...options, candidateText: Array.from({ length: 80 }, (_, i) => `内容 ${i}`).join("\n") }, plainTheme, () => rows, vi.fn());
    expect(panel.render(80).join("\n")).toContain("内容 0");
    panel.page(1);
    const next = panel.render(80).join("\n");
    expect(next).not.toContain("内容 0\n");
    expect(next).toContain("a Accept");
    expect(next).toContain("q Back");
    expect(next).not.toContain("q/Esc");
    expect(next).toContain("e Edit");
    expect(next).toContain("f Revise");
    expect(next).toContain("i Input");
    expect(next).toContain("Settings");
    expect(next).not.toContain("←");
    expect(next).not.toContain("→");
    expect(next).not.toContain("t Context");
    panel.scrollBy(10000);
    expect(panel.render(80).join("\n")).toContain("内容 79");
    panel.scrollBy(-10000);
    expect(panel.render(80).join("\n")).toContain("内容 0");
    rows = 12;
    expect(panel.render(20).length).toBeLessThanOrEqual(12);
    rows = 40;
    expect(panel.render(100).join("\n")).toContain("内容 0");
  });

  it("reveals a long original on expansion and resets to the result on collapse", () => {
    const panel = create({ candidateText: "优化内容\n".repeat(80), draft: "原稿起点\n" + "原稿内容\n".repeat(80) }, 24);
    panel.render(80);
    panel.toggleOriginal();
    const original = panel.render(80).join("\n");
    expect(original).toContain("Original draft · at request time");
    expect(original).toContain("原稿起点");
    panel.toggleOriginal();
    expect(panel.render(80).join("\n")).toContain("Refined prompt");
  });

  it("sanitizes terminal controls in all external text including the original", () => {
    const panel = create({ candidateText: "bad\x1b[2J\x07", draft: "draft\x1b]52;c;evil\x07", contextLabel: "context\r", state: { ...options.state, model: { provider: "provider\x07", id: "model\x1b[2J" } } });
    panel.toggleOriginal();
    expect(panel.render(100).join("\n")).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
  });

  it.each(["dark", "light"])("uses the %s theme for prose, headings and controls", (name) => {
    const theme = getThemeByName(name)!;
    expect(theme).toBeDefined();
    const panel = new PreviewPanel(options, theme, () => 40, vi.fn());
    const before = panel.render(100);
    expect(before.join("\n")).toContain(theme.fg("success", theme.bold("✓ Done · 0s")));
    expect(before.join("\n")).toContain(theme.fg("text", theme.bold("Refined prompt")));
    panel.invalidate();
    expect(panel.render(100)).toEqual(before);
    for (const line of before) expect(visibleWidth(line)).toBeLessThanOrEqual(100);
  });

  it("sanitizes context in the scrolling header and exposes full metadata in help", () => {
    const panel = create({ candidateText: "long result\n".repeat(100), contextLabel: "context\x1b[2J\x07" });
    expect(panel.render(100).join("\n")).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
    panel.toggleHelp();
    panel.render(100);
    panel.scrollBy(12);
    expect(panel.render(100).join("\n")).toContain("Model: openai-codex/example-model");
  });

  it("rebuilds cached body styles when the active theme changes", () => {
    let tone = "\x1b[31m";
    const theme = { ...plainTheme, fg: (_color: string, text: string) => `${tone}${text}\x1b[39m` };
    const panel = new PreviewPanel(options, theme, () => 40, vi.fn());
    expect(panel.render(100).join("\n")).toContain("\x1b[31m");
    tone = "\x1b[32m";
    panel.invalidate();
    const updated = panel.render(100).join("\n");
    expect(updated).not.toContain("\x1b[31m");
    expect(updated).toContain("\x1b[32m");
  });

  it.each([20, 80])("makes pending delivery clear without offering send again at %i columns", (width) => {
    const panel = create({ state: { ...options.state, pendingSend: true } });
    const text = panel.render(width).join("\n");
    expect(text).toContain("Send");
    for (const action of ["a Accept", "e Edit", "f Revise", "s Send", "s sends directly"]) {
      expect(text).not.toContain(action);
    }
  });

  it("prioritizes stopping over candidate actions while a revision is generating", () => {
    const panel = create({ state: { ...options.state, phase: "generating" } });
    const text = panel.render(100).join("\n");
    expect(text).toContain("x Stop");
    expect(text).toContain("q Back");
    for (const action of ["a Accept", "e Edit", "f Revise", "s sends directly"]) {
      expect(text).not.toContain(action);
    }
  });

  it("keeps a failed revision actionable without suggesting a new-draft retry", () => {
    const panel = create({ state: { ...options.state, phase: "error" } });
    const text = panel.render(100).join("\n");
    expect(text).toContain("previous result kept");
    expect(panel.render(100).slice(-2).join("\n")).toContain("a Accept · e Edit · f Revise");
    expect(text).not.toContain("r Retry");
  });

  it("aligns result actions with navigation using the same column stops as Tasks", () => {
    const panel = create({ navigation: { index: 1, count: 1, label: "#1 refine" } });
    expect(panel.render(100).slice(-2).map((line) => line.trim())).toEqual([
      "a Accept · e Edit · f Revise · s Send",
      "q Back   · ? Help · i Input  · m Model · g Same input",
    ]);
  });

  it.each(["dark", "light"])("keeps themed footer columns aligned across states, help and resize in %s", (name) => {
    const theme = getThemeByName(name)!;
    const states: Partial<PreviewOptions>[] = [
      {},
      { state: { ...options.state, phase: "generating" }, candidateText: undefined },
      { state: { ...options.state, phase: "error" }, candidateText: undefined },
      { state: { ...options.state, phase: "idle" }, candidateText: undefined },
      { state: { ...options.state, pendingSend: true } },
      { accepted: { editorChanged: false }, canRestore: true },
    ];
    const starts = (line: string) => {
      let column = 0;
      return line.split(" · ").map((cell) => {
        const start = column;
        column += visibleWidth(cell) + 3;
        return start;
      });
    };
    for (const state of states) {
      const panel = new PreviewPanel({ ...options, navigation: { index: 1, count: 1, label: "#1 refine" }, ...state },
        theme, () => 40, vi.fn());
      for (const helpVisible of [false, true]) {
        if (helpVisible) panel.toggleHelp();
        for (const width of [40, 60, 80, 100, 200]) {
          const footer = panel.render(width).slice(-2);
          const [top, bottom] = footer.map(stripVTControlCharacters);
          const count = Math.min(starts(top!).length, starts(bottom!).length);
          expect(starts(top!).slice(0, count)).toEqual(starts(bottom!).slice(0, count));
          expect(bottom).toContain("q Back");
          expect(bottom).toContain(helpVisible ? "? Hide help" : "? Help");
          expect(footer[1]).toContain(theme.fg("text", theme.bold("q")));
          expect(footer[1]).toContain(theme.fg("muted", "Back"));
          expect(footer.join("\n")).not.toContain("\t");
          for (const line of footer) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  it("keeps Back/Help on narrow screens even with long primary labels", () => {
    for (const state of [
      { accepted: { editorChanged: false }, canRestore: true },
      { state: { ...options.state, pendingSend: true } },
    ]) {
      const panel = create(state);
      for (const width of [12, 20, 24, 30]) {
        const footer = panel.render(width).slice(-2);
        expect(footer[1]).toContain("q Back");
        if (width >= 20) expect(footer[1]).toContain("? Help");
        for (const line of footer) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it("prioritizes return and help in the single-line footer, then fits primary actions", () => {
    const panel = create({}, 8);
    expect(panel.render(100).at(-1)?.trim()).toBe("q Back · ? Help · a Accept · e Edit · f Revise · s Send · i Input · m Model");
    expect(panel.render(20).at(-1)?.trim()).toBe("q Back · ? Help");
    expect(panel.render(12).at(-1)?.trim()).toBe("q Back");
  });

  it("bounds state-specific footers and preserves return/help across resize", () => {
    const states: Partial<PreviewOptions>[] = [
      {},
      { state: { ...options.state, phase: "generating" }, candidateText: undefined },
      { state: { ...options.state, pendingSend: true } },
      { state: { ...options.state, phase: "idle" }, accepted: { editorChanged: false } },
    ];
    for (const state of states) {
      for (const rows of [8, 16, 40]) {
        for (const width of [12, 20, 40, 100]) {
          const lines = create(state, rows).render(width);
          const layout = panelLayout(width, rows);
          expect(lines).toHaveLength(layout.height);
          for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
          const footer = lines.slice(-layout.footerHeight).join("\n");
          expect(footer).toContain("q Back");
          if (width >= 40) expect(footer).toContain("? Help");
        }
      }
    }
  });

  it("keeps pending delivery visible after scrolling and in short terminals", () => {
    for (const rows of [8, 40]) {
      const panel = create({ state: { ...options.state, pendingSend: true }, candidateText: "Result\n".repeat(100) }, rows);
      panel.render(40);
      panel.scrollBy(10000);
      const lines = panel.render(40);
      const layout = panelLayout(40, rows);
      expect(lines.slice(layout.topSeparatorHeight, layout.topSeparatorHeight + layout.headerHeight).join("\n")).toContain("Send pending");
    }
  });

  it("retains model identity while scrolling and prioritizes notices", () => {
    const panel = create({ candidateText: "Result\n".repeat(100) });
    expect(panel.render(100)[2]).toContain("openai-codex/example-model");
    panel.setNotice("Context saved");
    panel.scrollBy(10);
    expect(panel.render(40)[2]).toMatch(/Context saved.*↑↓/);
  });

  it.each([40, 80, 100])("uses English chrome with elapsed time and no ellipses at %i columns", (width) => {
    const panel = create({ candidateText: "Refined prompt", draft: "Draft", elapsedSeconds: 17 });
    const text = panel.render(width).join("\n");
    expect(text).toContain("17s");
    expect(text).not.toMatch(/[\p{Script=Han}…]|\.{3}/u);
  });

  it("keeps long-body layout cached across progress ticks and scrolling", () => {
    const pending = { ...options, state: { ...options.state, phase: "generating" as const },
      candidateText: undefined, draft: "Keep **literal** commands.\n".repeat(500) };
    const panel = create(pending);
    const renderText = vi.spyOn(Text.prototype, "render");
    panel.render(100);
    renderText.mockClear();
    for (let elapsedSeconds = 1; elapsedSeconds <= 10; elapsedSeconds++) {
      panel.update({ ...pending, state: { ...pending.state }, elapsedSeconds });
      panel.scrollBy(1);
      expect(panel.render(100)[2]).toContain(`${elapsedSeconds}s`);
    }
    expect(renderText).not.toHaveBeenCalled();
    panel.update({ ...pending, draftChanged: true });
    panel.scrollBy(-10000);
    expect(panel.render(100).join("\n")).toContain("Main editor differs");
    expect(renderText).toHaveBeenCalled();
    renderText.mockRestore();
  });

  it("keeps Markdown cached on metadata refresh and rebuilds when content or theme changes", () => {
    const panel = create({ candidateText: "**A**\n\n".repeat(500) });
    const renderMarkdown = vi.spyOn(Markdown.prototype, "render");
    panel.render(100);
    renderMarkdown.mockClear();
    panel.update({ ...options, candidateText: "**A**\n\n".repeat(500), elapsedSeconds: 5, notice: "Saved" });
    panel.scrollBy(1);
    expect(panel.render(100)[2]).toContain("Saved");
    expect(renderMarkdown).not.toHaveBeenCalled();
    panel.update({ ...options, candidateText: "**New result**" });
    expect(panel.render(100).join("\n")).toContain("New result");
    expect(renderMarkdown).toHaveBeenCalledOnce();
    panel.invalidate();
    panel.render(100);
    expect(renderMarkdown).toHaveBeenCalledTimes(2);
    renderMarkdown.mockRestore();
  });

  it("refreshes a completed candidate and preserves expansion settings without stale content", () => {
    const panel = create({ state: { ...options.state, phase: "generating" }, candidateText: undefined, draft: undefined });
    expect(panel.render(80).join("\n")).toContain("Refining");
    panel.update(options);
    expect(panel.render(80).join("\n")).toContain("用户目标");
    panel.update({ ...options, candidateText: "新的优化结果" });
    expect(panel.render(80).join("\n")).not.toContain("用户目标");
    expect(panel.render(80).join("\n")).toContain("新的优化结果");
  });
});
