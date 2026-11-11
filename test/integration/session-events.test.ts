import { describe, expect, it, vi } from "vitest";
import type { Hello, Receipt, RunDetail, Snapshot, TaskDetail } from "../../src/app/api.js";
import { INVALIDATION_EVENT, REQUEST_EVENT, RESPONSE_EVENT } from "../../src/adapters/wire.js";
import { extensionHarnessEnvironment } from "../support/extension-harness.js";
import { requireValue, wireMutation, wireRequest } from "../support/application-wire.js";
import { flushPromises } from "../support/helpers.js";

const { makeHarness } = extensionHarnessEnvironment();
describe("session-local application transport", () => {
  it.each(["rpc", "print"] as const)("configures, creates, explicitly runs and reads in %s without editor/transcript effects", async (mode) => {
    const h = await makeHarness({ mode, configureModel: false });
    const hello = requireValue(await wireRequest<Hello>(h.events, { action: "hello", clientId: "browser-one" }));
    const empty = requireValue(await wireRequest<Snapshot>(h.events, { action: "query", binding: hello.binding, query: { method: "snapshot", scope: "current" } }));
    expect(empty.optimizer.model).toBeUndefined();
    expect(requireValue(await wireMutation<Receipt>(h.events, hello, { method: "createDraft", text: "new source" }))).toMatchObject({ outcome: "captured" });
    expect(h.complete).not.toHaveBeenCalled();
    expect(await wireMutation(h.events, hello, { method: "startRun", taskId: "task-1", expectedVersion: 1 })).toEqual({ kind: "rejected", code: "no-model" });
    const set = { method: "setDefaultOptimizer", model: { provider: "fake-provider", id: "fake-chat" }, thinking: "high", expectedVersion: empty.optimizer.version } as const;
    expect(requireValue(await wireMutation<Receipt>(h.events, hello, set))).toMatchObject({ outcome: "configured", optimizer: { thinking: "off", persistence: "pending" } });
    expect(await wireMutation(h.events, hello, set)).toEqual({ kind: "conflict", code: "optimizer-version" });
    const started = await wireMutation<Receipt>(h.events, hello, { method: "startRun", taskId: "task-1", expectedVersion: 1 }, "once");
    expect(requireValue(started)).toEqual({ outcome: "started", taskId: "task-1", runId: "run-1" });
    expect(await wireMutation(h.events, hello, { method: "startRun", taskId: "task-1", expectedVersion: 1 }, "once")).toEqual(started);
    await flushPromises();
    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(h.complete.mock.calls[0]![1]).toHaveProperty("tools", []);
    const run = requireValue(await wireRequest<RunDetail>(h.events, { action: "query", binding: hello.binding, query: { method: "run", runId: "run-1" } }));
    expect(run).toMatchObject({ status: "generated", text: "Refined prompt", original: "new source" });
    expect(JSON.stringify(run)).not.toMatch(/systemPrompt|apiKey|preparedInput|projectDiagnostics|cwd/);
    expect(h.editorWrites).toEqual([]);
    expect(h.sent).toEqual([]);
    expect(h.internalMessages).toEqual([]);
    expect(h.sessionWrites).toEqual([]);
    expect(h.customCalls()).toBe(0);
  });

  it("shares mutations with native TUI, but does not accept another runtime's binding", async () => {
    const a = await makeHarness();
    const b = await makeHarness({ mode: "rpc" });
    const one = requireValue(await wireRequest<Hello>(a.events, { action: "hello", clientId: "client" }));
    const two = requireValue(await wireRequest<Hello>(b.events, { action: "hello", clientId: "client" }));
    expect(one.binding.runtimeId).not.toBe(two.binding.runtimeId);
    expect(await wireRequest(b.events, { action: "query", binding: one.binding, query: { method: "snapshot", scope: "all" } })).toEqual({ kind: "conflict", code: "binding-stale" });
    a.holdPanel();
    void a.shortcuts.get("ctrl+\\")!(a.context);
    await flushPromises();
    const snapshot = requireValue(await wireRequest<Snapshot>(a.events, { action: "query", binding: one.binding, query: { method: "snapshot", scope: "current" } }));
    expect(snapshot.tasks).toHaveLength(1);
    const task = snapshot.tasks[0]!;
    expect(requireValue(await wireMutation<Receipt>(a.events, one, { method: "updateDraft", taskId: task.id, expectedVersion: task.version, text: "from remote" }))).toMatchObject({ outcome: "updated" });
    expect(a.panelLines().join("\n")).toContain("from remote");
    expect(a.complete).not.toHaveBeenCalled();
    expect(a.getEditor()).toBe("Draft A");
  });

  it("stages long Unicode JSON losslessly and chunks full detail without narrowing application text limits", async () => {
    const h = await makeHarness({ mode: "rpc", config: { maxDraftChars: 100_000 } });
    const hello = requireValue(await wireRequest<Hello>(h.events, { action: "hello", clientId: "long" }));
    const text = "中文😀\n\"\\".repeat(12_000);
    expect(text.length).toBeLessThanOrEqual(100_000);
    const call = { action: "mutate", meta: { binding: hello.binding, clientLeaseId: hello.lease.id, operationId: "long-create" }, mutation: { method: "createDraft", text } };
    const encoded = Buffer.from(JSON.stringify(call)).toString("base64");
    const chunkSize = 32_000, total = Math.ceil(encoded.length / chunkSize);
    for (let index = 0; index < total; index++) {
      const part = { action: "stage", transferId: "long-transfer", index, total, text: encoded.slice(index * chunkSize, (index + 1) * chunkSize) };
      expect((await wireRequest(h.events, part)).kind).toBe("ok");
      expect((await wireRequest(h.events, part)).kind).toBe("ok");
    }
    expect(requireValue(await wireRequest<Receipt>(h.events, { action: "commit", transferId: "long-transfer" }))).toMatchObject({ outcome: "captured", taskId: "task-1" });
    const detail = requireValue(await wireRequest<TaskDetail>(h.events, { action: "query", binding: hello.binding, query: { method: "task", taskId: "task-1" } }));
    expect(detail.text).toBe(text);
    expect(h.complete).not.toHaveBeenCalled();
    expect(await wireRequest(h.events, call)).toEqual({ kind: "rejected", code: "invalid-input" });
  });

  it("reconnects to the same lease, closes subscriptions without cancelling, and releases bridge on reload", async () => {
    const h = await makeHarness({ mode: "rpc" });
    h.complete.mockImplementation(() => new Promise(() => {}));
    const hello = requireValue(await wireRequest<Hello>(h.events, { action: "hello", clientId: "one" }));
    expect((await wireRequest(h.events, { action: "subscribe", binding: hello.binding })).kind).toBe("ok");
    const updates = vi.fn();
    const off = h.events.on(INVALIDATION_EVENT, updates);
    await wireMutation(h.events, hello, { method: "optimizeText", text: "running" }, "run-once");
    await flushPromises();
    expect(updates).toHaveBeenCalled();
    expect((await wireRequest(h.events, { action: "close" })).kind).toBe("ok");
    const reconnect = requireValue(await wireRequest<Hello>(h.events, { action: "hello", clientId: "one", resumeLease: hello.lease.id }, "new-connection"));
    expect(reconnect.lease).toEqual(hello.lease);
    expect((await wireMutation(h.events, reconnect, { method: "optimizeText", text: "running" }, "run-once")).kind).toBe("ok");
    expect(h.complete).toHaveBeenCalledTimes(1);
    await h.reload();
    expect(await wireRequest(h.events, { action: "query", binding: hello.binding, query: { method: "snapshot", scope: "all" } })).toEqual({ kind: "conflict", code: "binding-stale" });
    const responses = vi.fn();
    const stop = h.events.on(RESPONSE_EVENT, responses);
    await h.dispose();
    h.events.emit(REQUEST_EVENT, { connectionId: "closed", requestId: "closed", call: { action: "hello", clientId: "one" } });
    await flushPromises();
    expect(responses).not.toHaveBeenCalled();
    off(); stop();
  });

  it("keeps slash results outside model context and does not reinterpret old /refine text", async () => {
    const h = await makeHarness({ mode: "rpc" });
    await h.commands.get("refine-api")!("drafts create -- Body With CASE\n ", h.context);
    const hello = requireValue(await wireRequest<Hello>(h.events, { action: "hello", clientId: "reader" }));
    const detail = requireValue(await wireRequest<TaskDetail>(h.events, { action: "query", binding: hello.binding, query: { method: "task", taskId: "task-1" } }));
    expect(detail.text).toBe("Body With CASE\n ");
    expect(h.internalMessages).toEqual([]);
    expect(h.sessionWrites).toEqual([]);
    expect(h.sent).toEqual([]);
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.notifications.at(-1)).not.toContain("Body With CASE");
    await h.command("api prose must remain prose", h.context);
    expect(h.notifications.at(-1)).toContain("only available in TUI");
  });
});
