import { describe, expect, it, vi } from "vitest";
import { createApplication } from "../../src/app/application.js";
import { createApplicationEvents } from "../../src/app/events.js";
import { RefineController } from "../../src/controller.js";
import type { Hello, Mutation, Receipt, Reply, RunDetail, Snapshot, TaskDetail } from "../../src/app/api.js";
import { input, model } from "../support/controller.js";
import { flushPromises } from "../support/helpers.js";

function value<T>(reply: Reply<unknown>): T {
  expect(reply.kind).toBe("ok");
  if (reply.kind !== "ok") throw new Error(reply.code);
  return reply.value as T;
}
function fixture() {
  const events = createApplicationEvents();
  const complete = vi.fn(() => new Promise<never>(() => {}));
  const controller = new RefineController({ complete, onState: () => events.changed(), maxDraftChars: 100_000, timeoutMs: 60_000 });
  controller.setSession("session-1");
  const capture = vi.fn((text: string) => input(text, { systemPrompt: "PRIVATE-SYSTEM", history: { ...input("").history, text: "PRIVATE-HISTORY" } }));
  const app = createApplication({ controller, events, input: { capture }, maxDraftChars: () => 100_000,
    models: { list: () => [{ ...model, name: "Model", thinkingLevels: ["off"], favorite: false }],
      resolve: (selected = model, thinking = "off") => ({ model: selected, thinking }),
      optimizer: () => ({ version: 1, model, thinking: "inherit", persistence: "persisted" }),
      configure: () => ({ kind: "rejected", code: "model-unavailable" }) },
    storage: { summary: () => ({ state: "disabled", savedCount: 0, omittedCount: 0, memoryOnlyCount: 0 }) },
  });
  app.bind("session-1");
  const hello = value<Hello>(app.api.hello("one"));
  let sequence = 0;
  function execute(mutation: Mutation, scope = hello, operationId = `op-${++sequence}`) {
    return app.api.execute({ binding: scope.binding, clientLeaseId: scope.lease.id, operationId }, mutation);
  }
  const snapshot = () => value<Snapshot>(app.api.query(hello.binding, { method: "snapshot", scope: "all" }));
  return { app, controller, complete, capture, hello, execute, snapshot, events };
}

