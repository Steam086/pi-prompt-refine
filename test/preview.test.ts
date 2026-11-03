import { describe, expect, it, vi } from "vitest";
// Test-only access to the installed Pi palettes; production uses the injected theme.
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { visibleWidth } from "@earendil-works/pi-tui";
import { PreviewPanel, type PreviewOptions } from "../src/preview.js";
import { READING_WIDTH } from "../src/presentation.js";
import { panelLayout } from "../src/panel-layout.js";

const identity = (text: string) => text;
const plainTheme = { fg: (_color: string, text: string) => text, bold: identity, italic: identity, underline: identity, strikethrough: identity };
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
    expect(text).toContain("Accept puts the result in the editor; s sends directly.");
    expect(panel.render(100).slice(-2)).toEqual([
      "  a Accept · e Edit · f Revise",
      "  q Back · ? Help",
    ]);
    expect(text.match(/Prompt Refine/g)).toHaveLength(1);
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
    const panel = create({ candidateText: undefined, state: { ...options.state, phase: "idle" }, contextLabel: "Context: not captured" });
    const lines = panel.render(100, "› Prompt refine     Settings");
    expect(lines[0]).toBe("  " + "─".repeat(96));
    expect(lines[1]).toBe("  › Prompt refine     Settings");
    expect(lines[2]?.trim()).toBe("");
    const layout = panelLayout(100, 40);
    const emptyRow = layout.topSeparatorHeight + layout.headerHeight + Math.floor((layout.bodyHeight - 2) / 2);
    expect(lines[emptyRow]?.trim()).toBe("No result yet.");
    expect(lines[emptyRow + 1]?.trim()).toBe("openai-codex/example-model");
    expect(lines[emptyRow]).toBe(" ".repeat(layout.inset + Math.floor((layout.innerWidth - "No result yet.".length) / 2)) + "No result yet.");
    expect(lines.slice(-2)).toEqual([
      "  r Refine · m Model · i Input",
      "  q Back · ? Help",
    ]);
    const text = lines.join("\n");
    expect(text.match(/r Refine/g)).toHaveLength(1);
    for (const redundant of ["Refine · Prompt Refine", "Context: not captured", "x Cancel", "Enter won't send"]) {
      expect(text).not.toContain(redundant);
    }
    const theme = getThemeByName("dark")!;
    const styled = new PreviewPanel(options, theme, () => 40, vi.fn()).render(100);
    expect(styled[0]).toContain(theme.fg("borderMuted", "─".repeat(96)));
    expect(styled[1]).toContain(theme.bold("Prompt Refine"));
  });

  it.each(["generating", "error", "ready"] as const)("keeps useful %s status without repeating the brand", (phase) => {
    const panel = create({ state: { ...options.state, phase }, candidateText: phase === "ready" ? options.candidateText : undefined });
    const lines = panel.render(100, "› Prompt refine     Settings");
    const text = lines.join("\n");
    expect(text.match(/Prompt refine/gi)).toHaveLength(1);
    expect(lines[2]).toContain(phase === "generating" ? "Refining" : phase === "error" ? "Failed" : "Done");
    if (phase === "generating") {
      expect(text).toContain("x Stop");
      expect(text).toContain("q returns to editing; work continues.");
      expect(text).not.toContain("Restart");
    }
    if (phase === "error") expect(text.match(/r Retry/g)).toHaveLength(1);
    if (phase === "ready") expect(text).toContain("s sends directly");
    else expect(text).not.toContain("s sends directly");
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
    expect(lines.join("\n")).toContain(theme.fg("text", "No result yet."));
    expect(lines.join("\n")).toContain(theme.fg("muted", "openai-codex/example-model"));
    panel.setNotice("Context saved");
    expect(panel.render(100)[2]).toContain("Context saved");
    panel.toggleHelp();
    expect(panel.render(100)[3]).toContain("Help");
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
    const text = panel.render(100).join("\n");
    for (const hint of ["follow-up", "Edit candidate (no model call)", "x/d Stop request / discard result", "z Restore", "r Refine", "m Model", "c Cycle favorites", "o Original", "v Formatted/source", "i Input", "→ Settings", "Enter won't send", "Nothing to restore"]) {
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
    expect(next).not.toContain("i Input");
    expect(next).not.toContain("→ Settings");
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
    expect(before.join("\n")).toContain(theme.fg("accent", theme.bold("Refined prompt")));
    panel.invalidate();
    expect(panel.render(100)).toEqual(before);
    for (const line of before) expect(visibleWidth(line)).toBeLessThanOrEqual(100);
  });

  it("sanitizes context in the scrolling header and exposes full metadata in help", () => {
    const panel = create({ candidateText: "long result\n".repeat(100), contextLabel: "context\x1b[2J\x07" });
    expect(panel.render(100).join("\n")).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
    panel.toggleHelp();
    panel.render(100);
    panel.scrollBy(10);
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

  it("prioritizes return and help in the single-line footer, then fits primary actions", () => {
    const panel = create({}, 8);
    expect(panel.render(100).at(-1)?.trim()).toBe("q Back · ? Help · a Accept · e Edit · f Revise");
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
      const lines = panel.render(40, "Prompt refine");
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
