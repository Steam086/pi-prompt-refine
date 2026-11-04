export type PreferenceScope = "project" | "global";
export interface RevisionPreference {
  id: string;
  version: number;
  scope: PreferenceScope;
  name: string;
  body: string;
}
export interface SelectedPreference extends RevisionPreference {
  /** Immutable source body, for detecting edits local to this revision. */
  sourceBody: string;
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
  save(scope: PreferenceScope, value: { name: string; body: string }, expected?: RevisionPreference): Promise<RevisionPreference>;
  remove(expected: RevisionPreference): Promise<void>;
}
export const PREFERENCE_NAME_LIMIT = 120;
export const PREFERENCE_BODY_LIMIT = 16_000;
export const PREFERENCE_SELECTION_LIMIT = 50;

export function preferenceKey(entry: Pick<RevisionPreference, "id" | "scope">): string {
  return `${entry.scope}:${entry.id}`;
}
export function selectPreference(entry: RevisionPreference): SelectedPreference {
  return { ...entry, sourceBody: entry.body };
}
/** Preserve every nonblank body literally. Both previews and submission use this. */
export function composeRevision(selected: readonly SelectedPreference[], freeText: string): string {
  return [...selected.map((entry) => entry.body), freeText].filter((text) => text.trim()).join("\n\n");
}
export function preferenceValidation(value: { name: string; body: string }): string | undefined {
  if (!value.name.trim() || value.name.length > PREFERENCE_NAME_LIMIT) return `Name must contain 1–${PREFERENCE_NAME_LIMIT} characters.`;
  if (!value.body.trim() || value.body.length > PREFERENCE_BODY_LIMIT) return `Instruction must contain 1–${PREFERENCE_BODY_LIMIT} characters.`;
  return undefined;
}
export function searchPreferences(entries: readonly RevisionPreference[], query: string): RevisionPreference[] {
  const needle = query.trim().toLocaleLowerCase();
  const rank = (entry: RevisionPreference) => entry.name.toLocaleLowerCase().includes(needle) ? 0 : 1;
  return entries.filter((entry) => !needle || rank(entry) === 0 || entry.body.toLocaleLowerCase().includes(needle))
    .sort((a, b) => rank(a) - rank(b));
}
