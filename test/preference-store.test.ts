import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PreferenceStore, PREFERENCE_MAX_BYTES } from "../src/preference-store.js";
import { automaticPreferences, composeRevision, searchPreferences, selectPreference, type PreferenceMetadata, type RevisionPreference } from "../src/revision-preferences.js";

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
    for (const content of ["broken", '{"version":3,"entries":[]}', " ".repeat(PREFERENCE_MAX_BYTES + 1),
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

describe("typed preferences", () => {
  const metadata: PreferenceMetadata = { kind: "rewrite", description: "并列问题条目化", activation: "auto", match: "parallel" };
  const entry: RevisionPreference = { id: "structured", version: 1, scope: "global", name: "Structure", body: "Keep literal 中文\tcommands.", metadata };

  it("loads the reorganized preset catalog through the production reader", async () => {
    const f = await setup();
    await writeFile(f.global, await readFile(new URL("../examples/prompt-refine-preferences.json", import.meta.url), "utf8"));
    const library = await f.store.load();
    expect(library.errors).toEqual({});
    expect(library.entries).toHaveLength(10);
    expect(library.entries.every((entry) => entry.metadata?.description && ["rewrite", "task"].includes(entry.metadata.kind))).toBe(true);
    expect(library.entries.filter((entry) => entry.metadata?.kind === "task").every((entry) => entry.metadata?.activation === "manual")).toBe(true);
    const chosen = automaticPreferences(library.entries, "先解释原因，再讨论方案。为什么？有什么取舍？");
    expect(chosen.map((entry) => entry.name)).toEqual(["Prompt Step Structure", "Clarify Prompt Intent"]);
    expect(automaticPreferences(library.entries, "Clear request.").map((entry) => entry.name)).toEqual(["Clarify Prompt Intent"]);
  });

  it("round-trips v2 metadata, preserves it in old-style edits and isolates pending writes/snapshots", async () => {
    const f = await setup();
    const value = { name: entry.name, body: entry.body, metadata: structuredClone(metadata) };
    const pending = f.store.save("global", value);
    value.metadata.description = "mutated while awaiting IO";
    const saved = await pending;
    expect(saved.metadata).toEqual(metadata);
    expect(JSON.parse(await readFile(f.global, "utf8")).version).toBe(2);
    const selected = selectPreference(saved);
    saved.metadata!.description = "mutated after selection";
    expect(selected.metadata).toEqual(metadata);
    const fresh = (await f.store.load()).entries[0]!;
    const edited = await f.store.save("global", { name: "Renamed", body: fresh.body }, fresh);
    expect(edited.metadata).toEqual(metadata);
    const external = JSON.parse(await readFile(f.global, "utf8"));
    external.entries[0].metadata.activation = "manual";
    await writeFile(f.global, JSON.stringify(external));
    await expect(f.store.remove(edited)).rejects.toThrow("changed or was deleted");
  });

  it("rejects malformed metadata without overwriting the library", async () => {
    const f = await setup();
    for (const invalid of ["serialized JSON", null, { ...metadata, kind: "unknown" }, { ...metadata, description: "" },
      { ...metadata, match: "guess" }, { ...metadata, match: undefined }, { ...metadata, kind: "task" }, { ...metadata, typo: true }]) {
      const content = JSON.stringify({ version: 2, entries: [{ ...entry, metadata: invalid }] });
      await writeFile(f.global, content);
      expect((await f.store.load()).errors.global).toBeTruthy();
      await expect(f.store.save("global", { name: "New", body: "New" })).rejects.toThrow();
      expect(await readFile(f.global, "utf8")).toBe(content);
    }
  });

  it("keeps names/descriptions/activation out of instructions and preserves legacy literal composition", () => {
    const task = { ...entry, id: "language", body: "Require an English answer.", metadata: { kind: "task", description: "回答语言", activation: "manual" } as const };
    const composed = composeRevision([selectPreference(entry), selectPreference(task)], "Remove only repeated wording.");
    expect(composed).toBe(`Prompt rewriting instructions:\n${entry.body}\n\nMain-agent task requirements:\n${task.body}\n\nRemove only repeated wording.`);
    expect(composed).not.toContain(metadata.description);
    expect(searchPreferences([entry], "并列")).toEqual([entry]);
  });

  it("matches only eligible rewrites, prefers sequence to bullets, ignores fenced code and deduplicates scopes", () => {
    const sequence = { ...entry, id: "sequence", body: "Sequence", metadata: { ...metadata, match: "sequence" as const } };
    const legacy = { ...entry, id: "legacy", metadata: undefined };
    const manual = { ...entry, id: "manual", metadata: { ...metadata, activation: "manual" as const } };
    const task = { ...entry, id: "task", metadata: { ...metadata, kind: "task" as const } };
    const project = { ...entry, id: "project", scope: "project" as const };
    const entries = [entry, sequence, legacy, manual, task, project];
    expect(automaticPreferences(entries, "Why? How?").map((entry) => entry.id)).toEqual(["project"]);
    expect(automaticPreferences(entries, "先检查接口，再讨论方案。\n1. 检查\n2. 讨论").map((entry) => entry.id)).toEqual(["sequence"]);
    expect(automaticPreferences(entries, "First inspect, then explain.").map((entry) => entry.id)).toEqual(["sequence"]);
    expect(automaticPreferences(entries, "解释：\n```text\nWhy? How?\n```")).toEqual([]);
    expect(automaticPreferences(entries, "Already clear.")).toEqual([]);
    expect(automaticPreferences(entries, " ")).toEqual([]);
    const result = automaticPreferences(entries, "Why? How?")[0]!;
    expect(result.adoption).toBe("auto");
    result.metadata!.description = "local";
    expect(project.metadata!.description).toBe(metadata.description);
  });
});
