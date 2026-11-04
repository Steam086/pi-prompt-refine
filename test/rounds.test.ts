import { describe, expect, it, vi } from "vitest";
import { RefineController, type RefineCompletion, type RefineRequest, type RefineRequestInput } from "../src/controller.js";
import { selectHistory } from "../src/context.js";
import { deferred, FakeScheduler, flushPromises, success } from "./helpers.js";
const model = { provider: "p", id: "a" };
const other = { provider: "p", id: "b" };
const input = (draft: string, context = "first"): RefineRequestInput => ({ draft, model, sessionId: "s", branchLeafId: "leaf",
  history: selectHistory([{ type: "message", message: { role: "user", content: context } }], 12, 1000), systemPrompt: context });
function setup(maxConcurrent = 4) {
  const scheduler = new FakeScheduler();
  const jobs: { request: RefineRequest; signal: AbortSignal; result: ReturnType<typeof deferred<RefineCompletion>> }[] = [];
  const complete = vi.fn((request: RefineRequest, signal: AbortSignal) => {
    const result = deferred<RefineCompletion>(); jobs.push({ request, signal, result }); return result.promise;
  });
  const controller = new RefineController({ complete, scheduler, timeoutMs: 100, maxDraftChars: 1000, maxConcurrent, onState() {} }, model);
  controller.setSession("s");
  return { controller, scheduler, jobs, complete };
}

