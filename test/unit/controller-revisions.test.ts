import { describe, expect, it, vi } from "vitest";
import { RefineController, type RefineCompletion, type RefineRequest } from "../../src/controller.js";
import { composeRevision, selectPreference, type RevisionPreference } from "../../src/revision-preferences.js";
import { input, model, setup } from "../support/controller.js";
import { deferred, FakeScheduler, flushPromises, success } from "../support/helpers.js";

describe("manual-only preference lifecycle", () => {
  const entries: RevisionPreference[] = [{ id: "structure", version: 1, scope: "global", name: "Structure", body: "Preserve existing order.",
    metadata: { kind: "rewrite", description: "Explicit structure", activation: "manual" } }];
  function preferenceSetup() {
    const library = structuredClone(entries);
    const jobs: Array<{ request: RefineRequest; pending: ReturnType<typeof deferred<RefineCompletion>> }> = [];
    const controller = new RefineController({ timeoutMs: 1000, maxDraftChars: 2000, maxConcurrent: 1, onState() {},
      complete: (request) => { const pending = deferred<RefineCompletion>(); jobs.push({ request, pending }); return pending.promise; },
    }, model);
    return { controller, library, jobs };
  }

  it.each(["为什么失败？如何处理？", "先检查，再解释。", "Why? How?", "First inspect, then explain.", "- One\n- Two"])(
    "never selects preferences on capture, creation, editing or direct submission: %s", (draft) => {
      for (const method of ["capture", "createDraft", "trigger"] as const) {
        const { controller, jobs } = preferenceSetup();
        controller[method](input(draft));
        const record = controller.getHistory()[0]!;
        expect(record.input.preferences).toBeUndefined();
        expect(record.input.editingInstruction).toBeUndefined();
        if (method !== "trigger") {
          expect(controller.updateDraft(record.id, draft, "首先检查，然后解释。 Why? How?")).toBe(true);
          expect(controller.getRecord(record.id)!.input.preferences).toBeUndefined();
          expect(controller.getRecord(record.id)!.input.editingInstruction).toBeUndefined();
          expect(jobs).toHaveLength(0);
        } else {
          expect(jobs[0]!.request.preferences).toBeUndefined();
          expect(jobs[0]!.request.editingInstruction).toBeUndefined();
        }
      }
    });

  it("preserves explicit snapshots on draft edits and never restores deselected entries", () => {
    const { controller, library } = preferenceSetup();
    const captured = controller.createDraft(input("First inspect, then explain."));
    if (captured.kind !== "captured") throw new Error("not captured");
    const selected = [selectPreference(library[0]!)];
    expect(controller.updateDraftPreferences(controller.getRecord(captured.recordId)!, selected)).toBeUndefined();
    library[0]!.body = "Changed";
    library[0]!.metadata!.description = "Changed description";
    const instruction = composeRevision(selected, "");
    for (const draft of ["Explain this.", "为什么？怎么办？", "First inspect, then compare."]) {
      const record = controller.getRecord(captured.recordId)!;
      expect(controller.updateDraft(record.id, record.input.draft, draft)).toBe(true);
      expect(controller.getRecord(record.id)!.input.preferences).toEqual(selected);
      expect(controller.getRecord(record.id)!.input.editingInstruction).toBe(instruction);
    }
    library.splice(0);
    expect(controller.updateDraftPreferences(controller.getRecord(captured.recordId)!, [])).toBeUndefined();
    expect(controller.updateDraft(captured.recordId, "First inspect, then compare.", "先检查，再解释。")).toBe(true);
    expect(controller.getRecord(captured.recordId)!.input.preferences).toEqual([]);
    expect(controller.getRecord(captured.recordId)!.input.editingInstruction).toBeUndefined();
    const next = controller.createDraft(input("先检查，再解释。"));
    if (next.kind !== "captured") throw new Error("not captured");
    expect(controller.getRecord(next.recordId)!.input.preferences).toBeUndefined();
  });

  it("preserves standalone editing instructions verbatim when editing an original", () => {
    const { controller } = preferenceSetup();
    const capture = controller.createDraft(input("Original", { editingInstruction: "  Keep literals\n" }));
    if (capture.kind !== "captured") throw new Error("not captured");
    expect(controller.updateDraft(capture.recordId, "Original", "Why? How?")).toBe(true);
    expect(controller.getRecord(capture.recordId)!.input.editingInstruction).toBe("  Keep literals\n");
  });

  it("freezes manually selected queued bodies and metadata without replaying them as revision feedback", async () => {
    const { controller, jobs, library } = preferenceSetup();
    controller.trigger(input("Blocking"));
    const captured = controller.capture(input("First inspect, then explain."));
    if (captured.kind !== "captured") throw new Error("not captured");
    const frozen = [selectPreference(library[0]!)];
    expect(controller.updateDraftPreferences(controller.getRecord(captured.recordId)!, frozen)).toBeUndefined();
    controller.startRecord(captured.recordId);
    library[0]!.body = "Changed externally";
    library[0]!.metadata!.description = "Changed description";
    expect(controller.updateDraft(captured.recordId, "First inspect, then explain.", "Changed")).toBe(false);
    jobs[0]!.pending.resolve(success("Blocking result")); await flushPromises();
    expect(jobs[1]!.request.preferences).toEqual(frozen);
    expect(jobs[1]!.request.editingInstruction).toBe(composeRevision(frozen, ""));
    jobs[1]!.pending.resolve(success("Structured result")); await flushPromises();
    controller.applyResult(captured.recordId);
    const source = controller.getCandidate()!;
    controller.trigger({ ...source, revision: { previousCandidate: source.text, instruction: "Remove the structure requirement." } },
      { revisionToken: controller.getCandidateToken()! });
    expect(jobs[2]!.request.revision?.instruction).toBe("Remove the structure requirement.");
    expect(jobs[2]!.request.preferences).toEqual(frozen);
  });

  it("rejects over-limit manual requirements without changing the selection or requesting a model", () => {
    const { controller, jobs, library } = preferenceSetup();
    const capture = controller.createDraft(input("First inspect, then explain."));
    if (capture.kind !== "captured") throw new Error("not captured");
    library[0]!.body = "x".repeat(2000);
    expect(controller.updateDraftPreferences(controller.getRecord(capture.recordId)!, [selectPreference(library[0]!)])).toContain("exceed");
    expect(controller.getRecord(capture.recordId)!.input.preferences).toBeUndefined();
    expect(jobs).toHaveLength(0);
  });
});

