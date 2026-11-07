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
/** Deduplicate literal content, not names. Explicit selection wins over an automatic default. */
export function uniquePreferences(selected: readonly SelectedPreference[]): SelectedPreference[] {
  const result: SelectedPreference[] = [];
  const positions = new Map<string, number>();
  for (const entry of selected) {
    const key = preferenceContentKey(entry);
    const index = positions.get(key);
    if (index === undefined) { positions.set(key, result.length); result.push(entry); }
    else if (result[index]!.adoption === "auto" && entry.adoption !== "auto") result[index] = entry;
  }
  return result;
}
/** Preserve bodies literally, with explicit purpose and provenance boundaries. */
export function composeRevision(selected: readonly SelectedPreference[], freeText: string): string {
  const entries = uniquePreferences(selected);
  const blocks = entries.map((entry) => {
    const purpose = !entry.metadata ? "Saved editing requirements"
      : entry.metadata.kind === "rewrite" ? "Prompt rewriting instructions" : "Main-agent task requirements";
    const source = entry.adoption === "auto" ? "automatic default" : "manually selected";
    return `${purpose} (${source}):\n${entry.body}`;
  });
  if (freeText.trim()) blocks.push(entries.length ? `Current user instructions:\n${freeText}` : freeText);
  return blocks.join("\n\n");
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
/** Ignore quoted examples and code, without treating them as adoption instructions. */
function matchingText(draft: string): string {
  let fence: { character: string; length: number } | undefined;
  const lines: string[] = [];
  for (const line of draft.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence.character && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined;
      lines.push("");
    } else if (marker) {
      fence = { character: marker[1]![0]!, length: marker[1]!.length };
      lines.push("");
    } else lines.push(/^(?: {0,3}>| {4}|\t)/.test(line) ? "" : line);
  }
  const text = lines.join("\n");
  const visible: string[] = [];
  const quotes: Record<string, string> = { "“": "”", "「": "」", "『": "』", '"': '"' };
  let quote: string | undefined;
  let ticks = 0;
  // Unclosed spans conservatively hide the rest. Scan once, including malformed input.
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (quote) { if (character === quote) quote = undefined; continue; }
    if (character === "`") {
      let end = index + 1;
      while (text[end] === "`") end++;
      const length = end - index;
      if (!ticks) { ticks = length; visible.push(" "); }
      else if (ticks === length) ticks = 0;
      index = end - 1;
    } else if (!ticks) {
      if (quotes[character]) { quote = quotes[character]; visible.push(" "); }
      else visible.push(character);
    }
  }
  return visible.join("").replace(/https?:\/\/\S+/g, " ");
}
/** Conservative cues only: numbered lists alone do not establish either parallelism or sequence. */
function structureCues(draft: string): { parallel: boolean; sequence: boolean } {
  const plain = matchingText(draft);
  const positive = plain.split(/[。！？.!?;；\n]/).filter((part) =>
    !/(?:不要|别|无需|不必|禁止|不能|不应|不允许|并非|不是|\b(?:not|never|avoid|without)\b|\bdon['’]t\b)/i.test(part));
  const follows = (part: string, start: RegExp, end: RegExp): boolean => {
    const match = start.exec(part);
    return !!match && end.test(part.slice(match.index + match[0].length + 1));
  };
  const sequence = positive.some((part) => /(?:按顺序|依次|按次序|\bin (?:order|sequence)\b)/i.test(part) ||
    follows(part, /先/, /再|然后/) || follows(part, /首先/, /其次|接着/) || follows(part, /\bfirst\b/i, /\bthen\b/i));
  // Repeated punctuation is one question; require actual text between question groups.
  // Splitting keeps long unpunctuated drafts linear rather than backtracking over every suffix.
  const questions = plain.split(/[?？]+/).slice(0, -1).filter((part) =>
    /[\p{L}\p{N}]/u.test(part.split(/[。!！;；\n]/).at(-1) ?? "")).length;
  const numbered = /^\s*\d+[.)、][ \t]*\S/m.test(plain);
  const bullets = plain.match(/^[ \t]*[-*+][ \t]+\S/gm)?.length ?? 0;
  return { sequence, parallel: !numbered && (questions >= 2 || bullets >= 2) };
}
/** Only rewrite preferences can be adopted implicitly. Project entries precede global duplicates. */
export function automaticPreferences(entries: readonly RevisionPreference[], draft: string): SelectedPreference[] {
  if (!draft.trim()) return [];
  const { parallel, sequence } = structureCues(draft);
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
