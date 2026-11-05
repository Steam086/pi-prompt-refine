import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { KeyId } from "@earendil-works/pi-tui";

export interface ModelRef {
  provider: string;
  id: string;
}

export type ShortcutAction = "optimize" | "view" | "dismiss" | "selectModel" | "cycleModel" | "restore";
export type ShortcutConfig = Record<ShortcutAction, KeyId | null>;

export interface ProjectContextConfig {
  enabled: boolean;
  maxChars: number;
  instructionsMaxChars: number;
  /** Include rules in Revise requests; new refinement tasks always start fresh. */
  instructionsOnFollowUp: boolean;
  instructionsEnabled: boolean;
  skillsEnabled: boolean;
  skillsMaxChars: number;
  /** Explicit @directory listings; shares tree limits, not tree.enabled. */
  referencedDirectories: { enabled: boolean; maxReferences: number };
  tree: {
    enabled: boolean;
    maxChars: number;
    maxDepth: number;
    maxEntriesPerDirectory: number;
    maxEntries: number;
    maxScannedEntries: number;
    timeoutMs: number;
    exclude: string[];
  };
}

export interface RefineConfig {
  version: 1;
  model?: ModelRef;
  /** Explicit optimizer override; omitted means inherit the active Pi session level. */
  thinkingLevel?: ModelThinkingLevel;
  /** Last confirmed thinking level per provider/model, including comparison-only models. */
  modelThinkingLevels: Record<string, ModelThinkingLevel>;
  /** Custom editing policy; the fixed refiner protocol is always added. */
  systemPrompt?: string;
  favorites: ModelRef[];
  shortcuts: ShortcutConfig;
  /** Local to Revise; null disables the key, leaving the result-page p entry. */
  preferencesKey: KeyId | null;
  timeoutMs: number;
  /** Save minimal per-session history; never full background or unsent input. */
  historyPersistence: boolean;
  context: {
    maxMessages: number;
    maxChars: number;
  };
  projectContext: ProjectContextConfig;
  maxDraftChars: number;
  maxOutputTokens: number;
}

export interface LoadedConfig {
  config: RefineConfig;
  warnings: string[];
  shortcutsMigrated?: boolean;
}

export const DEFAULT_SHORTCUTS: ShortcutConfig = {
  optimize: "ctrl+\\",
  view: null,
  dismiss: null,
  selectModel: null,
  cycleModel: null,
  restore: null,
};

export const DEFAULT_CONFIG: RefineConfig = {
  version: 1,
  modelThinkingLevels: {},
  favorites: [],
  shortcuts: { ...DEFAULT_SHORTCUTS },
  preferencesKey: "alt+p",
  timeoutMs: 60_000,
  historyPersistence: true,
  context: { maxMessages: 12, maxChars: 16_000 },
  projectContext: {
    enabled: true,
    maxChars: 28_000,
    instructionsMaxChars: 16_000,
    instructionsOnFollowUp: true,
    instructionsEnabled: false,
    skillsEnabled: false,
    skillsMaxChars: 6_000,
    referencedDirectories: { enabled: true, maxReferences: 8 },
    tree: {
      enabled: false, maxChars: 4_000, maxDepth: 2,
      maxEntriesPerDirectory: 20, maxEntries: 120,
      maxScannedEntries: 2_000, timeoutMs: 200,
      exclude: [".git", "node_modules", "dist", "build", "coverage", ".venv", "venv", "__pycache__", ".cache", ".next", ".nuxt", ".turbo", ".aws", ".codex"],
    },
  },
  maxDraftChars: 16_000,
  maxOutputTokens: 8_192,
};

