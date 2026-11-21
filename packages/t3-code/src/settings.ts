import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { loadConfig, saveConfig, parseConfig, type RefineConfig } from "../../../src/config.js";
import { isRecord } from "../../../src/adapters/wire.js";
import type { SettingsFields } from "./protocol.js";

export function settingsFields(config: RefineConfig): SettingsFields {
  const project = config.projectContext;
  return {
    maxMessages: config.context.maxMessages,
    historyMaxChars: config.context.maxChars,
    projectContext: project.enabled,
    instructions: project.instructionsEnabled ? project.instructionsOnFollowUp ? "always" : "first" : "off",
    directoryTree: project.tree.enabled,
    directoryReferences: project.referencedDirectories.enabled,
    skillMetadata: project.skillsEnabled,
    maxOutputTokens: config.maxOutputTokens,
    timeoutMs: config.timeoutMs,
    maxDraftChars: config.maxDraftChars,
    systemPrompt: config.systemPrompt ?? "",
  };
}

export function parseSettings(value: unknown, config: RefineConfig): RefineConfig | undefined {
  if (!isRecord(value)) return;
  const fields = settingsFields(config);
  if (Object.entries(value).some(([key, proposed]) => !Object.hasOwn(fields, key) ||
    typeof proposed !== typeof fields[key as keyof SettingsFields])) return;
  const next = { ...fields, ...value };
  if (!["first", "always", "off"].includes(next.instructions) || next.systemPrompt.length > 16_000) return;
  const parsed = parseConfig({
    ...config,
    maxOutputTokens: next.maxOutputTokens, timeoutMs: next.timeoutMs, maxDraftChars: next.maxDraftChars,
    systemPrompt: next.systemPrompt.trim() ? next.systemPrompt : undefined,
    context: { maxMessages: next.maxMessages, maxChars: next.historyMaxChars },
    projectContext: { ...config.projectContext, enabled: next.projectContext,
      instructionsEnabled: next.instructions !== "off", instructionsOnFollowUp: next.instructions === "always",
      skillsEnabled: next.skillMetadata, tree: { ...config.projectContext.tree, enabled: next.directoryTree },
      referencedDirectories: { ...config.projectContext.referencedDirectories, enabled: next.directoryReferences } },
  });
  if (parsed.warnings.length || Object.entries(value).some(([key, proposed]) =>
    settingsFields(parsed.config)[key as keyof SettingsFields] !== proposed)) return;
  return parsed.config;
}

export async function loadDesktopSettings(stateDir: string) {
  const path = join(stateDir, "prompt-refine.json");
  const loaded = await loadConfig(path);
  const config = loaded.config;
  const writable = loaded.warnings.length === 0;
  let version = randomUUID();
  let writes = Promise.resolve(true);
  return {
    config, writable,
    version: () => version,
    save(next: RefineConfig, expected: string): Promise<boolean> | undefined {
      if (!writable || version !== expected) return;
      Object.assign(config, next, { model: next.model, thinkingLevel: next.thinkingLevel, systemPrompt: next.systemPrompt });
      version = randomUUID();
      const snapshot = structuredClone(config);
      writes = writes.then(() => saveConfig(path, snapshot)).then(() => true, () => false);
      return writes;
    },
  };
}
