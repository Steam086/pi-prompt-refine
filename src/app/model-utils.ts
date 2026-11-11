import { clampThinkingLevel, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRef } from "../config.js";

export function sameModel(model: ModelRef, ref: ModelRef): boolean {
  return model.provider === ref.provider && model.id === ref.id;
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
