import { describe, expect, it } from "vitest";
import { searchPreferences, type RevisionPreference } from "../src/revision-preferences.js";

const entry = (id: string, name: string, description = "", body = ""): RevisionPreference => ({
  id, name, body, scope: "project", version: 1,
  ...(description ? { metadata: { description, kind: "task", activation: "manual" } } : {}),
});
const ids = (entries: RevisionPreference[], query: string) => searchPreferences(entries, query).map((item) => item.id);

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
    expect(ids(entries, "cafe")).toEqual([]); // No accent folding or fuzzy matching.
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
