import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { InlinePreferences } from "../src/inline-preferences.js";
import { sanitizeTerminalText } from "../src/presentation.js";
import { selectPreference, type PreferenceLibrary, type PreferenceRepository, type RevisionPreference, type SelectedPreference } from "../src/revision-preferences.js";

afterEach(() => vi.restoreAllMocks());

const first: RevisionPreference = { id: "first", version: 1, scope: "project", name: "Keep 中文😀", body: "Original body\n".repeat(20),
  metadata: { kind: "task", description: "Literal description", activation: "manual" } };
const second: RevisionPreference = { id: "second", version: 1, scope: "global", name: "Rewrite", body: "Another body",
  metadata: { kind: "rewrite", description: "Rewrite description", activation: "manual" } };
function fixture(entries = [first, second], selected: SelectedPreference[] = [], themeName = "dark") {
  let library: PreferenceLibrary = { entries, errors: {} };
  const state = { selected, editable: true };
  const save = vi.fn((next: SelectedPreference[]) => { state.selected = next; return undefined as string | undefined; });
  const load = vi.fn(async () => structuredClone(library));
  const repository: PreferenceRepository = { load, save: vi.fn(), remove: vi.fn() };
  const theme = getThemeByName(themeName)!;
  const redraw = vi.fn();
  const picker = new InlinePreferences(repository, () => ({ selected: state.selected, save: state.editable ? save : undefined }), theme, getKeybindings(), redraw);
  picker.focused = true; picker.setTarget(1, true);
  const render = (width = 60, height = 10) => picker.render(width, height);
  const text = (width = 60, height = 10) => stripVTControlCharacters(render(width, height).join("\n"));
  return { picker, state, save, load, theme, redraw, render, text, library: (value: PreferenceLibrary) => { library = value; } };
}

