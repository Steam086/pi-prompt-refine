import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { modelKey } from "../config.js";
import type { RefineController } from "../controller.js";
import type { Failure, ModelIdentity, OptimizerDto, Thinking } from "./api.js";
import type { createConfigService } from "./config-service.js";
import { effectiveThinkingLevel, modelRef, resolveAvailableModel, type ModelRegistryLookup } from "./model-utils.js";
import type { ModelPort } from "./ports.js";

export function createModelService(deps: {
  controller: Pick<RefineController, "setModel" | "getState">;
  config: Pick<ReturnType<typeof createConfigService>, "read" | "optimizerState" | "setOptimizer">;
  registry(): ModelRegistryLookup;
  sessionThinking(): Thinking | undefined;
}): ModelPort & { settled(): Promise<boolean> } {
  let latestSave = Promise.resolve(deps.config.optimizerState().persistence !== "blocked");
  function optimizer(): OptimizerDto {
    const { model, thinkingLevel } = deps.config.read();
    return { ...deps.config.optimizerState(), ...(model ? { model: { ...model } } : {}), thinking: thinkingLevel ?? "inherit" };
  }
  function resolve(ref = deps.config.read().model, thinking: Thinking | "inherit" | undefined = deps.config.read().thinkingLevel): ReturnType<ModelPort["resolve"]> {
    if (!ref) return { kind: "rejected", code: "no-model" };
    const result = resolveAvailableModel(deps.registry(), ref);
    if (result.kind !== "available") return { kind: "rejected", code: "model-unavailable" };
    return { model: modelRef(result.model),
      thinking: effectiveThinkingLevel(result.model, thinking === "inherit" ? undefined : thinking, deps.sessionThinking()) };
  }
  return {
    optimizer, resolve, settled: () => latestSave,
    list: () => {
      const { favorites } = deps.config.read();
      return deps.registry().getAvailable().map((model) => ({ ...modelRef(model), name: model.name,
        thinkingLevels: getSupportedThinkingLevels(model), favorite: favorites.some((ref) => modelKey(ref) === modelKey(model)) }));
    },
    configure(expectedVersion: number, model: ModelIdentity, thinking: Thinking | "inherit"): OptimizerDto | Failure {
      if (expectedVersion !== deps.config.optimizerState().version) return { kind: "conflict", code: "optimizer-version" };
      if (deps.controller.getState().pendingSend) return { kind: "rejected", code: "send-pending" };
      const selection = resolve(model, thinking);
      if ("kind" in selection) return selection;
      const { model: current, modelThinkingLevels } = deps.config.read();
      const previous = current && modelThinkingLevels[modelKey(current)] === undefined ? resolve(current) : undefined;
      latestSave = deps.config.setOptimizer(selection.model, thinking === "inherit" ? undefined : selection.thinking,
        selection.thinking, previous && !("kind" in previous) ? previous : undefined).catch(() => false);
      deps.controller.setModel(selection.model);
      return optimizer();
    },
  };
}
