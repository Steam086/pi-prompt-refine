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
  const quotes: Record<string, string> = { "“": "”", "「": "」", "『": "』", "‘": "’", "'": "'", '"': '"' };
  let quote: string | undefined;
  let ticks = 0;
  // Unclosed spans conservatively hide the rest. Scan once, including malformed input.
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    // Apostrophes inside words (don't / user's / don’t) are not quotation marks.
    const apostrophe = (character === "'" || character === "’") &&
      /[\p{L}\p{N}]/u.test(text[index - 1] ?? "") && /[\p{L}\p{N}]/u.test(text[index + 1] ?? "");
    if (quote) { if (character === quote && !apostrophe) quote = undefined; continue; }
    if (character === "`") {
      let end = index + 1;
      while (text[end] === "`") end++;
      const length = end - index;
      if (!ticks) { ticks = length; visible.push(" "); }
      else if (ticks === length) ticks = 0;
      index = end - 1;
    } else if (!ticks) {
      if (quotes[character] && !apostrophe) { quote = quotes[character]; visible.push(" "); }
      else visible.push(character);
    }
  }
  return visible.join("").replace(/https?:\/\/\S+/g, " ");
}
/** Local eligibility only, not a semantic verdict. Keep ambiguous prose out of step adoption. */
function structureCues(draft: string): { parallel: boolean; sequence: boolean } {
  const plain = matchingText(draft);
  // These constraints concern the draft's structure, not the main agent's answer format.
  const preserveStructure = /(?:保留|保持)(?:原有|原稿|原文|现有)?(?:的)?(?:结构|格式|自然段)|(?:不要|禁止|无需|不必|别)(?:将|把)?(?:原稿|原文|prompt)?(?:改成|改为|整理成|转换为|使用|添加)?(?:列表|条目|编号|步骤)|(?:不要|禁止|别)(?:改变|调整|修改)(?:原稿|原文|现有)?(?:的)?(?:结构|格式)|\b(?:preserve|keep) (?:the )?(?:(?:original|existing|draft) )?(?:structure|format|paragraphs)\b|\b(?:do not|don't|don’t|never) (?:restructure|reformat)\b/i.test(plain);
  if (preserveStructure) return { parallel: false, sequence: false };

  const negative = /(?:不要|别|无需|不必|禁止|不能|不应|不允许|并非|不是|\b(?:not|never|avoid|without)\b|\bdon['’]t\b)/i;
  // Clause-local negation: “无需联网，先检查再解释” must retain the positive request.
  const clauses = plain.split(/[，,。！？.!?;；\n]/).map((part) => part.trim());
  const request = /^(?:(?:请你|请|麻烦|我们需要|需要)\s*|(?:please|we should|you should)\s+)?/i;
  const starts = /^(?:首先|先(?!前|生|进|验|天)|first\b)\s*(\S.*)$/i;
  const continuation = /^(?:再|然后|其次|接着|then\b|next\b)\s*\S/i;
  const normalized = clauses.map((part) => part.replace(/^[-*+•]\s+/, "").replace(request, ""));
  let sequence = false;
  for (let index = 0; index < normalized.length; index++) {
    const part = normalized[index]!;
    if (negative.test(part)) continue;
    if (/^(?:按顺序|依次|按次序)\s*\S|^in (?:order|sequence)\b(?!\s+to\b)/i.test(part)) sequence = true;
    const start = starts.exec(part);
    if (!start) continue;
    // Require content between the markers, not a substring such as “优先”.
    if (/(?:再|然后|其次|接着|\bthen\b)\s*\S/i.test(start[1]!.slice(1))) sequence = true;
    const next = normalized[index + 1];
    if (next && !negative.test(next) && continuation.test(next)) sequence = true;
  }
  // Explicit step labels carry order; plain numbered lists do not.
  const stepLabels = normalized.filter((part) => !negative.test(part)).map((part) =>
    /^(?:第([一二三四五六七八九十\d]+)步|步骤([一二三四五六七八九十\d]+)|step\s+(\d+)\b)\s*[:：、.)]?\s*\S/i.exec(part))
    .filter((match) => match !== null).map((match) => match[1] ?? match[2] ?? match[3]);
  if (new Set(stepLabels).size >= 2) sequence = true;

  // Exclude numbered lines locally, rather than suppressing unrelated questions in the draft.
  const unnumbered = plain.split(/\r?\n/).filter((line) => !/^\s*\d+[.)、][ \t]*\S/.test(line)).join("\n");
  const questions = unnumbered.split(/[?？]+/).slice(0, -1).filter((part) =>
    /[\p{L}\p{N}]/u.test(part.split(/[。!！;；\n]/).at(-1) ?? "")).length;
  const bullets = unnumbered.match(/^[ \t]*[-*+•][ \t]+\S/gm)?.length ?? 0;
  // Unresolved ordering cues should not be reclassified as parallel merely due to punctuation.
  const possibleOrder = /(?:第一步|第二步|步骤[一二12]|然后|接着|随后|\b(?:then|next|after|before)\b)/i.test(plain);
  return { sequence, parallel: !possibleOrder && (questions >= 2 || bullets >= 2) };
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
