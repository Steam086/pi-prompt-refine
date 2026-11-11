import type { JsonValue, PluginPeer, PluginPeerChannel } from "@jmfederico/pi-web/plugin-api";
import type { Binding, Hello, ModelOption, Mutation, MutationMeta, OperationStatus, Query, QueryValue, Receipt, Snapshot } from "../../../../src/app/api.js";
import { isRecord } from "../../../../src/adapters/wire.js";

const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
const sameBinding = (a: Binding, b: Binding) => a.runtimeId === b.runtimeId && a.sessionId === b.sessionId && a.lifecycleEpoch === b.lifecycleEpoch;
function encode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 4096) binary += String.fromCharCode(...bytes.subarray(i, i + 4096));
  return btoa(binary);
}
function unwrap<T>(value: unknown): T {
  if (!isRecord(value) || value.kind !== "ok") throw new Error(isRecord(value) && typeof value.code === "string" ? value.code : "invalid-response");
  return value.value as T;
}

export class RefineClient {
  readonly clientId = crypto.randomUUID();
  hello?: Hello;
  snapshot?: Snapshot;
  models: ModelOption[] = [];
  notice = "Connect to this conversation's Refine runtime.";
  connected = false;
  pending?: { meta: MutationMeta; mutation: Mutation };
  private channel?: PluginPeerChannel;
  private lifetime = new AbortController();
  private heartbeat?: ReturnType<typeof setInterval>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private refreshing = false;
  private refreshAgain = false;
  private attempt = 0;
  constructor(private peer: PluginPeer, readonly sessionId: string, readonly changed: () => void) {}
  private async request(operation: string, body: object): Promise<JsonValue> {
    if (!this.peer.request) throw new Error("Backend requests unavailable");
    return this.peer.request(operation, json({ sessionId: this.sessionId, clientId: this.clientId, ...body }), { signal: this.lifetime.signal });
  }
  private async call(call: object): Promise<unknown> {
    const serialized = JSON.stringify(call);
    let response: unknown;
    if (new TextEncoder().encode(serialized).length <= 48 * 1024) response = await this.request("call", { call });
    else {
      const encoded = encode(serialized), chunkSize = 32_000;
      const transferId = crypto.randomUUID(), total = Math.ceil(encoded.length / chunkSize);
      if (encoded.length > 2 * 1024 * 1024 || total > 128) throw new Error("resource-limit");
      for (let index = 0; index < total; index++) {
        const reply = await this.request("call", { call: { action: "stage", transferId, index, total, text: encoded.slice(index * chunkSize, (index + 1) * chunkSize) } });
        if (!isRecord(reply) || reply.kind !== "ok") throw new Error("text-transfer-failed");
      }
      response = await this.request("call", { call: { action: "commit", transferId } });
    }
    if (isRecord(response) && isRecord(response.transfer)) {
      const { id, total } = response.transfer;
      if (typeof id !== "string" || !Number.isSafeInteger(total) || (total as number) < 1 || (total as number) > 512) throw new Error("invalid-response");
      const parts: string[] = [];
      let size = 0;
      try {
        for (let index = 0; index < (total as number); index++) {
          const reply = await this.request("read", { transferId: id, index });
          if (!isRecord(reply) || !isRecord(reply.part) || reply.part.index !== index || reply.part.total !== total ||
            reply.part.encoding !== "base64" || typeof reply.part.text !== "string" || reply.part.text.length > 48 * 1024) throw new Error("invalid-response");
          parts.push(reply.part.text); size += reply.part.text.length;
          if (size > 16 * 1024 * 1024) throw new Error("resource-limit");
        }
        const bytes = Uint8Array.from(atob(parts.join("")), (char) => char.charCodeAt(0));
        response = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } finally { void this.request("release", { transferId: id }).catch(() => {}); }
    }
    return response;
  }
  async connect(fresh = false): Promise<void> {
    this.disconnect(); this.lifetime = new AbortController();
    if (fresh) this.hello = undefined; // Pending writes retain their original immutable scope.
    const hello = unwrap<Hello>(await this.call({ action: "hello", clientId: this.clientId,
      ...(this.hello ? { resumeLease: this.hello.lease.id } : {}) }));
    if (hello.protocolVersion !== 1 || hello.binding.sessionId !== this.sessionId) throw new Error("binding-stale");
    this.hello = hello;
    this.models = await this.query<ModelOption[]>({ method: "models" });
    if (!this.peer.openChannel) throw new Error("Backend channels unavailable");
    const lifetime = this.lifetime;
    this.channel = await this.peer.openChannel("watch", json({ sessionId: this.sessionId, clientId: this.clientId, binding: hello.binding }), {
      signal: lifetime.signal,
      onData: (data) => {
        if (lifetime.signal.aborted || !isRecord(data)) return;
        if (data.type !== "pong" && (!isRecord(data.binding) || !sameBinding(data.binding as unknown as Binding, hello.binding))) {
          this.notice = "Binding changed. Reconnect explicitly; previous writes will not be replayed.";
          this.disconnect(); this.changed(); return;
        }
        void this.refresh().catch((error) => this.report(error));
      },
    });
    void this.channel.closed.then(() => {
      if (lifetime.signal.aborted) return;
      this.connected = false; this.notice = "Disconnected; reconnecting without replaying writes."; this.changed();
      this.retryTimer = setTimeout(() => { void this.connect().catch((error) => this.report(error)); }, Math.min(10_000, 500 * 2 ** this.attempt++));
    });
    this.heartbeat = setInterval(() => { try { this.channel?.send({ action: "ping" }); } catch (error) { this.report(error); } }, 60_000);
    this.connected = true; this.attempt = 0;
    await this.refresh(); this.notice = "Connected"; this.changed();
  }
  async query<T extends QueryValue>(query: Query): Promise<T> {
    if (!this.hello) throw new Error("not-ready");
    const binding = this.hello.binding;
    const result = await this.call({ action: "query", binding, query });
    if (!this.hello || !sameBinding(binding, this.hello.binding)) throw new Error("binding-stale");
    return unwrap<T>(result);
  }
  async refresh(): Promise<void> {
    if (this.refreshing) { this.refreshAgain = true; return; }
    this.refreshing = true;
    try {
      do {
        this.refreshAgain = false;
        this.snapshot = await this.query<Snapshot>({ method: "snapshot", scope: "all" });
        this.changed();
      } while (this.refreshAgain && !this.lifetime.signal.aborted);
    } finally { this.refreshing = false; }
  }
  async execute(mutation: Mutation): Promise<Receipt> {
    if (!this.hello || !this.connected) throw new Error("not-ready");
    if (this.pending) throw new Error("Resolve or explicitly forget the previous operation first.");
    this.pending = { meta: { binding: { ...this.hello.binding }, clientLeaseId: this.hello.lease.id, operationId: crypto.randomUUID() }, mutation: structuredClone(mutation) };
    this.changed();
    return this.submitPending();
  }
  private async submitPending(): Promise<Receipt> {
    const pending = this.pending!;
    const result = await this.call({ action: "mutate", ...pending });
    // Transport errors have unknown outcomes. Domain decisions are journalled and final.
    if (isRecord(result) && (result.kind === "ok" || result.kind === "rejected" || result.kind === "conflict" || result.code === "internal")) this.pending = undefined;
    this.changed();
    const receipt = unwrap<Receipt>(result);
    await this.refresh(); return receipt;
  }
  async retry(): Promise<Receipt | undefined> {
    if (!this.pending) return undefined;
    const { meta } = this.pending;
    const status = unwrap<OperationStatus>(await this.call({ action: "query", binding: meta.binding,
      query: { method: "operation", clientLeaseId: meta.clientLeaseId, operationId: meta.operationId } }));
    if (status.status === "expired") throw new Error("lease-expired; never retry under a new lease");
    if (status.status === "pending") throw new Error("Operation is still pending; check again later.");
    if (status.status === "completed") {
      this.pending = undefined; this.changed(); await this.refresh(); return unwrap<Receipt>(status.result);
    }
    return this.submitPending(); // Same nonce/scope; ledger decides, never a new write identity.
  }
  forgetRetry() { this.pending = undefined; this.changed(); }
  report(error: unknown) { this.notice = error instanceof Error ? error.message : "Request failed"; this.changed(); }
  disconnect() {
    this.connected = false; this.lifetime.abort(); this.channel?.close(); this.channel = undefined;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.heartbeat = undefined; this.retryTimer = undefined;
  }
}
