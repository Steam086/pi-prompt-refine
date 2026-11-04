import { describe, expect, it, vi } from "vitest";
import { RefineController, type RefineCompletion, type RefineRequest, type RefineRequestInput } from "../src/controller.js";
import type { ModelRef } from "../src/config.js";
import type { BudgetReport } from "../src/budget.js";
import { buildRefineSystemPrompt, selectHistory } from "../src/context.js";
import { deferred, FakeScheduler, flushPromises, success } from "./helpers.js";

const model: ModelRef = { provider: "provider-a", id: "chat-model" };

function input(draft: string, overrides: Partial<RefineRequestInput> = {}): RefineRequestInput {
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

function setup(complete: (request: RefineRequest, signal: AbortSignal) => Promise<RefineCompletion> = vi.fn(async () => success("Refined")), scheduler = new FakeScheduler()) {
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

describe("request budget diagnostics", () => {
  const report: BudgetReport = { status: "trimmed", inputTokens: 200, outputTokens: 1000, safetyTokens: 4096,
    contextWindow: 8000, outputLimit: 1000, removedMessages: 1, removedProjectParts: [], message: "Background reduced" };

  it("keeps per-run budgets separate from reusable input and ignores stale diagnostics", async () => {
    const jobs: Array<{ request: RefineRequest; pending: ReturnType<typeof deferred<RefineCompletion>> }> = [];
    const { controller } = setup((request) => {
      const pending = deferred<RefineCompletion>(); jobs.push({ request, pending }); return pending.promise;
    });
    controller.trigger(input("Draft"));
    const first = jobs[0]!;
    controller.capturePreparedInput(first.request.requestId, first.request.generation, "Full packet");
    controller.captureBudget(first.request.requestId, first.request.generation, report, "Reduced packet");
    expect(controller.getState().budget).toEqual(report);
    first.pending.resolve(success("Result")); await flushPromises();
    expect(controller.getCandidate()).toMatchObject({ preparedInput: "Full packet", sentInput: "Reduced packet", budget: report });
    controller.rerunRecord(first.request.recordId, { provider: "other", id: "larger" });
    const second = jobs[1]!;
    expect(second.request.preparedInput).toBe("Full packet");
    expect(second.request.budget).toBeUndefined();
    expect(second.request.sentInput).toBeUndefined();
    controller.captureBudget(second.request.requestId, second.request.generation, { ...report, status: "ok", removedMessages: 0 }, "Full packet");
    // Background work cannot overwrite the applied candidate's warning.
    expect(controller.getState().budget).toEqual(report);
    controller.stopRequest(second.request.recordId);
    controller.captureBudget(second.request.requestId, second.request.generation, { ...report, status: "blocked" });
    expect(controller.getRecord(second.request.recordId)?.input.budget?.status).toBe("ok");
    second.pending.resolve(success("Late")); await flushPromises();
  });

  it("reports budget rejection distinctly and preserves the previous revision candidate", async () => {
    let blocked = false;
    const { controller } = setup(async (request) => {
      if (!blocked) return success("Previous");
      controller.captureBudget(request.requestId, request.generation, { ...report, status: "blocked", message: "Request not sent" });
      return { text: "", stopReason: "budget" };
    });
    controller.trigger(input("Draft")); await flushPromises();
    blocked = true;
    controller.trigger(input("Draft", { revision: { previousCandidate: "Previous", instruction: "Shorten" } }), { revisionToken: controller.getCandidateToken()! });
    await flushPromises();
    expect(controller.getState()).toMatchObject({ phase: "error", error: "budget", budget: { status: "blocked" } });
    expect(controller.getCandidate()?.text).toBe("Previous");
    expect(controller.getHistory().at(-1)).toMatchObject({ status: "error", error: "budget" });
  });
});

describe("request source and shortcut routing", () => {
  it("preserves A while B runs and keeps B as the explicit foreground", async () => {
    const a = deferred<RefineCompletion>();
    const b = deferred<RefineCompletion>();
    const complete = vi.fn().mockImplementationOnce(() => a.promise).mockImplementationOnce(() => b.promise);
    const { controller } = setup(complete);
    expect(controller.shouldOpenPanel("A")).toBe(false);
    expect(controller.shouldOpenPanel(" ")).toBe(true);
    controller.trigger(input("A"));
    expect(controller.getRequestSource()).toEqual({ draft: "A" });
    controller.getRequestSource()!.draft = "mutated";
    expect(controller.shouldOpenPanel("A")).toBe(true);
    expect(controller.shouldOpenPanel("B")).toBe(true);
    expect(controller.trigger(input("x".repeat(101))).kind).toBe("too-long");
    expect(controller.getRequestSource()).toEqual({ draft: "A" });
    controller.trigger(input("B"));
    expect(complete.mock.calls[0]![1].aborted).toBe(false);
    expect(controller.getRequestSource()).toEqual({ draft: "B" });
    a.resolve(success("Late A"));
    await flushPromises();
    expect(controller.getState().phase).toBe("generating");
    b.resolve(success("Result B"));
    await flushPromises();
    expect(controller.getCandidate()?.text).toBe("Result B");
    expect(controller.shouldOpenPanel("B")).toBe(true);
    expect(controller.shouldOpenPanel("A")).toBe(true);
    controller.beginSend(controller.getCandidateToken()!);
    expect(controller.shouldOpenPanel("C")).toBe(true);
    controller.onSubmittedInput("Result B", "extension", "followUp");
    controller.onMessageStarted("Result B");
    expect(controller.getHistory().every((record) => record.archivedAt !== undefined)).toBe(true);
    expect(controller.getRequestSource()).toEqual({ draft: "B" });
  });

  it.each(["failure", "timeout"])("retains the source after %s but clears it on invalidation", async (outcome) => {
    const pending = deferred<RefineCompletion>();
    const { controller, scheduler } = setup(() => pending.promise);
    controller.trigger(input("A", { thinkingLevel: "high" }));
    expect(controller.getState()).toMatchObject({ phase: "generating", thinkingLevel: "high" });
    if (outcome === "timeout") scheduler.advance(100);
    else pending.reject(new Error("offline"));
    await flushPromises();
    expect(controller.getState()).toMatchObject({ phase: "error", thinkingLevel: "high" });
    expect(controller.getRequestSource()).toEqual({ draft: "A" });
    expect(controller.shouldOpenPanel("A")).toBe(true);
    expect(controller.shouldOpenPanel("B")).toBe(true);
    controller.invalidateLifecycle(true);
    expect(controller.getRequestSource()).toBeUndefined();
  });
});

describe("candidate revisions", () => {
  it("freezes revision input and retains the original draft across bounded successive revisions", async () => {
    const complete = vi.fn(async () => success("First result"));
    const { controller } = setup(complete);
    controller.trigger(input("Original constraints"));
    await flushPromises();
    const first = controller.getCandidateToken()!;
    const request = input("Original constraints", { revision: { previousCandidate: "First result", instruction: "Shorter" } });
    complete.mockResolvedValueOnce(success("Second result"));
    expect(controller.trigger(request, { revisionToken: first }).kind).toBe("started");
    expect(controller.getCandidate()).toBeUndefined();
    request.revision!.instruction = "Mutated";
    expect(controller.getRequestSource()).toEqual({ draft: "Original constraints", revisionInstruction: "Shorter" });
    await flushPromises();
    expect(controller.getCandidate()).toMatchObject({ draft: "Original constraints", text: "Second result", revision: { instruction: "Shorter" } });
    const copy = controller.getCandidate()!;
    copy.revision!.previousCandidate = "Mutated copy";
    expect(controller.getCandidate()?.revision?.previousCandidate).toBe("First result");
    complete.mockResolvedValueOnce(success("Third result"));
    controller.trigger(input("Original constraints", { revision: { previousCandidate: "Second result", instruction: "Keep commands" } }), { revisionToken: controller.getCandidateToken()! });
    await flushPromises();
    expect(controller.getCandidate()).toMatchObject({ draft: "Original constraints", text: "Third result", revision: { previousCandidate: "Second result", instruction: "Keep commands" } });
    expect(JSON.stringify(controller.getCandidate())).not.toContain("First result");
    expect(controller.acceptCandidate(first, "Original constraints", false, () => {})).toBe(false);
    const write = vi.fn();
    expect(controller.acceptCandidate(controller.getCandidateToken()!, "Original constraints", false, write)).toBe(true);
    expect(write).toHaveBeenCalledWith("Third result");
    expect(controller.getRestore()?.before).toBe("Original constraints");
  });

  it("rejects empty, over-budget, stale, mismatched and pending-send revisions without discarding the source", async () => {
    const { controller } = setup();
    controller.trigger(input("Draft"));
    await flushPromises();
    const token = controller.getCandidateToken()!;
    const revision = (instruction: string) => input("Draft", { revision: { previousCandidate: "Refined", instruction } });
    expect(controller.trigger(revision(" "), { revisionToken: token }).kind).toBe("empty");
    expect(controller.trigger(revision("x".repeat(101)), { revisionToken: token }).kind).toBe("too-long");
    expect(controller.trigger(revision("Shorter")).kind).toBe("stale-source");
    expect(controller.trigger({ ...revision("Shorter"), draft: "Other task" }, { revisionToken: token }).kind).toBe("stale-source");
    controller.beginSend(token);
    expect(controller.trigger(revision("Shorter"), { revisionToken: token }).kind).toBe("stale-source");
    controller.failSend(token.requestId);
    controller.updateCandidate(token, "Manually edited");
    expect(controller.trigger(revision("Shorter"), { revisionToken: token }).kind).toBe("stale-source");
    expect(controller.getCandidate()?.text).toBe("Manually edited");
  });

  it("accepts a previous result larger than the draft limit without treating it as a new draft", async () => {
    const { controller } = setup(async () => success("x".repeat(150)));
    controller.trigger(input("Draft"));
    await flushPromises();
    expect(controller.trigger(input("Draft", { revision: { previousCandidate: "x".repeat(150), instruction: "Shorter" } }), { revisionToken: controller.getCandidateToken()! }).kind).toBe("started");
    await flushPromises();
  });

  it.each(["failure", "invalid", "truncated", "timeout"])("restores the previous candidate after revision %s and rejects late output", async (kind) => {
    const pending = deferred<RefineCompletion>();
    let calls = 0;
    const { controller, scheduler } = setup(() => ++calls === 1 ? Promise.resolve(success("Previous")) : pending.promise);
    controller.trigger(input("Draft"));
    await flushPromises();
    const oldToken = controller.getCandidateToken()!;
    controller.trigger(input("Draft", { revision: { previousCandidate: "Previous", instruction: "Shorter" } }), { revisionToken: oldToken });
    if (kind === "timeout") scheduler.advance(100);
    else if (kind === "failure") pending.reject(new Error("offline"));
    else pending.resolve({ text: "bad", stopReason: kind === "truncated" ? "length" : "stop", invalidOutput: kind === "invalid" });
    await flushPromises();
    expect(controller.getState().phase).toBe("error");
    expect(controller.getCandidate()?.text).toBe("Previous");
    expect(controller.isCandidateCurrent(oldToken)).toBe(false);
    expect(controller.isCandidateCurrent(controller.getCandidateToken()!)).toBe(true);
    pending.resolve(success("Late replacement"));
    await flushPromises();
    expect(controller.getCandidate()?.text).toBe("Previous");
  });

  it.each(["cancel", "session", "new-draft"])("does not resurrect a revision source after %s", async (change) => {
    const pending = deferred<RefineCompletion>();
    let calls = 0;
    const { controller } = setup(() => ++calls === 1 ? Promise.resolve(success("Previous")) : pending.promise);
    controller.trigger(input("Draft"));
    await flushPromises();
    controller.trigger(input("Draft", { revision: { previousCandidate: "Previous", instruction: "Shorter" } }), { revisionToken: controller.getCandidateToken()! });
    if (change === "cancel") controller.cancelAndDismiss();
    if (change === "session") controller.setSession("other");
    if (change === "new-draft") controller.trigger(input("New draft"));
    pending.reject(new Error("Late failure"));
    await flushPromises();
    expect(controller.getCandidate()).toBeUndefined();
  });
});

describe("RefineController request lifecycle", () => {
  it("freezes duration through edits, pending sends, acceptance and restore, and resets it on retry", async () => {
    let now = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      let pending = deferred<RefineCompletion>();
      const { controller } = setup(() => pending.promise);
      controller.trigger(input("First"));
      now = 12_900;
      expect(controller.getState().elapsedSeconds).toBe(12);
      pending.resolve(success("First result"));
      await flushPromises();
      now = 60_000;
      expect(controller.getState().elapsedSeconds).toBe(12);
      controller.updateCandidate(controller.getCandidateToken()!, "Edited first result");
      controller.beginSend(controller.getCandidateToken()!);
      expect(controller.getState().elapsedSeconds).toBe(12);
      controller.failSend(controller.getState().requestId);
      controller.acceptCandidate(controller.getCandidateToken()!, "First", false, () => {});
      expect(controller.getAccepted()?.elapsedSeconds).toBe(12);

      pending = deferred<RefineCompletion>();
      controller.trigger(input("Edited first result"));
      expect(controller.getState().elapsedSeconds).toBe(0);
      now += 3_000;
      pending.resolve(success("Second result"));
      await flushPromises();
      controller.acceptCandidate(controller.getCandidateToken()!, "Edited first result", false, () => {});
      expect(controller.getAccepted()?.elapsedSeconds).toBe(3);
      controller.restoreDraft(controller.getRestoreToken()!, "Second result", false, () => {});
      expect(controller.getAccepted()?.elapsedSeconds).toBe(12);
    } finally {
      clock.mockRestore();
    }
  });

  it.each(["failure", "timeout"])("freezes duration after %s and ignores late output", async (kind) => {
    let now = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const pending = deferred<RefineCompletion>();
      const { controller, scheduler } = setup(() => pending.promise);
      controller.trigger(input("Draft"));
      now = 5_000;
      if (kind === "timeout") scheduler.advance(100);
      else pending.reject(new Error("offline"));
      await flushPromises();
      expect(controller.getState()).toMatchObject({ phase: "error", elapsedSeconds: 5 });
      now += 30_000;
      pending.resolve(success("Late"));
      await flushPromises();
      expect(controller.getState().elapsedSeconds).toBe(5);
      expect(controller.getCandidate()).toBeUndefined();
    } finally {
      clock.mockRestore();
    }
  });

  it("freezes round history and system prompt until a committed send", async () => {
    const pending = deferred<RefineCompletion>();
    const complete = vi.fn(() => pending.promise);
    const { controller } = setup(complete);
    const request = input("Draft", { thinkingLevel: "high" });
    controller.trigger(request);
    request.history.items[0]!.text = "mutated outside request";
    expect(controller.trigger(input("Draft", { thinkingLevel: "high" })).kind).toBe("duplicate");
    const updated = input("Draft", { thinkingLevel: "high", systemPrompt: buildRefineSystemPrompt(false, "Be brief") });
    expect(controller.trigger(updated).kind).toBe("duplicate");
    pending.resolve(success("Refined"));
    await flushPromises();
    expect(controller.getCandidate()?.history.items[0]?.text).toBe("Keep it concise");
    expect(controller.getCandidate()?.systemPrompt).toBe(request.systemPrompt);
    expect(controller.trigger(updated).kind).toBe("ready");
    const copy = controller.getCandidate()!;
    copy.history.items[0]!.text = "mutated copy";
    expect(controller.getCandidate()?.history.items[0]?.text).toBe("Keep it concise");
    const changed = structuredClone(updated);
    changed.history.status = "partial";
    changed.history.omittedMessageCount = 1;
    expect(controller.trigger(changed).kind).toBe("ready");
    controller.onMessageStarted("Sent prompt");
    expect(controller.trigger(changed).kind).toBe("started");
  });

  it("freezes title eligibility per round and drops unsolicited titles in the next", async () => {
    const { controller } = setup(async () => ({ ...success("Prompt"), title: "Project task" }));
    controller.trigger(input("Draft", { generateTitle: true }));
    await flushPromises();
    expect(controller.getCandidate()?.title).toBe("Project task");
    expect(controller.trigger(input("Draft", { generateTitle: true })).kind).toBe("ready");
    expect(controller.trigger(input("Draft", { generateTitle: false })).kind).toBe("ready");
    controller.onMessageStarted("Prompt");
    expect(controller.trigger(input("Draft", { generateTitle: false })).kind).toBe("started");
    await flushPromises();
    expect(controller.getCandidate()?.title).toBeUndefined();
  });

  it("rejects invalid structured output while retaining reported usage", async () => {
    const { controller, onAccepted } = setup(async () => ({ ...success(""), invalidOutput: true, usage: { totalTokens: 12 } }));
    controller.trigger(input("Draft", { generateTitle: true }));
    await flushPromises();
    expect(controller.getState()).toMatchObject({ phase: "error", error: "invalid-output", usage: { totalTokens: 12 } });
    expect(controller.getCandidate()).toBeUndefined();
    expect(onAccepted).not.toHaveBeenCalled();
  });
  it("freezes project resources for the whole round", async () => {
    const pending = deferred<ReturnType<typeof success>>();
    const requests: RefineRequest[] = [];
    const complete = vi.fn((request: RefineRequest) => { requests.push(request); return pending.promise; });
    const { controller } = setup(complete);
    const project = { cwd: "/repo", snapshot: { text: "Original rules", warnings: [], instructionCount: 1, skillCount: 0 } };
    expect(controller.trigger(input("draft", { project })).kind).toBe("started");
    expect(controller.trigger(input("draft", { project })).kind).toBe("duplicate");
    project.snapshot.text = "Updated rules";
    expect(requests[0]?.project?.snapshot.text).toBe("Original rules");
    expect(controller.trigger(input("draft", { project })).kind).toBe("duplicate");
    pending.resolve(success("Refined"));
    await flushPromises();
    expect(controller.getCandidate()?.project?.snapshot.text).toBe("Original rules");
    expect(controller.trigger(input("draft", { project })).kind).toBe("ready");
  });

  it("deduplicates an active snapshot and reuses its ready candidate", async () => {
    const pending = deferred<ReturnType<typeof success>>();
    const complete = vi.fn(() => pending.promise);
    const { controller } = setup(complete);

    expect(controller.trigger(input("draft A")).kind).toBe("started");
    expect(controller.trigger(input("draft A")).kind).toBe("duplicate");
    expect(complete).toHaveBeenCalledTimes(1);
    pending.resolve(success("improved A"));
    await flushPromises();
    expect(controller.getCandidate()?.text).toBe("improved A");
    expect(controller.trigger(input("draft A")).kind).toBe("ready");
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("lets a newer B request win when A resolves out of order; old finally cannot clear B", async () => {
    const a = deferred<ReturnType<typeof success>>();
    const b = deferred<ReturnType<typeof success>>();
    const signals: AbortSignal[] = [];
    const complete = vi.fn((request: RefineRequest, signal: AbortSignal) => {
      signals.push(signal);
      return request.draft === "A" ? a.promise : b.promise;
    });
    const { controller, scheduler } = setup(complete);

    controller.trigger(input("A"));
    controller.trigger(input("B"));
    expect(signals[0]?.aborted).toBe(false);
    expect(signals[1]?.aborted).toBe(false);
    b.resolve(success("B refined"));
    await flushPromises();
    a.resolve(success("A refined"));
    await flushPromises();

    expect(controller.getCandidate()?.text).toBe("B refined");
    expect(controller.getCandidate()?.draft).toBe("B");
    expect(controller.getState().phase).toBe("ready");
    expect(scheduler.size).toBe(0);
  });

  it("creates a new round for explicitly requested identical text after a committed send", async () => {
    const a = deferred<ReturnType<typeof success>>();
    const replacement = deferred<ReturnType<typeof success>>();
    const signals: AbortSignal[] = [];
    const complete = vi.fn((_request: RefineRequest, signal: AbortSignal) => {
      signals.push(signal);
      return signals.length === 1 ? a.promise : replacement.promise;
    });
    const { controller } = setup(complete);

    controller.trigger(input("same A"));
    expect(controller.onSubmittedInput("same A", "interactive")).toBe("pending");
    controller.onMessageStarted("same A");
    controller.trigger(input("same A"));
    expect(signals[0]?.aborted).toBe(false);
    expect(complete).toHaveBeenCalledTimes(2);
    replacement.resolve(success("new A"));
    await flushPromises();
    a.resolve(success("stale A"));
    await flushPromises();
    expect(controller.getCandidate()?.text).toBe("new A");
  });

  it("archives A without cancelling it when user message B starts", async () => {
    const pending = deferred<ReturnType<typeof success>>();
    let signal: AbortSignal | undefined;
    const { controller } = setup((_request, requestSignal) => {
      signal = requestSignal;
      return pending.promise;
    });

    controller.trigger(input("A"));
    controller.onSubmittedInput("B", "interactive");
    controller.onMessageStarted("B");
    expect(signal?.aborted).toBe(false);
    pending.resolve(success("Archived A"));
    await flushPromises();
    expect(controller.getHistory()[0]).toMatchObject({ status: "generated", candidate: { text: "Archived A" }, archivedAt: expect.any(Number) });
    expect(controller.getRoundId()).toBeUndefined();
  });

  it.each(["resolve", "reject"] as const)("drops provider callbacks after cancel (%s)", async (callback) => {
    const pending = deferred<ReturnType<typeof success>>();
    let signal: AbortSignal | undefined;
    const { controller, onState, scheduler } = setup((_request, requestSignal) => {
      signal = requestSignal;
      return pending.promise;
    });
    controller.trigger(input("A"));
    controller.cancelAndDismiss();
    expect(signal?.aborted).toBe(true);
    expect(scheduler.size).toBe(0);

    if (callback === "resolve") pending.resolve(success("late"));
    else pending.reject(new Error("late failure"));
    await flushPromises();
    expect(controller.getCandidate()).toBeUndefined();
    expect(controller.getState().phase).toBe("idle");
    expect(onState.mock.calls.at(-1)?.[0].phase).toBe("idle");
  });

  it("exposes an active provider/auth failure without creating a candidate", async () => {
    const { controller } = setup(async () => { throw new Error("authentication failed"); });
    controller.trigger(input("draft"));
    await flushPromises();
    expect(controller.getCandidate()).toBeUndefined();
    expect(controller.getState()).toMatchObject({ phase: "error", error: "failed" });
  });

  it("aborts on timeout and ignores providers that return after abort", async () => {
    const pending = deferred<ReturnType<typeof success>>();
    let signal: AbortSignal | undefined;
    const { controller, scheduler } = setup((_request, requestSignal) => {
      signal = requestSignal;
      return pending.promise;
    });
    controller.trigger(input("slow"));
    scheduler.advance(100);
    expect(signal?.aborted).toBe(true);
    expect(controller.getState()).toMatchObject({ phase: "error", error: "timeout" });
    pending.resolve(success("late but complete"));
    await flushPromises();
    expect(controller.getCandidate()).toBeUndefined();
    expect(controller.getState()).toMatchObject({ phase: "error", error: "timeout" });
  });

  it("rejects empty, tool-call, non-stop and overlong outputs", async () => {
    const cases = [
      { text: "  \n", stopReason: "stop" as const, error: "empty" },
      { text: "partial", stopReason: "length" as const, error: "truncated" },
      { text: "tool result", stopReason: "toolUse" as const, error: "tool-call" },
      { text: "x".repeat(201), stopReason: "stop" as const, error: "truncated" },
    ];
    for (const result of cases) {
      const { controller } = setup(async () => result);
      controller.trigger(input("draft"));
      await flushPromises();
      expect(controller.getCandidate()).toBeUndefined();
      expect(controller.getState()).toMatchObject({ phase: "error", error: result.error });
    }
  });

  it("rejects oversized drafts before calling the model", () => {
    const complete = vi.fn(async () => success("not called"));
    const { controller } = setup(complete);
    expect(controller.trigger(input("x".repeat(101))).kind).toBe("too-long");
    expect(complete).not.toHaveBeenCalled();
    expect(controller.getState().phase).toBe("idle");
  });

  it("explicit re-optimization bypasses a ready cache but still deduplicates in-flight requests", async () => {
    const pending = deferred<ReturnType<typeof success>>();
    const complete = vi.fn().mockResolvedValueOnce(success("first")).mockImplementation(() => pending.promise);
    const { controller } = setup(complete);
    controller.trigger(input("draft"));
    await flushPromises();
    expect(controller.trigger(input("draft")).kind).toBe("ready");
    expect(controller.trigger(input("draft"), { force: true }).kind).toBe("started");
    expect(controller.trigger(input("draft"), { force: true }).kind).toBe("duplicate");
    expect(complete).toHaveBeenCalledTimes(2);
    pending.resolve(success("second"));
    await flushPromises();
    expect(controller.getCandidate()?.text).toBe("second");
  });

  it("does not discard a usable result when an explicit replacement draft is invalid", async () => {
    const { controller } = setup();
    controller.trigger(input("original"));
    await flushPromises();
    const token = controller.getCandidateToken()!;
    expect(controller.trigger(input(" "), { force: true }).kind).toBe("empty");
    expect(controller.trigger(input("x".repeat(101)), { force: true }).kind).toBe("too-long");
    expect(controller.isCandidateCurrent(token)).toBe(true);
  });

  it.each(["session", "branch", "reload", "shutdown"] as const)("invalidates late output after %s changes", async (boundary) => {
    const pending = deferred<ReturnType<typeof success>>();
    const { controller } = setup(() => pending.promise);
    controller.trigger(input("A"));
    if (boundary === "session") controller.setSession("session-2");
    else if (boundary === "branch") controller.invalidateLifecycle(true);
    else if (boundary === "reload" || boundary === "shutdown") controller.setSession("session-1");
    pending.resolve(success("late"));
    await flushPromises();
    expect(controller.getCandidate()).toBeUndefined();
    expect(controller.getState().phase).toBe("idle");
  });
});

describe("multi-model task history", () => {
  const other = { provider: "provider-b", id: "second-model" };

  it("retains models and candidate selection without calls or stale-token resurrection", async () => {
    const complete = vi.fn(async (request: RefineRequest) => success(`${request.model.id}-${request.requestId}`));
    const { controller } = setup(complete);
    controller.trigger(input("Draft"));
    await flushPromises();
    const firstToken = controller.getCandidateToken()!;
    const first = controller.getCandidate()!.text;
    controller.trigger(controller.getTaskInput()!, { force: true, sameTask: true });
    await flushPromises();
    expect(controller.getCandidate()?.text).toBe(first);
    controller.applyResult(controller.getHistory().at(-1)!.id);
    const second = controller.getCandidate()!.text;
    expect(controller.getCandidatePosition()).toMatchObject({ index: 2, count: 2 });
    controller.cycleCandidate(-1);
    expect(controller.getCandidate()?.text).toBe(first);
    expect(controller.isCandidateCurrent(firstToken)).toBe(false);
    controller.setModel(other);
    expect(controller.getCandidate()?.text).toBe(first);
    expect(controller.getCandidatePosition()).toMatchObject({ index: 1, count: 2 });
    expect(controller.shouldOpenPanel("Draft")).toBe(true);
    controller.trigger({ ...controller.getTaskInput()!, model: other }, { force: true, sameTask: true });
    await flushPromises();
    controller.setModel(model);
    controller.applyResult(controller.getHistory()[0]!.id);
    expect(controller.getCandidate()?.text).toBe(first);
    controller.cycleCandidate(1);
    expect(controller.getCandidate()?.text).toBe(second);
    expect(complete).toHaveBeenCalledTimes(3);
    expect(controller.getTaskModels()).toEqual([model, other]);
  });

  it("freezes final input and keeps it independent of revisions and journal copies", async () => {
    const { controller } = setup();
    controller.trigger(input("Original"));
    controller.capturePreparedInput(controller.getState().requestId, controller.getGeneration(), '{"draft":"Original","project":"snapshot"}');
    await flushPromises();
    const frozen = controller.getTaskInput()!;
    expect(controller.getCandidate()?.preparedInput).toBe(frozen.preparedInput);
    frozen.draft = "Mutated";
    controller.trigger(input("Original", { revision: { previousCandidate: "Refined", instruction: "Shorter" } }), { revisionToken: controller.getCandidateToken()! });
    controller.capturePreparedInput(controller.getState().requestId, controller.getGeneration(), "revision packet");
    await flushPromises();
    expect(controller.getTaskInput()?.preparedInput).toContain('"draft":"Original"');
    const history = controller.getHistory();
    history[0]!.candidate!.text = "mutated";
    expect(controller.getHistory()[0]?.candidate?.text).toBe("Refined");
    expect(history[1]).toMatchObject({ kind: "revise", parentId: history[0]!.id, taskId: history[0]!.taskId });
  });

  it("archives manual edits without losing raw model output or inventing request usage", async () => {
    const { controller } = setup(async () => ({ ...success("Raw model output"), usage: { totalTokens: 17 } }));
    controller.trigger(input("Draft"));
    await flushPromises();
    controller.updateCandidate(controller.getCandidateToken()!, "Edited text");
    const records = controller.getHistory();
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ kind: "refine", candidate: { text: "Raw model output" }, usage: { totalTokens: 17 } });
    expect(records[1]).toMatchObject({ kind: "edit", parentId: records[0]!.id, candidate: { text: "Edited text" } });
    expect(records[1]?.usage).toBeUndefined();
    expect(controller.getCandidate()?.usage).toBeUndefined();
    expect(controller.getState().usage).toBeUndefined();
    controller.cycleCandidate(-1);
    expect(controller.getCandidate()?.text).toBe("Raw model output");
  });

  it("retains accepted snapshots while other models run and permits explicit historical Apply", async () => {
    const { controller } = setup();
    controller.trigger(input("Draft"));
    await flushPromises();
    controller.acceptCandidate(controller.getCandidateToken()!, "Draft", false, () => {});
    controller.setModel(other);
    expect(controller.getViewedAccepted()?.text).toBe("Refined");
    expect(controller.getCandidate()).toBeUndefined();
    controller.trigger({ ...controller.getTaskInput()!, model: other }, { force: true, sameTask: true });
    await flushPromises();
    expect(controller.getCandidate()).toBeUndefined();
    controller.applyResult(controller.getHistory().at(-1)!.id);
    expect(controller.getCandidate()).toBeDefined();
    controller.setModel(model);
    expect(controller.getCandidateToken()).toBeDefined();
    expect(controller.applyResult(controller.getHistory()[0]!.id)).toBe(true);
    expect(controller.getCandidate()?.text).toBe("Refined");
    expect(controller.getHistory()[0]?.acceptedAt).toEqual(expect.any(Number));
  });

  it("allows switching in flight, stops one background run, and ignores late output", async () => {
    const pending = deferred<RefineCompletion>();
    const complete = vi.fn().mockResolvedValueOnce(success("First")).mockImplementationOnce(() => pending.promise);
    const { controller } = setup(complete);
    controller.trigger(input("Draft"));
    await flushPromises();
    controller.trigger(controller.getTaskInput()!, { force: true, sameTask: true });
    expect(controller.setModel(other)).toBe(true);
    expect(controller.cycleCandidate(1)).toBe(true);
    expect(controller.trigger(controller.getTaskInput()!, { sameTask: true }).kind).toBe("duplicate");
    controller.stopRequest(controller.getHistory().at(-1)!.id);
    expect(controller.getCandidate()?.text).toBe("First");
    expect(controller.getTaskInput()?.draft).toBe("Draft");
    expect(controller.setModel(model)).toBe(true);
    pending.resolve(success("Late"));
    await flushPromises();
    expect(controller.getCandidate()?.text).toBe("First");
    expect(controller.getHistory().map((record) => record.status)).toEqual(["generated", "cancelled"]);
  });

  it("records failures, acceptance and acknowledged sends separately, scoped by session", async () => {
    const complete = vi.fn().mockResolvedValueOnce({ ...success(""), invalidOutput: true, usage: { totalTokens: 5 } }).mockResolvedValue(success("Ready"));
    const { controller } = setup(complete);
    controller.trigger(input("Draft"));
    await flushPromises();
    controller.trigger(controller.getTaskInput()!, { force: true, sameTask: true });
    await flushPromises();
    controller.applyResult(controller.getHistory().at(-1)!.id);
    controller.beginSend(controller.getCandidateToken()!);
    expect(controller.setModel(other)).toBe(false);
    expect(controller.getHistory()[1]?.sentAt).toBeUndefined();
    controller.onSubmittedInput("Ready", "extension", "followUp");
    controller.onMessageStarted("Ready");
    expect(controller.getTaskInput()?.draft).toBe("Draft");
    expect(controller.getHistory()[0]).toMatchObject({ status: "error", error: "invalid-output", usage: { totalTokens: 5 } });
    expect(controller.getHistory()[1]?.sentAt).toEqual(expect.any(Number));
    expect(controller.getHistory()[1]?.acceptedAt).toBeUndefined();
    controller.setSession("other-session");
    expect(controller.getHistory()).toEqual([]);
    controller.setSession("session-1");
    expect(controller.getHistory()).toHaveLength(2);
    expect(controller.getTaskInput()).toBeUndefined();
  });
});

