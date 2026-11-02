import { describe, expect, it, vi } from "vitest";
// Test-only access to the installed Pi palettes; production uses the injected theme.
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { visibleWidth } from "@earendil-works/pi-tui";
import { PreviewPanel, type PreviewOptions } from "../src/preview.js";
import { READING_WIDTH } from "../src/presentation.js";

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
    expect(text).toContain("o Original");
    expect(text).toContain("? Help");
    expect(text).toContain("Enter won't send");
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
    expect(text).not.toContain("s Send");
    expect(text).toContain(editorChanged ? "excludes later edits" : "no model call");
    panel.toggleHelp();
    expect(panel.render(100).join("\n")).toContain("a/e/s disabled");
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
    for (const hint of ["follow-up", "x/d", "z Restore", "r Refine", "m Model", "c Cycle favorites", "v Formatted/source", "Nothing to restore"]) {
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
    expect(next).toContain("q/Esc/Ctrl+\\ Back");
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
    expect(text).not.toContain("s Send");
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
