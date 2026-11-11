import type { ApplicationApi, Binding, Reply } from "../app/api.js";
import { binding, identity, isRecord, keysOnly, mutationMeta, parseMutation, parseQuery,
  REQUEST_EVENT, RESPONSE_EVENT, INVALIDATION_EVENT } from "./wire.js";

export interface SessionBus {
  on(event: string, listener: (data: unknown) => void): () => void;
  emit(event: string, data: unknown): void;
}
interface Stage { parts: string[]; total: number; bytes: number; expiresAt: number }
interface Connection { touched: number; unsubscribe?: () => void; stages: Map<string, Stage> }
const FRAME_BYTES = 48 * 1024;
const MAX_TRANSFER = 2 * 1024 * 1024;
const MAX_OUTPUT = 16 * 1024 * 1024;
const TTL = 60_000;

/** Session-local adapter. The paired host capability owns routing/authentication; payloads cannot select another session. */
export function createSessionEventsBridge(api: ApplicationApi, bus: SessionBus, now = Date.now) {
  const connections = new Map<string, Connection>();
  let pending = 0;
  let disposed = false;
  function release(id: string) {
    connections.get(id)?.unsubscribe?.();
    connections.delete(id);
  }
  function prune() {
    for (const [id, connection] of connections) {
      if (now() - connection.touched > 5 * TTL) { release(id); continue; }
      for (const [key, stage] of connection.stages) if (stage.expiresAt <= now()) connection.stages.delete(key);
    }
  }
  function emit(event: string, data: unknown) {
    if (disposed) return;
    try { bus.emit(event, data); } catch { /* Delivery failure must not roll back a committed operation. */ }
  }
  function respond(connectionId: string, requestId: string, result: unknown) {
    const bytes = Buffer.from(JSON.stringify(result));
    if (bytes.length <= FRAME_BYTES) { emit(RESPONSE_EVENT, { connectionId, requestId, result }); return; }
    if (bytes.length > MAX_OUTPUT) {
      emit(RESPONSE_EVENT, { connectionId, requestId, result: { kind: "rejected", code: "resource-limit" } });
      return;
    }
    // Base64 chunks cannot split Unicode or exceed channel limits after JSON escaping.
    const encoded = bytes.toString("base64");
    const total = Math.ceil(encoded.length / FRAME_BYTES);
    for (let index = 0; index < total; index++) emit(RESPONSE_EVENT, {
      connectionId, requestId, part: { index, total, encoding: "base64", text: encoded.slice(index * FRAME_BYTES, (index + 1) * FRAME_BYTES) },
    });
  }
  async function invoke(connectionId: string, connection: Connection, call: Record<string, unknown>): Promise<unknown> {
    switch (call.action) {
      case "hello":
        if (!keysOnly(call, ["action", "clientId", "resumeLease"]) || !identity(call.clientId) ||
          (call.resumeLease !== undefined && !identity(call.resumeLease))) break;
        return api.hello(call.clientId, call.resumeLease as string | undefined);
      case "query": {
        const query = parseQuery(call.query);
        if (!keysOnly(call, ["action", "binding", "query"]) || !binding(call.binding) || !query) break;
        return api.query(call.binding, query);
      }
      case "mutate": {
        const mutation = parseMutation(call.mutation);
        if (!keysOnly(call, ["action", "meta", "mutation"]) || !mutationMeta(call.meta) || !mutation) break;
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
        return invoke(connectionId, connection, staged);
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
    if (!connection) { connection = { touched: now(), stages: new Map() }; connections.set(connectionId, connection); }
    connection.touched = now();
    pending++;
    void invoke(connectionId, connection, packet.call).then((result) => respond(connectionId, requestId, result),
      () => respond(connectionId, requestId, { kind: "error", code: "internal" } satisfies Reply<never>)).finally(() => { pending--; });
  });
  const timer = setInterval(prune, TTL);
  timer.unref?.();
  return { dispose() { disposed = true; clearInterval(timer); off(); for (const id of connections.keys()) release(id); } };
}
