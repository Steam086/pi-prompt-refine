import { constants } from "node:fs";
import { mkdir, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { metadataValidation, preferenceValidation, preferenceKey, selectPreference, uniquePreferences, type SelectedPreference, type PreferenceLibrary, type PreferenceMetadata, type PreferenceRepository, type PreferenceScope, type PreferenceValue, type RevisionPreference } from "./revision-preferences.js";
import { ProjectPreferenceDefaults } from "./project-preference-defaults.js";

export const PREFERENCE_MAX_BYTES = 1024 * 1024;
export const PREFERENCE_MAX_ENTRIES = 500;
const scopes: PreferenceScope[] = ["project", "global"];
const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException)?.code;
const message = (error: unknown): string => error instanceof Error ? error.message : "Unknown storage error";
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function decode(content: string, scope: PreferenceScope): RevisionPreference[] {
  const data: unknown = JSON.parse(content);
  if (!object(data) || (data.version !== 1 && data.version !== 2) || !Array.isArray(data.entries) || data.entries.length > PREFERENCE_MAX_ENTRIES) {
    throw new Error("Invalid or unsupported preference library; original file kept.");
  }
  const ids = new Set<string>();
  return data.entries.map((entry: unknown) => {
    if (!object(entry) || typeof entry.id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(entry.id) || ids.has(entry.id) ||
      !Number.isSafeInteger(entry.version) || (entry.version as number) < 1 || typeof entry.name !== "string" || typeof entry.body !== "string" ||
      preferenceValidation({ name: entry.name, body: entry.body }) ||
      entry.metadata !== undefined && metadataValidation(entry.metadata, true)) throw new Error("Invalid preference entry; original file kept.");
    ids.add(entry.id);
    const metadata = entry.metadata as PreferenceMetadata | undefined;
    // Read old auto/match fields for compatibility, but never expose or execute them.
    // Loading does not rewrite the file; the next explicit mutation writes manual metadata.
    return { id: entry.id, version: entry.version as number, scope, name: entry.name, body: entry.body,
      ...(metadata ? { metadata: { description: metadata.description, kind: metadata.kind, activation: "manual" as const } } : {}) };
  });
}

/** Libraries are independent of sessions. All cooperating writers lock and re-read. */
export class PreferenceStore implements PreferenceRepository {
  private projectRoot?: Promise<string>;
  private defaultPreferences: SelectedPreference[] = [];
  constructor(private readonly agentDir: string, private readonly cwd: string) {}

  private async path(scope: PreferenceScope): Promise<string> {
    const root = scope === "project" ? join(await (this.projectRoot ??= realpath(this.cwd)), ".pi") : resolve(this.agentDir);
    return join(root, "prompt-refine-preferences.json");
  }

