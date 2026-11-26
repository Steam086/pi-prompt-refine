import { DEFAULT_CONFIG, type ContextSettings } from "./config.js";
export type { ContextSettings } from "./config.js";

export interface SettingsResult { message: string; persisted: boolean }

export type NumberSetting = "maxMessages" | "historyMaxChars" | "maxOutputTokens" | "timeoutMs" | "maxDraftChars";
export interface NumberSettingSpec {
  field: NumberSetting;
  label: string;
  min: number;
  max: number;
  unit: string;
  scale: number;
  presets: number[];
  summary?: string;
  description: string;
  shortLabel?: string;
  shortUnit?: string;
}

export const NUMBER_SETTINGS: Record<number, NumberSettingSpec> = {
  8: { field: "maxMessages", label: "History messages", min: 0, max: 50, unit: "messages", scale: 1,
    presets: [0, 6, 12, 24, 50], summary: "Max messages to include",
    description: "Either limit set to 0 turns off history. Counts visible user and assistant messages only." },
  9: { field: "historyMaxChars", label: "History characters", min: 0, max: 100000, unit: "characters", scale: 1,
    presets: [0, 8000, 16000, 32000, 64000, 100000], summary: "Max characters to include",
    description: "Either limit set to 0 turns off history. Counts role labels as well as message text." },
  10: { field: "maxOutputTokens", label: "Output token limit", min: 16, max: 65536, unit: "tokens", scale: 1,
    presets: [2048, 4096, 8192, 16384, 32768, 65536], shortLabel: "Output",
    description: "Includes reasoning; capped by model capacity." },
  11: { field: "timeoutMs", label: "Request timeout", min: 1, max: 300, unit: "seconds", scale: 1000,
    presets: [30, 60, 120, 300], shortLabel: "Timeout", shortUnit: "s", summary: "Excludes queue time",
    description: "Starts when the request runs, not in queue. Running timers are unchanged." },
  12: { field: "maxDraftChars", label: "Draft character limit", min: 1, max: 100000, unit: "characters", scale: 1,
    presets: [8000, 16000, 32000, 64000, 100000], shortLabel: "Draft", shortUnit: " chars", summary: "Drafts and revision instructions",
    description: "Oversized drafts and revision instructions are rejected, not truncated. Existing work is kept." },
};

export function numberSettingValue(settings: ContextSettings, field: NumberSetting): number {
  return settings[field] ?? (field === "maxMessages" ? DEFAULT_CONFIG.context.maxMessages
    : field === "historyMaxChars" ? DEFAULT_CONFIG.context.maxChars : DEFAULT_CONFIG[field]);
}

export function settingsDirty(selected: ContextSettings, original: ContextSettings): boolean {
  return (Object.keys({ ...selected, ...original }) as (keyof ContextSettings)[]).some((key) => selected[key] !== original[key]);
}