describe("Unsent preference requirements", () => {
  const preference = (body = "Ask the main agent to use bullets.") => selectPreference({ id: "bullets", scope: "project", version: 1, name: "Bullet Points", body });
  const create = (controller: RefineController, draft = "Original task") => {
    const result = controller.createDraft(input(draft));
    if (result.kind !== "captured") throw new Error(result.kind);
    return controller.getRecord(result.recordId)!;
  };

  it("isolates originals, snapshots literal bodies, and clears without changing the task or round", () => {
    const complete = vi.fn(async () => success("Result"));
    const { controller } = setup(complete);
    const first = create(controller); const second = create(controller);
    const selected = preference();
    expect(controller.updateDraftPreferences(first, [selected])).toBeUndefined();
    selected.body = "Library changed"; selected.name = "Renamed";
    const saved = controller.getRecord(first.id)!;
    expect(saved.input).toMatchObject({ draft: first.input.draft, systemPrompt: first.input.systemPrompt,
      history: first.input.history, roundId: first.input.roundId, editingInstruction: composeRevision([preference()], ""), preferences: [preference()] });
    expect(saved.originalInput).toEqual(saved.input);
    expect(controller.getRecord(second.id)!.input.preferences).toBeUndefined();
    expect(complete).not.toHaveBeenCalled();
    expect(controller.updateDraftPreferences(saved, [])).toBeUndefined();
    expect(controller.getRecord(first.id)!.input.editingInstruction).toBeUndefined();
    expect(controller.getRecord(first.id)!.input.draft).toBe(first.input.draft);
  });

  it("rejects stale targets and over-limit combinations while retaining the saved selection", () => {
    const { controller } = setup();
    const source = create(controller);
    const long = preference("a".repeat(60));
    expect(controller.updateDraftPreferences(source, [long, { ...long, id: "other", body: "b".repeat(60) }])).toContain("exceed 100");
    expect(controller.getRecord(source.id)!.input.preferences).toBeUndefined();
    expect(controller.updateDraftPreferences(source, [preference()])).toBeUndefined();
    expect(controller.updateDraftPreferences(source, [])).toContain("changed");
    const selected = controller.getRecord(source.id)!;
    expect(controller.updateDraft(source.id, source.input.draft, "Edited task")).toBe(true);
    expect(controller.getRecord(source.id)!.input.preferences).toEqual(selected.input.preferences);
    expect(controller.updateDraftPreferences(selected, [])).toContain("changed");
    const current = controller.getRecord(source.id)!;
    controller.onMessageStarted("Pi message");
    expect(controller.updateDraftPreferences(current, [])).toContain("changed");
    const archived = controller.getRecord(source.id)!;
    // Explicitly reopening an old Unsent original keeps its old background.
    expect(controller.updateDraftPreferences(archived, [preference()])).toBeUndefined();
    controller.setSession("other-session");
    expect(controller.updateDraftPreferences(archived, [])).toContain("changed");
  });

  it("normalizes duplicate manual bodies without hiding different requirements or changing snapshots", () => {
    const { controller } = setup();
    const source = create(controller);
    const selected = preference();
    const copy = { ...selected, scope: "global" as const, id: "global-copy" };
    expect(controller.updateDraftPreferences(source, [selected, copy])).toBeUndefined();
    const saved = controller.getRecord(source.id)!;
    expect(saved.input.preferences).toEqual([selected]);
    expect(saved.input.editingInstruction).toBe(composeRevision([selected], ""));
    expect(copy.scope).toBe("global");
  });

  it("includes independent editing requirements in deduplication", () => {
    const pending = deferred<RefineCompletion>();
    const complete = vi.fn(() => pending.promise);
    const { controller } = setup(complete);
    expect(controller.trigger(input("Same", { editingInstruction: "Bullets" })).kind).toBe("started");
    expect(controller.trigger(input("Same", { editingInstruction: "Bullets" })).kind).toBe("duplicate");
    expect(controller.trigger(input("Same", { editingInstruction: "Steps" })).kind).toBe("started");
    expect(controller.trigger(input("Same", { editingInstruction: "x".repeat(101) })).kind).toBe("too-long");
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("freezes queued requests and retains the same requirements for another-model comparisons", async () => {
    const jobs: Array<{ request: RefineRequest; pending: ReturnType<typeof deferred<RefineCompletion>> }> = [];
    const complete = vi.fn((request: RefineRequest) => {
      const pending = deferred<RefineCompletion>(); jobs.push({ request, pending }); return pending.promise;
    });
    const controller = new RefineController({ complete, timeoutMs: 100, maxDraftChars: 100, maxConcurrent: 1,
      scheduler: new FakeScheduler(), onState() {} }, model);
    controller.setSession("session-1");
    controller.trigger(input("Busy"));
    const queued = create(controller);
    const selected = preference();
    controller.updateDraftPreferences(queued, [selected]);
    const saved = controller.getRecord(queued.id)!;
    controller.startRecord(queued.id);
    expect(controller.getRecord(queued.id)!.status).toBe("queued");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(controller.updateDraftPreferences(saved, [])).toContain("already started");
    selected.body = "Mutated library";
    jobs[0]!.pending.resolve(success("Busy result")); await flushPromises();
    expect(jobs[1]!.request).toMatchObject({ draft: queued.input.draft, editingInstruction: composeRevision([preference()], ""), preferences: [preference()] });
    jobs[1]!.pending.resolve(success("Refined")); await flushPromises();
    controller.runOriginal(queued.id, { provider: "another", id: "model" });
    expect(jobs[2]!.request).toMatchObject({ draft: queued.input.draft, editingInstruction: composeRevision([preference()], ""), preferences: [preference()] });
    expect(controller.getRecord(queued.id)!.input.editingInstruction).toBe(composeRevision([preference()], ""));
    jobs[2]!.pending.resolve(success("Other result")); await flushPromises();
  });

  it("does not inherit preferences into a newly created original or the next round", () => {
    const { controller } = setup();
    const source = create(controller);
    controller.updateDraftPreferences(source, [preference()]);
    controller.onMessageStarted();
    const next = create(controller);
    expect(next.input.roundId).not.toBe(source.input.roundId);
    expect(next.input.preferences).toBeUndefined();
    expect(next.input.editingInstruction).toBeUndefined();
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
