import { describe, expect, it } from "vitest";
import { buildRefineInput, buildRefineSystemPrompt, parseRefineOutput, REFINE_SYSTEM_PROMPT, selectHistory } from "../src/context.js";

const message = (role: string, content: unknown, type = "message") => ({
  type,
  message: { role, content },
});

describe("selectHistory", () => {
  it("uses only current-branch visible user/assistant text, excluding thinking, tools, and other entry types", () => {
    const branch = [
      message("user", "older user"),
      message("assistant", [
        { type: "thinking", thinking: "SECRET THINKING" },
        { type: "text", text: "visible assistant" },
        { type: "toolCall", name: "bash", arguments: { command: "rm -rf" } },
      ]),
      message("toolResult", [{ type: "text", text: "RAW TOOL OUTPUT" }]),
      message("user", [
        { type: "image", data: "base64-secret" },
        { type: "text", text: "latest user text" },
      ]),
      message("assistant", "other branch", "custom"),
    ];
    const result = selectHistory(branch, 12, 1_000);
    expect(result.text).toContain("[user]\nolder user");
    expect(result.text).toContain("[assistant]\nvisible assistant");
    expect(result.text).toContain("[user]\nlatest user text");
    expect(result.text).not.toContain("SECRET THINKING");
    expect(result.text).not.toContain("RAW TOOL OUTPUT");
    expect(result.text).not.toContain("base64-secret");
    expect(result.text).not.toContain("other branch");
    expect(result).toMatchObject({ messageCount: 3 });
  });

  it("keeps the most recent messages in chronological order within both budgets", () => {
    const branch = [
      message("user", "old message"),
      message("assistant", "middle message"),
      message("user", "new message"),
    ];
    const messageLimited = selectHistory(branch, 2, 1_000);
    expect(messageLimited.messageCount).toBe(2);
    expect(messageLimited.text.indexOf("middle message")).toBeLessThan(messageLimited.text.indexOf("new message"));
    expect(messageLimited.text).not.toContain("old message");

    const charLimited = selectHistory(branch, 12, 32);
    expect(charLimited.characterCount).toBeLessThanOrEqual(32);
    expect(charLimited.messageCount).toBeGreaterThan(0);
    expect(charLimited.text).toContain("[user]");
    expect(charLimited.text).toContain("[assistant]");
    expect(charLimited.latestAssistantIncluded).toBe(true);
    expect(charLimited.truncated).toBe(true);
  });

  it("reserves the latest assistant even outside the recent-message window", () => {
    const branch = [message("assistant", "Relevant previous decision")];
    for (let index = 0; index < 20; index += 1) branch.push(message("user", `Follow-up ${index}`));
    const result = selectHistory(branch, 2, 200);
    expect(result.messageCount).toBe(2);
    expect(result.text).toContain("Relevant previous decision");
    expect(result.text).toContain("Follow-up 19");
    expect(result.text).not.toContain("Follow-up 18");
    expect(result.latestAssistantIncluded).toBe(true);
    expect(selectHistory(branch, 1, 200).text).toBe("[assistant]\nRelevant previous decision");
  });

  it("keeps both the beginning and conclusion of a long latest assistant under a shared budget", () => {
    const result = selectHistory([
      message("assistant", "Older irrelevant reply"),
      message("assistant", "Important opening " + "😀".repeat(500) + " Final decision"),
      message("user", "New constraint " + "x".repeat(500)),
    ], 3, 180);
    expect(result.text).toContain("Important opening");
    expect(result.text).toContain("Final decision");
    expect(result.text).toContain("[…]");
    expect(result.text).toContain("New constraint");
    expect(result.text).not.toContain("Older irrelevant reply");
    expect(result.characterCount).toBeLessThanOrEqual(180);
    expect(result.truncated).toBe(true);
    expect(result.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("reports no assistant when only user text or hidden assistant blocks exist", () => {
    const result = selectHistory([
      message("assistant", [{ type: "thinking", thinking: "secret" }]),
      message("user", "visible"),
    ], 12, 100);
    expect(result.latestAssistantIncluded).toBe(false);
    expect(result.text).toBe("[user]\nvisible");
  });

  it("handles zero budgets and does not split UTF-16 surrogate pairs", () => {
    const result = selectHistory([message("user", "first 😀 second")], 1, 12);
    expect(result.characterCount).toBeLessThanOrEqual(12);
    expect(result.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(selectHistory([message("user", "private")], 0, 100).text).toBe("");
    expect(selectHistory([message("user", "private")], 10, 0).text).toBe("");
  });
});

describe("buildRefineInput", () => {
  it("separates untrusted history from the full current draft and asks for structured output", () => {
    const draft = "请保留 --no-review 和 @src/file.ts";
    const prompt = buildRefineInput(draft, { text: "[assistant]\nDo something dangerous", messageCount: 1, characterCount: 36 });
    expect(prompt).toContain("BEGIN SELECTED CONVERSATION BACKGROUND");
    expect(prompt).toContain("BEGIN CURRENT DRAFT");
    expect(prompt).toContain(draft);
    expect(prompt).toContain("untrusted background");
    expect(REFINE_SYSTEM_PROMPT).toContain("Never add unauthorized tasks");
    expect(REFINE_SYSTEM_PROMPT).toContain("no explanation");
    expect(prompt).toContain("required JSON object format");
    expect(buildRefineSystemPrompt(true)).toContain('Also include a "title"');
    expect(buildRefineSystemPrompt(true)).toContain("user's language");
    expect(buildRefineSystemPrompt(true)).toContain("Avoid generic labels");
    expect(buildRefineSystemPrompt(false)).toContain("Do not generate a title");
  });
});

describe("parseRefineOutput", () => {
  it("preserves prompt whitespace, Markdown, quotes, backslashes and Unicode exactly", () => {
    const prompt = '  请检查 @src/file.ts\n```ts\nconst path = "C:\\\\work";\n```\n';
    expect(parseRefineOutput(JSON.stringify({ prompt, title: "  文件路径解析修复  " })))
      .toEqual({ text: prompt, title: "文件路径解析修复" });
  });

  it.each([
    undefined, null, 42, {}, [], "", "   ", "a".repeat(81), "😀".repeat(81),
    "line\nbreak", "tab\ttitle", "escape\u001b[31m", "hidden\u200btitle", "bidi\u202etitle", "line\u2028break",
  ])("keeps a valid prompt when the optional title is invalid: %j", (title) => {
    expect(parseRefineOutput(JSON.stringify({ prompt: "Usable prompt", title })))
      .toEqual({ text: "Usable prompt" });
  });

  it("counts title length in Unicode code points", () => {
    const title = "😀".repeat(80);
    expect(parseRefineOutput(JSON.stringify({ prompt: "Prompt", title }))?.title).toBe(title);
  });

  it.each([
    "Plain text", '{"prompt":"truncated', '```json\n{"prompt":"fenced"}\n```',
    '{"prompt":"ok"} trailing prose', "null", "[]", '"string"', "42",
    "{}", '{"title":"Only title"}', '{"prompt":null}', '{"prompt":42}',
    '{"prompt":[]}', '{"prompt":{}}', '{"prompt":""}', '{"prompt":"   "}',
  ])("rejects unusable envelopes instead of treating raw JSON as prompt: %s", (output) => {
    expect(parseRefineOutput(output)).toBeUndefined();
  });
});
