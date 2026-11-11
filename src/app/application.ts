import { randomUUID } from "node:crypto";
import type { RefineController } from "../controller.js";
import type { RefineRecord } from "../history.js";
import type { TriggerResult } from "../request-types.js";
import type { ApplicationApi, Binding, Failure, FailureCode, Hello, Mutation, MutationMeta, Query, QueryValue, Receipt, Reply, Snapshot } from "./api.js";
import type { InputPort, ModelPort, StoragePort } from "./ports.js";
import { createOperationLedger } from "./idempotency.js";
import { createApplicationEvents } from "./events.js";
import { immutable, localId, runDetail, runId, runSummary, taskDetail, taskGroups, taskId, taskSummary } from "./queries.js";
import { binding as validBinding, identity, mutationMeta, parseMutation, parseQuery } from "../adapters/wire.js";

type Controller = Pick<RefineController, "getSessionId" | "getRoundId" | "getHistory" | "getState" | "getRecord" |
  "getTaskVersion" | "getRunVersion" | "getRunElapsed" | "createDraft" | "capture" | "updateDraft" | "removeDraft" | "runOriginal" |
  "trigger" | "stopRequest" | "getSubmission" | "findOriginalRun">;
const reject = (code: FailureCode): Failure => ({ kind: "rejected", code });
const conflict = (code: FailureCode): Failure => ({ kind: "conflict", code });

