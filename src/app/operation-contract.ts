import type { Binding, ModelIdentity, Mutation, MutationMeta, Query, Thinking } from "./api.js";

const thinkingLevels: readonly Thinking[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
export const keysOnly = (value: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(value).every((key) => allowed.includes(key));
export const identity = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value);
const version = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
export const taskId = (id: number): string => `task-${id}`;
export const runId = (id: number): string => `run-${id}`;
export function localId(value: unknown, kind: "task" | "run"): number | undefined {
  const prefix = `${kind}-`;
  if (typeof value !== "string" || !value.startsWith(prefix)) return undefined;
  const suffix = value.slice(prefix.length);
  return /^[1-9][0-9]{0,14}$/.test(suffix) ? Number(suffix) : undefined;
}
// Shared operation ceiling. The configured maxDraftChars can impose a lower limit.
const text = (value: unknown): value is string => typeof value === "string" && value.length <= 100_000;
const thinking = (value: unknown): value is Thinking => thinkingLevels.includes(value as Thinking);
function modelIdentity(value: unknown): value is ModelIdentity {
  return isRecord(value) && keysOnly(value, ["provider", "id"]) &&
    [value.provider, value.id].every((part) => typeof part === "string" && part.length > 0 && part.length <= 512);
}
export function binding(value: unknown): value is Binding {
  return isRecord(value) && keysOnly(value, ["runtimeId", "sessionId", "lifecycleEpoch"]) && identity(value.runtimeId) &&
    typeof value.sessionId === "string" && value.sessionId.length > 0 && value.sessionId.length <= 512 && version(value.lifecycleEpoch);
}
export function mutationMeta(value: unknown): value is MutationMeta {
  return isRecord(value) && keysOnly(value, ["binding", "clientLeaseId", "operationId"]) &&
    binding(value.binding) && identity(value.clientLeaseId) && identity(value.operationId);
}
export function parseMutation(value: unknown): Mutation | undefined {
  if (!isRecord(value)) return undefined;
  const choice = () => (value.model === undefined || modelIdentity(value.model)) && (value.thinking === undefined || thinking(value.thinking));
  const draftTarget = () => localId(value.taskId, "task") !== undefined && version(value.expectedVersion);
  let valid = false;
  switch (value.method) {
    case "createDraft": case "captureDraft": valid = keysOnly(value, ["method", "text"]) && text(value.text); break;
    case "updateDraft": valid = keysOnly(value, ["method", "taskId", "expectedVersion", "text"]) && draftTarget() && text(value.text); break;
    case "copyToCurrent": case "discardDraft": valid = keysOnly(value, ["method", "taskId", "expectedVersion"]) && draftTarget(); break;
    case "startRun": valid = keysOnly(value, ["method", "taskId", "expectedVersion", "model", "thinking"]) && draftTarget() && choice(); break;
    case "optimizeText": valid = keysOnly(value, ["method", "text", "model", "thinking"]) && text(value.text) && choice(); break;
    case "stopRun": valid = keysOnly(value, ["method", "runId"]) && localId(value.runId, "run") !== undefined; break;
    case "setDefaultOptimizer": valid = keysOnly(value, ["method", "expectedVersion", "model", "thinking"]) &&
      version(value.expectedVersion) && modelIdentity(value.model) && (value.thinking === "inherit" || thinking(value.thinking)); break;
  }
  return valid ? structuredClone(value) as unknown as Mutation : undefined;
}
export function parseQuery(value: unknown): Query | undefined {
  if (!isRecord(value)) return undefined;
  let valid = false;
  switch (value.method) {
    case "snapshot": valid = keysOnly(value, ["method", "scope"]) && ["current", "all"].includes(value.scope as string); break;
    case "task": valid = keysOnly(value, ["method", "taskId"]) && localId(value.taskId, "task") !== undefined; break;
    case "run": valid = keysOnly(value, ["method", "runId"]) && localId(value.runId, "run") !== undefined; break;
    case "models": valid = keysOnly(value, ["method"]); break;
    case "operation": valid = keysOnly(value, ["method", "clientLeaseId", "operationId"]) && identity(value.clientLeaseId) && identity(value.operationId); break;
  }
  return valid ? structuredClone(value) as unknown as Query : undefined;
}