describe("inline Unsent preferences", () => {
  it.each(["dark", "light"])("previews adjacent choices while navigating groups and resizing (%s)", async (themeName) => {
    const entries = Array.from({ length: 18 }, (_, i) => ({ ...(i < 9 ? first : second), id: `item-${i}`, name: `Item ${String(i).padStart(2, "0")} 中文😀` }));
    const f = fixture(entries, [], themeName); await Promise.resolve();
    for (const [width, height] of [[60, 10], [24, 5], [60, 10]]) {
      f.picker.handleInput("\x1b[H");
      for (let i = 0; i < entries.length; i++) {
        const frame = f.render(width!, height!);
        const plain = stripVTControlCharacters(frame.join("\n"));
        expect(plain).toContain(`› [ ] ${entries[i]!.name}`);
        if (i + 1 < entries.length) expect(plain).toContain(entries[i + 1]!.name);
        expect(frame.join("\n")).toContain(f.theme.fg("text", f.theme.bold(entries[i]!.name)));
        expect(frame.length).toBeLessThanOrEqual(height!);
        expect(frame.every((line) => visibleWidth(line) <= width!)).toBe(true);
        expect(f.render(width!, height!)).toEqual(frame);
        f.picker.handleInput("\x1b[B");
      }
      for (let i = entries.length - 2; i >= 0; i--) {
        f.picker.handleInput("\x1b[A");
        const plain = f.text(width!, height!);
        expect(plain).toContain(`› [ ] ${entries[i]!.name}`);
        if (i > 0) expect(plain).toContain(entries[i - 1]!.name);
      }
    }
    expect(f.save).not.toHaveBeenCalled();
    expect(f.load).toHaveBeenCalledTimes(1);
    f.picker.dispose();
  });

  it.each(["dark", "light"])("keeps snapshot identities and composition order, rejects duplicates, and never silently replaces sources (%s)", async (themeName) => {
    const copy = { ...first, id: "copy", scope: "global" as const, name: "Duplicate" };
    const f = fixture([first, copy, second], [selectPreference(first)], themeName);
    await Promise.resolve();
    f.picker.handleInput("\x1b[B"); f.picker.handleInput(" ");
    expect(f.text()).toContain("Same requirements already selected");
    expect(f.state.selected).toEqual([selectPreference(first)]);
    f.picker.handleInput("\x1b[B"); f.picker.handleInput(" ");
    expect(f.state.selected).toEqual([selectPreference(first), selectPreference(second)]);
    // Toggling does not move the cursor or reorder the remaining library rows.
    expect(f.text()).toContain("› [x] Rewrite");
    f.library({ entries: [{ ...first, version: 2, name: "Renamed source", body: "Updated source" }, second], errors: {} });
    await f.picker.refresh();
    f.picker.handleInput("\x1b[H");
    expect(f.text()).toContain("! Keep 中文😀");
    f.picker.handleInput("\r");
    let document = "";
    for (let i = 0; i < 12; i++) { document += f.text(60, 10); f.picker.handleInput("\x1b[6~"); }
    expect(document).toContain("Selected snapshot"); expect(document).toContain("Original body");
    expect(document).toContain("Current library entry"); expect(document).toContain("Updated source");
    expect(f.state.selected[0]).toEqual(selectPreference(first));
    f.picker.handleInput("\x1b"); f.picker.handleInput(" "); f.picker.handleInput(" ");
    expect(f.state.selected.map((entry) => entry.id)).toEqual([second.id, first.id]);
    expect(f.state.selected[1]!.body).toBe("Updated source");
    f.picker.dispose();
  });

  it("keeps unavailable/deleted snapshots removable, and does not offer stale library entries after a refresh failure", async () => {
    const f = fixture([first, second], [selectPreference(first)]);
    await Promise.resolve();
    f.load.mockRejectedValueOnce(new Error("Permission denied 中文"));
    await f.picker.refresh();
    expect(f.text()).toContain("Library unavailable: Permission denied 中文");
    expect(f.text()).not.toContain("[ ] Rewrite");
    expect(f.text()).toContain("! Keep 中文😀");
    f.picker.handleInput("\r");
    expect(f.text(60, 20)).toContain("Library unavailable; selected snapshot retained.");
    f.picker.handleInput("\x1b"); f.picker.handleInput(" ");
    expect(f.state.selected).toEqual([]);
    expect(f.text()).not.toContain("[ ] Keep");
    f.library({ entries: [first, second], errors: { project: "Project unreadable" } });
    await f.picker.refresh();
    expect(f.text()).toContain("[ ] Rewrite"); expect(f.text()).not.toContain("[ ] Keep");
    f.picker.dispose();
  });

  it("keeps focus, descriptions, search text and warnings safe and bounded with ANSI and wide text", async () => {
    const malicious = { ...first, name: "Safe 中文😀 \x1b]52;c;payload\x07", metadata: { ...first.metadata!, description: "Info \x1b[2J 中文😀" } };
    const f = fixture([malicious, second]); await Promise.resolve();
    const full = f.render().join("\n");
    expect(full).toContain(f.theme.fg("text", f.theme.bold(sanitizeTerminalText(malicious.name))));
    expect(full).toContain(f.theme.fg("muted", sanitizeTerminalText(malicious.metadata.description)));
    expect(full).not.toContain("\x1b]52;"); expect(full).not.toContain("\x1b[2J");
    f.save.mockReturnValue("Editing requirements exceed limit"); f.picker.handleInput(" ");
    for (const [width, height] of [[60, 10], [20, 3], [12, 1], [1, 1], [60, 10]]) {
      const lines = f.render(width!, height!);
      expect(lines.length).toBeLessThanOrEqual(height!);
      expect(lines.every((line) => visibleWidth(line) <= width!)).toBe(true);
      if (width! >= 12) expect(lines.join("\n")).toContain(f.theme.fg("warning", "⚠").split("⚠")[0] + "⚠");
    }
    expect(f.state.selected).toEqual([]);
    f.picker.handleInput("/");
    for (const key of ["n", "i", "p", "s", "f"]) f.picker.handleInput(key);
    expect(f.picker.hints).toBe("search"); expect(f.text()).toContain("Search: nipsf");
    expect(f.save).toHaveBeenCalledTimes(1);
    f.picker.handleInput("\x1b"); expect(f.picker.handleInput("\x1b")).toBe("back");
    f.picker.dispose();
  });

  it("does not refilter or reload on focus changes and scrolling", async () => {
    const f = fixture(); await Promise.resolve();
    const search = vi.spyOn(String.prototype, "toLowerCase");
    f.text(); const searches = search.mock.calls.length;
    for (let i = 0; i < 10; i++) { f.picker.setTarget(1, i % 2 === 0); f.text(); }
    expect(search.mock.calls.length).toBe(searches);
    expect(f.load).toHaveBeenCalledTimes(1);
    search.mockRestore(); f.picker.dispose();
  });

  it("retains independent document positions across focus changes and originals, but refreshes source comparisons", async () => {
    const f = fixture(); await Promise.resolve();
    f.picker.handleInput("\r"); f.text(50, 8);
    f.picker.handleInput("\x1b[6~");
    const scrolled = f.text(50, 8);
    expect(scrolled).not.toContain("Library entry");
    f.picker.setTarget(1, false); f.text(); f.picker.setTarget(1, true);
    expect(f.text(50, 8)).toBe(scrolled);
    f.picker.setTarget(2, true); expect(f.picker.hints).toBe("select");
    f.picker.setTarget(1, true); expect(f.text(50, 8)).toBe(scrolled);
    f.picker.handleInput("\x1b"); f.picker.handleInput("\r");
    expect(f.text(50, 8)).toBe(scrolled);
    f.library({ entries: [{ ...first, version: 2, body: "Changed body" }], errors: {} });
    await f.picker.refresh(); expect(f.picker.hints).toBe("select");
    f.picker.handleInput("\r"); expect(f.text()).toContain("Changed body");
    f.picker.dispose();
  });

  it("recovers its cursor after End on an empty or loading library and enforces the item limit", async () => {
    const f = fixture();
    f.picker.handleInput("\x1b[F"); // Before the initial asynchronous load settles.
    await Promise.resolve(); expect(f.text()).toContain("› [ ] Keep");
    f.picker.handleInput(" "); expect(f.state.selected).toHaveLength(1);
    f.state.selected = Array.from({ length: 50 }, (_, index) => selectPreference({ ...first, id: `selected-${index}`, body: `Body ${index}` }));
    f.picker.handleInput(" ");
    expect(f.text()).toContain("Select at most 50 preferences");
    expect(f.state.selected).toHaveLength(50); expect(f.save).toHaveBeenCalledTimes(1);
    f.picker.dispose();
    f.picker.handleInput(" "); expect(f.save).toHaveBeenCalledTimes(1);
  });

  it("ignores late loads after disposal and never commits to an invalid target", async () => {
    const f = fixture(); await Promise.resolve();
    f.state.editable = false;
    expect(f.picker.handleInput(" ")).toBe("back"); expect(f.save).not.toHaveBeenCalled();
    let resolve!: (value: PreferenceLibrary) => void;
    f.load.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = f.picker.refresh(); const redraws = f.redraw.mock.calls.length;
    f.picker.dispose(); resolve({ entries: [], errors: {} }); await pending;
    expect(f.redraw).toHaveBeenCalledTimes(redraws);
  });
});
