import type { RefineController } from "../controller.js";
import type { ModelIdentity, Mutation, Receipt, Reply, Thinking } from "../app/api.js";
import type { LocalReply } from "../app/application.js";
import { runId, taskId } from "../app/queries.js";

/** Synchronous native view boundary; scheduling, versions and validation remain in the application. */
export function createTuiOperations(
  dispatch: (mutation: Mutation) => LocalReply,
  controller: Pick<RefineController, "getRecord" | "getTaskVersion">,
) {
  function failure(result: Reply<Receipt>): string | undefined { return result.kind === "ok" ? undefined : result.code; }
  return {
    version(id: number) { const record = controller.getRecord(id); return record ? controller.getTaskVersion(record.taskId) : 0; },
    create(text: string): { kind: "captured"; recordId: number } | { kind: "rejected"; code: string } {
      const result = dispatch({ method: "createDraft", text });
      if (result.kind !== "ok") return { kind: "rejected", code: result.code };
      return result.recordId === undefined ? { kind: "rejected", code: "not-found" } : { kind: "captured", recordId: result.recordId };
    },
    update(id: number, expectedVersion: number, text: string): boolean {
      const record = controller.getRecord(id);
      return !!record && dispatch({ method: "updateDraft", taskId: taskId(record.taskId), expectedVersion, text }).kind === "ok";
    },
    discard(id: number, expectedVersion: number): void {
      const record = controller.getRecord(id);
      if (record) dispatch({ method: "discardDraft", taskId: taskId(record.taskId), expectedVersion });
    },
    start(id: number, model?: ModelIdentity, thinking?: Thinking, expectedVersion?: number): { kind: string; recordId?: number } {
      const record = controller.getRecord(id);
      if (!record) return { kind: "not-found" };
      const result = dispatch({ method: "startRun", taskId: taskId(record.taskId),
        expectedVersion: expectedVersion ?? controller.getTaskVersion(record.taskId), model, thinking });
      if (result.kind !== "ok") return { kind: result.code };
      const { outcome } = result.value;
      return { kind: outcome === "queued" ? "started" : outcome, recordId: result.recordId };
    },
    stop(id: number): string | undefined { return failure(dispatch({ method: "stopRun", runId: runId(id) })); },
  };
}
export type TuiOperations = ReturnType<typeof createTuiOperations>;
