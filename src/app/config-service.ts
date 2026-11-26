import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { modelKey, type ConfigReader, type ContextSettings, type ModelRef, type RefineConfig } from "../config.js";
import { immutable } from "../immutable.js";
import type { OptimizerDto } from "./api.js";

export function createConfigService(initial: RefineConfig, deps: {
  defaultSystemPrompt: string;
  write?(snapshot: ReturnType<ConfigReader>): Promise<void>;
  changed(): void;
  unsaved(reason: "blocked" | "failed"): void;
}) {
  let config: ReturnType<ConfigReader> = immutable(structuredClone(initial));
  let version = 1;
  const initialPersistence = deps.write ? "persisted" : "blocked";
  let optimizerSave: { pending: number; persistence: OptimizerDto["persistence"] } = { pending: 0, persistence: initialPersistence };
  let queue = Promise.resolve(true);

  function apply(next: ReturnType<ConfigReader>): Promise<boolean> {
    const snapshot = config = immutable(next);
    const write = deps.write;
    if (!write) {
      deps.changed();
      deps.unsaved("blocked");
      return Promise.resolve(false);
    }

    const optimizer = optimizerSave;
    optimizer.pending++;
    if (optimizer.persistence !== "persisted") optimizer.persistence = "pending";
    // Enqueue the accepted snapshot before notifying readers. A later write can
    // also persist the current optimizer, since each write saves the whole config.
    const saved = queue.then(() => write(snapshot)).then(() => true, () => false);
    queue = saved;
    const settled = saved.then((persisted) => {
      optimizer.pending--;
      if (persisted) optimizer.persistence = "persisted";
      else if (!optimizer.pending && optimizer.persistence !== "persisted") optimizer.persistence = "failed";
      deps.changed();
      if (!persisted) deps.unsaved("failed");
      return persisted;
    });
    deps.changed();
    return settled;
  }

  return {
    read: (): ReturnType<ConfigReader> => config,
    contextSettings(): ContextSettings {
      const { context, projectContext, maxOutputTokens, timeoutMs, maxDraftChars } = config;
      return {
        instructions: !projectContext.instructionsEnabled ? "off" : projectContext.instructionsOnFollowUp ? "always" : "first",
        tree: projectContext.tree.enabled, skills: projectContext.skillsEnabled, enabled: projectContext.enabled,
        referencedDirectories: projectContext.referencedDirectories.enabled,
        maxMessages: context.maxMessages, historyMaxChars: context.maxChars, maxOutputTokens, timeoutMs, maxDraftChars,
      };
    },
    optimizerState: () => ({ version, persistence: optimizerSave.persistence }),
    setOptimizer(model: ModelRef, override: ModelThinkingLevel | undefined, effective: ModelThinkingLevel,
      previous?: { model: ModelRef; thinking: ModelThinkingLevel }): Promise<boolean> {
      if (model.provider !== config.model?.provider || model.id !== config.model?.id || override !== config.thinkingLevel) version++;
      optimizerSave = { pending: 0, persistence: deps.write ? "pending" : "blocked" };
      const remembered = { ...config.modelThinkingLevels };
      if (previous) remembered[modelKey(previous.model)] ??= previous.thinking;
      remembered[modelKey(model)] = effective;
      return apply({ ...config, model: { ...model }, thinkingLevel: override, modelThinkingLevels: remembered });
    },
    rememberComparisonThinking(model: ModelRef, thinking: ModelThinkingLevel): Promise<boolean> | undefined {
      const key = modelKey(model);
      if (config.modelThinkingLevels[key] === thinking) return undefined;
      return apply({ ...config, modelThinkingLevels: { ...config.modelThinkingLevels, [key]: thinking } });
    },
    async saveSystemPrompt(expected: string | undefined, text: string): Promise<"stale" | "empty" | "unchanged" | "saved" | "memory-only"> {
      if (config.systemPrompt !== expected) return "stale";
      if (!text.trim()) return "empty";
      if (text === (expected ?? deps.defaultSystemPrompt)) return "unchanged";
      return await apply({ ...config, systemPrompt: text }) ? "saved" : "memory-only";
    },
    saveContext(selected: ContextSettings): Promise<boolean> {
      const { projectContext, context } = config;
      return apply({ ...config,
        projectContext: {
          ...projectContext,
          enabled: selected.enabled ?? projectContext.enabled,
          instructionsEnabled: selected.instructions !== "off",
          instructionsOnFollowUp: selected.instructions === "off" ? projectContext.instructionsOnFollowUp : selected.instructions === "always",
          skillsEnabled: selected.skills,
          tree: { ...projectContext.tree, enabled: selected.tree },
          referencedDirectories: { ...projectContext.referencedDirectories, enabled: selected.referencedDirectories ?? projectContext.referencedDirectories.enabled },
        },
        context: { maxMessages: selected.maxMessages ?? context.maxMessages, maxChars: selected.historyMaxChars ?? context.maxChars },
        maxOutputTokens: selected.maxOutputTokens ?? config.maxOutputTokens,
        timeoutMs: selected.timeoutMs ?? config.timeoutMs,
        maxDraftChars: selected.maxDraftChars ?? config.maxDraftChars,
      });
    },
    flush: () => queue,
  };
}
