import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { buildRefineInput, buildRefineSystemPrompt, parseRefineOutput, selectHistory } from "../../src/context.js";

// Explicit opt-in; sends only these synthetic fixtures, never workspace/history.
// These are preservation/explicit-edit smoke tests, not downstream IFEval scores.
// REFINE_POLICY_LIVE=1 REFINE_POLICY_OUTPUT=/tmp/refine-policy.jsonl npm test -- test/live/refine-policy.live.test.ts
const command = "npm test -- --run";
const clear = `Explain what \`${command}\` does. Do not execute it.`;
const literal = 'Explain the literal string "foo" in `printf \'%s\\n\' \'foo\'`. Do not execute anything.';
const paths = ["../src/context.ts:144:7", "./config/dev.json", "../../data/input.csv"];
const url = "https://example.com/a%2Fb?q=Hello+World#L7";
const configValue = "`Mode=Dev_01`";
const pathDraft = `检查 ${paths[0]} 的引用，使用 ${paths[1]} 和 ${paths[2]}。参考 ${url}，配置值是 ${configValue}。只解释，不修改文件。`;
// Intentionally invalid syntax, mixed indentation, Chinese comments, and trailing spaces.
const codeBlock = ['```python', 'def Hello(User_Name)', '\t# 保留原注释  ', '    print("你好", User_Name)  ', '```'].join("\n");
const codeDraft = `修复下面代码的语法错误，并解释修改原因：\n\n${codeBlock}`;
const revisedPaths = pathDraft.replace(paths[0], "../src/context.ts:145:7");
const cases = [
  { name: "clear-no-edit", draft: clear, instruction: undefined, revision: undefined,
    check: (text: string) => expect(text).toBe(clear) },
  { name: "conditional-structure-no-edit", draft: clear,
    instruction: "Prompt rewriting instructions (manually selected):\nUse numbered items only if needed to clarify the draft; otherwise leave it unchanged.",
    revision: undefined, check: (text: string) => expect(text).toBe(clear) },
  { name: "explicit-translation-keeps-response-language",
    draft: `解释 \`${command}\` 的用途，不要执行。请用中文回答。`,
    instruction: "Prompt rewriting instructions (manually selected):\nTranslate the prompt into English.", revision: undefined,
    check: (text: string) => {
      expect(text).toContain(command);
      expect(text).toMatch(/explain/i);
      expect(text).toMatch(/(?:do not|don't|without|never) (?:execute|run|executing|running)/i);
      expect(text).toMatch(/(?:answer|respond|response|reply).*Chinese/i);
      expect(text).not.toMatch(/[\u3400-\u9fff]/u);
    } },
  { name: "explicit-source-edit", draft: literal,
    instruction: 'Replace only the double-quoted string "foo" with "bar" in the prompt; keep every other character unchanged, including the shell example.',
    revision: undefined, check: (text: string) => expect(text).toBe(literal.replace('"foo"', '"bar"')) },
  { name: "relative-paths-and-literal-values", draft: pathDraft,
    instruction: "Improve clarity and structure where useful.", revision: undefined,
    check: (text: string) => {
      for (const value of [...paths, url, configValue]) expect(text).toContain(value);
    } },
  { name: "code-repair-is-main-agent-task", draft: codeDraft,
    instruction: "Improve clarity and structure where useful.", revision: undefined,
    check: (text: string) => {
      expect(text).toContain(codeBlock);
      expect(text).toMatch(/修复|修正|纠正/u);
      expect(text).toMatch(/解释|说明/u);
    } },
  { name: "prompt-translation-keeps-code-and-comments", draft: codeDraft,
    instruction: "Translate the prompt into English.", revision: undefined,
    check: (text: string) => {
      expect(text).toContain(codeBlock);
      const surrounding = text.replace(codeBlock, "");
      expect(surrounding).toMatch(/fix|correct|repair/i);
      expect(surrounding).toMatch(/explain/i);
      expect(surrounding).not.toMatch(/[\u3400-\u9fff]/u);
    } },
  { name: "revise-preserves-code", draft: codeDraft, instruction: undefined,
    revision: { previousCandidate: codeDraft, instruction: "Improve the wording and structure where useful." },
    check: (text: string) => expect(text).toContain(codeBlock) },
  { name: "revise-preserves-authorized-path-edit", draft: pathDraft, instruction: undefined,
    revision: { previousCandidate: revisedPaths, instruction: "Improve clarity where useful.",
      previousInstruction: 'Replace only "../src/context.ts:144:7" with "../src/context.ts:145:7".' },
    check: (text: string) => {
      for (const value of ["../src/context.ts:145:7", ...paths.slice(1), url, configValue]) expect(text).toContain(value);
      expect(text).not.toContain(paths[0]);
    } },
  { name: "revise-explicit-source-edit", draft: literal, instruction: undefined,
    revision: { previousCandidate: literal,
      instruction: 'Replace only the double-quoted string "foo" with "bar"; keep every other character unchanged, including the shell example.' },
    check: (text: string) => expect(text).toBe(literal.replace('"foo"', '"bar"')) },
  { name: "compatible-task-requirement", draft: clear,
    instruction: "Main-agent task requirements (manually selected):\nAnswer in Chinese.", revision: undefined,
    check: (text: string) => {
      expect(text).toContain(command);
      expect(text).toMatch(/Chinese|中文/u);
      expect(text).toMatch(/(?:do not|don't|without|never) (?:execute|run|executing|running)/i);
      expect(text).not.toContain("Main-agent task requirements");
    } },
  { name: "revise-explicit-format", draft: clear, instruction: undefined,
    revision: { previousCandidate: clear,
      instruction: "Rewrite the prompt as exactly two numbered items: the explanation request, then the execution prohibition. Preserve the command literally." },
    check: (text: string) => {
      expect(text).toMatch(/^1\. /);
      expect(text).toMatch(/\n2\. /);
      expect(text).toContain(command);
      expect(text).toMatch(/(?:do not|don't|without|never) (?:execute|run|executing|running)/i);
    } },
] as const;

describe.skipIf(process.env.REFINE_POLICY_LIVE !== "1")("live conservative policy safeguards", () => {
  let runtime: ModelRuntime;
  beforeAll(async () => { runtime = await ModelRuntime.create(); });

  it.each(cases)("$name", async ({ name, draft, instruction, revision, check }) => {
    const provider = process.env.REFINE_POLICY_PROVIDER ?? "openai-codex";
    const model = runtime.getModel(provider, process.env.REFINE_POLICY_MODEL ?? "gpt-6-luna");
    expect(model, "Model must be configured locally").toBeDefined();
    const systemPrompt = buildRefineSystemPrompt(false);
    const packet = buildRefineInput(draft, selectHistory([], 0, 0), "", revision, instruction);
    const response = await runtime.streamSimple(model!, {
      systemPrompt, tools: [], messages: [{ role: "user", content: packet, timestamp: Date.now() }],
    }, { maxTokens: 8192, reasoning: "high", maxRetries: 0, signal: AbortSignal.timeout(180_000) }).result();
    const raw = response.content.filter((block) => block.type === "text").map((block) => block.text).join("");
    const parsed = parseRefineOutput(raw);
    const observation = { name, provider, model: model!.id, reasoning: "high", timestamp: Date.now(),
      systemPromptSha256: createHash("sha256").update(systemPrompt).digest("hex"),
      packet: JSON.parse(packet), raw, prompt: parsed?.text, stopReason: response.stopReason, usage: response.usage };
    // Record even an unsuccessful assertion; do not retry until it passes.
    if (process.env.REFINE_POLICY_OUTPUT) await appendFile(process.env.REFINE_POLICY_OUTPUT, JSON.stringify(observation) + "\n");
    expect(response.stopReason, response.errorMessage).toBe("stop");
    expect(parsed, raw).toBeDefined();
    check(parsed!.text);
  }, 190_000);
});