const SHORTCUT_ACTIONS: ShortcutAction[] = ["optimize", "view", "dismiss", "selectModel", "cycleModel", "restore"];
const THINKING_LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);
const SPECIAL_KEYS = new Set([
  "escape", "esc", "enter", "return", "tab", "space", "backspace", "delete", "insert", "clear",
  "home", "end", "pageup", "pagedown", "up", "down", "left", "right",
]);
const SYMBOL_KEYS = new Set(["`", "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/", "!", "@", "#", "$", "%", "^", "&", "*", "(", ")", "_", "|", "~", "{", "}", ":", "<", ">", "?"]);
const KEY_ALIASES: Record<string, string> = { esc: "escape", return: "enter" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelRef(value: unknown): ModelRef | undefined {
  if (!isRecord(value) || typeof value.provider !== "string" || typeof value.id !== "string") return undefined;
  const provider = value.provider.trim();
  const id = value.id.trim();
  if (!provider || !id || provider.length > 128 || id.length > 256) return undefined;
  return { provider, id };
}

/** Returns a case-insensitive identity so alternate modifier orderings cannot duplicate a binding. */
export function canonicalShortcut(value: string): string | undefined {
  if (!value || value.trim() !== value) return undefined;
  let modifiers: string[];
  let key: string;

  if (value === "+") {
    modifiers = [];
    key = "+";
  } else if (value.endsWith("++")) {
    const prefix = value.slice(0, -2);
    modifiers = prefix ? prefix.split("+") : [];
    key = "+";
  } else {
    const parts = value.split("+");
    key = parts.pop() ?? "";
    modifiers = parts;
  }

  const lowerModifiers = modifiers.map((modifier) => modifier.toLowerCase());
  if (lowerModifiers.some((modifier) => !MODIFIERS.has(modifier))) return undefined;
  if (new Set(lowerModifiers).size !== lowerModifiers.length) return undefined;
  if (lowerModifiers.length !== modifiers.length) return undefined;

  const lowerKey = key.toLowerCase();
  const validKey = /^[a-z0-9]$/.test(lowerKey) || /^f(?:[1-9]|1[0-2])$/.test(lowerKey) || SPECIAL_KEYS.has(lowerKey) || SYMBOL_KEYS.has(key);
  if (!validKey) return undefined;
  return [...lowerModifiers].sort().concat(KEY_ALIASES[lowerKey] ?? lowerKey).join("+");
}

function isLegacyDefaultShortcuts(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).length !== SHORTCUT_ACTIONS.length) return false;
  const legacy = [
    ["f2", "f3", "f4", "f5", "f6", "f7"],
    ["alt+shift+r", "alt+shift+v", "alt+shift+x", "alt+shift+m", "alt+shift+c", "alt+shift+z"],
  ];
  return legacy.some((keys) => SHORTCUT_ACTIONS.every((action, index) => value[action] === keys[index]));
}

function validateShortcuts(value: unknown, warnings: string[]): ShortcutConfig {
  const shortcuts: ShortcutConfig = { ...DEFAULT_SHORTCUTS };
  if (value !== undefined && !isRecord(value)) {
    warnings.push("shortcuts must be an object; using the default shortcuts.");
    return shortcuts;
  }

  for (const action of SHORTCUT_ACTIONS) {
    const proposed = isRecord(value) ? value[action] : undefined;
    if (proposed === undefined) continue;
    if (proposed === null) {
      shortcuts[action] = null;
      continue;
    }
    if (typeof proposed !== "string" || !canonicalShortcut(proposed)) {
      warnings.push(`Shortcut ${action} is invalid; using the default value.`);
      continue;
    }
    if (/(^|\+)f\d+$/.test(canonicalShortcut(proposed)!)) {
      warnings.push(`Shortcut ${action} cannot use function keys; using the default value.`);
      continue;
    }
    shortcuts[action] = proposed as KeyId;
  }

  const owners = new Map<string, ShortcutAction>();
  for (const action of SHORTCUT_ACTIONS) {
    const key = shortcuts[action];
    const canonical = key === null ? undefined : canonicalShortcut(key);
    if (!canonical) continue;
    const previous = owners.get(canonical);
    if (previous) {
      warnings.push(`Shortcuts ${previous} and ${action} conflict; all shortcuts were reset to their defaults.`);
      return { ...DEFAULT_SHORTCUTS };
    }
    owners.set(canonical, action);
  }
  return shortcuts;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number, label: string, warnings: string[]): number {
  if (value === undefined) return fallback;
  if (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max) return value;
  warnings.push(`${label} is outside the valid range ${min}–${max}; using the default value ${fallback}.`);
  return fallback;
}

function booleanOption(value: unknown, fallback: boolean, label: string, warnings: string[]): boolean {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  warnings.push(`${label} must be a boolean; using the default value.`);
  return fallback;
}

