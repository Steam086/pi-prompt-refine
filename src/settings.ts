import { DEFAULT_CONFIG } from "./config.js";

/** Shared draft survives model/policy child pages; saving is always explicit. */
export interface ContextSettings {
  instructions: "first" | "always" | "off";
  tree: boolean;
  skills: boolean;
  enabled?: boolean;
  referencedDirectories?: boolean;
  maxMessages?: number;
  historyMaxChars?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  maxDraftChars?: number;
}

export type NumberSetting = "maxMessages" | "historyMaxChars" | "maxOutputTokens" | "timeoutMs" | "maxDraftChars";
export interface NumberSettingSpec {
  field: NumberSetting;
  label: string;
  min: number;
  max: number;
  unit: string;
  scale: number;
  presets: number[];
  description: string;
}

export const NUMBER_SETTINGS: Record<number, NumberSettingSpec> = {
  8: { field: "maxMessages", label: "History messages", min: 0, max: 50, unit: "messages", scale: 1,
    presets: [0, 6, 12, 24, 50], description: "Maximum visible user/assistant messages. Zero disables history. Applies to the next round." },
  9: { field: "historyMaxChars", label: "History characters", min: 0, max: 100000, unit: "characters", scale: 1,
    presets: [0, 8000, 16000, 32000, 64000, 100000], description: "History character budget, including role labels. Zero disables history. Applies to the next round." },
  10: { field: "maxOutputTokens", label: "Output token limit", min: 16, max: 65536, unit: "tokens", scale: 1,
    presets: [2048, 4096, 8192, 16384, 32768, 65536], description: "Includes reasoning allowance; also bounded by model capacity. Does not guarantee answer space. Applies to subsequently started requests." },
  11: { field: "timeoutMs", label: "Request timeout", min: 1, max: 300, unit: "seconds", scale: 1000,
    presets: [30, 60, 120, 300], description: "Starts when a request runs, excluding queue time. Does not change running timers." },
  12: { field: "maxDraftChars", label: "Draft character limit", min: 1, max: 100000, unit: "characters", scale: 1,
    presets: [8000, 16000, 32000, 64000, 100000], description: "Reject oversized new drafts and revision requirements; never truncate them. Existing work is retained." },
};

export function numberSettingValue(settings: ContextSettings, field: NumberSetting): number {
  return settings[field] ?? (field === "maxMessages" ? DEFAULT_CONFIG.context.maxMessages
    : field === "historyMaxChars" ? DEFAULT_CONFIG.context.maxChars : DEFAULT_CONFIG[field]);
}

export function settingsDirty(selected: ContextSettings, original: ContextSettings): boolean {
  return (Object.keys({ ...selected, ...original }) as (keyof ContextSettings)[]).some((key) => selected[key] !== original[key]);
}
