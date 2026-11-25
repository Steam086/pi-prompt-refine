import { describe, expect, it } from "vitest";
import { SessionPreferences } from "../../src/app/session-preferences.js";
import { preferenceKey, type PreferenceLibrary, type RevisionPreference } from "../../src/revision-preferences.js";

const first: RevisionPreference = { scope: "project", id: "one", version: 1, name: "One", body: "One requirement" };
const second: RevisionPreference = { scope: "global", id: "two", version: 1, name: "Two", body: "Two requirements" };

function setup() {
  const library: PreferenceLibrary = { entries: [first, second], errors: {}, projectDefaults: [preferenceKey(first)] };
  const selections = new SessionPreferences();
  let current = true;
  const target = selections.target("session", () => current, () => 16000);
  return { library, target, close: () => { current = false; } };
}

describe("session preference overrides", () => {
  it("clears the effective selection without muting newly enabled project defaults", () => {
    const { library, target } = setup();
    expect(target.change(library, { kind: "set", key: preferenceKey(second), enabled: true })).toBeUndefined();
    expect(target.read(library).map(preferenceKey)).toEqual([preferenceKey(first), preferenceKey(second)]);
    expect(target.change(library, { kind: "clear" })).toBeUndefined();
    expect(target.read(library)).toEqual([]);
    expect(library.projectDefaults).toEqual([preferenceKey(first)]);
    const third = { ...second, id: "three", body: "Three requirements" };
    library.entries.push(third);
    library.projectDefaults?.push(preferenceKey(third));
    expect(target.read(library).map(preferenceKey)).toEqual([preferenceKey(third)]);
    expect(target.change(library, { kind: "inherit", key: preferenceKey(first) })).toBeUndefined();
    expect(target.read(library)).toMatchObject([{ id: first.id, selectionSource: "project-default" }, { id: third.id }]);
  });

  it("prefers an explicit item over a duplicate project default and snapshots current available text", () => {
    const { library, target } = setup();
    target.change(library, { kind: "set", key: preferenceKey(second), enabled: true });
    const captured = target.read(library);
    library.entries = [first, { ...second, version: 2, body: first.body }];
    expect(target.read(library)).toMatchObject([{ id: second.id, body: first.body }]);
    expect(captured[1]?.body).toBe(second.body);
    library.errors.global = "Unavailable";
    expect(target.read(library)).toMatchObject([{ id: first.id, selectionSource: "project-default" }]);
  });

  it("does not apply changes from a stale chooser", () => {
    const { library, target, close } = setup();
    close();
    expect(target.change(library, { kind: "set", key: preferenceKey(first), enabled: false })).toContain("Session changed");
    expect(target.read(library)).toMatchObject([{ id: first.id }]);
  });
});
