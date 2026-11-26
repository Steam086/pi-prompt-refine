import { clampThinkingLevel, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelRef } from "../config.js";

export type ModelRegistryLookup = Pick<ExtensionContext["modelRegistry"], "find" | "getAvailable">;

export function sameModel(model: ModelRef, ref: ModelRef): boolean {
  return model.provider === ref.provider && model.id === ref.id;
}
export function resolveAvailableModel(registry: ModelRegistryLookup, ref: ModelRef):
  { kind: "available"; model: Model<Api> } | { kind: "unknown" | "unavailable" } {
  const model = registry.find(ref.provider, ref.id);
  if (!model) return { kind: "unknown" };
  if (!registry.getAvailable().some((candidate) => sameModel(candidate, ref))) return { kind: "unavailable" };
  return { kind: "available", model };
}
export function modelRef(model: Model<Api>): ModelRef { return { provider: model.provider, id: model.id }; }
export function displayModel(model: ModelRef): string { return `${model.provider}/${model.id}`; }
export function effectiveThinkingLevel(model: Model<Api>, override: ModelThinkingLevel | undefined, sessionLevel: ModelThinkingLevel | undefined): ModelThinkingLevel {
  return clampThinkingLevel(model, override ?? sessionLevel ?? "medium");
}
export function thinkingSource(override: ModelThinkingLevel | undefined, sessionLevel: ModelThinkingLevel | undefined): string {
  if (override !== undefined) return "Extension setting";
  return sessionLevel === undefined ? "Default (medium)" : "Inherited from current session";
}
