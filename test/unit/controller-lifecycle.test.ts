import { describe, expect, it, vi } from "vitest";
import type { BudgetReport } from "../../src/budget.js";
import { buildRefineSystemPrompt } from "../../src/context.js";
import { RefineController, type RefineCompletion, type RefineRequest } from "../../src/controller.js";
import { input, model, setup } from "../support/controller.js";
import { deferred, FakeScheduler, flushPromises, success } from "../support/helpers.js";

describe("runtime settings", () => {
  it("uses new limits for new work and queued starts without changing active timers or output guards", async () => {
    const limits = { timeoutMs: 100, maxDraftChars: 100, maxOutputChars: 200 };
    const scheduler = new FakeScheduler();
    const jobs: Array<{ request: RefineRequest; pending: ReturnType<typeof deferred<RefineCompletion>>; signal: AbortSignal }> = [];
    const controller = new RefineController({
      get timeoutMs() { return limits.timeoutMs; },
      get maxDraftChars() { return limits.maxDraftChars; },
      get maxOutputChars() { return limits.maxOutputChars; },
      maxConcurrent: 1, scheduler, onState() {},
      complete: (request, signal) => { const pending = deferred<RefineCompletion>(); jobs.push({ request, signal, pending }); return pending.promise; },
    }, model);
    controller.trigger(input("A"));
    controller.trigger(input("B"));
    expect(jobs).toHaveLength(1);
    limits.timeoutMs = 300;
    limits.maxDraftChars = 1;
    limits.maxOutputChars = 5;
    expect(controller.trigger(input("Too long"))).toEqual({ kind: "too-long" });
    jobs[0]!.pending.resolve(success("Longer than the new output guard"));
    await flushPromises();
    expect(controller.getRecord(jobs[0]!.request.recordId)?.status).toBe("generated");
    expect(jobs).toHaveLength(2);
    scheduler.advance(100);
    expect(jobs[1]!.signal.aborted).toBe(false);
    scheduler.advance(200);
    expect(jobs[1]!.signal.aborted).toBe(true);
    expect(controller.getRecord(jobs[1]!.request.recordId)?.error).toBe("timeout");
    limits.timeoutMs = 500;
    controller.trigger(input("C"));
    limits.timeoutMs = 1000;
    scheduler.advance(500);
    expect(jobs[2]!.signal.aborted).toBe(true); // Existing timer keeps its 500 ms deadline.
  });
});

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
