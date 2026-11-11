import { randomUUID } from "node:crypto";
import { outputChunks, retainedBytes } from "./json-output.js";
import type { ApplicationApi, Binding, Reply } from "../app/api.js";
import { binding, identity, isRecord, keysOnly, mutationMeta, parseMutation, parseQuery,
  REQUEST_EVENT, RESPONSE_EVENT, INVALIDATION_EVENT } from "./wire.js";

export interface SessionBus {
  on(event: string, listener: (data: unknown) => void): () => void;
  emit(event: string, data: unknown): void;
}
interface Stage { parts: string[]; total: number; bytes: number; expiresAt: number }
interface Output {
  binding: Binding; iterator?: Generator<Buffer>; next?: IteratorResult<Buffer>; bytes: number;
  index: number; last?: { index: number; done: boolean; encoding: "base64"; text: string };
  expiresAt: number; deadline: number;
}
interface Connection { touched: number; unsubscribe?: () => void; stages: Map<string, Stage>; outputs: Map<string, Output> }
const FRAME_BYTES = 48 * 1024;
const MAX_TRANSFER = 2 * 1024 * 1024;
const MAX_OUTPUT = 16 * 1024 * 1024;
const TTL = 60_000;

/** Session-local adapter. The paired host capability owns routing/authentication; payloads cannot select another session. */
export function createSessionEventsBridge(api: ApplicationApi, bus: SessionBus, now = Date.now) {
  const connections = new Map<string, Connection>();
  let pending = 0;
  let disposed = false;
  let outputBytes = 0;
  function releaseOutput(connection: Connection, id: string) {
    const output = connection.outputs.get(id);
    if (!output) return;
    outputBytes -= output.bytes; output.iterator?.return(undefined);
    connection.outputs.delete(id);
  }
  function release(id: string) {
    const connection = connections.get(id);
    connection?.unsubscribe?.();
    if (connection) for (const key of connection.outputs.keys()) releaseOutput(connection, key);
    connections.delete(id);
  }
  function prune() {
    for (const [id, connection] of connections) {
      if (now() - connection.touched > 5 * TTL) { release(id); continue; }
      for (const [key, stage] of connection.stages) if (stage.expiresAt <= now()) connection.stages.delete(key);
      for (const [key, output] of connection.outputs) if (output.expiresAt <= now()) releaseOutput(connection, key);
    }
  }
  function emit(event: string, data: unknown) {
    if (disposed) return;
    try { bus.emit(event, data); } catch { /* Delivery failure must not roll back a committed operation. */ }
  }
  function respond(connectionId: string, requestId: string, result: unknown, bound?: Binding, page = false) {
    const send = (result: unknown) => emit(RESPONSE_EVENT, { connectionId, requestId, result });
    if (page) { send(result); return; } // Already bounded to one 48 KiB encoded page.
    let bytes: number;
    try { bytes = retainedBytes(result, MAX_OUTPUT); }
    catch { send({ kind: "rejected", code: "resource-limit" }); return; }
    if (bytes <= FRAME_BYTES && Buffer.byteLength(JSON.stringify(result)) <= FRAME_BYTES) { send(result); return; }
    const connection = connections.get(connectionId);
    if (!connection || !bound || !api.isCurrentBinding(bound)) { send({ kind: "conflict", code: "binding-stale" }); return; }
    const localBytes = [...connection.outputs.values()].reduce((n, output) => n + output.bytes, 0);
    const count = [...connections.values()].reduce((n, entry) => n + entry.outputs.size, 0);
    bytes += 256 * 1024; // Bounded iterator/lookahead/escaping scratch, not a second whole encoded result.
    if (connection.outputs.size >= 4 || count >= 16 || localBytes + bytes > MAX_OUTPUT || outputBytes + bytes > 4 * MAX_OUTPUT) {
      send({ kind: "rejected", code: "resource-limit" }); return;
    }
    const id = randomUUID();
    connection.outputs.set(id, { binding: { ...bound }, iterator: outputChunks(result), bytes, index: 0,
      expiresAt: now() + TTL, deadline: now() + 5 * TTL });
    outputBytes += bytes;
    send({ output: { id } });
  }
  async function invoke(connectionId: string, connection: Connection, call: Record<string, unknown>, scope: { binding?: Binding }): Promise<unknown> {
    switch (call.action) {
      case "hello":
        if (!keysOnly(call, ["action", "clientId", "resumeLease"]) || !identity(call.clientId) ||
          (call.resumeLease !== undefined && !identity(call.resumeLease))) break;
        return api.hello(call.clientId, call.resumeLease as string | undefined);
      case "query": {
        const query = parseQuery(call.query);
        if (!keysOnly(call, ["action", "binding", "query"]) || !binding(call.binding) || !query) break;
        scope.binding = { ...call.binding };
        return api.query(call.binding, query);
      }
      case "mutate": {
        const mutation = parseMutation(call.mutation);
        if (!keysOnly(call, ["action", "meta", "mutation"]) || !mutationMeta(call.meta) || !mutation) break;
        scope.binding = { ...call.meta.binding };
        return api.execute(call.meta, mutation);
      }
      case "subscribe": {
        if (!keysOnly(call, ["action", "binding"]) || !binding(call.binding)) break;
        const snapshot = api.query(call.binding, { method: "snapshot", scope: "current" });
        if (snapshot.kind !== "ok") return snapshot;
        connection.unsubscribe?.();
        const bound: Binding = { ...call.binding };
        connection.unsubscribe = api.subscribe(bound, (event) => {
          emit(INVALIDATION_EVENT, { connectionId, ...event });
          if (event.binding.lifecycleEpoch !== bound.lifecycleEpoch || event.binding.sessionId !== bound.sessionId) release(connectionId);
        });
        return { kind: "ok", revision: snapshot.revision };
      }
      case "close":
        if (!keysOnly(call, ["action"])) break;
        release(connectionId);
        return { kind: "ok" };
      case "readOutput": {
        if (!keysOnly(call, ["action", "outputId", "index"]) || !identity(call.outputId) || !Number.isSafeInteger(call.index)) break;
        const output = connection.outputs.get(call.outputId);
        if (!output || output.expiresAt <= now()) return { kind: "rejected", code: "transfer-expired" };
        if (!api.isCurrentBinding(output.binding)) {
          releaseOutput(connection, call.outputId); return { kind: "conflict", code: "binding-stale" };
        }
        if (call.index === output.last?.index) return { part: output.last };
        if (call.index !== output.index || !output.iterator) break;
        const current = output.next ?? output.iterator.next();
        const next = output.iterator.next();
        output.next = next;
        output.last = { index: output.index++, done: !!next.done, encoding: "base64", text: (current.value ?? Buffer.alloc(0)).toString("base64") };
        output.expiresAt = Math.min(now() + TTL, output.deadline);
        if (next.done) {
          output.iterator = undefined; output.next = undefined;
          const retained = output.last.text.length * 2 + 256;
          outputBytes -= output.bytes - retained; output.bytes = retained;
        }
        return { part: output.last };
      }
      case "releaseOutput":
        if (!keysOnly(call, ["action", "outputId"]) || !identity(call.outputId)) break;
        releaseOutput(connection, call.outputId); return { kind: "ok" };
      case "stage": {
        if (!keysOnly(call, ["action", "transferId", "index", "total", "text"]) || !identity(call.transferId) ||
          !Number.isSafeInteger(call.index) || !Number.isSafeInteger(call.total) || typeof call.text !== "string") break;
        const index = call.index as number, total = call.total as number;
        if (index < 0 || index >= total || total < 1 || total > 128) break;
        let stage = connection.stages.get(call.transferId);
        if (!stage) {
          if (index !== 0 || connection.stages.size >= 2 || [...connections.values()].reduce((n, c) => n + c.stages.size, 0) >= 16) break;
          stage = { parts: [], total, bytes: 0, expiresAt: now() + TTL };
          connection.stages.set(call.transferId, stage);
        }
        if (stage.total !== total || index > stage.parts.length) break;
        if (index < stage.parts.length) return stage.parts[index] === call.text ? { kind: "ok" } : { kind: "conflict", code: "transfer-conflict" };
        const size = Buffer.byteLength(call.text);
        const globalSize = [...connections.values()].flatMap((c) => [...c.stages.values()]).reduce((n, s) => n + s.bytes, 0);
        if (stage.bytes + size > MAX_TRANSFER || globalSize + size > 8 * MAX_TRANSFER) {
          connection.stages.delete(call.transferId);
          return { kind: "rejected", code: "resource-limit" };
        }
        stage.parts.push(call.text); stage.bytes += size;
        return { kind: "ok" };
      }
      case "commit": {
        if (!keysOnly(call, ["action", "transferId"]) || !identity(call.transferId)) break;
        const stage = connection.stages.get(call.transferId);
        if (!stage || stage.parts.length !== stage.total) break;
        connection.stages.delete(call.transferId);
        let staged: unknown;
        try { staged = JSON.parse(Buffer.from(stage.parts.join(""), "base64").toString("utf8")); } catch { break; }
        if (!isRecord(staged) || !["mutate", "query"].includes(staged.action as string)) break;
        return invoke(connectionId, connection, staged, scope);
      }
    }
    return { kind: "rejected", code: "invalid-input" };
  }
  const off = bus.on(REQUEST_EVENT, (packet) => {
    if (disposed || !isRecord(packet) || !identity(packet.connectionId) || !identity(packet.requestId)) return;
    const { connectionId, requestId } = packet;
    prune();
    let size = Infinity;
    try { size = Buffer.byteLength(JSON.stringify(packet)); } catch { /* Reject non-JSON bus data. */ }
    if (!keysOnly(packet, ["connectionId", "requestId", "call"]) || !isRecord(packet.call) || size > 60 * 1024) {
      respond(connectionId, requestId, { kind: "rejected", code: "invalid-input" }); return;
    }
    let connection = connections.get(connectionId);
    if (pending >= 64 || (!connection && connections.size >= 16)) {
      respond(connectionId, requestId, { kind: "rejected", code: "resource-limit" }); return;
    }
    if (!connection) { connection = { touched: now(), stages: new Map(), outputs: new Map() }; connections.set(connectionId, connection); }
    connection.touched = now();
    pending++;
    const scope: { binding?: Binding } = {};
    const call = packet.call;
    void invoke(connectionId, connection, call, scope).then((result) => respond(connectionId, requestId, result, scope.binding, call.action === "readOutput"),
      () => respond(connectionId, requestId, { kind: "error", code: "internal" } satisfies Reply<never>)).finally(() => { pending--; });
  });
  const timer = setInterval(prune, TTL);
  timer.unref?.();
  return { dispose() { disposed = true; clearInterval(timer); off(); for (const id of connections.keys()) release(id); } };
}
