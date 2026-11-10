import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { appendFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildRefineInput, buildRefineSystemPrompt, parseRefineOutput, selectHistory } from "../../src/context.js";
import { composeRevision, selectPreference } from "../../src/revision-preferences.js";

// Explicit opt-in: sends ONLY the synthetic fixtures below, using locally configured
// Pi credentials. Never part of the offline suite; JSONL contains no credentials.
// REFINE_LIVE=1 REFINE_LIVE_OUTPUT=/tmp/revision-semantics.jsonl npm test -- test/live/revision-semantics.live.test.ts
const enabled = process.env.REFINE_LIVE === "1";
const mode = process.env.REFINE_LIVE_MODE === "seeded" ? "seeded" : "chain";
const scenarios = [
  { name: "remove-response-language", draft: "解释 `npm test -- --run` 的用途和注意事项，不执行命令。",
    kind: "task", initial: "Answer in English.",
    seed: "简述 `npm test -- --run` 的用途和注意事项，不执行命令。",
    revisions: ["删除回答语言要求，不添加任何其他回答语言限制。", "再精简一点。", "保留命令原样。"] },
  { name: "retain-translation", draft: "解释 `npm test -- --run` 的用途和注意事项，不执行命令。",
    kind: "rewrite", initial: "Translate the prompt to English.",
    seed: "Explain `npm test -- --run` and any precautions. Do not run it.",
    revisions: ["保留现有内容，只改善措辞。", "再精简一点。", "保留命令原样。"] },
  { name: "retain-format", draft: "解释 `npm test -- --run` 的用途，再列出注意事项，不执行命令。",
    kind: "rewrite", initial: "Rewrite the prompt as exactly two numbered items, starting with 1. and 2. Keep commands literal.",
    seed: "1. 解释 `npm test -- --run` 的用途。\n2. 列出注意事项，不执行命令。",
    revisions: ["保留现有内容，只改善措辞。", "再精简一点。", "保留命令原样。"] },
] as const;
const cases = scenarios.flatMap((scenario) => (["current", "omit-history"] as const).flatMap((strategy) =>
  Array.from({ length: Number(process.env.REFINE_LIVE_REPEATS ?? 2) }, (_, repeat) => ({ scenario, strategy, repeat }))));

describe.skipIf(!enabled)("live revision semantics (observations, not proof of general compliance)", () => {
  it.concurrent.each(cases)("$scenario.name / $strategy / $repeat", async ({ scenario, strategy, repeat }) => {
    const runtime = await ModelRuntime.create();
    const provider = process.env.REFINE_LIVE_PROVIDER ?? "openai-codex";
    const model = runtime.getModel(provider, process.env.REFINE_LIVE_MODEL ?? "gpt-6-luna");
    expect(model, "Model must be configured locally").toBeDefined();
    const preferences = [selectPreference({ id: "synthetic", scope: "project", version: 1, name: scenario.name,
      body: scenario.initial, metadata: { kind: scenario.kind, activation: "manual", description: "Synthetic fixture" } })];
    const history = selectHistory([], 0, 0);
    // Seeded probes isolate the late-window request with identical candidates in
    // both arms. The removed requirement/correction is absent from this candidate.
    let candidate: string = mode === "seeded" ? scenario.seed : "";
    let previousInstruction: string | undefined = mode === "seeded" ? scenario.revisions[1] : undefined;
    const steps: Array<{ packet: unknown; prompt: string }> = [];
    for (let step = mode === "seeded" ? 3 : 0; step <= scenario.revisions.length; step++) {
      const instruction = scenario.revisions[step - 1];
      const packet = JSON.parse(buildRefineInput(scenario.draft, history, "", step ? {
        previousCandidate: candidate, instruction: instruction!, previousInstruction,
      } : undefined, step ? undefined : composeRevision(preferences, ""), preferences));
      if (strategy === "omit-history") delete packet.historical_editing_context;
      const response = await runtime.streamSimple(model!, {
        systemPrompt: buildRefineSystemPrompt(false), tools: [],
        messages: [{ role: "user", content: JSON.stringify(packet), timestamp: Date.now() }],
      }, { maxTokens: 2048, reasoning: "low", maxRetries: 0, signal: AbortSignal.timeout(120_000) }).result();
      const raw = response.content.filter((block) => block.type === "text").map((block) => block.text).join("");
      expect(response.stopReason, response.errorMessage).toBe("stop");
      const parsed = parseRefineOutput(raw);
      expect(parsed, raw).toBeDefined();
      candidate = parsed!.text;
      steps.push({ packet, prompt: candidate });
      previousInstruction = instruction;
    }
    const observation = { mode, provider, model: model!.id, reasoning: "low", scenario: scenario.name, strategy, repeat, steps };
    if (process.env.REFINE_LIVE_OUTPUT) await appendFile(process.env.REFINE_LIVE_OUTPUT, JSON.stringify(observation) + "\n");
    console.log(JSON.stringify(observation));
  }, 540_000);
});
