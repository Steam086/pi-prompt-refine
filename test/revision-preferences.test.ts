import { describe, expect, it } from "vitest";
import { composeRevision, metadataValidation, searchPreferences, selectPreference, uniquePreferences, type RevisionPreference } from "../src/revision-preferences.js";

const entry = (id: string, name: string, description = "", body = ""): RevisionPreference => ({
  id, name, body, scope: "project", version: 1,
  ...(description ? { metadata: { description, kind: "task", activation: "manual" } } : {}),
});
const ids = (entries: RevisionPreference[], query: string) => searchPreferences(entries, query).map((item) => item.id);

describe("manual preference metadata", () => {
  it("accepts manual preferences of either type, but rejects automatic adoption on new writes", () => {
    for (const kind of ["rewrite", "task"]) {
      const metadata = { kind, activation: "manual", description: "Requirements" };
      expect(metadataValidation(metadata)).toBeUndefined();
      expect(metadataValidation({ ...metadata, activation: "auto", match: "always" })).toContain("manually");
      expect(metadataValidation({ ...metadata, match: "parallel" })).toContain("Unknown");
    }
  });

  it("only permits valid legacy fields when explicitly reading old libraries", () => {
    for (const match of ["always", "parallel", "sequence"]) {
      const legacy = { kind: "rewrite", activation: "auto", description: "Old preference", match };
      expect(metadataValidation(legacy, true)).toBeUndefined();
      expect(metadataValidation({ ...legacy, kind: "task" }, true)).toBeTruthy();
    }
    expect(metadataValidation({ kind: "rewrite", activation: "auto", description: "Missing condition" }, true)).toBeTruthy();
  });
});

describe("requirement composition boundaries", () => {
  it("deduplicates literal type/body pairs in selection order and preserves body bytes", () => {
    const first = selectPreference({ ...entry("a", "First", "Description", "  Keep 中文\n"),
      metadata: { kind: "rewrite", activation: "manual", description: "Not sent" } });
    const duplicate = { ...selectPreference(first), id: "copy", scope: "global" as const };
    const task = { ...duplicate, id: "task", metadata: { ...duplicate.metadata!, kind: "task" as const } };
    expect(uniquePreferences([first, duplicate, task])).toEqual([first, task]);
    const composed = composeRevision([first, duplicate, task], "Replace only the answer format.");
    expect(composed).toBe("Prompt rewriting instructions (manually selected):\n  Keep 中文\n\n\nMain-agent task requirements (manually selected):\n  Keep 中文\n\n\nCurrent user instructions:\nReplace only the answer format.");
    expect(composed).not.toContain("Not sent");
    expect(composed).not.toContain("automatic default");
    expect(uniquePreferences([duplicate, first])).toEqual([duplicate]);
  });
});

describe("searchPreferences", () => {
  it("AND-matches whitespace tokens across name, description and body without fuzzy matching", () => {
    const entries = [entry("all", "Keep commands", "Literal paths", "Preserve 中文 flags"),
      entry("missing", "Keep commands", "Literal paths", "Translate flags"), entry("body", "Other", "", "keep 中文 paths")];
    expect(ids(entries, " KEEP\t中文\npaths ")).toEqual(["all", "body"]);
    expect(ids(entries, "keep nonexistent")).toEqual([]);
    expect(ids(entries, "kcommand")).toEqual([]);
    expect(ids(entries, "comands")).toEqual([]);
  });

  it("ranks exact name, substring/all-name tokens, description, then body with stable source ties", () => {
    const entries = [entry("body-first", "Other", "", "alpha beta"), entry("description-first", "Other", "alpha beta"),
      entry("substring", "Extended alpha beta"), entry("tokens", "Beta then ALPHA"), entry("exact", "ALPHA BETA"),
      entry("description-second", "Alpha", "Beta"), entry("body-second", "Alpha", "", "Beta"), entry("missing", "Alpha")];
    expect(ids(entries, "alpha beta")).toEqual(["exact", "substring", "tokens", "description-first", "description-second", "body-first", "body-second"]);
    expect(ids(entries, "beta alpha")).toEqual(["substring", "tokens", "exact", "description-first", "description-second", "body-first", "body-second"]);
    expect(entries.map((item) => item.id)).toEqual(["body-first", "description-first", "substring", "tokens", "exact", "description-second", "body-second", "missing"]);
  });

  it("uses case-insensitive literal Unicode matching and Unicode whitespace", () => {
    const entries = [entry("body", "Other", "", "CAFÉ 中文 😀 ΔΟΚΙΜΉ"), entry("name", "Café 中文", "Δοκιμή 😀")];
    expect(ids(entries, "café\u3000中文")).toEqual(["name", "body"]);
    expect(ids(entries, "δοκιμή\u00a0😀")).toEqual(["name", "body"]);
    expect(ids(entries, "cafe")).toEqual([]);
  });

  it("preserves source order and identities for empty/whitespace queries without mutating input", () => {
    const entries = [entry("z", "Z"), entry("a", "A"), entry("b", "B")];
    for (const query of ["", " \t\n\u3000"]) {
      const result = searchPreferences(entries, query);
      expect(result).toEqual(entries);
      expect(result).not.toBe(entries);
      expect(result[0]).toBe(entries[0]);
    }
    const frozen = Object.freeze([...entries]);
    expect(searchPreferences(frozen, "a")).toEqual([entries[1]]);
  });
});
