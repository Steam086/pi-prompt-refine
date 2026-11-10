import { constants } from "node:fs";
import { mkdir, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { PREFERENCE_SELECTION_LIMIT } from "./revision-preferences.js";

const MAX_BYTES = 16_384;
const code = (error: unknown) => (error as NodeJS.ErrnoException)?.code;

/** Directory-local activation is separate from either library's storage scope. */
export class ProjectPreferenceDefaults {
  constructor(private readonly cwd: string) {}

  private async path(): Promise<string> {
    return join(await realpath(this.cwd), ".pi", "prompt-refine-preference-defaults.json");
  }

  private async read(path: string): Promise<string[]> {
    let file;
    try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (code(error) === "ENOENT") return []; throw error; }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("Project defaults must be a regular file of at most 16 KiB.");
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > MAX_BYTES) throw new Error("Project defaults exceed 16 KiB.");
      const data: unknown = JSON.parse(buffer.toString("utf8", 0, size));
      if (!data || typeof data !== "object" || Array.isArray(data) || !("version" in data) || data.version !== 1 ||
        !("preferences" in data) || !Array.isArray(data.preferences) || data.preferences.length > PREFERENCE_SELECTION_LIMIT ||
        data.preferences.some((key: unknown) => typeof key !== "string" || !/^(project|global):[a-zA-Z0-9-]{1,80}$/.test(key)) ||
        new Set(data.preferences).size !== data.preferences.length) throw new Error("Invalid or unsupported project defaults; original file kept.");
      return data.preferences;
    } finally { await file.close(); }
  }

  async load(): Promise<string[]> { return this.read(await this.path()); }

  async set(key: string, enabled: boolean): Promise<void> {
    if (!/^(project|global):[a-zA-Z0-9-]{1,80}$/.test(key)) throw new Error("Invalid preference identity.");
    const path = await this.path();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const lockPath = `${path}.lock`;
    let lock;
    try { lock = await open(lockPath, "wx", 0o600); }
    catch (error) {
      if (code(error) === "EEXIST") throw new Error("Project defaults busy. Retry after the other writer finishes.");
      throw error;
    }
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      // Re-read under the lock so toggles in other sessions are retained.
      const keys = await this.read(path);
      const preferences = enabled ? keys.includes(key) ? keys : [...keys, key] : keys.filter((item) => item !== key);
      if (preferences.length > PREFERENCE_SELECTION_LIMIT) throw new Error(`Select at most ${PREFERENCE_SELECTION_LIMIT} project defaults.`);
      await writeFile(temp, JSON.stringify({ version: 1, preferences }, null, 2) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temp, path);
    } finally {
      await rm(temp, { force: true }).catch(() => undefined);
      await lock.close();
      await rm(lockPath, { force: true });
    }
  }
}
