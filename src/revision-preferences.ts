export type PreferenceScope = "project" | "global";
export interface PreferenceMetadata {
  description: string;
  kind: "rewrite" | "task";
  activation: "manual";
}
export interface PreferenceValue {
  name: string;
  body: string;
  metadata?: PreferenceMetadata;
}
export interface RevisionPreference {
  id: string;
  version: number;
  scope: PreferenceScope;
  name: string;
  body: string;
  metadata?: PreferenceMetadata;
}
export interface SelectedPreference extends RevisionPreference {
  /** Immutable source body, for detecting edits local to this revision. */
  sourceBody: string;
  selectionSource?: "project-default";
}
export interface RevisionDraft {
  freeText: string;
  selected: SelectedPreference[];
}
export interface PreferenceLibrary {
  entries: RevisionPreference[];
  errors: Partial<Record<PreferenceScope | "defaults", string>>;
  projectDefaults?: string[];
}
export interface PreferenceRepository {
  load(): Promise<PreferenceLibrary>;
  save(scope: PreferenceScope, value: PreferenceValue, expected?: RevisionPreference): Promise<RevisionPreference>;
  remove(expected: RevisionPreference): Promise<void>;
  setProjectDefault?(entry: RevisionPreference, enabled: boolean): Promise<PreferenceLibrary>;
}
export const PREFERENCE_NAME_LIMIT = 120;
export const PREFERENCE_BODY_LIMIT = 16_000;
export const PREFERENCE_SELECTION_LIMIT = 50;

export function preferenceKey(entry: Pick<RevisionPreference, "id" | "scope">): string {
  return `${entry.scope}:${entry.id}`;
}
export function preferenceContentKey(entry: Pick<RevisionPreference, "body" | "metadata">): string {
  return JSON.stringify([entry.metadata?.kind, entry.body]);
}
export function selectPreference(entry: RevisionPreference): SelectedPreference {
  return { ...structuredClone(entry), sourceBody: entry.body };
}
export function preferenceSelectionLabel(entry: SelectedPreference): string {
  return entry.selectionSource === "project-default" ? "Project default" : "Manually selected";
}
/** Deduplicate literal content, not names, retaining the user's selection order. */
export function uniquePreferences(selected: readonly SelectedPreference[]): SelectedPreference[] {
  const result: SelectedPreference[] = [];
  const seen = new Set<string>();
  for (const entry of selected) {
    const key = preferenceContentKey(entry);
    if (!seen.has(key)) { seen.add(key); result.push(entry); }
  }
  return result;
}
/** Preserve bodies literally, with explicit purpose and provenance boundaries. */
export function composeRevision(selected: readonly SelectedPreference[], freeText: string): string {
  const entries = uniquePreferences(selected);
  const blocks = entries.map((entry) => {
    const purpose = !entry.metadata ? "Saved editing requirements"
      : entry.metadata.kind === "rewrite" ? "Prompt rewriting instructions" : "Main-agent task requirements";
    return `${purpose} (${preferenceSelectionLabel(entry).toLowerCase()}):\n${entry.body}`;
  });
  if (freeText.trim()) blocks.push(entries.length ? `Current user instructions:\n${freeText}` : freeText);
  return blocks.join("\n\n");
}
/** Only the storage reader accepts legacy adoption fields, before normalizing to manual. */
export function metadataValidation(value: unknown, legacy = false): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Metadata must be a JSON object.";
  const data = value as Record<string, unknown>;
  if (typeof data.description !== "string" || !data.description.trim() || data.description.length > 2000) return "Description must contain 1–2000 characters.";
  if (data.kind !== "rewrite" && data.kind !== "task") return "Preference type must be rewrite or task.";
  if (data.activation !== "manual" && !(legacy && data.activation === "auto")) return "Preferences must be selected manually.";
  if (legacy) {
    if (data.match !== undefined && !["always", "parallel", "sequence"].includes(data.match as string)) return "Unknown legacy adoption condition.";
    if (data.activation === "auto" && (data.kind !== "rewrite" || data.match === undefined)) return "Invalid legacy automatic preference.";
  }
  if (Object.keys(data).some((key) => !["description", "kind", "activation", ...(legacy ? ["match"] : [])].includes(key))) return "Unknown preference metadata field.";
  return undefined;
}
export function preferenceValidation(value: PreferenceValue): string | undefined {
  if (!value.name.trim() || value.name.length > PREFERENCE_NAME_LIMIT) return `Name must contain 1–${PREFERENCE_NAME_LIMIT} characters.`;
  if (!value.body.trim() || value.body.length > PREFERENCE_BODY_LIMIT) return `Instruction must contain 1–${PREFERENCE_BODY_LIMIT} characters.`;
  return value.metadata === undefined ? undefined : metadataValidation(value.metadata);
}
export function searchPreferences(entries: readonly RevisionPreference[], query: string): RevisionPreference[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...entries];
  const tokens = needle.split(/\s+/u);
  return entries.map((entry, index) => {
    const name = entry.name.toLowerCase();
    const description = entry.metadata?.description.toLowerCase() ?? "";
    const body = entry.body.toLowerCase();
    const matches = tokens.every((token) => [name, description, body].some((field) => field.includes(token)));
    const rank = name === needle ? 0 : name.includes(needle) || tokens.every((token) => name.includes(token)) ? 1
      : tokens.every((token) => name.includes(token) || description.includes(token)) ? 2 : 3;
    return { entry, index, matches, rank };
  }).filter((item) => item.matches).sort((a, b) => a.rank - b.rank || a.index - b.index).map((item) => item.entry);
}
