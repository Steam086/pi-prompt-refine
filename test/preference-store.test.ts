import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PreferenceStore, PREFERENCE_MAX_BYTES } from "../src/preference-store.js";
import { composeRevision, searchPreferences, selectPreference, type PreferenceMetadata, type RevisionPreference } from "../src/revision-preferences.js";

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
    expect(composeRevision([selected], "\nFree text\n")).toBe("Saved editing requirements (manually selected):\n  Keep\t中文\n\n\nCurrent user instructions:\n\nFree text\n");
    expect(composeRevision([selected], " \n")).toBe("Saved editing requirements (manually selected):\n  Keep\t中文\n");
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
  it("points version-limit recovery at Add without modifying the source", async () => {
    const f = await setup();
    const source: RevisionPreference = { id: "limit", version: Number.MAX_SAFE_INTEGER, scope: "global", name: "A", body: "Original" };
    const { scope: _, ...stored } = source;
    const content = JSON.stringify({ version: 1, entries: [stored] });
    await writeFile(f.global, content);
    await expect(f.store.save("global", { name: "A", body: "Edited" }, source)).rejects.toThrow("Use Add and copy the text into a new entry");
    expect(await readFile(f.global, "utf8")).toBe(content);
    // Add has no expected source, so it creates a new identity at version 1.
    const added = await f.store.save("global", { name: "Copy", body: source.body });
    expect(added.id).not.toBe(source.id); expect(added.version).toBe(1);
    expect((await f.store.load()).entries).toEqual([source, added]);
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
    await expect(f.store.save("project", { name: "A", body: "B" }, saved)).rejects.toThrow("Use Add and copy the text into a new entry in the other scope");
    expect((await f.store.load()).entries).toEqual([saved]);
  });
});