function parseProjectContext(value: unknown, warnings: string[]): ProjectContextConfig {
  const config = structuredClone(DEFAULT_CONFIG.projectContext);
  if (value === undefined) return config;
  if (!isRecord(value)) { warnings.push("projectContext must be an object; using the default configuration."); return config; }
  config.enabled = booleanOption(value.enabled, config.enabled, "projectContext.enabled", warnings);
  for (const key of ["instructionsOnFollowUp", "instructionsEnabled", "skillsEnabled"] as const) {
    config[key] = booleanOption(value[key], config[key], `projectContext.${key}`, warnings);
  }
  for (const key of ["maxChars", "instructionsMaxChars", "skillsMaxChars"] as const) {
    config[key] = boundedInteger(value[key], config[key], 512, 100_000, `projectContext.${key}`, warnings);
  }
  if (value.referencedDirectories !== undefined && !isRecord(value.referencedDirectories)) {
    warnings.push("projectContext.referencedDirectories must be an object; using defaults.");
  }
  if (isRecord(value.referencedDirectories)) {
    const refs = value.referencedDirectories;
    config.referencedDirectories.enabled = booleanOption(refs.enabled, config.referencedDirectories.enabled, "projectContext.referencedDirectories.enabled", warnings);
    config.referencedDirectories.maxReferences = boundedInteger(refs.maxReferences, config.referencedDirectories.maxReferences, 1, 32, "projectContext.referencedDirectories.maxReferences", warnings);
  }
  if (value.tree !== undefined && !isRecord(value.tree)) warnings.push("projectContext.tree must be an object; using the default configuration.");
  if (isRecord(value.tree)) {
    const tree = value.tree;
    config.tree.enabled = booleanOption(tree.enabled, config.tree.enabled, "projectContext.tree.enabled", warnings);
    const bounds = { maxChars: [128, 20_000], maxDepth: [1, 6], maxEntriesPerDirectory: [1, 100], maxEntries: [1, 1_000], maxScannedEntries: [1, 20_000], timeoutMs: [10, 2_000] } as const;
    for (const key of Object.keys(bounds) as Array<keyof typeof bounds>) {
      config.tree[key] = boundedInteger(tree[key], config.tree[key], bounds[key][0], bounds[key][1], `projectContext.tree.${key}`, warnings);
    }
    if (tree.exclude !== undefined) {
      if (Array.isArray(tree.exclude) && tree.exclude.length <= 100 && tree.exclude.every((name) => typeof name === "string" && name.length > 0 && name.length <= 128 && !/[\/\\\x00-\x1f]/.test(name) && name !== "." && name !== "..")) {
        config.tree.exclude = [...new Set(tree.exclude as string[])];
      } else warnings.push("projectContext.tree.exclude must be an array of up to 100 directory or file names; using the default value.");
    }
  }
  return config;
}

