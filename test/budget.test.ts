import { describe, expect, it } from "vitest";
import { budgetRequest, estimateTextTokens } from "../src/budget.js";
import { buildRefineInput, selectHistory } from "../src/context.js";

const empty = selectHistory([], 12, 16_000);
const packet = (draft = "Keep all paths and commands unchanged.") => buildRefineInput(draft, empty);
const model = { contextWindow: 128_000, maxTokens: 16_384 };
const message = (id: string, role: string, content: string) => ({ type: "message", id, message: { role, content } });

describe("unified request budget", () => {
  it("accounts for the complete system and serialized JSON, including escaping and metadata", () => {
    const draft = '中文😀\\path\n"literal"\u0000';
    const input = packet(draft);
    const result = budgetRequest("system 中文", input, model, 8192);
    expect(result.report).toMatchObject({ status: "ok", inputTokens: Buffer.byteLength("system 中文") + Buffer.byteLength(input), outputTokens: 8192 });
    expect(result.input).toBe(input);
    expect(JSON.parse(result.input).draft).toBe(draft);
    expect(estimateTextTokens(draft)).toBeGreaterThan(draft.length);
  });

  it("drops tree then skills before touching history or project rules", () => {
    const history = selectHistory([message("u", "user", "Do not add dependencies.")], 12, 16_000);
    const project = 'PROJECT INSTRUCTIONS:\n{"content":"preserve rules"}' +
      "\n\nMAIN AGENT SKILLS (metadata only; not optimizer tools):\n" + "S".repeat(6000) +
      "\n\nPROJECT TREE (names only, partial):\n" + "T".repeat(6000);
    const input = buildRefineInput("draft intact", history, project);
    const result = budgetRequest("system", input, { ...model, contextWindow: 8000 }, 1024);
    expect(result.report).toMatchObject({ status: "trimmed", removedMessages: 0, removedProjectParts: ["project tree", "skill metadata"] });
    const sent = JSON.parse(result.input);
    expect(sent.project_context).toContain("preserve rules");
    expect(sent.conversation.items).toEqual(history.items);
    expect(sent.budget_omissions).toHaveLength(2);
    expect(input).toContain("T".repeat(6000));
  });

  it("removes older whole messages first, preserving latest user and assistant and accurate counts", () => {
    const history = selectHistory([
      message("old", "user", "O".repeat(4000)),
      message("assistant", "assistant", "current proposal"),
      message("correction", "user", "Only discuss. Do not implement."),
    ], 12, 16_000);
    const input = buildRefineInput("Explain", history);
    const result = budgetRequest("system", input, { ...model, contextWindow: 6500 }, 1024);
    expect(result.report).toMatchObject({ status: "trimmed", removedMessages: 1 });
    expect(JSON.parse(result.input).conversation).toMatchObject({
      status: "partial", total_message_count: 3, selected_message_count: 2,
      omitted_message_count: 1, excerpted_message_count: 0,
      items: [{ id: "assistant" }, { id: "correction" }],
    });
    expect(history.items).toHaveLength(3);
    expect(budgetRequest("system", input, model, 1024).input).toBe(input);
  });

  it("keeps omission and excerpt counts correct for already-truncated history", () => {
    const history = selectHistory([
      message("old", "user", "old"), message("a", "assistant", "a".repeat(8000)), message("u", "user", "u".repeat(8000)),
    ], 2, 9000);
    const result = budgetRequest("system", buildRefineInput("draft", history), { ...model, contextWindow: 6000 }, 1024);
    const conversation = JSON.parse(result.input).conversation;
    expect(conversation.total_message_count).toBe(3);
    expect(conversation.omitted_message_count + conversation.selected_message_count).toBe(3);
    expect(conversation.excerpted_message_count).toBe(conversation.items.filter((item: any) => item.status === "excerpted").length);
  });

  it("blocks rather than cutting mandatory draft, custom system or revision fields", () => {
    const draft = "中文原文".repeat(1000);
    const revision = { previousCandidate: "previous".repeat(1000), instruction: "Keep paths unchanged" };
    const input = buildRefineInput(draft, empty, "optional project", revision);
    const result = budgetRequest("custom system".repeat(1000), input, { ...model, contextWindow: 20_000 }, 16_384);
    expect(result.report.status).toBe("blocked");
    expect(result.maxTokens).toBe(0);
    expect(JSON.parse(result.input)).toMatchObject({ original_draft: draft, previous_candidate: revision.previousCandidate, revision_instruction: revision.instruction });
    expect(result.report.message).toContain("Request not sent");
  });

  it("blocks when the full prompt cannot fit the configured or model output ceiling", () => {
    for (const [maxTokens, configLimit] of [[100, 8192], [16_384, 100]]) {
      const input = packet("中文".repeat(500));
      const result = budgetRequest("system", input, { ...model, maxTokens: maxTokens! }, configLimit!);
      expect(result.report.status).toBe("blocked");
      expect(result.report.message).toContain("output reserve");
      expect(result.input).toBe(input);
    }
  });

  it("can use a higher configured allowance for a long Chinese draft without exceeding the model", () => {
    const input = packet("保留原文".repeat(2500));
    const result = budgetRequest("system", input, { contextWindow: 128_000, maxTokens: 48_000 }, 65_536);
    expect(result.report.status).toBe("ok");
    expect(result.maxTokens).toBe(48_000);
    expect(result.input).toBe(input);
  });

  it("reduces surplus output only after optional context, never below the full-prompt reserve", () => {
    const result = budgetRequest("system", packet(), { ...model, contextWindow: 6000 }, 8192);
    expect(result.report.status).toBe("ok");
    expect(result.maxTokens).toBeLessThan(8192);
    expect(result.maxTokens).toBeGreaterThan(256);
    expect(result.report.inputTokens + result.report.outputTokens + result.report.safetyTokens).toBe(6000);
  });

  it.each([undefined, "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)("budgets reasoning adapters safely: %s", (thinking) => {
    const result = budgetRequest("system", packet(), model, 8192, thinking);
    expect(result.report.status).toBe("ok");
    const addedThinking = result.thinkingBudgets?.high ?? 0;
    expect(result.maxTokens + addedThinking).toBe(result.report.outputTokens);
    expect(result.maxTokens + addedThinking).toBeLessThanOrEqual(model.maxTokens);
    if (thinking && thinking !== "off") expect(addedThinking).toBeGreaterThanOrEqual(1024);
  });

  it.each([0, -1, NaN, Infinity, undefined])("fails closed on unavailable/invalid model capacity: %s", (capacity) => {
    const result = budgetRequest("system", packet(), { contextWindow: capacity as number, maxTokens: 8192 }, 8192);
    expect(result.report.status).toBe("blocked");
    expect(result.report.message).toContain("missing or invalid");
  });

  it("maintains the budget inequality across window, language, background and reasoning sizes", () => {
    for (const window of [4096, 8192, 16_384, 32_768, 128_000]) {
      for (const text of ["abc", "中文😀\\\"\n".repeat(200)]) {
        for (const thinking of ["off", "high"] as const) {
          const history = selectHistory([message("a", "assistant", "x".repeat(9000)), message("u", "user", "last correction")], 12, 16_000);
          const result = budgetRequest("sys", buildRefineInput(text, history, "p".repeat(6000)), { contextWindow: window, maxTokens: 8192 }, 8192, thinking);
          expect(JSON.parse(result.input).draft).toBe(text);
          if (result.report.status === "blocked") { expect(result.maxTokens).toBe(0); continue; }
          const { inputTokens, outputTokens, safetyTokens } = result.report;
          expect(inputTokens).toBe(estimateTextTokens("sys") + estimateTextTokens(result.input));
          expect(inputTokens + outputTokens + safetyTokens).toBeLessThanOrEqual(window);
          expect(result.maxTokens + (result.thinkingBudgets?.high ?? 0)).toBe(outputTokens);
          expect(outputTokens).toBeLessThanOrEqual(8192);
        }
      }
    }
  });
});