export function createApplication(deps: {
  controller: Controller; input: InputPort; models: ModelPort; storage: StoragePort;
  maxDraftChars(): number; events: ReturnType<typeof createApplicationEvents>;
}) {
  const { controller, events } = deps;
  const runtimeId = randomUUID();
  const ledger = createOperationLedger();
  let lifecycleEpoch = 0;
  let current: Binding | undefined;
  function ok<T>(value: T): Reply<T> { return immutable({ kind: "ok", value, revision: events.revision }); }
  function guard(value: Binding): Failure | undefined {
    if (!validBinding(value)) return reject("invalid-input");
    if (!current || value.runtimeId !== current.runtimeId || value.sessionId !== current.sessionId ||
      value.lifecycleEpoch !== current.lifecycleEpoch || value.sessionId !== controller.getSessionId()) return conflict("binding-stale");
    return undefined;
  }
  function recordsFor(id: string): RefineRecord[] {
    const number = localId(id, "task");
    return controller.getHistory().filter((record) => record.taskId === number);
  }
  function modelUnavailable(): FailureCode | undefined {
    const selection = deps.models.resolve();
    return "kind" in selection ? selection.code : undefined;
  }
  function target(id: string, expected: number): RefineRecord | Failure {
    const records = recordsFor(id);
    const record = records.find((record) => !record.input.revision) ?? records[0];
    if (!record) return reject("not-found");
    if (controller.getTaskVersion(record.taskId) !== expected) return conflict("task-version");
    return record;
  }
  function created(result: TriggerResult, outcome: "captured" | "copied" = "captured"): Reply<Receipt> {
    if (result.kind !== "captured") return rejectedTrigger(result);
    const record = controller.getRecord(result.recordId)!;
    return ok({ outcome, taskId: taskId(record.taskId), version: controller.getTaskVersion(record.taskId) });
  }
  function rejectedTrigger(result: TriggerResult): Failure {
    const code: Partial<Record<TriggerResult["kind"], FailureCode>> = {
      empty: "empty", "too-long": "too-long", "no-model": "no-model", "stale-source": "background-unavailable",
      busy: controller.getState().pendingSend ? "send-pending" : "journal-capacity",
    };
    return reject(code[result.kind] ?? "not-editable");
  }
  function started(result: TriggerResult, duplicateId?: number): Reply<Receipt> {
    if (result.kind === "duplicate") {
      const record = duplicateId === undefined ? undefined : controller.getRecord(duplicateId);
      return ok({ outcome: "duplicate", taskId: record ? taskId(record.taskId) : null, runId: record ? runId(record.id) : null });
    }
    if (result.kind !== "started") return rejectedTrigger(result);
    const submission = controller.getSubmission(result);
    if (!submission) return { kind: "error", code: "internal" };
    const record = controller.getRecord(submission.recordId)!;
    return ok({ outcome: submission.queued ? "queued" : "started", taskId: taskId(record.taskId), runId: runId(record.id) });
  }
  function commit(mutation: Mutation): Reply<Receipt> {
    if ("text" in mutation && mutation.text.length > deps.maxDraftChars()) return reject("too-long");
    switch (mutation.method) {
      case "setDefaultOptimizer": {
        const result = deps.models.configure(mutation.expectedVersion, mutation.model, mutation.thinking);
        return "kind" in result ? result : ok({ outcome: "configured", optimizer: result });
      }
      case "createDraft": return created(controller.createDraft(deps.input.capture(mutation.text)));
      case "captureDraft": {
        if (!mutation.text.trim()) return reject("empty");
        const selection = deps.models.resolve();
        if ("kind" in selection) return selection;
        const result = controller.capture({ ...deps.input.capture(mutation.text), model: selection.model, thinkingLevel: selection.thinking });
        if (result.kind !== "duplicate") return created(result);
        const match = controller.getHistory().find((record) => record.archivedAt === undefined && (record.input.draft === mutation.text ||
          (record.candidate?.text === mutation.text && (record.acceptedAt !== undefined || record.sentAt !== undefined))));
        return ok({ outcome: "duplicate", taskId: match ? taskId(match.taskId) : null,
          runId: match && match.status !== "unsent" ? runId(match.id) : null });
      }
      case "updateDraft": case "copyToCurrent": case "discardDraft": case "startRun": {
        const record = target(mutation.taskId, mutation.expectedVersion);
        if ("code" in record) return record;
        if (mutation.method === "copyToCurrent") return created(controller.createDraft(deps.input.capture((record.originalInput ?? record.input).draft)), "copied");
        if (mutation.method === "startRun") {
          if (record.input.contextUnavailable) return reject("background-unavailable");
          if (!record.input.draft.trim()) return reject("empty");
          const selection = deps.models.resolve(mutation.model, mutation.thinking);
          if ("kind" in selection) return selection;
          const result = controller.runOriginal(record.id, selection.model, selection.thinking);
          return started(result, controller.findOriginalRun(record.taskId, selection.model, selection.thinking));
        }
        if (record.status !== "unsent" || record.archivedAt !== undefined || record.input.contextUnavailable) return reject("not-editable");
        if (mutation.method === "discardDraft") {
          controller.removeDraft(record.id);
          return ok({ outcome: "removed", taskId: mutation.taskId, version: mutation.expectedVersion });
        }
        if (!controller.updateDraft(record.id, record.input.draft, mutation.text)) return conflict("task-version");
        return ok({ outcome: "updated", taskId: mutation.taskId, version: controller.getTaskVersion(record.taskId) });
      }
      case "optimizeText": {
        if (!mutation.text.trim()) return reject("empty");
        const selection = deps.models.resolve(mutation.model, mutation.thinking);
        if ("kind" in selection) return selection;
        const input = { ...deps.input.capture(mutation.text), model: selection.model, thinkingLevel: selection.thinking };
        const result = controller.trigger(input, { force: true });
        const duplicate = result.kind === "duplicate" ? controller.getHistory().find((record) =>
          ["queued", "generating"].includes(record.status) && record.input.roundId === controller.getRoundId() &&
          !record.input.revision && record.input.draft === input.draft && record.input.editingInstruction === input.editingInstruction &&
          record.input.model.provider === selection.model.provider && record.input.model.id === selection.model.id &&
          record.input.thinkingLevel === selection.thinking)?.id : undefined;
        return started(result, duplicate);
      }
      case "stopRun": {
        const record = controller.getRecord(localId(mutation.runId, "run")!);
        if (!record || record.status === "unsent") return reject("not-found");
        const pending = ["queued", "generating"].includes(record.status);
        if (pending) controller.stopRequest(record.id);
        return ok({ outcome: pending ? "cancelled" : "already-terminal", runId: mutation.runId });
      }
    }
  }
  const api: ApplicationApi = {
    hello(clientId: string, resumeLease?: string): Reply<Hello> {
      if (!identity(clientId) || (resumeLease !== undefined && !identity(resumeLease))) return reject("invalid-input");
      if (!current) return reject("not-ready");
      const lease = ledger.lease(clientId, resumeLease);
      if ("kind" in lease) return lease;
      return ok({ binding: { ...current }, protocolVersion: 1, lease, revision: events.revision });
    },
    query(value: Binding, requested: Query): Reply<QueryValue> {
      const failure = guard(value);
      if (failure) return failure;
      const query = parseQuery(requested);
      if (!query) return reject("invalid-input");
      switch (query.method) {
        case "models": return ok(deps.models.list());
        case "operation": return ok(ledger.status(query.clientLeaseId, query.operationId));
        case "task": {
          const records = recordsFor(query.taskId);
          return records.length ? ok(taskDetail(records, controller.getTaskVersion(records[0]!.taskId), controller.getState().pendingSend, modelUnavailable())) : reject("not-found");
        }
        case "run": {
          const record = controller.getHistory().find((record) => record.id === localId(query.runId, "run"));
          return record && record.status !== "unsent" ? ok(runDetail(record, controller.getRunVersion(record.id), controller.getRunElapsed(record.id))) : reject("not-found");
        }
        case "snapshot": {
          const groups = taskGroups(controller.getHistory(), query.scope === "all");
          const unavailable = modelUnavailable();
          const snapshot: Snapshot = {
            binding: { ...current! }, revision: events.revision, roundId: controller.getRoundId(),
            tasks: groups.map((group) => taskSummary(group, controller.getTaskVersion(group[0]!.taskId), controller.getState().pendingSend, unavailable)),
            runs: groups.flatMap((group) => group.filter((record) => record.status !== "unsent").sort((a, b) => b.id - a.id)
              .map((record) => runSummary(record, controller.getRunVersion(record.id), controller.getRunElapsed(record.id)))),
            optimizer: deps.models.optimizer(), maxDraftChars: deps.maxDraftChars(),
            capabilities: { drafts: true, runs: true, editor: false, send: false }, storage: deps.storage.summary(),
          };
          return ok(snapshot);
        }
      }
    },
    execute(meta: MutationMeta, requested: Mutation): Promise<Reply<Receipt>> {
      if (!mutationMeta(meta)) return Promise.resolve(reject("invalid-input"));
      const failure = guard(meta.binding);
      if (failure) return Promise.resolve(failure);
      const mutation = parseMutation(requested);
      if (!mutation) return Promise.resolve(reject("invalid-input"));
      return ledger.execute(meta.clientLeaseId, meta.operationId, mutation, () => commit(mutation));
    },
    subscribe(value, listener) {
      if (guard(value)) throw new Error("Binding is stale");
      const captured = { ...value };
      const off = events.subscribe((revision) => {
        try { listener(immutable({ binding: { ...(current ?? { ...captured, lifecycleEpoch }) }, revision })); }
        finally { if (guard(captured)) off(); }
      });
      return off;
    },
  };
  return {
    api,
    /** Native synchronous UI events use the same guards/use cases, not a remote retry ledger. */
    local(requested: Mutation): Reply<Receipt> {
      if (!current) return reject("not-ready");
      const failure = guard(current);
      if (failure) return failure;
      const mutation = parseMutation(requested);
      return mutation ? commit(mutation) : reject("invalid-input");
    },
    bind(sessionId: string) { current = { runtimeId, sessionId, lifecycleEpoch: ++lifecycleEpoch }; ledger.clear(); events.changed(); },
    invalidate() { current = undefined; lifecycleEpoch++; ledger.clear(); events.changed(); },
  };
}
