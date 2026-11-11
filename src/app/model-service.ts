import { clampThinkingLevel, getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import type { RefineConfig } from "../config.js";
import { modelKey } from "../config.js";
import type { RefineController } from "../controller.js";
import type { Failure, ModelIdentity, OptimizerDto, Thinking } from "./api.js";
import type { ModelPort } from "./ports.js";

export function createModelService(deps: {
  controller: Pick<RefineController, "getModel" | "setModel" | "getState">;
  config: Pick<RefineConfig, "model" | "thinkingLevel" | "modelThinkingLevels" | "favorites">;
  available(): Model<Api>[];
  sessionThinking(): Thinking | undefined;
  persist(): Promise<boolean>;
  changed(): void;
  writable: boolean;
}): ModelPort & { settled(): Promise<boolean> } {
  let version = 1;
  let observed = "";
  let persistence: OptimizerDto["persistence"] = deps.writable ? "persisted" : "blocked";
  let saveSequence = 0;
  let latestSave = Promise.resolve(deps.writable);
  function optimizer(): OptimizerDto {
    const model = deps.controller.getModel();
    const signature = JSON.stringify([model, deps.config.thinkingLevel]);
    if (observed && observed !== signature) version++;
    observed = signature;
    return { version, ...(model ? { model: { ...model } } : {}), thinking: deps.config.thinkingLevel ?? "inherit", persistence };
  }
  optimizer();
  function resolve(ref = deps.controller.getModel(), thinking = deps.config.thinkingLevel): ReturnType<ModelPort["resolve"]> {
    if (!ref) return { kind: "rejected", code: "no-model" } as const;
    const model = deps.available().find((entry) => entry.provider === ref.provider && entry.id === ref.id);
    if (!model) return { kind: "rejected", code: "model-unavailable" } as const;
    return { model: { provider: model.provider, id: model.id },
      thinking: clampThinkingLevel(model, thinking ?? deps.sessionThinking() ?? "medium") };
  }
  return {
    optimizer, resolve, settled: () => latestSave,
    list: () => deps.available().map((model) => ({ provider: model.provider, id: model.id, name: model.name,
      thinkingLevels: getSupportedThinkingLevels(model), favorite: deps.config.favorites.some((ref) => modelKey(ref) === modelKey(model)) })),
    configure(expectedVersion: number, model: ModelIdentity, thinking: Thinking | "inherit"): OptimizerDto | Failure {
      if (expectedVersion !== optimizer().version) return { kind: "conflict", code: "optimizer-version" };
      if (deps.controller.getState().pendingSend) return { kind: "rejected", code: "send-pending" };
      const selection = resolve(model, thinking === "inherit" ? deps.sessionThinking() ?? "medium" : thinking);
      if ("kind" in selection) return selection;
      const previous = deps.controller.getModel();
      if (previous && deps.config.modelThinkingLevels[modelKey(previous)] === undefined) {
        const resolved = resolve(previous);
        if (!("kind" in resolved)) deps.config.modelThinkingLevels[modelKey(previous)] = resolved.thinking;
      }
      deps.controller.setModel(selection.model);
      deps.config.model = selection.model;
      deps.config.thinkingLevel = thinking === "inherit" ? undefined : selection.thinking;
      deps.config.modelThinkingLevels[modelKey(model)] = selection.thinking;
      persistence = deps.writable ? "pending" : "blocked";
      const sequence = ++saveSequence;
      deps.changed();
      const save = deps.persist();
      latestSave = save.catch(() => false);
      void save.then((saved) => {
        if (sequence !== saveSequence) return;
        persistence = saved ? "persisted" : deps.writable ? "failed" : "blocked";
        deps.changed();
      }, () => {
        if (sequence !== saveSequence) return;
        persistence = "failed";
        deps.changed();
      });
      return optimizer();
    },
  };
}
