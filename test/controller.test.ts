import { describe, expect, it, vi } from "vitest";
import { RefineController, type RefineCompletion, type RefineRequest, type RefineRequestInput } from "../src/controller.js";
import type { ModelRef } from "../src/config.js";
import { deferred, FakeScheduler, flushPromises, success } from "./helpers.js";

const model: ModelRef = { provider: "provider-a", id: "chat-model" };

function input(draft: string, overrides: Partial<RefineRequestInput> = {}): RefineRequestInput {
  return {
    draft,
    model,
    sessionId: "session-1",
    branchLeafId: "leaf-1",
    historyText: "[user]\nKeep it concise",
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

describe("RefineController request lifecycle", () => {
  it("includes title eligibility in deduplication and drops unsolicited titles", async () => {
    const { controller } = setup(async () => ({ ...success("Prompt"), title: "Project task" }));
    controller.trigger(input("Draft", { generateTitle: true }));
    await flushPromises();
    expect(controller.getCandidate()?.title).toBe("Project task");
    expect(controller.trigger(input("Draft", { generateTitle: true })).kind).toBe("ready");
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
  it("includes project resources in deduplication and freezes their source snapshot", async () => {
    const pending = deferred<ReturnType<typeof success>>();
    const requests: RefineRequest[] = [];
    const complete = vi.fn((request: RefineRequest) => { requests.push(request); return pending.promise; });
    const { controller } = setup(complete);
    const project = { cwd: "/repo", snapshot: { text: "Original rules", warnings: [], instructionCount: 1, skillCount: 0 } };
    expect(controller.trigger(input("draft", { project })).kind).toBe("started");
    expect(controller.trigger(input("draft", { project })).kind).toBe("duplicate");
    project.snapshot.text = "Updated rules";
    expect(requests[0]?.project?.snapshot.text).toBe("Original rules");
    expect(controller.trigger(input("draft", { project })).kind).toBe("started");
    pending.resolve(success("Refined"));
    await flushPromises();
    expect(controller.getCandidate()?.project?.snapshot.text).toBe("Updated rules");
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
    expect(signals[0]?.aborted).toBe(true);
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

  it("invalidates a submitted draft even when the same text is typed again", async () => {
    const a = deferred<ReturnType<typeof success>>();
    const replacement = deferred<ReturnType<typeof success>>();
    const signals: AbortSignal[] = [];
    const complete = vi.fn((_request: RefineRequest, signal: AbortSignal) => {
      signals.push(signal);
      return signals.length === 1 ? a.promise : replacement.promise;
    });
    const { controller } = setup(complete);

    controller.trigger(input("same A"));
    expect(controller.onSubmittedInput("same A", "interactive")).toBe("invalidated");
    controller.trigger(input("same A"));
    expect(signals[0]?.aborted).toBe(true);
    expect(complete).toHaveBeenCalledTimes(2);
    replacement.resolve(success("new A"));
    await flushPromises();
    a.resolve(success("stale A"));
    await flushPromises();
    expect(controller.getCandidate()?.text).toBe("new A");
  });

  it("does not revive a result when a user submits B while A is pending", async () => {
    const pending = deferred<ReturnType<typeof success>>();
    let signal: AbortSignal | undefined;
    const { controller } = setup((_request, requestSignal) => {
      signal = requestSignal;
      return pending.promise;
    });

    controller.trigger(input("A"));
    controller.onSubmittedInput("B", "interactive");
    expect(signal?.aborted).toBe(true);
    pending.resolve(success("stale A"));
    await flushPromises();
    expect(controller.getCandidate()).toBeUndefined();
    expect(controller.getState().phase).toBe("idle");
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

  it.each(["model", "session", "branch", "reload", "shutdown"] as const)("invalidates late output after %s changes", async (boundary) => {
    const pending = deferred<ReturnType<typeof success>>();
    const { controller } = setup(() => pending.promise);
    controller.trigger(input("A"));
    if (boundary === "model") controller.setModel({ provider: "provider-b", id: "another" });
    else if (boundary === "session") controller.setSession("session-2");
    else if (boundary === "branch") controller.invalidateLifecycle(true);
    else if (boundary === "reload" || boundary === "shutdown") controller.setSession("session-1");
    pending.resolve(success("late"));
    await flushPromises();
    expect(controller.getCandidate()).toBeUndefined();
    expect(controller.getState().phase).toBe("idle");
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
    expect(controller.shouldOpenPanel()).toBe(true);
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
    if (boundary === "submission") controller.onSubmittedInput("manually edited", "interactive");
    if (boundary === "session") controller.setSession("session-2");
    if (boundary === "branch") controller.invalidateLifecycle(true);
    if (boundary === "restore") controller.restoreDraft(controller.getRestoreToken()!, "Refined", false, () => {});
    const retained = boundary === "dismiss" || boundary === "model";
    expect(controller.shouldOpenPanel()).toBe(retained);
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
    expect(controller.shouldOpenPanel()).toBe(true);
    expect(controller.getCandidate()).toBeUndefined();
  });

  it("opens a panel for errors instead of treating the shortcut as a retry", async () => {
    const { controller } = setup(async () => { throw new Error("offline"); });
    expect(controller.shouldOpenPanel()).toBe(false);
    controller.trigger(input("draft"));
    expect(controller.shouldOpenPanel()).toBe(true);
    await flushPromises();
    expect(controller.shouldOpenPanel()).toBe(true);
  });

  it("restoring an accepted draft cancels a newer refinement and rejects late results", async () => {
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
    expect(controller.shouldOpenPanel()).toBe(false);
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

  it("consumes a busy follow-up only at Pi's input boundary and restores retry after send timeout", async () => {
    const scheduler = new FakeScheduler();
    const { controller } = setup(undefined, scheduler);
    controller.trigger(input("original"));
    await flushPromises();
    const token = controller.getCandidateToken()!;
    const send = controller.beginSend(token, 100)!;
    expect(controller.onSubmittedInput(send.text, "extension", "followUp")).toBe("sent");
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
    const restoreToken = controller.getRestoreToken()!;
    controller.cancelAndDismiss();
    expect(controller.isRestoreCurrent(controller.getRestoreToken()!)).toBe(true);
    controller.onSubmittedInput("new prompt", "interactive");
    expect(controller.isRestoreCurrent(restoreToken)).toBe(false);
  });
});