describe("shared application contract", () => {
  it("creates explicit empty/duplicate drafts without model calls, uses frozen background and immutable whitelists", async () => {
    const f = fixture();
    try {
      const first = value<Receipt>(await f.execute({ method: "createDraft", text: "" }));
      const second = value<Receipt>(await f.execute({ method: "createDraft", text: "" }));
      expect(first).toMatchObject({ outcome: "captured", taskId: "task-1", version: 1 });
      expect(second).toMatchObject({ taskId: "task-2" });
      expect(f.complete).not.toHaveBeenCalled();
      expect(f.controller.getHistory()[0]!.input.roundId).toBe(f.controller.getHistory()[1]!.input.roundId);
      const before = f.snapshot();
      expect(before.tasks.map((task) => task.id)).toEqual(["task-2", "task-1"]);
      expect(JSON.stringify(before)).not.toMatch(/PRIVATE|systemPrompt|sessionManager|apiKey|cwd/);
      expect(before.runs).toEqual([]);
      expect(Object.isFrozen(before.tasks[0])).toBe(true);
      const detail = value<TaskDetail>(f.app.api.query(f.hello.binding, { method: "task", taskId: "task-1" }));
      expect(detail.text).toBe("");
      expect(JSON.stringify(detail)).not.toMatch(/PRIVATE|systemPrompt|history|preparedInput/);
    } finally { f.controller.invalidateLifecycle(); }
  });

  it("serializes competing clients, checks replay before versions, and sees native TUI mutations", async () => {
    const f = fixture();
    try {
      await f.execute({ method: "createDraft", text: "one" });
      const two = value<Hello>(f.app.api.hello("two"));
      const mutation: Mutation = { method: "updateDraft", taskId: "task-1", expectedVersion: 1, text: "two" };
      const first = await f.execute(mutation, f.hello, "edit");
      expect(await f.execute(mutation, two)).toEqual({ kind: "conflict", code: "task-version" });
      expect(await f.execute(mutation, f.hello, "edit")).toEqual(first);
      expect(await f.execute({ ...mutation, text: "changed retry" }, f.hello, "edit")).toEqual({ kind: "conflict", code: "operation-id-reused" });
      const version = f.snapshot().tasks[0]!.version;
      expect(f.controller.updateDraft(1, "two", "native TUI edit")).toBe(true);
      expect(f.snapshot().tasks[0]!.version).toBeGreaterThan(version);
      expect(await f.execute({ ...mutation, expectedVersion: version })).toEqual({ kind: "conflict", code: "task-version" });
    } finally { f.controller.invalidateLifecycle(); }
  });

  it("returns exact started/queued/duplicate ids, cancels queued work and keeps transport disconnect non-cancelling", async () => {
    const f = fixture();
    try {
      for (let n = 1; n <= 5; n++) {
        await f.execute({ method: "createDraft", text: `draft ${n}` });
        const receipt = value<Receipt>(await f.execute({ method: "startRun", taskId: `task-${n}`, expectedVersion: 1 }));
        expect(receipt).toEqual({ outcome: n === 5 ? "queued" : "started", taskId: `task-${n}`, runId: `run-${n}` });
      }
      expect(f.complete).toHaveBeenCalledTimes(4);
      const task = f.snapshot().tasks.find((task) => task.id === "task-1")!;
      const duplicate = await f.execute({ method: "startRun", taskId: task.id, expectedVersion: task.version });
      expect(value<Receipt>(duplicate)).toEqual({ outcome: "duplicate", taskId: "task-1", runId: "run-1" });
      const listener = vi.fn();
      const unsubscribe = f.app.api.subscribe(f.hello.binding, listener);
      unsubscribe();
      expect(f.complete.mock.calls.length).toBe(4);
      expect(value<Receipt>(await f.execute({ method: "stopRun", runId: "run-5" }))).toEqual({ outcome: "cancelled", runId: "run-5" });
      expect(value<Receipt>(await f.execute({ method: "stopRun", runId: "run-5" }))).toEqual({ outcome: "already-terminal", runId: "run-5" });
      expect(f.complete).toHaveBeenCalledTimes(4);
      const detail = value<RunDetail>(f.app.api.query(f.hello.binding, { method: "run", runId: "run-5" }));
      expect(detail).toMatchObject({ status: "cancelled", original: "draft 5", model });
      expect(JSON.stringify(detail)).not.toMatch(/PRIVATE|systemPrompt|preparedInput|history/);
    } finally { f.controller.invalidateLifecycle(); }
  });

  it("retains exact submission identity even when the completion port throws synchronously", async () => {
    const f = fixture();
    try {
      f.complete.mockImplementation(() => { throw new Error("port unavailable"); });
      const receipt = value<Receipt>(await f.execute({ method: "optimizeText", text: "source" }));
      expect(receipt).toEqual({ outcome: "started", taskId: "task-1", runId: "run-1" });
      expect(f.snapshot().runs[0]!.status).toBe("error");
    } finally { f.controller.invalidateLifecycle(); }
  });

  it("invalidates lifecycle bindings independently of candidate/presentation generation", async () => {
    const f = fixture();
    try {
      await f.execute({ method: "createDraft", text: "draft" });
      const before = f.hello.binding;
      f.controller.setModel(model);
      expect(f.app.api.query(before, { method: "models" }).kind).toBe("ok");
      const listener = vi.fn();
      f.app.api.subscribe(before, listener);
      f.app.invalidate();
      expect(f.app.api.query(before, { method: "snapshot", scope: "all" })).toEqual({ kind: "conflict", code: "binding-stale" });
      expect(f.app.api.hello("one")).toEqual({ kind: "rejected", code: "not-ready" });
      expect(await f.execute({ method: "createDraft", text: "stale" })).toEqual({ kind: "conflict", code: "binding-stale" });
      f.app.bind("session-1");
      const current = value<Hello>(f.app.api.hello("one"));
      expect(current.binding.lifecycleEpoch).toBeGreaterThan(before.lifecycleEpoch);
      expect(current.binding.runtimeId).toBe(before.runtimeId);
      expect(current.lease.id).not.toBe(f.hello.lease.id);
      await flushPromises();
      expect(listener).toHaveBeenCalled();
      expect(f.controller.getHistory()).toHaveLength(1);
    } finally { f.controller.invalidateLifecycle(); }
  });

  it("coalesces invalidation and validates before capture, keeping over-limit requests side-effect free", async () => {
    const f = fixture();
    try {
      await flushPromises();
      const changed = vi.fn();
      const off = f.app.api.subscribe(f.hello.binding, changed);
      f.events.changed(); f.events.changed(); f.events.changed();
      await flushPromises();
      expect(changed).toHaveBeenCalledTimes(1);
      off();
      const revision = f.snapshot().revision;
      expect(f.snapshot().revision).toBe(revision);
      expect(await f.execute({ method: "createDraft", text: "x".repeat(100_001) })).toEqual({ kind: "rejected", code: "invalid-input" });
      expect(await f.execute({ method: "createDraft", text: "draft", history: "injected" } as unknown as Mutation)).toEqual({ kind: "rejected", code: "invalid-input" });
      expect(f.capture).not.toHaveBeenCalled();
      expect(f.controller.getHistory()).toEqual([]);
    } finally { f.controller.invalidateLifecycle(); }
  });
});
