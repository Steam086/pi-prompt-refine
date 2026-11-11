import { describe, expect, it, vi } from "vitest";
import { createOperationLedger } from "../../src/app/idempotency.js";
import type { Receipt, Reply } from "../../src/app/api.js";

const accepted: Reply<Receipt> = { kind: "ok", revision: 1, value: { outcome: "captured", taskId: "task-1", version: 1 } };
function lease(ledger: ReturnType<typeof createOperationLedger>, client = "client") {
  const result = ledger.lease(client);
  if ("kind" in result) throw new Error(result.code);
  return result;
}
describe("operation ledger", () => {
  it("admits once before committing, coalesces pending callers, and replays frozen results", async () => {
    const ledger = createOperationLedger();
    const scope = lease(ledger);
    let finish!: (value: Reply<Receipt>) => void;
    const commit = vi.fn(() => new Promise<Reply<Receipt>>((resolve) => { finish = resolve; }));
    const a = ledger.execute(scope.id, "op", { text: " x ", method: "createDraft" }, commit);
    const b = ledger.execute(scope.id, "op", { method: "createDraft", text: " x " }, commit);
    expect(a).toBe(b);
    expect(ledger.status(scope.id, "op")).toEqual({ status: "pending" });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(await ledger.execute(scope.id, "op", { text: "different" }, commit)).toEqual({ kind: "conflict", code: "operation-id-reused" });
    finish(accepted);
    const result = await a;
    expect(result).toEqual(accepted);
    expect(Object.isFrozen(result)).toBe(true);
    expect(ledger.status(scope.id, "op")).toEqual({ status: "completed", result });
    expect(await ledger.execute(scope.id, "op", { method: "createDraft", text: " x " }, commit)).toBe(result);
  });

  it("records rejection, enforces quota before effects, and never executes expired scopes", async () => {
    let now = 0;
    const ledger = createOperationLedger({ now: () => now, ttlMs: 100, maxEntries: 1, maxLeases: 1 });
    const scope = lease(ledger);
    const fail = vi.fn(() => ({ kind: "conflict", code: "task-version" } as const));
    expect(await ledger.execute(scope.id, "first", {}, fail)).toEqual({ kind: "conflict", code: "task-version" });
    expect(await ledger.execute(scope.id, "first", {}, fail)).toEqual({ kind: "conflict", code: "task-version" });
    expect(fail).toHaveBeenCalledTimes(1);
    const commit = vi.fn(() => accepted);
    expect(await ledger.execute(scope.id, "second", {}, commit)).toEqual({ kind: "rejected", code: "ledger-capacity" });
    expect(ledger.lease("other")).toEqual({ kind: "rejected", code: "ledger-capacity" });
    now = 101;
    expect(ledger.status(scope.id, "first")).toEqual({ status: "expired" });
    expect(ledger.lease("client", scope.id)).toEqual({ kind: "rejected", code: "lease-expired" });
    expect(await ledger.execute(scope.id, "first", {}, commit)).toEqual({ kind: "rejected", code: "lease-expired" });
    expect(commit).not.toHaveBeenCalled();
    expect(lease(ledger).id).not.toBe(scope.id);
  });

  it("isolates clients and caches sanitized exceptions without rejecting the promise", async () => {
    const ledger = createOperationLedger();
    const a = lease(ledger, "a"), b = lease(ledger, "b");
    const failure = vi.fn(() => { throw new Error("private provider credential"); });
    expect(await ledger.execute(a.id, "same-id", {}, failure)).toEqual({ kind: "error", code: "internal" });
    expect(await ledger.execute(a.id, "same-id", {}, failure)).toEqual({ kind: "error", code: "internal" });
    expect(failure).toHaveBeenCalledTimes(1);
    expect(await ledger.execute(b.id, "same-id", {}, () => accepted)).toEqual(accepted);
  });
});
