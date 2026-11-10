import { describe, expect, it, vi } from "vitest";
import { type RefineCompletion, type RefineRequest } from "../../src/controller.js";
import { input, model, setup } from "../support/controller.js";
import { deferred, FakeScheduler, flushPromises, success } from "../support/helpers.js";

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

describe("confirmed request deletion", () => {
  it("removes unsent drafts and permits capturing the same draft again", () => {
    const { controller } = setup();
    controller.capture(input("Draft"));
    const id = controller.getHistory()[0]!.id;
    expect(controller.deleteRecords([id])).toBe(true);
    expect(controller.getHistory()).toEqual([]);
    expect(controller.capture(input("Draft")).kind).toBe("captured");
  });

  it("aborts running targets and removes queued targets before pumping, ignoring late completion", async () => {
    const jobs: { signal: AbortSignal; pending: ReturnType<typeof deferred<RefineCompletion>> }[] = [];
    const { controller, scheduler } = setup((_request, signal) => {
      const pending = deferred<RefineCompletion>(); jobs.push({ signal, pending }); return pending.promise;
    });
    for (let i = 0; i < 6; i++) controller.trigger(input(`Draft ${i}`));
    expect(jobs).toHaveLength(4);
    const ids = controller.getHistory().map((record) => record.id);
    expect(controller.deleteRecords(ids)).toBe(true);
    expect(jobs).toHaveLength(4);
    expect(jobs.every((job) => job.signal.aborted)).toBe(true);
    expect(scheduler.size).toBe(0);
    for (const job of jobs) job.pending.resolve({ ...success("Late"), usage: { output: 12 } });
    await flushPromises();
    expect(controller.getHistory()).toEqual([]);
    expect(controller.getCandidate()).toBeUndefined();
    expect(controller.getState()).toMatchObject({ phase: "idle", runningCount: 0, queuedCount: 0 });
  });

  it("deletes an applied result without invalidating other runs", async () => {
    const { controller } = setup();
    controller.trigger(input("One")); await flushPromises();
    const token = controller.getCandidateToken()!;
    const id = controller.getAppliedRecordId()!;
    controller.trigger(input("Two")); await flushPromises();
    controller.applyResult(id);
    expect(controller.deleteRecords([id])).toBe(true);
    expect(controller.getAppliedRecordId()).toBeUndefined();
    expect(controller.getHistory()).toHaveLength(1);
    expect(controller.acceptCandidate(token, "One", true, vi.fn())).toBe(false);
    expect(controller.applyResult(controller.getHistory()[0]!.id)).toBe(true);
  });

  it("deletes accepted history while keeping the editor restore snapshot", async () => {
    const { controller } = setup();
    controller.trigger(input("One")); await flushPromises();
    const id = controller.getAppliedRecordId()!;
    const write = vi.fn();
    controller.acceptCandidate(controller.getCandidateToken()!, "One", false, write);
    const restore = controller.getRestoreToken()!;
    expect(controller.deleteRecords([id])).toBe(true);
    expect(controller.getViewedAccepted()).toBeUndefined();
    expect(write).toHaveBeenCalledTimes(1);
    expect(controller.restoreDraft(restore, "Refined", false, write)).toBe(true);
  });
});
