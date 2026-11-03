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
