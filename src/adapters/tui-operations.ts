import type { RefineController } from "../controller.js";
import type { ModelIdentity, Mutation, Receipt, Reply, Thinking } from "../app/api.js";
import { localId, runId, taskId } from "../app/queries.js";

/** Synchronous native view boundary; scheduling, versions and validation remain in the application. */
export function createTuiOperations(
  dispatch: (mutation: Mutation) => Reply<Receipt>,
  controller: Pick<RefineController, "getRecord" | "getHistory" | "getTaskVersion">,
) {
  function failure(result: Reply<Receipt>): string | undefined { return result.kind === "ok" ? undefined : result.code; }
  return {
    version(id: number) { const record = controller.getRecord(id); return record ? controller.getTaskVersion(record.taskId) : 0; },
    create(text: string): { kind: "captured"; recordId: number } | { kind: "rejected"; code: string } {
      const result = dispatch({ method: "createDraft", text });
      if (result.kind !== "ok") return { kind: "rejected", code: result.code };
      const receipt = result.value;
      const record = "taskId" in receipt ? controller.getHistory().find((record) => record.taskId === localId(receipt.taskId ?? "", "task")) : undefined;
      return record ? { kind: "captured", recordId: record.id } : { kind: "rejected", code: "not-found" };
    },
    update(id: number, expectedVersion: number, text: string): boolean {
      const record = controller.getRecord(id);
      return !!record && dispatch({ method: "updateDraft", taskId: taskId(record.taskId), expectedVersion, text }).kind === "ok";
    },
    discard(id: number, expectedVersion: number): void {
      const record = controller.getRecord(id);
      if (record) dispatch({ method: "discardDraft", taskId: taskId(record.taskId), expectedVersion });
    },
    start(id: number, model?: ModelIdentity, thinking?: Thinking, expectedVersion?: number): { kind: string } {
      const record = controller.getRecord(id);
      if (!record) return { kind: "not-found" };
      const result = dispatch({ method: "startRun", taskId: taskId(record.taskId),
        expectedVersion: expectedVersion ?? controller.getTaskVersion(record.taskId), model, thinking });
      if (result.kind !== "ok") return { kind: result.code };
      return { kind: result.value.outcome === "queued" ? "started" : result.value.outcome };
    },
    stop(id: number): string | undefined { return failure(dispatch({ method: "stopRun", runId: runId(id) })); },
  };
}
export type TuiOperations = ReturnType<typeof createTuiOperations>;