export function parseConfig(value: unknown): LoadedConfig {
  const warnings: string[] = [];
  if (!isRecord(value) || value.version !== 1) {
    return { config: structuredClone(DEFAULT_CONFIG), warnings: ["Configuration structure is invalid or the version is unsupported; the original file was not overwritten. Using the default configuration."] };
  }

  const config = structuredClone(DEFAULT_CONFIG);
  config.projectContext = parseProjectContext(value.projectContext, warnings);
  config.historyPersistence = booleanOption(value.historyPersistence, config.historyPersistence, "historyPersistence", warnings);
  if (value.systemPrompt !== undefined) {
    if (typeof value.systemPrompt === "string" && value.systemPrompt.trim()) config.systemPrompt = value.systemPrompt;
    else warnings.push("systemPrompt must be a non-empty string; using the built-in prompt.");
  }
  if (value.model !== undefined) {
    const selected = modelRef(value.model);
    if (selected) config.model = selected;
    else warnings.push("model must include a non-empty provider and id; ignoring this value. No model will be selected or billed automatically when unset.");
  }
  if (value.thinkingLevel !== undefined) {
    if (typeof value.thinkingLevel === "string" && THINKING_LEVELS.includes(value.thinkingLevel as ModelThinkingLevel)) {
      config.thinkingLevel = value.thinkingLevel as ModelThinkingLevel;
    } else {
      warnings.push("thinkingLevel must be off, minimal, low, medium, high, xhigh, or max; inheriting the session level.");
    }
  }

  if (value.modelThinkingLevels !== undefined) {
    if (isRecord(value.modelThinkingLevels)) {
      for (const [key, level] of Object.entries(value.modelThinkingLevels)) {
        const separator = key.indexOf("/");
        const ref = modelRef({ provider: key.slice(0, separator), id: key.slice(separator + 1) });
        if (separator > 0 && ref && modelKey(ref) === key && typeof level === "string" && THINKING_LEVELS.includes(level as ModelThinkingLevel)) {
          config.modelThinkingLevels[key] = level as ModelThinkingLevel;
        } else warnings.push(`modelThinkingLevels contains an invalid entry: ${key}; ignoring it.`);
      }
    } else warnings.push("modelThinkingLevels must be an object; ignoring it.");
  }

  if (Array.isArray(value.favorites)) {
    const favoriteKeys = new Set<string>();
    config.favorites = value.favorites.flatMap((item) => {
      const favorite = modelRef(item);
      if (!favorite) {
        warnings.push("Favorites contain an invalid model entry; ignoring it.");
        return [];
      }
      const key = `${favorite.provider}/${favorite.id}`;
      if (favoriteKeys.has(key)) {
        warnings.push(`Favorite model ${key} is duplicated; keeping its first occurrence.`);
        return [];
      }
      favoriteKeys.add(key);
      return [favorite];
    }).slice(0, 100);
  } else if (value.favorites !== undefined) {
    warnings.push("favorites must be an array; using an empty favorites list.");
  }

  const shortcutsMigrated = isLegacyDefaultShortcuts(value.shortcuts);
  config.shortcuts = validateShortcuts(shortcutsMigrated ? undefined : value.shortcuts, warnings);
  if (value.preferencesKey === null) config.preferencesKey = null;
  else if (value.preferencesKey !== undefined) {
    const key = typeof value.preferencesKey === "string" ? canonicalShortcut(value.preferencesKey) : undefined;
    // Migrate the previous shipped default without making every existing
    // configuration invalid (warnings intentionally disable settings writes).
    if (key === "f2") config.preferencesKey = DEFAULT_CONFIG.preferencesKey;
    else if (key && !/(^|\+)f\d+$/.test(key) && (key.includes("ctrl+") || key.includes("alt+")) &&
      !["ctrl+s", "ctrl+e", "ctrl+c", "ctrl+\\", "tab", "shift+tab", "escape", "enter"].includes(key) &&
      !Object.values(config.shortcuts).some((shortcut) => shortcut && canonicalShortcut(shortcut) === key)) {
      config.preferencesKey = key as KeyId;
    } else warnings.push("preferencesKey must be a non-function modified key without a reserved Revise or extension conflict; using Alt+P.");
  }
  if (config.preferencesKey && Object.values(config.shortcuts).some((shortcut) => shortcut && canonicalShortcut(shortcut) === canonicalShortcut(config.preferencesKey!))) {
    config.preferencesKey = null;
    warnings.push("preferencesKey conflicts with an extension shortcut; disabled. Use p on result details.");
  }
  config.timeoutMs = boundedInteger(value.timeoutMs, DEFAULT_CONFIG.timeoutMs, 1_000, 300_000, "timeoutMs", warnings);
  config.maxDraftChars = boundedInteger(value.maxDraftChars, DEFAULT_CONFIG.maxDraftChars, 1, 100_000, "maxDraftChars", warnings);
  config.maxOutputTokens = boundedInteger(value.maxOutputTokens, DEFAULT_CONFIG.maxOutputTokens, 16, 65_536, "maxOutputTokens", warnings);

  if (value.context !== undefined && !isRecord(value.context)) {
    warnings.push("context must be an object; using the default context budget.");
  } else if (isRecord(value.context)) {
    config.context.maxMessages = boundedInteger(value.context.maxMessages, DEFAULT_CONFIG.context.maxMessages, 0, 50, "context.maxMessages", warnings);
    config.context.maxChars = boundedInteger(value.context.maxChars, DEFAULT_CONFIG.context.maxChars, 0, 100_000, "context.maxChars", warnings);
  }

  return { config, warnings, ...(shortcutsMigrated ? { shortcutsMigrated: true } : {}) };
}

export async function loadConfig(filePath: string): Promise<LoadedConfig> {
  try {
    const content = await readFile(filePath, "utf8");
    try {
      return parseConfig(JSON.parse(content) as unknown);
    } catch {
      return { config: structuredClone(DEFAULT_CONFIG), warnings: ["Configuration is not valid JSON; the original file was not overwritten. Using the default configuration."] };
    }
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return { config: structuredClone(DEFAULT_CONFIG), warnings: [] };
    }
    return { config: structuredClone(DEFAULT_CONFIG), warnings: ["Failed to read configuration; using the default configuration."] };
  }
}

export function configPath(agentDir: string): string {
  return join(agentDir, "prompt-refine.json");
}

export async function saveConfig(filePath: string, config: RefineConfig): Promise<void> {
  const dir = dirname(filePath);
  const tempPath = join(dir, `.prompt-refine.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function modelKey(model: ModelRef): string {
  return `${model.provider}/${model.id}`;
}
