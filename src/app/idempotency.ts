import { createHash, randomUUID } from "node:crypto";
import type { Failure, Lease, OperationStatus, Receipt, Reply } from "./api.js";
import { immutable } from "./queries.js";

interface Entry { fingerprint: string; result?: Reply<Receipt>; promise: Promise<Reply<Receipt>> }
interface ClientLease extends Lease { clientId: string; entries: Map<string, Entry> }
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function createOperationLedger(options: { now?: () => number; ttlMs?: number; maxLeases?: number; maxEntries?: number } = {}) {
  const now = options.now ?? Date.now;
  const leases = new Map<string, ClientLease>();
  const failure = (code: Failure["code"], kind: Failure["kind"] = "rejected"): Failure => ({ kind, code });
  function prune() {
    for (const [id, lease] of leases) {
      if (lease.expiresAt <= now() && [...lease.entries.values()].every((entry) => entry.result !== undefined)) leases.delete(id);
    }
  }
  function current(id: string): ClientLease | undefined {
    const lease = leases.get(id);
    return lease && lease.expiresAt > now() ? lease : undefined;
  }
  return {
    lease(clientId: string, resume?: string): Lease | Failure {
      prune();
      if (resume !== undefined) {
        const old = current(resume);
        return old?.clientId === clientId ? { id: old.id, expiresAt: old.expiresAt } : failure("lease-expired");
      }
      const old = [...leases.values()].find((lease) => lease.clientId === clientId && lease.expiresAt > now());
      if (old) return { id: old.id, expiresAt: old.expiresAt };
      if (leases.size >= (options.maxLeases ?? 16)) return failure("ledger-capacity");
      const lease = { id: randomUUID(), clientId, expiresAt: now() + (options.ttlMs ?? 30 * 60_000), entries: new Map<string, Entry>() };
      leases.set(lease.id, lease);
      return { id: lease.id, expiresAt: lease.expiresAt };
    },
    status(leaseId: string, operationId: string): OperationStatus {
      const lease = current(leaseId);
      if (!lease) return { status: "expired" };
      const entry = lease.entries.get(operationId);
      return !entry ? { status: "not-seen" } : entry.result ? { status: "completed", result: entry.result } : { status: "pending" };
    },
    execute(leaseId: string, operationId: string, input: unknown, commit: () => Reply<Receipt> | Promise<Reply<Receipt>>): Promise<Reply<Receipt>> {
      prune();
      const lease = current(leaseId);
      if (!lease) return Promise.resolve(failure("lease-expired"));
      const fingerprint = createHash("sha256").update(canonical(input)).digest("hex");
      const old = lease.entries.get(operationId);
      if (old) return old.fingerprint === fingerprint ? old.promise : Promise.resolve(failure("operation-id-reused", "conflict"));
      const count = [...leases.values()].reduce((n, lease) => n + lease.entries.size, 0);
      if (count >= (options.maxEntries ?? 256)) return Promise.resolve(failure("ledger-capacity"));
      let resolve!: (value: Reply<Receipt>) => void;
      const promise = new Promise<Reply<Receipt>>((done) => { resolve = done; });
      const entry: Entry = { fingerprint, promise };
      lease.entries.set(operationId, entry);
      // Register before invoking even a synchronous/reentrant commit.
      const finish = (result: Reply<Receipt>) => { entry.result = immutable(structuredClone(result)); resolve(entry.result); };
      try { Promise.resolve(commit()).then(finish, () => finish(failure("internal", "error"))); }
      catch { finish(failure("internal", "error")); }
      return promise;
    },
    clear() { leases.clear(); },
  };
}
