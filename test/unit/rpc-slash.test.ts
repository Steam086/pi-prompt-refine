import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { createRpcSlash } from "../../src/adapters/rpc-slash.js";
import type { Binding, Invalidation, QueryValue, Reply, RunDetail } from "../../src/app/api.js";

afterEach(() => vi.useRealTimers());

it.each(["generated", "error"] as const)("observes a run already %s at receipt time and releases its subscription once", async (status) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const binding: Binding = { runtimeId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", sessionId: "session-one", lifecycleEpoch: 1 };
  const run: RunDetail = {
    id: "run-1", taskId: "task-1", version: 1, displayNumber: 1, kind: "refine", status,
    model: { provider: "fake", id: "chat" }, createdAt: 0, archived: false, hasOutput: status === "generated",
    actions: { stop: { enabled: false } }, original: "Draft", backgroundAvailable: true,
    ...(status === "generated" ? { text: "Candidate" } : { diagnostic: "Run timed out." }),
  };
  let invalidate: ((event: Invalidation) => void) | undefined;
  const unsubscribe = vi.fn();
  const subscribe = vi.fn((_binding: Binding, listener: (event: Invalidation) => void) => {
    invalidate = listener;
    return unsubscribe;
  });
  const query = vi.fn((): Reply<QueryValue> => ({ kind: "ok", value: run, revision: 1 }));
  const rpc = createRpcSlash({
    currentBinding: () => binding,
    optimize: () => ({ kind: "ok", value: { outcome: "started", runId: run.id, taskId: run.taskId }, revision: 1 }),
    api: { isCurrentBinding: () => true, subscribe, query },
  });
  const ui = { notify: vi.fn(), setStatus: vi.fn(), editor: vi.fn() };
  const ctx = { ui, isIdle: () => true, sessionManager: { getSessionId: () => binding.sessionId } } as unknown as ExtensionContext;
  await rpc.command("optimize Draft", ctx);
  expect(subscribe).toHaveBeenCalledWith(binding, expect.any(Function));
  expect(query).toHaveBeenCalledExactlyOnceWith(binding, { method: "run", runId: run.id });
  expect(unsubscribe).toHaveBeenCalledTimes(1);
  expect(ui.notify).toHaveBeenCalledTimes(status === "error" ? 2 : 1);
  invalidate!({ binding, revision: 2 });
  invalidate!({ binding, revision: 3 });
  expect(query).toHaveBeenCalledTimes(1);
  expect(unsubscribe).toHaveBeenCalledTimes(1);
  expect(ui.editor).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(250);
  if (status === "generated") {
    expect(ui.setStatus).toHaveBeenCalledWith("prompt-refine", "Refine · run-1 ready");
    expect(ui.editor).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("run-1"), "Candidate");
  } else {
    expect(ui.setStatus).toHaveBeenCalledWith("prompt-refine", "Refine · run-1 · Run timed out.");
    expect(ui.editor).not.toHaveBeenCalled();
  }
});