  private async read(path: string, scope: PreferenceScope): Promise<RevisionPreference[]> {
    let file;
    try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (code(error) === "ENOENT") return []; throw error; }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > PREFERENCE_MAX_BYTES) throw new Error("Preference library is not a regular file or exceeds 1 MiB.");
      const buffer = Buffer.alloc(PREFERENCE_MAX_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > PREFERENCE_MAX_BYTES) throw new Error("Preference library exceeds 1 MiB.");
      return decode(buffer.toString("utf8", 0, size), scope);
    } finally { await file.close(); }
  }

  async load(): Promise<PreferenceLibrary> {
    const result: PreferenceLibrary = { entries: [], errors: {} };
    for (const scope of scopes) {
      try { result.entries.push(...await this.read(await this.path(scope), scope)); }
      catch (error) { result.errors[scope] = `${scope}: ${message(error)}`; }
    }
    try {
      const keys = await new ProjectPreferenceDefaults(this.cwd).load();
      if (keys.length) result.projectDefaults = keys;
      const missing = keys.filter((key) => !result.entries.some((entry) => preferenceKey(entry) === key));
      if (missing.length) result.errors.defaults = `${missing.length} project default(s) unavailable or deleted; skipped. Disable unavailable defaults with g in Preferences.`;
      this.defaultPreferences = uniquePreferences(keys.flatMap((key) => {
        const entry = result.entries.find((item) => preferenceKey(item) === key);
        return entry ? [{ ...selectPreference(entry), selectionSource: "project-default" as const }] : [];
      }));
    } catch (error) {
      result.errors.defaults = `Project defaults: ${message(error)}`;
      this.defaultPreferences = [];
    }
    return result;
  }

  /** Loaded on session start and library refresh; callers receive detached snapshots. */
  getDefaultPreferences(): SelectedPreference[] { return structuredClone(this.defaultPreferences); }

  async setProjectDefault(entry: RevisionPreference, enabled: boolean): Promise<PreferenceLibrary> {
    const key = preferenceKey(entry);
    if (enabled) {
      const library = await this.load();
      if (!library.entries.some((source) => preferenceKey(source) === key)) throw new Error("Library entry unavailable or deleted; default not enabled.");
    }
    await new ProjectPreferenceDefaults(this.cwd).set(key, enabled);
    return this.load();
  }

  private async mutate<T>(scope: PreferenceScope, change: (entries: RevisionPreference[]) => T): Promise<T> {
    const path = await this.path(scope);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const lockPath = `${path}.lock`;
    let lock;
    try { lock = await open(lockPath, "wx", 0o600); }
    catch (error) {
      if (code(error) === "EEXIST") throw new Error(`Library busy. Retry; if a writer crashed, remove ${lockPath} only after confirming no writer is active.`);
      throw error;
    }
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      const entries = await this.read(path, scope);
      const result = change(entries);
      if (entries.length > PREFERENCE_MAX_ENTRIES) throw new Error(`Library limit: ${PREFERENCE_MAX_ENTRIES} entries.`);
      const content = JSON.stringify({ version: entries.some((entry) => entry.metadata) ? 2 : 1,
        entries: entries.map(({ scope: _, ...entry }) => entry) }, null, 2) + "\n";
      if (Buffer.byteLength(content) > PREFERENCE_MAX_BYTES) throw new Error("Preference library exceeds 1 MiB.");
      await writeFile(temp, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temp, path);
      return result;
    } finally {
      await rm(temp, { force: true }).catch(() => undefined);
      await lock.close();
      await rm(lockPath, { force: true });
    }
  }

  private current(entries: RevisionPreference[], expected: RevisionPreference): number {
    const index = entries.findIndex((entry) => entry.id === expected.id);
    const entry = entries[index];
    if (!entry || entry.version !== expected.version || entry.name !== expected.name || entry.body !== expected.body ||
      entry.metadata?.kind !== expected.metadata?.kind || entry.metadata?.description !== expected.metadata?.description ||
      entry.metadata?.activation !== expected.metadata?.activation) {
      throw new Error("Library entry changed or was deleted. Cancel this form, refresh, and edit again; your text is still here.");
    }
    return index;
  }

  async save(scope: PreferenceScope, value: PreferenceValue, expected?: RevisionPreference): Promise<RevisionPreference> {
    // Freeze before awaiting IO: callers cannot change the pending operation.
    value = structuredClone(value); expected = expected && structuredClone(expected);
    if (value.metadata === undefined && expected?.metadata) value.metadata = structuredClone(expected.metadata);
    const error = preferenceValidation(value);
    if (error) throw new Error(error);
    if (expected && expected.scope !== scope) throw new Error("Use Add and copy the text into a new entry in the other scope; Edit keeps the source scope.");
    return this.mutate(scope, (entries) => {
      const index = expected ? this.current(entries, expected) : entries.length;
      if (expected?.version === Number.MAX_SAFE_INTEGER) throw new Error("Use Add and copy the text into a new entry; this entry's version limit was reached.");
      const entry = { ...value, scope, id: expected?.id ?? randomUUID(), version: (expected?.version ?? 0) + 1 };
      entries[index] = entry;
      return { ...entry };
    });
  }

  async remove(expected: RevisionPreference): Promise<void> {
    // Match save(): nested metadata is part of the call-time conflict expectation.
    expected = structuredClone(expected);
    await this.mutate(expected.scope, (entries) => { entries.splice(this.current(entries, expected), 1); });
  }
}
