import { afterEach, describe, expect, it, vi } from "vitest";
import { createContextJobs } from "../../src/app/context-jobs.js";
import { selectHistory } from "../../src/context.js";
import type { RefineRecord } from "../../src/history.js";
import type { TreeSnapshot } from "../../src/project-context.js";
import { deferred } from "../support/helpers.js";

const snapshot: TreeSnapshot = { text: "project/\n  source.ts", warnings: [] };
const caches: ReturnType<typeof createContextJobs>[] = [];
function cache(records: RefineRecord[] = []) {
  const jobs = createContextJobs(() => records);
  caches.push(jobs);
  return jobs;
}
afterEach(() => { for (const jobs of caches.splice(0)) jobs.clear(); });

describe("shared context jobs", () => {
  it("reuses in-flight and settled snapshots by key without sharing across application instances", async () => {
    const jobs = cache();
    const pending = deferred<TreeSnapshot>();
    const collect = vi.fn(() => pending.promise);
    const first = jobs.directorySnapshot("round:base", collect);
    expect(jobs.directorySnapshot("round:base", collect)).toBe(first);
    expect(collect).toHaveBeenCalledTimes(1);
    pending.resolve(snapshot);
    expect(await first).toBe(snapshot);
    expect(jobs.directorySnapshot("round:base", collect)).toBe(first);
    expect(jobs.directorySnapshot("round:reference", collect)).toBe(pending.promise);
    expect(cache().directorySnapshot("round:base", collect)).toBe(pending.promise);
    expect(collect).toHaveBeenCalledTimes(3);
  });

  it("keeps a rejected snapshot cached until lifecycle clearing permits recollection", async () => {
    const jobs = cache();
    const failed = Promise.reject(new Error("collection failed"));
    const collect = vi.fn(() => failed);
    const first = jobs.directorySnapshot("round:base", collect);
    await expect(first).rejects.toThrow("collection failed");
    expect(jobs.directorySnapshot("round:base", collect)).toBe(first);
    expect(collect).toHaveBeenCalledTimes(1);
    jobs.clear();
    const retry = vi.fn(async () => snapshot);
    expect(await jobs.directorySnapshot("round:base", retry)).toBe(snapshot);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("aborts shared collection only on clearing and does not let late jobs replace new snapshots", async () => {
    const jobs = cache();
    const pending = deferred<TreeSnapshot>();
    let sharedSignal!: AbortSignal;
    const first = jobs.directorySnapshot("round:base", (signal) => {
      sharedSignal = signal;
      return pending.promise;
    });
    expect(jobs.directorySnapshot("round:base", async () => snapshot)).toBe(first);
    expect(sharedSignal.aborted).toBe(false);
    jobs.clear();
    expect(sharedSignal.aborted).toBe(true);
    const replacement = jobs.directorySnapshot("round:base", async () => snapshot);
    expect(replacement).not.toBe(first);
    pending.resolve({ text: "late abandoned listing", warnings: [] });
    await first;
    expect(jobs.directorySnapshot("round:base", async () => snapshot)).toBe(replacement);
    expect(await replacement).toBe(snapshot);
  });

  it("prunes only settled unretained jobs at capacity, retaining frozen base and revision sources", async () => {
    const record: RefineRecord = {
      id: 1, taskId: 1, kind: "revise", createdAt: 0, status: "generated",
      input: {
        draft: "Original", revision: { previousCandidate: "Candidate", instruction: "Shorter" },
        model: { provider: "provider", id: "model" }, sessionId: "session", roundId: 7,
        branchLeafId: "leaf", history: selectHistory([], 0, 0), systemPrompt: "Policy",
      },
    };
    const jobs = cache([record]);
    const prefix = JSON.stringify(["session", 7]) + ":";
    const collect = vi.fn(async () => snapshot);
    const base = jobs.directorySnapshot(prefix + "base", collect);
    const revision = jobs.directorySnapshot(prefix + JSON.stringify("Original\nShorter"), collect);
    const pending = deferred<TreeSnapshot>();
    const unsettled = jobs.directorySnapshot("unsettled", () => pending.promise);
    const obsolete = Array.from({ length: 197 }, (_, index) => jobs.directorySnapshot(`obsolete-${index}`, collect));
    await Promise.all([base, revision, ...obsolete]);

    await jobs.directorySnapshot("next", collect);
    expect(jobs.directorySnapshot(prefix + "base", collect)).toBe(base);
    expect(jobs.directorySnapshot(prefix + JSON.stringify("Original\nShorter"), collect)).toBe(revision);
    expect(jobs.directorySnapshot("unsettled", collect)).toBe(unsettled);
    expect(jobs.directorySnapshot("obsolete-0", collect)).not.toBe(obsolete[0]);
    expect(collect).toHaveBeenCalledTimes(201);
    pending.resolve(snapshot);
    await unsettled;
  });
});
