import type { Binding, ModelIdentity, Mutation, MutationMeta, Query, Thinking } from "../app/api.js";

export const REQUEST_EVENT = "prompt-refine:v1:request";
export const RESPONSE_EVENT = "prompt-refine:v1:response";
export const INVALIDATION_EVENT = "prompt-refine:v1:invalidation";
export const thinkingLevels: readonly Thinking[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
export const keysOnly = (value: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(value).every((key) => allowed.includes(key));
export const identity = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value);
const version = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const target = (value: unknown, kind: string): boolean => typeof value === "string" && new RegExp(`^${kind}-[1-9][0-9]{0,14}$`).test(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length <= 100_000;
const thinking = (value: unknown): value is Thinking => thinkingLevels.includes(value as Thinking);
export function modelIdentity(value: unknown): value is ModelIdentity {
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
  const draftTarget = () => target(value.taskId, "task") && version(value.expectedVersion);
  let valid = false;
  switch (value.method) {
    case "createDraft": case "captureDraft": valid = keysOnly(value, ["method", "text"]) && text(value.text); break;
    case "updateDraft": valid = keysOnly(value, ["method", "taskId", "expectedVersion", "text"]) && draftTarget() && text(value.text); break;
    case "copyToCurrent": case "discardDraft": valid = keysOnly(value, ["method", "taskId", "expectedVersion"]) && draftTarget(); break;
    case "startRun": valid = keysOnly(value, ["method", "taskId", "expectedVersion", "model", "thinking"]) && draftTarget() && choice(); break;
    case "optimizeText": valid = keysOnly(value, ["method", "text", "model", "thinking"]) && text(value.text) && choice(); break;
    case "stopRun": valid = keysOnly(value, ["method", "runId"]) && target(value.runId, "run"); break;
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
    case "task": valid = keysOnly(value, ["method", "taskId"]) && target(value.taskId, "task"); break;
    case "run": valid = keysOnly(value, ["method", "runId"]) && target(value.runId, "run"); break;
    case "models": valid = keysOnly(value, ["method"]); break;
    case "operation": valid = keysOnly(value, ["method", "clientLeaseId", "operationId"]) && identity(value.clientLeaseId) && identity(value.operationId); break;
  }
  return valid ? structuredClone(value) as unknown as Query : undefined;
}
