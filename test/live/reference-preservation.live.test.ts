import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { appendFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildRefineInput, buildRefineSystemPrompt, parseRefineOutput, selectHistory } from "../../src/context.js";
import { preserveDroppedTuiReference } from "../../src/reference-preservation.js";
import { minimalEditInstruction, screen, screenDraft } from "../fixtures/reference-preservation.js";

// Explicit opt-in. No saved session data is read; ModelRuntime uses locally configured authentication.
// LUNA_REFERENCE_LIVE=1 LUNA_REFERENCE_OUTPUT=/tmp/luna-reference.jsonl npm test -- test/live/reference-preservation.live.test.ts
const levels = ["medium", "high"] as const;
const screenshotLines = screen.split("\n").map((line) => line.trim()).filter(Boolean);
function retainsScreen(text: string): boolean {
  const outputLines = text.split("\n").map((line) => line.trim());
  let position = 0;
  for (const line of screenshotLines) {
    position = outputLines.findIndex((item, index) => index >= position && item.startsWith(line));
    if (position < 0) return false;
    position++;
  }
  return true;
}
const repeats = Number(process.env.LUNA_REFERENCE_REPEATS ?? 1);
const cases = levels.flatMap((reasoning) => [false, true].flatMap((withInstruction) =>
  Array.from({ length: repeats }, (_, repeat) => ({ reasoning, withInstruction, repeat }))));

describe.skipIf(process.env.LUNA_REFERENCE_LIVE !== "1")("luna draft-reference preservation (live)", () => {
  it.each(cases)("$reasoning / editing instruction: $withInstruction / $repeat", async ({ reasoning, withInstruction, repeat }) => {
    const runtime = await ModelRuntime.create();
    const model = runtime.getModel("openai-codex", "gpt-6-luna");
    expect(model).toBeDefined();
    const packet = buildRefineInput(screenDraft, selectHistory([], 0, 0), "", undefined,
      withInstruction ? minimalEditInstruction : undefined);
    const response = await runtime.streamSimple(model!, { systemPrompt: buildRefineSystemPrompt(false), tools: [],
      messages: [{ role: "user", content: packet, timestamp: Date.now() }],
    }, { maxTokens: 8192, reasoning, maxRetries: 0, signal: AbortSignal.timeout(180_000) }).result();
    const raw = response.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    const parsed = parseRefineOutput(raw);
    const guarded = parsed && preserveDroppedTuiReference(screenDraft, parsed.text);
    const observation = { reasoning, withInstruction, repeat, stopReason: response.stopReason,
      parsed: !!parsed, result: parsed?.text, rawScreenshotIntact: parsed ? retainsScreen(parsed.text) : false,
      restored: guarded?.restored, finalScreenshotIntact: guarded ? retainsScreen(guarded.text) : false,
      originalQuestionIntact: parsed?.text.includes("右侧的正文部分是不是太靠下了，讨论能否删掉一部分") ?? false,
      usage: response.usage };
    if (process.env.LUNA_REFERENCE_OUTPUT) await appendFile(process.env.LUNA_REFERENCE_OUTPUT, JSON.stringify(observation) + "\n");
    expect(response.stopReason, response.errorMessage).toBe("stop");
    expect(parsed, raw).toBeDefined();
    // Permit indentation or spacing at the boundary with the user's question,
    // but require every screenshot line's visible contents in the original order.
    expect(retainsScreen(guarded!.text)).toBe(true);
    expect(guarded!.text).toMatch(/右侧|right/u);
  }, 190_000);

  it.each(levels)("$0 / unrelated screenshot in history stays external", async (reasoning) => {
    const runtime = await ModelRuntime.create();
    const model = runtime.getModel("openai-codex", "gpt-6-luna");
    expect(model).toBeDefined();
    const draft = "解释 `src/cache.ts` 中缓存配置的作用，不要修改代码。";
    const history = selectHistory([{ type: "message", message: { role: "user", content: [{ type: "text", text: screen }] } }], 10, 4000);
    const packet = buildRefineInput(draft, history);
    const response = await runtime.streamSimple(model!, { systemPrompt: buildRefineSystemPrompt(false), tools: [],
      messages: [{ role: "user", content: packet, timestamp: Date.now() }],
    }, { maxTokens: 8192, reasoning, maxRetries: 0, signal: AbortSignal.timeout(180_000) }).result();
    const raw = response.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    const parsed = parseRefineOutput(raw);
    if (process.env.LUNA_REFERENCE_OUTPUT) await appendFile(process.env.LUNA_REFERENCE_OUTPUT,
      JSON.stringify({ scenario: "external-background", reasoning, raw: parsed?.text, stopReason: response.stopReason }) + "\n");
    expect(response.stopReason, response.errorMessage).toBe("stop");
    expect(parsed, raw).toBeDefined();
    expect(parsed!.text).toContain("src/cache.ts");
    expect(parsed!.text).not.toContain("Focus: Library");
  }, 190_000);

  it.each(levels)("$0 / explicit screenshot removal stays allowed", async (reasoning) => {
    const runtime = await ModelRuntime.create();
    const model = runtime.getModel("openai-codex", "gpt-6-luna");
    expect(model).toBeDefined();
    const draft = screen + "请删除整个截图，只保留问句：右侧正文是否靠下？";
    const packet = buildRefineInput(draft, selectHistory([], 0, 0));
    const response = await runtime.streamSimple(model!, { systemPrompt: buildRefineSystemPrompt(false), tools: [],
      messages: [{ role: "user", content: packet, timestamp: Date.now() }],
    }, { maxTokens: 8192, reasoning, maxRetries: 0, signal: AbortSignal.timeout(180_000) }).result();
    const raw = response.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    const parsed = parseRefineOutput(raw);
    const guarded = parsed && preserveDroppedTuiReference(draft, parsed.text);
    if (process.env.LUNA_REFERENCE_OUTPUT) await appendFile(process.env.LUNA_REFERENCE_OUTPUT,
      JSON.stringify({ scenario: "explicit-remove", reasoning, raw: parsed?.text, guarded, stopReason: response.stopReason }) + "\n");
    expect(response.stopReason, response.errorMessage).toBe("stop");
    expect(parsed, raw).toBeDefined();
    expect(guarded?.restored).toBe(false);
    expect(guarded?.text).not.toContain("Focus: Library");
    expect(guarded?.text).toMatch(/右侧/);
  }, 190_000);
});
