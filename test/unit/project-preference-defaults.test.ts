import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PreferenceStore } from "../../src/preference-store.js";
import { ProjectPreferenceDefaults } from "../../src/project-preference-defaults.js";
import { composeRevision, preferenceKey, selectPreference } from "../../src/revision-preferences.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "refine-defaults-")); dirs.push(dir);
  const agent = join(dir, "agent"), cwd = join(dir, "project");
  await mkdir(agent); await mkdir(cwd); await mkdir(join(cwd, ".pi"));
  return { dir, agent, cwd, path: join(cwd, ".pi", "prompt-refine-preference-defaults.json"), store: new PreferenceStore(agent, cwd) };
}

describe("project preference defaults", () => {
  it("persists ordered references to both scopes per real cwd without changing libraries or selected snapshots", async () => {
    const f = await setup();
    const a = await f.store.save("global", { name: "Shared", body: "Keep literals." });
    const b = await f.store.save("project", { name: "Local", body: "Keep task scope." });
    const selected = [selectPreference(a)];
    const libraryBefore = await readFile(join(f.agent, "prompt-refine-preferences.json"), "utf8");
    await f.store.setProjectDefault(b, true); await f.store.setProjectDefault(a, true);
    expect(selected).toEqual([selectPreference(a)]);
    expect(await readFile(join(f.agent, "prompt-refine-preferences.json"), "utf8")).toBe(libraryBefore);
    expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({ version: 1, preferences: [preferenceKey(b), preferenceKey(a)] });
    expect((await stat(f.path)).mode & 0o777).toBe(0o600);
    const alias = join(f.dir, "alias"); await symlink(f.cwd, alias);
    const resumed = new PreferenceStore(f.agent, alias); await resumed.load();
    const defaults = resumed.getDefaultPreferences();
    expect(defaults.map(preferenceKey)).toEqual([preferenceKey(b), preferenceKey(a)]);
    expect(composeRevision(defaults, "")).toContain("Saved editing requirements (project default):\nKeep task scope.");
    defaults[0]!.body = "Caller mutation";
    expect(resumed.getDefaultPreferences()[0]!.body).toBe(b.body);
    const other = join(f.dir, "other"); await mkdir(other);
    const isolated = new PreferenceStore(f.agent, other); await isolated.load();
    expect(isolated.getDefaultPreferences()).toEqual([]);
    await resumed.setProjectDefault(a, false);
    expect((await f.store.load()).projectDefaults).toEqual([preferenceKey(b)]);
  });

  it("uses refreshed library bodies for future drafts, deduplicates content, and skips deleted sources", async () => {
    const f = await setup();
    const a = await f.store.save("project", { name: "A", body: "Original" });
    const duplicate = await f.store.save("global", { name: "Copy", body: "Original" });
    await f.store.setProjectDefault(a, true); await f.store.setProjectDefault(duplicate, true);
    expect(f.store.getDefaultPreferences()).toHaveLength(1);
    const frozen = f.store.getDefaultPreferences();
    const edited = await f.store.save("project", { name: "A", body: "Changed" }, a);
    await f.store.load();
    expect(f.store.getDefaultPreferences().map((entry) => entry.body)).toEqual(["Changed", "Original"]);
    expect(frozen[0]!.body).toBe("Original");
    await f.store.remove(edited);
    expect((await f.store.load()).errors.defaults).toContain("unavailable or deleted");
    expect(f.store.getDefaultPreferences().map(preferenceKey)).toEqual([preferenceKey(duplicate)]);
    await expect(f.store.setProjectDefault(edited, true)).rejects.toThrow("unavailable or deleted");
    await f.store.setProjectDefault(edited, false);
    expect((await f.store.load()).errors).toEqual({});
  });

  it("retains concurrent toggles and occupied locks, with a bounded selection", async () => {
    const f = await setup();
    const peers = [new ProjectPreferenceDefaults(f.cwd), new ProjectPreferenceDefaults(f.cwd)];
    const keys = ["global:a", "project:b"];
    const results = await Promise.allSettled(peers.map((store, i) => store.set(keys[i]!, true)));
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") {
        expect(result.reason.message).toContain("busy");
        await peers[index]!.set(keys[index]!, true);
      }
    }
    expect((await peers[0]!.load()).sort()).toEqual([...keys].sort());
    await writeFile(`${f.path}.lock`, "other writer");
    await expect(peers[0]!.set("global:c", true)).rejects.toThrow("busy");
    expect(await readFile(`${f.path}.lock`, "utf8")).toBe("other writer");
    await rm(`${f.path}.lock`);
    const preferences = Array.from({ length: 50 }, (_, i) => `global:item-${i}`);
    await writeFile(f.path, JSON.stringify({ version: 1, preferences }));
    await expect(peers[0]!.set("global:extra", true)).rejects.toThrow("at most 50");
    expect(await peers[0]!.load()).toEqual(preferences);
    await peers[0]!.set(preferences[0]!, false);
    await peers[0]!.set("global:extra", true);
  });

  it("reports corrupt, unsupported, oversized and symlinked defaults without overwriting them or breaking the library", async () => {
    const f = await setup();
    const entry = await f.store.save("global", { name: "A", body: "Body" });
    for (const content of ["broken", JSON.stringify({ version: 2, preferences: [] }), " ".repeat(16_385),
      JSON.stringify({ version: 1, preferences: ["unknown:id"] }), JSON.stringify({ version: 1, preferences: ["global:a", "global:a"] })]) {
      await writeFile(f.path, content);
      expect((await f.store.load()).entries).toEqual([entry]);
      expect((await f.store.load()).errors.defaults).toBeTruthy();
      expect(f.store.getDefaultPreferences()).toEqual([]);
      await expect(f.store.setProjectDefault(entry, true)).rejects.toThrow();
      expect(await readFile(f.path, "utf8")).toBe(content);
    }
    const target = join(f.dir, "target.json"); await writeFile(target, '{"version":1,"preferences":[]}');
    await rm(f.path); await symlink(target, f.path);
    await expect(f.store.setProjectDefault(entry, true)).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe('{"version":1,"preferences":[]}');
  });
});
