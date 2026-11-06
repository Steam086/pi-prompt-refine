export type PreferenceScope = "project" | "global";
export interface PreferenceMetadata {
  description: string;
  kind: "rewrite" | "task";
  activation: "manual" | "auto";
  /** Automatic adoption uses bounded local rules, never description-based guessing. */
  match?: "always" | "parallel" | "sequence";
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
  adoption?: "auto";
}
export interface RevisionDraft {
  freeText: string;
  selected: SelectedPreference[];
}
export interface PreferenceLibrary {
  entries: RevisionPreference[];
  errors: Partial<Record<PreferenceScope, string>>;
}
export interface PreferenceRepository {
  load(): Promise<PreferenceLibrary>;
  save(scope: PreferenceScope, value: PreferenceValue, expected?: RevisionPreference): Promise<RevisionPreference>;
  remove(expected: RevisionPreference): Promise<void>;
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
/** Preserve bodies literally; typed boundaries distinguish editor and main-agent requirements. */
export function composeRevision(selected: readonly SelectedPreference[], freeText: string): string {
  return [...selected.map((entry) => entry.metadata
    ? `${entry.metadata.kind === "rewrite" ? "Prompt rewriting instructions" : "Main-agent task requirements"}:\n${entry.body}`
    : entry.body), freeText].filter((text) => text.trim()).join("\n\n");
}
export function metadataValidation(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Metadata must be a JSON object.";
  const data = value as Record<string, unknown>;
  if (typeof data.description !== "string" || !data.description.trim() || data.description.length > 2000) return "Description must contain 1–2000 characters.";
  if (data.kind !== "rewrite" && data.kind !== "task") return "Preference type must be rewrite or task.";
  if (data.activation !== "manual" && data.activation !== "auto") return "Adoption must be manual or auto.";
  if (data.match !== undefined && !["always", "parallel", "sequence"].includes(data.match as string)) return "Unknown automatic adoption condition.";
  if (data.activation === "auto" && (data.kind !== "rewrite" || data.match === undefined)) return "Automatic adoption requires a rewrite preference and an explicit condition.";
  if (Object.keys(data).some((key) => !["description", "kind", "activation", "match"].includes(key))) return "Unknown preference metadata field.";
  return undefined;
}
export function preferenceValidation(value: PreferenceValue): string | undefined {
  if (!value.name.trim() || value.name.length > PREFERENCE_NAME_LIMIT) return `Name must contain 1–${PREFERENCE_NAME_LIMIT} characters.`;
  if (!value.body.trim() || value.body.length > PREFERENCE_BODY_LIMIT) return `Instruction must contain 1–${PREFERENCE_BODY_LIMIT} characters.`;
  return value.metadata === undefined ? undefined : metadataValidation(value.metadata);
}
/** Only rewrite preferences can be adopted implicitly. Project entries precede global duplicates. */
export function automaticPreferences(entries: readonly RevisionPreference[], draft: string): SelectedPreference[] {
  if (!draft.trim()) return [];
  const plain = draft.replace(/```[^\n]*\n[\s\S]*?(?:```|$)/g, "");
  const parallel = (plain.match(/[?？]/g)?.length ?? 0) >= 2 || (plain.match(/^\s*(?:[-*+] |\d+[.)、]\s*)\S/gm)?.length ?? 0) >= 2;
  const sequence = /(?:先[\s\S]{1,160}(?:再|然后)|首先[\s\S]{1,160}(?:其次|接着)|\bfirst\b[\s\S]{1,160}\bthen\b)/i.test(plain);
  const seen = new Set<string>();
  return [...entries].sort((a, b) => Number(b.scope === "project") - Number(a.scope === "project")).flatMap((entry) => {
    const meta = entry.metadata;
    if (!meta || metadataValidation(meta) || meta.activation !== "auto" || meta.kind !== "rewrite" ||
      !(meta.match === "always" || meta.match === "parallel" && parallel && !sequence || meta.match === "sequence" && sequence)) return [];
    const key = preferenceContentKey(entry);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ ...selectPreference(entry), adoption: "auto" as const }];
  });
}
export function searchPreferences(entries: readonly RevisionPreference[], query: string): RevisionPreference[] {
  const needle = query.trim().toLocaleLowerCase();
  const rank = (entry: RevisionPreference) => entry.name.toLocaleLowerCase().includes(needle) ? 0 : 1;
  return entries.filter((entry) => !needle || rank(entry) === 0 || entry.body.toLocaleLowerCase().includes(needle) || entry.metadata?.description.toLocaleLowerCase().includes(needle))
    .sort((a, b) => rank(a) - rank(b));
}
