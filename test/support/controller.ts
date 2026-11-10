import { vi } from "vitest";
import type { ModelRef } from "../../src/config.js";
import { buildRefineSystemPrompt, selectHistory } from "../../src/context.js";
import { RefineController, type RefineCompletion, type RefineRequest, type RefineRequestInput } from "../../src/controller.js";
import { FakeScheduler, success } from "./helpers.js";

export const model: ModelRef = { provider: "provider-a", id: "chat-model" };

export function input(draft: string, overrides: Partial<RefineRequestInput> = {}): RefineRequestInput {
  return {
    draft,
    model,
    sessionId: "session-1",
    branchLeafId: "leaf-1",
    history: selectHistory([{ type: "message", message: { role: "user", content: "Keep it concise" } }], 12, 1000),
    systemPrompt: buildRefineSystemPrompt(false),
    ...overrides,
  };
}

export function setup(complete: (request: RefineRequest, signal: AbortSignal) => Promise<RefineCompletion> = vi.fn(async () => success("Refined")), scheduler = new FakeScheduler()) {
  const onState = vi.fn();
  const onAccepted = vi.fn();
  const controller = new RefineController({
    complete,
    timeoutMs: 100,
    maxDraftChars: 100,
    maxOutputChars: 200,
    scheduler,
    onState,
    onAccepted,
  }, model);
  controller.setSession("session-1");
  return { controller, onState, onAccepted, scheduler };
}