describe("typed preferences", () => {
  const metadata: PreferenceMetadata = { kind: "rewrite", description: "并列问题条目化", activation: "manual" };
  const entry: RevisionPreference = { id: "structured", version: 1, scope: "global", name: "Structure", body: "Keep literal 中文\tcommands.", metadata };

  it("loads the reorganized preset catalog through the production reader", async () => {
    const f = await setup();
    await writeFile(f.global, await readFile(new URL("../examples/prompt-refine-preferences.json", import.meta.url), "utf8"));
    const library = await f.store.load();
    expect(library.errors).toEqual({});
    expect(library.entries).toHaveLength(11);
    const discussion = library.entries.filter((entry) => entry.id === "discussion-mode");
    expect(discussion).toHaveLength(1);
    expect(discussion[0]).toMatchObject({
      version: 2,
      name: "Discussion Mode",
      metadata: {
        description: "讨论需求和方案时只处理当前问题；需要选择时给出建议与取舍，追问仅限影响方向或阻塞规划的问题。",
        kind: "task",
        activation: "manual",
      },
    });
    expect(discussion[0]!.body).toContain("must not convert an explicitly requested execution task into discussion only");
    expect(discussion[0]!.body).toContain("Do not add tool-use or delegation authority");
    const structure = library.entries.filter((entry) => ["prompt-bullet-structure", "prompt-step-structure"].includes(entry.id));
    expect(structure.map((entry) => [entry.id, entry.version])).toEqual([
      ["prompt-bullet-structure", 4], ["prompt-step-structure", 4],
    ]);
    for (const entry of structure) {
      expect(entry.body).not.toContain("用户手动选择");
      expect(entry.body).toContain("Leave the draft unchanged");
      expect(entry.body).toContain("authorization scope");
      expect(entry.body).not.toContain("本地匹配");
    }
    expect(library.entries.every((entry) => entry.metadata?.description && ["rewrite", "task"].includes(entry.metadata.kind))).toBe(true);
    expect(library.entries.every((entry) => entry.metadata?.activation === "manual" && !("match" in entry.metadata))).toBe(true);
    for (const entry of library.entries) {
      expect(entry.body).not.toMatch(/本地匹配|本地线索|update the candidate prompt|refiner output protocol|SCAMPER/);
      expect(entry.metadata?.description).not.toMatch(/本地匹配|本地线索|手动选择后/);
    }
    const brainstorm = library.entries.find((entry) => entry.id === "brainstorm-alternatives")!;
    expect(brainstorm.body).toContain("unless requested");
    expect(brainstorm.body).toContain("If the task also asks for a choice");
    const translate = library.entries.find((entry) => entry.id === "translate-prompt-to-english")!;
    expect(translate.body).toContain("including non-English literals");
    expect(translate.body).toContain("an English prompt does not imply a request for an English answer");
    const delegate = library.entries.find((entry) => entry.id === "coordinate-authorized-subagents")!;
    expect(delegate.body).toContain("Only when the current draft explicitly authorizes delegation");
    expect(delegate.body).toContain("Report unavailable agents or capabilities");
    const clarify = library.entries.find((entry) => entry.id === "clarify-prompt-intent")!;
    expect(clarify.metadata?.activation).toBe("manual");
    expect(clarify.body.length).toBeLessThan(500);
    expect(clarify.body).toContain("smallest useful edit");
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
    external.entries[0].metadata.description = "External concurrent edit";
    await writeFile(f.global, JSON.stringify(external));
    await expect(f.store.remove(edited)).rejects.toThrow("changed or was deleted");
  });

  it.each([false, true])("freezes nested delete expectations before IO (stale source: %s)", async (stale) => {
    const f = await setup();
    const saved = await f.store.save("global", { name: entry.name, body: entry.body, metadata: structuredClone(metadata) });
    const changedMetadata: PreferenceMetadata = { kind: "task", description: "Changed after delete started", activation: "manual" };
    if (stale) {
      const external = JSON.parse(await readFile(f.global, "utf8"));
      external.entries[0].metadata = changedMetadata;
      await writeFile(f.global, JSON.stringify(external));
    }
    const before = await readFile(f.global, "utf8");
    const pending = f.store.remove(saved);
    // mutate() must await path/lock IO before comparing. The caller still owns saved.
    Object.assign(saved.metadata!, changedMetadata);
    if (stale) {
      // Mutating a stale expectation to match disk must not bypass conflict checks.
      await expect(pending).rejects.toThrow("changed or was deleted");
      expect(await readFile(f.global, "utf8")).toBe(before);
    } else {
      await expect(pending).resolves.toBeUndefined();
      expect((await f.store.load()).entries).toEqual([]);
    }
  });

  it("rejects malformed metadata without overwriting the library", async () => {
    const f = await setup();
    for (const invalid of ["serialized JSON", null, { ...metadata, kind: "unknown" }, { ...metadata, description: "" },
      { ...metadata, match: "guess" }, { ...metadata, activation: "unknown" }, { ...metadata, activation: "auto" },
      { ...metadata, kind: "task", activation: "auto", match: "always" }, { ...metadata, typo: true }]) {
      const content = JSON.stringify({ version: 2, entries: [{ ...entry, metadata: invalid }] });
      await writeFile(f.global, content);
      expect((await f.store.load()).errors.global).toBeTruthy();
      await expect(f.store.save("global", { name: "New", body: "New" })).rejects.toThrow();
      expect(await readFile(f.global, "utf8")).toBe(content);
    }
  });

  it("labels manually selected purposes without sending names/descriptions", () => {
    const task = { ...entry, id: "language", body: "Require an English answer.", metadata: { kind: "task", description: "回答语言", activation: "manual" } as const };
    const composed = composeRevision([selectPreference(entry), selectPreference(task)], "Remove only repeated wording.");
    expect(composed).toBe(`Prompt rewriting instructions (manually selected):\n${entry.body}\n\nMain-agent task requirements (manually selected):\n${task.body}\n\nCurrent user instructions:\nRemove only repeated wording.`);
    expect(composed).not.toContain(metadata.description);
    expect(searchPreferences([entry], "并列")).toEqual([entry]);
  });

  it.each(["always", "parallel", "sequence"])("loads legacy %s entries as manual without rewriting until an explicit save", async (match) => {
    const f = await setup();
    const content = JSON.stringify({ version: 2, entries: [{ ...entry, metadata: { ...metadata, activation: "auto", match } }] });
    await writeFile(f.global, content);
    const library = await f.store.load();
    expect(library.errors).toEqual({});
    expect(library.entries).toEqual([entry]);
    expect(await readFile(f.global, "utf8")).toBe(content);
    const selected = selectPreference(library.entries[0]!);
    expect(composeRevision([selected], "")).toBe(`Prompt rewriting instructions (manually selected):\n${entry.body}`);
    const updated = await f.store.save("global", { name: "Renamed", body: entry.body }, library.entries[0]);
    expect(updated).toMatchObject({ id: entry.id, version: 2, metadata });
    const stored = JSON.parse(await readFile(f.global, "utf8")).entries[0];
    expect(stored.metadata).toEqual(metadata);
    expect(stored.metadata).not.toHaveProperty("match");
    await f.store.remove(updated);
    expect((await f.store.load()).entries).toEqual([]);
  });

  it("rejects attempts to save new automatic preferences and leaves existing libraries intact", async () => {
    const f = await setup();
    await f.store.save("global", { name: entry.name, body: entry.body, metadata });
    const original = await readFile(f.global, "utf8");
    const invalid = { name: "Auto", body: "Must not be adopted", metadata: { ...metadata, activation: "auto", match: "always" } };
    await expect(f.store.save("global", invalid as unknown as Parameters<PreferenceStore["save"]>[1])).rejects.toThrow("manually");
    expect(await readFile(f.global, "utf8")).toBe(original);
  });
});
