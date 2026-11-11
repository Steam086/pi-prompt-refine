import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";
import plugin, { sessionEvents } from "../dist/server/packages/pi-web/src/server/index.js";
import { RefineClient } from "../dist/browser/packages/pi-web/src/browser/client.js";

// Exercise the actual core adapter without making the root test graph depend on this package.
const source = await readFile(new URL("../../../src/adapters/session-events.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText
  .replace('"./wire.js"', JSON.stringify(new URL("../dist/server/src/adapters/wire.js", import.meta.url).href));
const { createSessionEventsBridge } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

async function environment() {
  const binding = { runtimeId: "runtime-test", sessionId: "session-test", lifecycleEpoch: 1 };
  const emitter = new EventEmitter();
  const bus = { on(name, listener) { emitter.on(name, listener); return () => emitter.off(name, listener); }, emit(name, value) { emitter.emit(name, value); } };
  const listeners = new Set(), ledger = new Map(), leases = new Map();
  let text = "", writes = 0, revision = 1, dropped = false;
  const ok = (value) => ({ kind: "ok", value, revision });
  const snapshot = () => ({ binding, revision, tasks: [], runs: [], maxDraftChars: 100000,
    optimizer: { version: 1, thinking: "inherit", persistence: "persisted" },
    storage: { state: "disabled", savedCount: 0, omittedCount: 0, memoryOnlyCount: 0 },
    capabilities: { drafts: true, runs: true, editor: false, send: false } });
  const api = {
    hello(clientId, resume) {
      if (!leases.has(clientId)) leases.set(clientId, crypto.randomUUID());
      if (resume && resume !== leases.get(clientId)) return { kind: "rejected", code: "lease-expired" };
      return ok({ protocolVersion: 1, binding, revision, lease: { id: leases.get(clientId), expiresAt: Date.now() + 60000 } });
    },
    query(bound, query) {
      if (JSON.stringify(bound) !== JSON.stringify(binding)) return { kind: "conflict", code: "binding-stale" };
      if (query.method === "models") return ok([]);
      if (query.method === "snapshot") return ok(snapshot());
      if (query.method === "task" || query.method === "run") return ok({ text });
      if (query.method === "operation") return ok(ledger.has(`${query.clientLeaseId}/${query.operationId}`) ?
        { status: "completed", result: ledger.get(`${query.clientLeaseId}/${query.operationId}`) } : { status: "not-seen" });
      return { kind: "rejected", code: "not-found" };
    },
    async execute(meta, mutation) {
      const key = `${meta.clientLeaseId}/${meta.operationId}`;
      if (ledger.has(key)) return ledger.get(key);
      writes++; text = mutation.text ?? text; revision++;
      const reply = ok({ outcome: "captured", taskId: "task-1", version: revision }); ledger.set(key, reply);
      for (const listener of listeners) listener({ binding, revision });
      return reply;
    },
    subscribe(_binding, listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const bridge = createSessionEventsBridge(api, bus);
  const selections = [];
  const capability = { version: 1, async connect(selection) {
    selections.push(selection);
    if (selection.sessionId !== binding.sessionId || selection.projectId !== "project-authority" || selection.workspaceId !== "workspace-authority") throw new Error("Session not owned by workspace");
    const controller = new AbortController(), offs = new Set();
    return { signal: controller.signal,
      on(name, listener) { const off = bus.on(name, listener); offs.add(off); return () => { off(); offs.delete(off); }; },
      emit: bus.emit,
      close() { for (const off of offs) off(); offs.clear(); controller.abort(); },
    };
  } };
  const activation = await plugin.activate({});
  await activation.start({ capabilities: { resolve(token) {
    assert.equal(token.pluginId, "pi-web.host"); assert.equal(token.id, "pi-session-events"); assert.equal(token.version, 1);
    return token.parse(capability);
  } }, signal: new AbortController().signal });
  const scope = { kind: "workspace", project: { id: "project-authority" }, workspace: { id: "workspace-authority", projectId: "project-authority", path: "/host/private/path", label: "main", isMain: true } };
  const channelControllers = new Set();
  const peer = {
    async request(operation, input, options = {}) {
      const controller = new AbortController();
      const onAbort = () => controller.abort(); options.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const reply = await activation.peer.request({ scope, operation, input, signal: controller.signal });
        if (dropped && input.call?.action === "mutate") { dropped = false; return { kind: "error", code: "outcome-unknown" }; }
        return reply;
      } finally { controller.abort(); options.signal?.removeEventListener("abort", onAbort); }
    },
    async openChannel(operation, input, options) {
      const controller = new AbortController(); channelControllers.add(controller);
      let finish; const closed = new Promise((resolve) => { finish = resolve; });
      const abort = () => { controller.abort(); finish({ code: 1000, reason: "closed", wasClean: true }); };
      options.signal?.addEventListener("abort", abort, { once: true });
      const channel = await activation.peer.openChannel({ scope, operation, input, signal: controller.signal, send: options.onData });
      channel.closed?.then(abort);
      return { closed, send(data) { void channel.receive(data, controller.signal); },
        close() { abort(); channel.close?.({ code: 1000, reason: "closed", signal: new AbortController().signal }); options.signal?.removeEventListener("abort", abort); channelControllers.delete(controller); } };
    },
  };
  return { peer, scope, activation, selections, binding, listeners,
    writes: () => writes, dropNext: () => { dropped = true; }, setText: (value) => { text = value; },
    async dispose() { for (const controller of channelControllers) controller.abort(); await activation.dispose(); bridge.dispose(); },
  };
}

test("browser and server use the actual core wire, preserve long Unicode and recover lost acknowledgments", async () => {
  const env = await environment();
  const a = new RefineClient(env.peer, env.binding.sessionId, () => {});
  const b = new RefineClient(env.peer, env.binding.sessionId, () => {});
  try {
    await a.connect(); await b.connect();
    assert.notEqual(a.hello.lease.id, b.hello.lease.id);
    assert.equal(env.writes(), 0);
    const text = "中文😀\n\"\\".repeat(12000);
    await a.execute({ method: "createDraft", text });
    assert.equal((await b.query({ method: "task", taskId: "task-1" })).text, text);
    assert.equal(env.writes(), 1);
    env.dropNext();
    await assert.rejects(a.execute({ method: "createDraft", text: "lost receipt" }), /outcome-unknown/);
    assert.ok(a.pending);
    await a.retry();
    assert.equal(env.writes(), 2);
    assert.equal(a.pending, undefined);
    const lease = a.hello.lease.id;
    a.disconnect(); await a.connect();
    assert.equal(a.hello.lease.id, lease);
    assert.equal(env.writes(), 2);
    assert.ok(env.selections.every((s) => s.projectId === "project-authority" && s.workspaceId === "workspace-authority"));
  } finally { a.disconnect(); b.disconnect(); await env.dispose(); }
});

test("encoded response quota rejects explicitly and releases the pending allocation", async () => {
  const env = await environment();
  const client = new RefineClient(env.peer, env.binding.sessionId, () => {});
  try {
    await client.connect();
    env.setText("\u0000".repeat(2_097_152));
    await assert.rejects(client.query({ method: "run", runId: "run-1" }), /resource-limit/);
    env.setText("bounded response");
    assert.equal((await client.query({ method: "task", taskId: "task-1" })).text, "bounded response");
    assert.equal(env.writes(), 0);
  } finally { client.disconnect(); await env.dispose(); }
});

test("scope/unknown-field failures cannot route by a supplied path or leak host errors", async () => {
  const env = await environment();
  try {
    const request = (scope, input) => env.activation.peer.request({ scope, operation: "call", input, signal: new AbortController().signal });
    const input = { sessionId: "session-test", clientId: "one", call: { action: "hello", clientId: "one" } };
    assert.deepEqual(await request({ kind: "machine" }, input), { kind: "error", code: "invalid-scope" });
    assert.deepEqual(await request(env.scope, { ...input, path: "/another/private/path" }), { kind: "error", code: "invalid-input" });
    assert.equal(env.selections.length, 0);
    assert.deepEqual(await request(env.scope, { ...input, sessionId: "not-owned" }), { kind: "error", code: "bridge-unavailable" });
    assert.equal(env.writes(), 0);
    assert.throws(() => sessionEvents.parse({ version: 2, connect() {} }), /Unsupported/);
  } finally { await env.dispose(); }
});

test("browser build is a closed, Node-free graph; server has no runtime host-package resolution", async () => {
  async function files(dir) {
    const result = [];
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const path = new URL(`${item.name}${item.isDirectory() ? "/" : ""}`, dir);
      if (item.isDirectory()) result.push(...await files(path)); else result.push(path);
    }
    return result;
  }
  const browser = await files(new URL("../dist/browser/", import.meta.url));
  assert.ok(browser.length >= 5);
  for (const file of browser) {
    assert.ok(!/controller|history-store|\/server\//.test(file.href));
    const source = await readFile(file, "utf8");
    assert.ok(!/from\s*["'](?:node:|@jmfederico|@earendil)/.test(source));
    assert.ok(!/innerHTML\s*=/.test(source));
    for (const match of source.matchAll(/from\s*["']([^"']+)["']/g)) {
      assert.ok(match[1].startsWith("."));
      assert.ok(new URL(match[1], file).href.startsWith(new URL("../dist/browser/", import.meta.url).href));
    }
  }
  for (const file of await files(new URL("../dist/server/", import.meta.url))) {
    assert.ok(!/from\s*["']@jmfederico/.test(await readFile(file, "utf8")));
  }
});
