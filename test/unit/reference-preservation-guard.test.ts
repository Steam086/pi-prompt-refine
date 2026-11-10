import { describe, expect, it } from "vitest";
import { preserveDroppedTuiReference } from "../../src/reference-preservation.js";
import { screen, screenDraft } from "../fixtures/reference-preservation.js";

describe("conservative TUI loss guard", () => {
  it("keeps the original when a question-only result drops the whole screenshot", () => {
    expect(preserveDroppedTuiReference(screenDraft, "右侧正文部分太靠下了？讨论能否删掉一部分。"))
      .toEqual({ text: screenDraft, restored: true });
  });

  it("allows the screenshot with harmless whitespace boundary changes", () => {
    const rewritten = screen.trimEnd() + "\n\n右侧正文部分是不是太靠下了？";
    expect(preserveDroppedTuiReference(screenDraft, rewritten)).toEqual({ text: rewritten, restored: false });
  });

  it("does not prevent an explicit request to remove the screenshot", () => {
    const draft = screen + "请删除整个截图，只保留问句：右侧正文是否靠下？";
    const rewritten = "右侧正文是否靠下？";
    expect(preserveDroppedTuiReference(draft, rewritten)).toEqual({ text: rewritten, restored: false });
  });

  it("does not mistake discussion of deletion for authorization to delete the source", () => {
    const draft = screen + "请讨论是否需要删除截图中的某些行，不要直接删除。";
    expect(preserveDroppedTuiReference(draft, "讨论是否需要删除截图中的某些行。"))
      .toEqual({ text: draft, restored: true });
  });

  it.each([
    "不要删除截图，只改写问句。",
    "请保留截图，不要删除截图。",
    "删除截图是否合适？",
    "Can we remove the screenshot?",
    "Do not remove the screenshot.",
    "Remove the screenshot?",
    "请删除截图中的按钮。",
    "请删除截图。不要删除截图。",
    "Remove the screenshot. Preserve the screenshot.",
  ])("does not authorize source removal from %s", (instruction) => {
    const draft = screen + "\n" + instruction;
    expect(preserveDroppedTuiReference(draft, "Discuss the layout."))
      .toEqual({ text: draft, restored: true });
  });

  it.each(["请删除整个截图，只保留问句。", "Please remove the screenshot. Keep the question."])
  ("allows a removal request before the reference: %s", (instruction) => {
    const draft = instruction + "\n" + screenDraft;
    expect(preserveDroppedTuiReference(draft, "右侧正文是否靠下？"))
      .toEqual({ text: "右侧正文是否靠下？", restored: false });
  });

  it.each([
    "请删除整个截图，只保留问句。",
    "Prompt rewriting instructions (manually selected):\nPlease remove the screenshot.",
    "Saved editing requirements (manually selected):\n请不保留截图。",
    "Main-agent task requirements (manually selected):\nKeep answers short.\n\nCurrent user instructions:\nRemove the screenshot.",
  ])("honors explicit editing requirements: %s", (instruction) => {
    expect(preserveDroppedTuiReference(screenDraft, "右侧正文是否靠下？", instruction))
      .toEqual({ text: "右侧正文是否靠下？", restored: false });
  });

  it.each([
    "Main-agent task requirements (manually selected):\nRemove the screenshot.",
    "Prompt rewriting instructions (manually selected):\nDo not remove the screenshot.",
    "Prompt rewriting instructions (manually selected):\nDiscuss whether to remove the screenshot.",
  ])("does not use task requirements or non-removal instructions to bypass the guard: %s", (instruction) => {
    expect(preserveDroppedTuiReference(screenDraft, "右侧正文是否靠下？", instruction))
      .toEqual({ text: screenDraft, restored: true });
  });

  it("does not let a saved removal preference override an explicit preservation constraint", () => {
    const draft = screenDraft + "\n不要删除截图。";
    expect(preserveDroppedTuiReference(draft, "右侧正文是否靠下？", "Remove the screenshot."))
      .toEqual({ text: draft, restored: true });
  });

  it("does not take removal instructions inside table cells as authorization", () => {
    const draft = screenDraft.replace("Prompt Bullet Structure", "Remove the screenshot.");
    expect(preserveDroppedTuiReference(draft, "右侧正文是否靠下？"))
      .toEqual({ text: draft, restored: true });
  });

  it("does not guard unrelated short text, background outside the draft, or partial edits", () => {
    expect(preserveDroppedTuiReference("看下截图，给点建议。", "请分析截图。"))
      .toEqual({ text: "请分析截图。", restored: false });
    const partial = screen.split("\n").filter((line) => line.includes("│")).slice(0, 5).join("\n");
    expect(preserveDroppedTuiReference(screenDraft, partial)).toEqual({ text: partial, restored: false });
  });
});
