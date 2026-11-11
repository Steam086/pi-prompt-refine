import { randomUUID } from "node:crypto";
import type { JsonValue, PiWebHostPiSessionConnection, PiWebHostPiSessionEventsV1, PiWebHostPiSessionSelection } from "@jmfederico/pi-web/server-plugin-api";
import { identity, isRecord, REQUEST_EVENT, RESPONSE_EVENT, INVALIDATION_EVENT } from "../../../../src/adapters/wire.js";

const TTL = 60_000;
const MAX_BYTES = 16 * 1024 * 1024;
interface Pending {
  parts: string[]; total?: number; bytes: number;
  resolve(value: JsonValue): void; reject(error: Error): void; cleanup(): void;
}
interface Output { parts: string[]; bytes: number; expires: number }
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

/** Transport-only state. No controller, model calls, sidecar access or task persistence. */
export class Connection {
  readonly id = randomUUID();
  touched = Date.now();
  private pending = new Map<string, Pending>();
  private outputs = new Map<string, Output>();
  private listeners = new Set<(value: JsonValue) => void>();
  private bytes = 0;
  private disposed = false;
  private off: Array<() => void> = [];
  constructor(private host: PiWebHostPiSessionConnection, private reserve: (delta: number) => boolean, readonly sessionId: string) {
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
  private allocate(delta: number): boolean {
    if (this.bytes + delta > MAX_BYTES || !this.reserve(delta)) return false;
    this.bytes += delta; return true;
  }
  on(listener: (value: JsonValue) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  async call(call: Record<string, unknown>, signal: AbortSignal): Promise<JsonValue> {
    if (this.disposed || signal.aborted) throw new Error("connection-closed");
    if (this.pending.size >= 16 || Buffer.byteLength(JSON.stringify(call)) > 56 * 1024) throw new Error("resource-limit");
    this.touched = Date.now(); this.prune();
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const fail = (code: string) => { entry.cleanup(); reject(new Error(code)); };
      const abort = () => fail("outcome-unknown");
      const timer = setTimeout(() => fail("outcome-unknown"), 8_000);
      const entry: Pending = {
        parts: [], bytes: 0, resolve, reject,
        cleanup: () => { clearTimeout(timer); signal.removeEventListener("abort", abort); this.pending.delete(requestId); this.allocate(-entry.bytes); entry.bytes = 0; },
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
    const fail = (code = "invalid-response") => { entry.cleanup(); entry.reject(new Error(code)); };
    if ("result" in value) { entry.cleanup(); entry.resolve(json(value.result)); return; }
    const part = value.part;
    if (!isRecord(part) || part.encoding !== "base64" || typeof part.text !== "string" || part.text.length > 48 * 1024 ||
      !Number.isSafeInteger(part.index) || !Number.isSafeInteger(part.total)) { fail(); return; }
    const index = part.index as number, total = part.total as number;
    if (total < 1 || total > 512 || index !== entry.parts.length || (entry.total !== undefined && total !== entry.total)) { fail(); return; }
    if (!this.allocate(part.text.length)) { fail("resource-limit"); return; }
    entry.total = total; entry.parts.push(part.text); entry.bytes += part.text.length;
    if (entry.parts.length !== total) return;
    if (this.outputs.size >= 4) { fail("resource-limit"); return; }
    const id = randomUUID();
    this.outputs.set(id, { parts: entry.parts, bytes: entry.bytes, expires: Date.now() + TTL });
    entry.bytes = 0; // Ownership, not a second copy, moves to the paged output store.
    entry.cleanup();
    entry.resolve({ transfer: { id, total } });
  }
  read(id: string, index: number): JsonValue {
    this.prune(); this.touched = Date.now();
    const output = this.outputs.get(id);
    if (!output || !Number.isSafeInteger(index) || index < 0 || index >= output.parts.length) throw new Error("transfer-expired");
    return { part: { index, total: output.parts.length, encoding: "base64", text: output.parts[index]! } };
  }
  release(id: string) {
    const output = this.outputs.get(id);
    if (output) { this.allocate(-output.bytes); this.outputs.delete(id); }
  }
  prune() { for (const [id, output] of this.outputs) if (output.expires <= Date.now()) this.release(id); }
  close() {
    if (this.disposed) return;
    this.disposed = true;
    try { this.host.emit(REQUEST_EVENT, { connectionId: this.id, requestId: randomUUID(), call: { action: "close" } }); } catch { /* Host already closed. */ }
    for (const entry of [...this.pending.values()]) { entry.cleanup(); entry.reject(new Error("outcome-unknown")); }
    for (const id of this.outputs.keys()) this.release(id);
    this.off.splice(0).forEach((off) => off()); this.listeners.clear(); this.host.close();
  }
}

export function createConnections(capability: PiWebHostPiSessionEventsV1) {
  const connections = new Map<string, Promise<Connection>>();
  let bytes = 0, disposed = false;
  const timer = setInterval(() => {
    for (const [key, pending] of connections) void pending.then((connection) => {
      connection.prune();
      if (Date.now() - connection.touched > 5 * TTL || connection.closed) { connection.close(); connections.delete(key); }
    }, () => connections.delete(key));
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
        return new Connection(host, (delta) => {
          if (bytes + delta > 64 * 1024 * 1024) return false;
          bytes += delta; return true;
        }, selection.sessionId);
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