describe("round workspace", () => {
  it("creates independent editable drafts without a model, but refuses an empty launch", () => {
    const { controller, complete } = setup();
    const first = controller.createDraft({ ...input(""), model: { provider: "", id: "" } });
    expect(first.kind).toBe("captured");
    if (first.kind !== "captured") throw new Error("Missing draft");
    expect(controller.startRecord(first.recordId, model).kind).toBe("empty");
    expect(controller.updateDraft(first.recordId, "", "A")).toBe(true);
    expect(controller.updateDraft(first.recordId, "", "stale edit")).toBe(false);
    expect(controller.createDraft(input("A")).kind).toBe("captured");
    expect(controller.getHistory()).toHaveLength(2);
    expect(complete).not.toHaveBeenCalled();
    expect(controller.startRecord(first.recordId, model).kind).toBe("started");
    expect(controller.updateDraft(first.recordId, "A", "B")).toBe(false);
    controller.removeDraft(first.recordId);
    expect(controller.getRecord(first.recordId)).toBeDefined();
  });

  it("rejects draft edits after archival and cancels only the temporary draft", () => {
    const { controller, jobs } = setup();
    controller.trigger(input("A"));
    const created = controller.createDraft(input("B"));
    if (created.kind !== "captured") throw new Error("Missing draft");
    controller.onMessageStarted();
    expect(controller.updateDraft(created.recordId, "B", "C")).toBe(false);
    controller.removeDraft(created.recordId);
    expect(controller.getHistory()).toHaveLength(1);
    expect(jobs[0]!.signal.aborted).toBe(false);
  });

  it("does not keep the background of a cancelled empty workspace", () => {
    const { controller } = setup();
    const draft = controller.createDraft(input("", "old background"));
    if (draft.kind !== "captured") throw new Error("Missing draft");
    controller.removeDraft(draft.recordId);
    expect(controller.getRoundId()).toBeUndefined();
    controller.createDraft(input("A", "new background"));
    expect(controller.getHistory()[0]!.input.systemPrompt).toBe("new background");
  });

  it("compares the original even when launched from a revision, without changing the default model", async () => {
    const { controller, jobs } = setup();
    controller.trigger(input("A"));
    controller.capturePreparedInput(jobs[0]!.request.requestId, jobs[0]!.request.generation, "Original packet");
    jobs[0]!.result.resolve(success("A result"));
    await flushPromises();
    const token = controller.getCandidateToken()!;
    controller.trigger({ ...input("A"), revision: { previousCandidate: "A result", instruction: "Shorter" } }, { revisionToken: token });
    const revisionId = jobs[1]!.request.recordId;
    controller.capturePreparedInput(jobs[1]!.request.requestId, jobs[1]!.request.generation, "Revision packet");
    expect(controller.runOriginal(revisionId, other, "high").kind).toBe("started");
    expect(jobs[2]!.request).toMatchObject({ draft: "A", model: other, thinkingLevel: "high", preparedInput: "Original packet" });
    expect(jobs[2]!.request.revision).toBeUndefined();
    expect(controller.getModel()).toEqual(model);
    expect(controller.runOriginal(revisionId, other, "high").kind).toBe("duplicate");
    expect(jobs).toHaveLength(3);
  });

  it("captures changed inputs during generation without calling, replacing, or duplicating", () => {
    const { controller, jobs, complete } = setup();
    controller.trigger(input("A"));
    expect(controller.capture(input("B", "new context")).kind).toBe("captured");
    expect(controller.capture(input("B")).kind).toBe("duplicate");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(jobs[0]!.signal.aborted).toBe(false);
    expect(controller.getRequestSource()?.draft).toBe("A");
    expect(controller.getHistory()[1]).toMatchObject({ status: "unsent", input: { draft: "B", systemPrompt: "first", roundId: 1 } });
  });
  it("runs same and different prompts/models in parallel without stealing the applied result", async () => {
    const { controller, jobs } = setup();
    controller.trigger(input("A"));
    jobs[0]!.result.resolve(success("A result"));
    await flushPromises();
    const token = controller.getCandidateToken()!;
    controller.capture(input("B"));
    const records = controller.getHistory();
    controller.startRecord(records[1]!.id);
    controller.setModel(other);
    controller.rerunRecord(records[0]!.id);
    expect(jobs.map((j) => [j.request.draft, j.request.model.id])).toEqual([["A", "a"], ["B", "a"], ["A", "b"]]);
    jobs[2]!.result.resolve(success("Other model"));
    jobs[1]!.result.resolve(success("B result"));
    await flushPromises();
    expect(controller.isCandidateCurrent(token)).toBe(true);
    expect(controller.getCandidate()?.text).toBe("A result");
    expect(controller.applyResult(controller.getHistory()[2]!.id)).toBe(true);
    expect(controller.getCandidate()?.text).toBe("Other model");
    expect(controller.isCandidateCurrent(token)).toBe(false);
  });
  it("archives only after committed send, retains pending work, and captures next context lazily", async () => {
    const { controller, jobs } = setup();
    controller.trigger(input("A"));
    controller.capture(input("B"));
    controller.onSubmittedInput("A", "interactive");
    expect(controller.getCurrentRecords()).toHaveLength(2);
    controller.onMessageStarted("A");
    expect(controller.getCurrentRecords()).toHaveLength(0);
    expect(controller.hasWorkspaceContent()).toBe(true);
    expect(controller.shouldOpenPanel("C")).toBe(true);
    expect(controller.getRoundId()).toBeUndefined();
    expect(jobs[0]!.signal.aborted).toBe(false);
    controller.capture(input("C", "latest Pi reply"));
    const records = controller.getHistory();
    expect(records[2]).toMatchObject({ status: "unsent", input: { roundId: 2, systemPrompt: "latest Pi reply" } });
    controller.startRecord(records[1]!.id); // Old pending input explicitly uses its old snapshot.
    expect(jobs[1]!.request).toMatchObject({ draft: "B", roundId: 1, systemPrompt: "first" });
    jobs[0]!.result.resolve(success("Old result"));
    await flushPromises();
    controller.applyResult(records[0]!.id);
    expect(controller.getRoundId()).toBe(2);
    expect(controller.getCandidate()?.roundId).toBe(1);
  });
  it("does not archive on send failure, timeout, acceptance, or Apply", async () => {
    const { controller, jobs, scheduler } = setup();
    controller.trigger(input("A"));
    jobs[0]!.result.resolve(success("Result"));
    await flushPromises();
    const recordId = controller.getHistory()[0]!.id;
    controller.applyResult(recordId);
    let send = controller.beginSend(controller.getCandidateToken()!)!;
    controller.failSend(send.requestId);
    expect(controller.getCurrentRecords()).toHaveLength(1);
    send = controller.beginSend(controller.getCandidateToken()!)!;
    controller.onSubmittedInput(send.text, "extension", "followUp");
    expect(controller.getCurrentRecords()).toHaveLength(1);
    scheduler.advance(100);
    expect(controller.getCurrentRecords()).toHaveLength(1);
    controller.acceptCandidate(controller.getCandidateToken()!, "A", false, () => {});
    expect(controller.getCurrentRecords()).toHaveLength(1);
  });
  it("queues over the concurrency limit, starts timeouts only on launch, and stops a single row", async () => {
    const { controller, jobs, scheduler } = setup(2);
    for (const draft of ["A", "B", "C", "D"]) controller.trigger(input(draft));
    expect(jobs).toHaveLength(2);
    expect(controller.getHistory().map((r) => r.status)).toEqual(["generating", "generating", "queued", "queued"]);
    expect(scheduler.size).toBe(2);
    controller.stopRequest(controller.getHistory()[2]!.id);
    expect(jobs).toHaveLength(2);
    jobs[0]!.result.resolve(success("A result"));
    await flushPromises();
    expect(jobs[2]!.request.draft).toBe("D");
    expect(jobs[1]!.signal.aborted).toBe(false);
    controller.stopRequest(controller.getHistory()[1]!.id);
    jobs[1]!.result.resolve({ ...success("Too late"), usage: { totalTokens: 12 } });
    await flushPromises();
    expect(controller.getHistory()[1]).toMatchObject({ status: "cancelled", usage: { totalTokens: 12 } });
    expect(controller.getHistory()[1]?.candidate).toBeUndefined();
  });
  it("timeouts and failures are per run, while lifecycle teardown aborts every run and queue", async () => {
    const { controller, jobs, scheduler } = setup(2);
    controller.trigger(input("A"));
    controller.trigger(input("B"));
    controller.trigger(input("C"));
    jobs[0]!.result.reject(new Error("offline"));
    await flushPromises();
    expect(jobs[1]!.signal.aborted).toBe(false);
    expect(jobs[2]!.request.draft).toBe("C");
    controller.invalidateLifecycle(true);
    expect(jobs.every((j) => j.signal.aborted)).toBe(true);
    expect(scheduler.size).toBe(0);
    for (const job of jobs) job.result.resolve(success("Late"));
    await flushPromises();
    expect(controller.getHistory().every((r) => !r.candidate)).toBe(true);
  });
  it("refuses excess unsent work instead of evicting drafts", () => {
    const { controller, complete } = setup();
    for (let i = 0; i < 100; i++) expect(controller.capture(input(`Draft ${i}`)).kind).toBe("captured");
    expect(controller.capture(input("overflow")).kind).toBe("busy");
    expect(controller.getHistory()).toHaveLength(100);
    expect(complete).not.toHaveBeenCalled();
  });
});
