import { randomUUID } from "node:crypto";
import type { JsonValue, PiWebHostPiSessionConnection, PiWebHostPiSessionEventsV1, PiWebHostPiSessionSelection } from "@jmfederico/pi-web/server-plugin-api";
import { identity, isRecord, REQUEST_EVENT, RESPONSE_EVENT, INVALIDATION_EVENT } from "../../../../src/adapters/wire.js";

const TTL = 60_000;
interface Pending { resolve(value: JsonValue): void; reject(error: Error): void; cleanup(): void }
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

/** Only bounded in-flight frames. Full DTO/output ownership stays in the core's paged transport. */
export class Connection {
  readonly id = randomUUID();
  touched = Date.now();
  private pending = new Map<string, Pending>();
  private listeners = new Set<(value: JsonValue) => void>();
  private disposed = false;
  private off: Array<() => void> = [];
  constructor(private host: PiWebHostPiSessionConnection, readonly sessionId: string) {
    this.off.push(host.on(RESPONSE_EVENT, (value) => this.response(value)), host.on(INVALIDATION_EVENT, (value) => {
      if (!isRecord(value) || value.connectionId !== this.id) return;
      for (const listener of [...this.listeners]) {
        try { listener(json(value)); } catch { /* A disconnected reader cannot fail a task. */ }
      }
    }));
    const aborted = () => this.close();
    host.signal.addEventListener("abort", aborted, { once: true });
    this.off.push(() => host.signal.removeEventListener("abort", aborted));
    if (host.signal.aborted) this.close();
  }
  get closed() { return this.disposed; }
  on(listener: (value: JsonValue) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  async call(call: Record<string, unknown>, signal: AbortSignal): Promise<JsonValue> {
    if (this.disposed || signal.aborted) throw new Error("connection-closed");
    if (this.pending.size >= 16 || Buffer.byteLength(JSON.stringify(call)) > 56 * 1024) throw new Error("resource-limit");
    this.touched = Date.now();
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const fail = (code: string) => { entry.cleanup(); reject(new Error(code)); };
      const abort = () => fail("outcome-unknown");
      const timer = setTimeout(() => fail("outcome-unknown"), 8_000);
      const entry: Pending = {
        resolve, reject,
        cleanup: () => { clearTimeout(timer); signal.removeEventListener("abort", abort); this.pending.delete(requestId); },
      };
      this.pending.set(requestId, entry);
      signal.addEventListener("abort", abort, { once: true });
      try { this.host.emit(REQUEST_EVENT, { connectionId: this.id, requestId, call }); }
      catch { fail("outcome-unknown"); }
    });
  }
  private response(value: unknown) {
    if (!isRecord(value) || value.connectionId !== this.id || !identity(value.requestId)) return;
    const entry = this.pending.get(value.requestId);
    if (!entry) return;
    entry.cleanup();
    try {
      if (!("result" in value)) throw new Error("invalid-response");
      const serialized = JSON.stringify(value.result);
      if (Buffer.byteLength(serialized) > 60 * 1024) throw new Error("resource-limit");
      entry.resolve(JSON.parse(serialized));
    } catch { entry.reject(new Error("invalid-response")); }
  }
  close() {
    if (this.disposed) return;
    this.disposed = true;
    try { this.host.emit(REQUEST_EVENT, { connectionId: this.id, requestId: randomUUID(), call: { action: "close" } }); } catch { /* Host already closed. */ }
    for (const entry of [...this.pending.values()]) { entry.cleanup(); entry.reject(new Error("outcome-unknown")); }
    this.off.splice(0).forEach((off) => off()); this.listeners.clear(); this.host.close();
  }
}

export function createConnections(capability: PiWebHostPiSessionEventsV1) {
  const connections = new Map<string, Promise<Connection>>();
  let disposed = false;
  const timer = setInterval(() => {
    for (const [key, pending] of connections) void pending.then((connection) => {
      if (Date.now() - connection.touched > 5 * TTL || connection.closed) { connection.close(); if (connections.get(key) === pending) connections.delete(key); }
    }, () => { if (connections.get(key) === pending) connections.delete(key); });
  }, TTL);
  timer.unref();
  return {
    async get(selection: PiWebHostPiSessionSelection, clientId: string): Promise<Connection> {
      if (disposed) throw new Error("connection-closed");
      const key = JSON.stringify([selection.projectId, selection.workspaceId, selection.sessionId, clientId]);
      const old = connections.get(key);
      if (old) {
        const connection = await old;
        if (disposed) throw new Error("connection-closed");
        if (connections.get(key) !== old) return this.get(selection, clientId);
        if (!connection.closed) return connection;
        connections.delete(key);
      }
      if (connections.size >= 32) throw new Error("resource-limit");
      const pending = capability.connect(selection).then((host) => {
        if (disposed) { host.close(); throw new Error("connection-closed"); }
        return new Connection(host, selection.sessionId);
      });
      connections.set(key, pending);
      try { return await pending; } catch (error) { if (connections.get(key) === pending) connections.delete(key); throw error; }
    },
    dispose() {
      disposed = true; clearInterval(timer);
      for (const pending of connections.values()) void pending.then((connection) => connection.close(), () => {});
      connections.clear();
    },
  };
}
