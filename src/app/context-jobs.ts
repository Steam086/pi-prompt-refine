import type { RefineRecord } from "../history.js";
import type { TreeSnapshot } from "../project-context.js";

/** Shared collection survives cancellation of an individual model request. */
export function createContextJobs(getHistory: () => RefineRecord[]) {
  const contextJobs = new Map<string, { abort: AbortController; promise: Promise<TreeSnapshot>; settled: boolean }>();
  function directorySnapshot(key: string, collect: (signal: AbortSignal) => Promise<TreeSnapshot>): Promise<TreeSnapshot> {
    const existing = contextJobs.get(key);
    if (existing) return existing.promise;
    if (contextJobs.size >= 200) {
      const retained = new Set(getHistory().flatMap(({ input }) => {
        const prefix = JSON.stringify([input.sessionId, input.roundId]) + ":";
        const source = input.revision ? `${input.draft}\n${input.revision.instruction}` : input.draft;
        return [prefix + "base", prefix + JSON.stringify(source)];
      }));
      for (const [jobKey, job] of contextJobs) {
        if (job.settled && !retained.has(jobKey)) contextJobs.delete(jobKey);
      }
    }
    const abort = new AbortController();
    const job = { abort, settled: false, promise: collect(abort.signal) };
    void job.promise.then(() => { job.settled = true; }, () => { job.settled = true; });
    contextJobs.set(key, job);
    return job.promise;
  }
  function clearContextJobs(): void {
    for (const job of contextJobs.values()) job.abort.abort();
    contextJobs.clear();
  }
  return { directorySnapshot, clear: clearContextJobs };
}
