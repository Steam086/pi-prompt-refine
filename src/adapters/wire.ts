import type { Binding, Mutation, MutationMeta, Query } from "../app/api.js";
import { binding, identity, isRecord, keysOnly, mutationMeta, parseMutation, parseQuery } from "../app/operation-contract.js";

export const REQUEST_EVENT = "prompt-refine:v1:request";
export const RESPONSE_EVENT = "prompt-refine:v1:response";
export const INVALIDATION_EVENT = "prompt-refine:v1:invalidation";

export type WireCall =
  | { action: "hello"; clientId: string; resumeLease?: string }
  | { action: "query"; binding: Binding; query: Query }
  | { action: "mutate"; meta: MutationMeta; mutation: Mutation }
  | { action: "subscribe"; binding: Binding }
  | { action: "close" }
  | { action: "readOutput"; outputId: string; index: number }
  | { action: "releaseOutput"; outputId: string }
  | { action: "stage"; transferId: string; index: number; total: number; text: string }
  | { action: "commit"; transferId: string };

export function parseWireCall(call: unknown): WireCall | undefined {
  if (!isRecord(call)) return undefined;
  const { action } = call;
  switch (action) {
    case "hello":
      if (keysOnly(call, ["action", "clientId", "resumeLease"]) && identity(call.clientId) &&
        (call.resumeLease === undefined || identity(call.resumeLease))) return { action, clientId: call.clientId, resumeLease: call.resumeLease };
      break;
    case "query": {
      if (!keysOnly(call, ["action", "binding", "query"]) || !binding(call.binding)) break;
      const query = parseQuery(call.query);
      if (query) return { action, binding: call.binding, query };
      break;
    }
    case "mutate": {
      if (!keysOnly(call, ["action", "meta", "mutation"]) || !mutationMeta(call.meta)) break;
      const mutation = parseMutation(call.mutation);
      if (mutation) return { action, meta: call.meta, mutation };
      break;
    }
    case "subscribe":
      if (keysOnly(call, ["action", "binding"]) && binding(call.binding)) return { action, binding: call.binding };
      break;
    case "close":
      if (keysOnly(call, ["action"])) return { action };
      break;
    case "readOutput":
      if (keysOnly(call, ["action", "outputId", "index"]) && identity(call.outputId) &&
        typeof call.index === "number" && Number.isSafeInteger(call.index)) return { action, outputId: call.outputId, index: call.index };
      break;
    case "releaseOutput":
      if (keysOnly(call, ["action", "outputId"]) && identity(call.outputId)) return { action, outputId: call.outputId };
      break;
    case "stage":
      if (keysOnly(call, ["action", "transferId", "index", "total", "text"]) && identity(call.transferId) &&
        typeof call.index === "number" && Number.isSafeInteger(call.index) &&
        typeof call.total === "number" && Number.isSafeInteger(call.total) && typeof call.text === "string") {
        return { action, transferId: call.transferId, index: call.index, total: call.total, text: call.text };
      }
      break;
    case "commit":
      if (keysOnly(call, ["action", "transferId"]) && identity(call.transferId)) return { action, transferId: call.transferId };
      break;
  }
  return undefined;
}
