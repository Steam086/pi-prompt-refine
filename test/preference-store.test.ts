import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PreferenceStore, PREFERENCE_MAX_BYTES } from "../src/preference-store.js";
import { composeRevision, searchPreferences, selectPreference } from "../src/revision-preferences.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "refine-preferences-")); dirs.push(dir);
  const agent = join(dir, "agent"); const cwd = join(dir, "project");
  await mkdir(cwd); await mkdir(agent);
  return { dir, cwd, agent, global: join(agent, "prompt-refine-preferences.json"), project: join(cwd, ".pi", "prompt-refine-preferences.json"),
    store: new PreferenceStore(agent, cwd) };
}

describe("revision preference snapshots", () => {
  it("preserves literal bodies/order and composes selected-only or free-only requests", () => {
    const entry = { id: "a", version: 1, scope: "project" as const, name: "Not sent", body: "  Keep\t中文\n" };
    const selected = selectPreference(entry);
    entry.body = "changed later";
    expect(composeRevision([selected], "\nFree text\n")).toBe("  Keep\t中文\n\n\n\nFree text\n");
    expect(composeRevision([selected], " \n")).toBe("  Keep\t中文\n");
    expect(composeRevision([], "Free")).toBe("Free");
    expect(composeRevision([], " \n")).toBe("");
    selected.body = "Temporary";
    expect(selected.sourceBody).toBe("  Keep\t中文\n");
    expect(entry.body).toBe("changed later");
  });
  it("searches body but ranks names first without mutating the library", () => {
    const entries = ["other", "中文 name", "last"].map((name, i) => ({ id: `${i}`, name, body: "中文", version: 1, scope: "global" as const }));
    expect(searchPreferences(entries, "中文").map((entry) => entry.id)).toEqual(["1", "0", "2"]);
    expect(entries.map((entry) => entry.id)).toEqual(["0", "1", "2"]);
  });
});

describe("preference persistence", () => {
  it("isolates cwd libraries, shares global entries, and resolves cwd symlinks", async () => {
    const f = await setup();
    expect(await f.store.load()).toEqual({ entries: [], errors: {} });
    const project = await f.store.save("project", { name: "Same", body: "Project" });
    const global = await f.store.save("global", { name: "Same", body: "Global" });
    const alias = join(f.dir, "alias"); await symlink(f.cwd, alias);
    expect((await new PreferenceStore(f.agent, alias).load()).entries).toEqual([project, global]);
    const other = join(f.dir, "other"); await mkdir(other);
    expect((await new PreferenceStore(f.agent, other).load()).entries).toEqual([global]);
    expect((await stat(f.global)).mode & 0o777).toBe(0o600);
  });
  it("rejects stale edits/deletes and leaves selected snapshots unchanged", async () => {
    const f = await setup(); const peer = new PreferenceStore(f.agent, f.cwd);
    const original = await f.store.save("global", { name: "A", body: "Original" });
    const selected = selectPreference(original);
    const changed = await peer.save("global", { name: "B", body: "Changed" }, original);
    expect(changed.version).toBe(2);
    await expect(f.store.save("global", { name: "A", body: "Lost update" }, original)).rejects.toThrow("changed or was deleted");
    await expect(f.store.remove(original)).rejects.toThrow("changed or was deleted");
    expect((await f.store.load()).entries).toEqual([changed]);
    await peer.remove(changed);
    expect(selected.body).toBe("Original");
    expect((await f.store.load()).entries).toEqual([]);
  });
  it("serializes competing writers without losing either creation on retry", async () => {
    const f = await setup(); const peer = new PreferenceStore(f.agent, f.cwd);
    const values = [{ name: "One", body: "First" }, { name: "Two", body: "Second" }];
    const attempts = await Promise.allSettled([f.store.save("global", values[0]!), peer.save("global", values[1]!)]);
    for (let i = 0; i < attempts.length; i++) {
      const result = attempts[i]!;
      if (result.status === "rejected") {
        expect(result.reason.message).toContain("Library busy");
        await peer.save("global", values[i]!);
      }
    }
    expect((await f.store.load()).entries.map((entry) => entry.name).sort()).toEqual(["One", "Two"]);
  });
  it("never overwrites corrupt, unsupported, oversized or symlinked libraries", async () => {
    const f = await setup();
    for (const content of ["broken", '{"version":2,"entries":[]}', " ".repeat(PREFERENCE_MAX_BYTES + 1),
      JSON.stringify({ version: 1, entries: [{ id: "x", version: 0, name: "Bad", body: "Bad" }] })]) {
      await writeFile(f.global, content);
      const library = await f.store.load();
      expect(library.errors.global).toBeTruthy(); expect(library.errors.project).toBeUndefined();
      await expect(f.store.save("global", { name: "No", body: "Overwrite" })).rejects.toThrow();
      expect(await readFile(f.global, "utf8")).toBe(content);
    }
    const target = join(f.agent, "target.json"); await writeFile(target, '{"version":1,"entries":[]}');
    await rm(f.global); await symlink(target, f.global);
    await expect(f.store.save("global", { name: "No", body: "Overwrite" })).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe('{"version":1,"entries":[]}');
  });
  it("retains an occupied lock and makes failed validation/IO recoverable", async () => {
    const f = await setup();
    await writeFile(`${f.global}.lock`, "existing writer");
    await expect(f.store.save("global", { name: "A", body: "B" })).rejects.toThrow("Library busy");
    expect(await readFile(`${f.global}.lock`, "utf8")).toBe("existing writer");
    await rm(`${f.global}.lock`);
    await expect(f.store.save("global", { name: "A", body: " " })).rejects.toThrow("Instruction");
    const saved = await f.store.save("global", { name: "A", body: "B" });
    await expect(f.store.save("project", { name: "A", body: "B" }, saved)).rejects.toThrow("Save as");
    expect((await f.store.load()).entries).toEqual([saved]);
  });
});
