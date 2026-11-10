import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { describe, expect, it, vi } from "vitest";
import { budgetRequest } from "../../src/budget.js";
import { buildRefineInput, selectHistory } from "../../src/context.js";
import { readRunUsage, totalInputTokens } from "../../src/usage.js";

// Exercise the real SDK's payload/usage conversion without credentials or network.
const model: Model<"openai-completions"> = {
  id: "deepseek-flash", name: "DeepSeek Flash", provider: "deepseek", api: "openai-completions",
  baseUrl: "https://deepseek.invalid", reasoning: true, input: ["text"],
  thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high", max: "max" },
  cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
  contextWindow: 1_000_000, maxTokens: 384_000,
  compat: { thinkingFormat: "deepseek", maxTokensField: "max_tokens", supportsDeveloperRole: false, supportsStore: false },
};

async function run(thinking: ModelThinkingLevel) {
  const input = buildRefineInput("确认关闭 session 后能否恢复记录", selectHistory([], 0, 0));
  const budget = budgetRequest("Rewrite only; return JSON.", input, model, 2048, thinking);
  const reasoning = thinking !== "off";
  const chunk = {
    id: "mock", object: "chat.completion.chunk", created: 0, model: model.id,
    choices: [{ index: 0, delta: reasoning ? { reasoning_content: "Synthetic reasoning" } : { content: '{"prompt":"确认记录能否恢复"}' }, finish_reason: reasoning ? "length" : "stop" }],
    usage: { prompt_tokens: 1769, prompt_cache_hit_tokens: 256, completion_tokens: reasoning ? 2048 : 20,
      completion_tokens_details: { reasoning_tokens: reasoning ? 2048 : 0 } },
  };
  const fetch = vi.fn(async () => new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  }));
  let payload: Record<string, unknown> = {};
  const response = await streamSimple(model, normalizeContext({
    systemPrompt: "Rewrite only; return JSON.", tools: [],
    messages: [{ role: "user", content: budget.input, timestamp: 0 }],
  }), {
    apiKey: "test-key", fetch, maxRetries: 0, maxTokens: budget.maxTokens,
    thinkingBudgets: budget.thinkingBudgets,
    ...(reasoning ? { reasoning: thinking } : {}),
    onPayload: (value) => { payload = value as Record<string, unknown>; },
  }).result();
  return { budget, payload, response, fetch };
}

describe("DeepSeek shared output budget", () => {
  it("maps max thinking correctly and preserves reasoning-only length failures without double counting", async () => {
    const { budget, payload, response, fetch } = await run("max");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(payload).toMatchObject({ max_tokens: 2048, thinking: { type: "enabled" }, reasoning_effort: "max" });
    expect(payload).not.toHaveProperty("max_completion_tokens");
    expect(payload).not.toHaveProperty("thinking_token_budget");
    expect(payload).not.toHaveProperty("tools");
    expect(budget.thinkingBudgets).toBeUndefined();
    expect(budget.report.message).toContain("cannot reserve answer space");
    expect(response.stopReason).toBe("length");
    expect(response.content.some((block) => block.type === "text")).toBe(false);
    const usage = readRunUsage(response.usage, { hasPricing: true });
    expect(usage).toMatchObject({ input: 1513, cacheRead: 256, cacheWrite: 0, output: 2048, reasoning: 2048, totalTokens: 3817 });
    expect(totalInputTokens(usage)).toBe(1769);
    expect(usage?.cost?.total).toBeCloseTo(0.002913036);
  });

  it("explicitly disables DeepSeek thinking when off, without increasing the output cap", async () => {
    const { budget, payload, response } = await run("off");
    expect(payload).toMatchObject({ max_tokens: 2048, thinking: { type: "disabled" } });
    expect(payload).not.toHaveProperty("reasoning_effort");
    expect(budget.report.message).toBeUndefined();
    expect(response.stopReason).toBe("stop");
    expect(response.content).toContainEqual(expect.objectContaining({ type: "text", text: '{"prompt":"确认记录能否恢复"}' }));
  });
});