describe("RefineController explicit operations", () => {
  it.each(["accept", "idle-send", "follow-up"])("commits an independent metadata snapshot exactly once on %s", async (operation) => {
    const { controller, onAccepted, scheduler } = setup(async () => ({ ...success("Prompt"), title: "Task name" }));
    controller.trigger(input("Draft", { generateTitle: true }));
    await flushPromises();
    const token = controller.getCandidateToken()!;
    expect(onAccepted).not.toHaveBeenCalled();
    onAccepted.mockImplementation((candidate) => { candidate.title = "Mutated by observer"; });
    if (operation === "accept") {
      const writer = vi.fn(() => { expect(onAccepted).not.toHaveBeenCalled(); });
      expect(controller.acceptCandidate(token, "Draft", false, writer)).toBe(true);
      expect(controller.acceptCandidate(token, "Draft", false, writer)).toBe(false);
      expect(controller.getAccepted()?.title).toBe("Task name");
      controller.restoreDraft(controller.getRestoreToken()!, "Prompt", false, () => {});
    } else {
      controller.beginSend(token);
      expect(onAccepted).not.toHaveBeenCalled();
      if (operation === "idle-send") {
        controller.onSubmittedInput("Prompt", "extension");
        expect(onAccepted).not.toHaveBeenCalled();
        controller.onMessageStarted("Prompt");
      } else controller.onSubmittedInput("Prompt", "extension", "followUp");
      controller.onMessageStarted("Prompt");
    }
    expect(onAccepted).toHaveBeenCalledTimes(1);
    expect(scheduler.size).toBe(0);
  });

  it("clears a pending send when accepting, without a second commit on late acknowledgement", async () => {
    const { controller, onAccepted, scheduler } = setup();
    controller.trigger(input("Draft"));
    await flushPromises();
    const token = controller.getCandidateToken()!;
    controller.beginSend(token);
    controller.acceptCandidate(token, "Draft", false, () => {});
    expect(scheduler.size).toBe(0);
    controller.onMessageStarted("Refined");
    expect(onAccepted).toHaveBeenCalledTimes(1);
  });

  it("isolates metadata callback errors from the committed editor operation", async () => {
    const { controller, onAccepted } = setup();
    onAccepted.mockImplementation(() => { throw new Error("metadata unavailable"); });
    controller.trigger(input("Draft"));
    await flushPromises();
    expect(controller.acceptCandidate(controller.getCandidateToken()!, "Draft", false, () => {})).toBe(true);
    expect(controller.getState().phase).toBe("idle");
    expect(controller.getAccepted()?.text).toBe("Refined");
  });
  async function readyController(draft = "original") {
    const { controller } = setup();
    controller.trigger(input(draft));
    await flushPromises();
    const token = controller.getCandidateToken();
    expect(token).toBeDefined();
    return { controller, token: token! };
  }

  it("edits only the candidate, invalidates stale candidate tokens, and accepts explicitly", async () => {
    const { controller, token } = await readyController();
    expect(controller.updateCandidate(token, "edited result")).toBe(true);
    expect(controller.isCandidateCurrent(token)).toBe(false);
    const updatedToken = controller.getCandidateToken()!;
    const writes: string[] = [];
    expect(controller.acceptCandidate(updatedToken, "original", false, (text) => writes.push(text))).toBe(true);
    expect(writes).toEqual(["edited result"]);
    expect(controller.getCandidate()).toBeUndefined();
  });

  it("retains an accepted snapshot for viewing without reviving an actionable candidate", async () => {
    const { controller, token } = await readyController();
    controller.updateCandidate(token, "manually refined");
    const edited = controller.getCandidateToken()!;
    expect(controller.acceptCandidate(edited, "original", false, () => {})).toBe(true);
    expect(controller.shouldOpenPanel("manually refined")).toBe(true);
    expect(controller.shouldOpenPanel("original")).toBe(true);
    expect(controller.shouldOpenPanel("changed draft")).toBe(true);
    expect(controller.getRequestSource()).toEqual({ draft: "original" });
    expect(controller.getCandidateToken()).toBeUndefined();
    expect(controller.isCandidateCurrent(edited)).toBe(false);
    expect(controller.getAccepted()).toMatchObject({ text: "manually refined", draft: "original", model });
    const snapshot = controller.getAccepted()!;
    snapshot.text = "external mutation";
    snapshot.model.id = "changed";
    expect(controller.getAccepted()).toMatchObject({ text: "manually refined", model });
  });

  it.each(["dismiss", "model", "submission", "session", "branch", "restore"] as const)("handles accepted provenance across %s", async (boundary) => {
    const { controller, token } = await readyController();
    controller.acceptCandidate(token, "original", false, () => {});
    if (boundary === "dismiss") controller.cancelAndDismiss();
    if (boundary === "model") controller.setModel({ provider: "another", id: "chat" });
    if (boundary === "submission") controller.onMessageStarted("manually edited");
    if (boundary === "session") controller.setSession("session-2");
    if (boundary === "branch") controller.invalidateLifecycle(true);
    if (boundary === "restore") controller.restoreDraft(controller.getRestoreToken()!, "Refined", false, () => {});
    const retained = boundary === "dismiss" || boundary === "model" || boundary === "submission";
    expect(controller.shouldOpenPanel("Refined")).toBe(boundary !== "session");
    expect(!!controller.getAccepted()).toBe(retained);
  });

  it("restores provenance when undoing a second acceptance back to an edited optimized draft", async () => {
    const { controller, token } = await readyController();
    controller.acceptCandidate(token, "original", false, () => {});
    controller.trigger(input("Refined with edits"));
    await flushPromises();
    controller.updateCandidate(controller.getCandidateToken()!, "second version");
    controller.acceptCandidate(controller.getCandidateToken()!, "Refined with edits", false, () => {});
    const write = vi.fn();
    controller.restoreDraft(controller.getRestoreToken()!, "second version", false, write);
    expect(write).toHaveBeenCalledWith("Refined with edits");
    expect(controller.getAccepted()?.text).toBe("Refined");
    expect(controller.shouldOpenPanel("Refined")).toBe(true);
    expect(controller.shouldOpenPanel("Refined with edits")).toBe(true);
    expect(controller.getCandidate()).toBeUndefined();
  });

  it("opens a panel for errors instead of treating the shortcut as a retry", async () => {
    const { controller } = setup(async () => { throw new Error("offline"); });
    expect(controller.shouldOpenPanel("draft")).toBe(false);
    controller.trigger(input("draft"));
    expect(controller.shouldOpenPanel("draft")).toBe(true);
    await flushPromises();
    expect(controller.shouldOpenPanel("draft")).toBe(true);
  });

  it("restoring a draft prevents newer background completion from replacing the restored preview", async () => {
    const pending = deferred<ReturnType<typeof success>>();
    const complete = vi.fn().mockResolvedValueOnce(success("accepted")).mockImplementation(() => pending.promise);
    const { controller } = setup(complete);
    controller.trigger(input("original"));
    await flushPromises();
    controller.acceptCandidate(controller.getCandidateToken()!, "original", false, () => {});
    controller.trigger(input("accepted with edits"));
    const write = vi.fn();
    expect(controller.restoreDraft(controller.getRestoreToken()!, "accepted with edits", true, write)).toBe(true);
    expect(write).toHaveBeenCalledWith("original");
    expect(controller.shouldOpenPanel("original")).toBe(true);
    pending.resolve(success("stale"));
    await flushPromises();
    expect(controller.getCandidate()).toBeUndefined();
    expect(controller.getAccepted()).toBeUndefined();
  });

  it("requires confirmation for changed drafts and stores the actual replaced text for one safe restore", async () => {
    const { controller, token } = await readyController("A");
    const writes: string[] = [];
    expect(controller.acceptCandidate(token, "draft B", false, (text) => writes.push(text))).toBe(false);
    expect(writes).toEqual([]);
    expect(controller.acceptCandidate(token, "draft B", true, (text) => writes.push(text))).toBe(true);
    expect(writes).toEqual(["Refined"]);

    const restore = controller.getRestore();
    const restoreToken = controller.getRestoreToken();
    expect(restore).toMatchObject({ before: "draft B", applied: "Refined" });
    expect(restoreToken).toBeDefined();
    expect(controller.restoreDraft(restoreToken!, "later edit", false, (text) => writes.push(text))).toBe(false);
    expect(controller.restoreDraft(restoreToken!, "later edit", true, (text) => writes.push(text))).toBe(true);
    expect(writes.at(-1)).toBe("draft B");
    expect(controller.getRestore()).toBeUndefined();
    expect(controller.restoreDraft(restoreToken!, "draft B", true, () => undefined)).toBe(false);
  });

  it("keeps a candidate after a failed send acknowledgement and prevents repeat until Pi accepts it", async () => {
    const { controller, token } = await readyController();
    const first = controller.beginSend(token);
    expect(first?.text).toBe("Refined");
    expect(controller.beginSend(token)).toBeUndefined();
    controller.failSend(first!.requestId);
    expect(controller.getCandidate()?.text).toBe("Refined");
    const retry = controller.beginSend(controller.getCandidateToken()!);
    expect(retry?.text).toBe("Refined");
    expect(controller.onSubmittedInput("Refined", "extension")).toBe("pending");
    expect(controller.getCandidate()?.text).toBe("Refined");
    controller.onMessageStarted("Refined");
    expect(controller.getCandidate()).toBeUndefined();
    expect(controller.getRestore()).toBeUndefined();
  });

  it("consumes a busy follow-up only at message start and restores retry after send timeout", async () => {
    const scheduler = new FakeScheduler();
    const { controller } = setup(undefined, scheduler);
    controller.trigger(input("original"));
    await flushPromises();
    const token = controller.getCandidateToken()!;
    const send = controller.beginSend(token, 100)!;
    expect(controller.onSubmittedInput(send.text, "extension", "followUp")).toBe("pending");
    expect(controller.getCandidate()).toBeDefined();
    controller.onMessageStarted(send.text);
    expect(controller.getCandidate()).toBeUndefined();

    controller.trigger(input("again"));
    await flushPromises();
    const retryToken = controller.getCandidateToken()!;
    controller.beginSend(retryToken, 100);
    scheduler.advance(100);
    expect(controller.getCandidate()?.text).toBe("Refined");
    expect(controller.getState()).toMatchObject({ phase: "ready", pendingSend: false });
    expect(controller.beginSend(controller.getCandidateToken()!)).toBeDefined();
  });

  it("invalidates the restore snapshot on user submission but preserves it through ignore", async () => {
    const { controller, token } = await readyController();
    expect(controller.acceptCandidate(token, "original", false, () => undefined)).toBe(true);
    controller.cancelAndDismiss();
    const restoreToken = controller.getRestoreToken()!;
    expect(controller.isRestoreCurrent(restoreToken)).toBe(true);
    controller.onSubmittedInput("new prompt", "interactive");
    expect(controller.isRestoreCurrent(restoreToken)).toBe(true);
    controller.onMessageStarted("new prompt");
    expect(controller.isRestoreCurrent(restoreToken)).toBe(false);
  });
});
