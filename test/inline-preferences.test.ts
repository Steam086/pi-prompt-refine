import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { InlinePreferences } from "../src/inline-preferences.js";
import { RefineController } from "../src/controller.js";
import { selectHistory } from "../src/context.js";
import * as preferences from "../src/revision-preferences.js";
import { sanitizeTerminalText } from "../src/presentation.js";
import * as presentation from "../src/presentation.js";
import { formatKeyHint } from "../src/key-hints.js";
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
  it.each(["dark", "light"])("puts rewriting before task and legacy entries without reordering selections (%s)", async (themeName) => {
    const legacy = { ...first, id: "legacy", name: "Legacy", metadata: undefined };
    const f = fixture([first, legacy, second], [], themeName); await Promise.resolve();
    const assertOrder = () => {
      const plain = f.text(60, 16);
      const labels = ["Prompt rewriting", second.name, "Task requirements", first.name, "Unclassified", legacy.name];
      for (let index = 1; index < labels.length; index++) {
        expect(plain.indexOf(labels[index - 1]!)).toBeGreaterThanOrEqual(0);
        expect(plain.indexOf(labels[index]!)).toBeGreaterThan(plain.indexOf(labels[index - 1]!));
      }
    };
    assertOrder();
    f.picker.handleInput("\x1b[B"); f.picker.handleInput(" ");
    f.picker.handleInput("\x1b[A"); f.picker.handleInput(" ");
    expect(f.state.selected.map((entry) => entry.id)).toEqual([first.id, second.id]);
    assertOrder();
    // Both typed entries match; filtering must retain the same purpose order.
    f.picker.handleInput("/"); f.picker.handleInput("description"); f.picker.handleInput("\r");
    const filtered = f.text(60, 16);
    expect(filtered.indexOf("Prompt rewriting")).toBeLessThan(filtered.indexOf("Task requirements"));
    expect(filtered).not.toContain("Unclassified");
    expect(f.state.selected.map((entry) => entry.id)).toEqual([first.id, second.id]);
    f.picker.dispose();
  });

  it.each(["dark", "light"])("previews adjacent choices while navigating groups and resizing (%s)", async (themeName) => {
    const entries = Array.from({ length: 18 }, (_, i) => ({ ...(i < 9 ? second : first), id: `item-${i}`, name: `Item ${String(i).padStart(2, "0")} 中文😀` }));
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
    f.picker.handleInput("\x1b[F"); f.picker.handleInput(" ");
    expect(f.text()).toContain("Same requirements already selected");
    expect(f.state.selected).toEqual([selectPreference(first)]);
    f.picker.handleInput("\x1b[H"); f.picker.handleInput(" ");
    expect(f.state.selected).toEqual([selectPreference(first), selectPreference(second)]);
    // Toggling does not move the cursor or reorder the remaining library rows.
    expect(f.text()).toContain("› [x] Rewrite");
    f.library({ entries: [{ ...first, version: 2, name: "Renamed source", body: "Updated source" }, second], errors: {} });
    await f.picker.refresh();
    f.picker.handleInput("\x1b[F");
    expect(f.text()).toContain("! Keep 中文😀");
    f.picker.handleInput("o");
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
    f.picker.handleInput("o");
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
    f.picker.handleInput("\x1b[F");
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

  it.each(["dark", "light"])("wraps the highlighted summary without changing checked snapshots (%s)", async (themeName) => {
    const description = "简介 中文😀 \x1b[2J literal **text** wraps across several lines without dropping the ending.";
    const entry = { ...first, metadata: { ...first.metadata!, description } };
    const f = fixture([entry, second], [selectPreference(entry)], themeName); await Promise.resolve();
    f.picker.handleInput("\x1b[F");
    const selected = structuredClone(f.state.selected);
    for (const width of [24, 60, 24]) {
      const summary = f.picker.renderDescription(width, 12);
      expect(summary[0]).toContain(f.theme.fg("text", f.theme.bold(entry.name)));
      expect(summary.length).toBeGreaterThan(2);
      expect(stripVTControlCharacters(summary.join("\n"))).toContain("ending.");
      expect(summary.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(summary.join("\n")).not.toContain("\x1b[2J");
      expect(summary[1]).toBe(f.theme.fg("muted", stripVTControlCharacters(summary[1]!)));
      const list = stripVTControlCharacters(f.picker.render(width, 12, true, false).join("\n"));
      expect(list).not.toContain("简介");
      expect(list).toContain("[x] Keep 中文😀");
      const narrow = stripVTControlCharacters(f.render(width, 12).join("\n"));
      expect(narrow).toContain("简介");
      expect(narrow.replace(/\s+/gu, " ")).toContain("literal **text**");
    }
    const clipped = f.picker.renderDescription(24, 3);
    expect(clipped).toHaveLength(3);
    expect(stripVTControlCharacters(clipped[2]!)).toContain("…");
    f.picker.handleInput("\x1b[A");
    expect(stripVTControlCharacters(f.picker.renderDescription(60, 6).join("\n"))).toContain("Rewrite description");
    expect(f.state.selected).toEqual(selected);
    expect(f.save).not.toHaveBeenCalled(); expect(f.load).toHaveBeenCalledTimes(1);
    f.picker.handleInput("/"); f.picker.handleInput("no matches");
    expect(f.picker.renderDescription(60, 6)).toEqual([]);
    f.picker.dispose();
  });

  it.each(["dark", "light"])("previews literal instructions with distinct heading and description styles (%s)", async (themeName) => {
    const entry = { ...first, body: "# Literal **instructions** 中文😀\n\x1b[1mDo not render Markdown\x1b[22m\n".repeat(10),
      metadata: { ...first.metadata!, description: "Description 中文😀\x1b[2J\nSecond line\nThird line\nFourth line" } };
    const f = fixture([entry, second], [], themeName); await Promise.resolve();
    vi.spyOn(f.theme, "bold").mockImplementation((text) => `\x1b[1m${text}\x1b[22m`);
    f.picker.handleInput("\x1b[F");
    const preview = f.picker.renderPreview(60, 14);
    expect(preview[0]).toBe(f.theme.fg("text", f.theme.bold(entry.name)));
    expect(preview[1]).toBe(f.theme.fg("muted", sanitizeTerminalText(entry.metadata.description.split("\n")[0]!)));
    const literal = preview.find((line) => stripVTControlCharacters(line).startsWith("# Literal"));
    expect(literal).toBe(f.theme.fg("text", "# Literal **instructions** 中文😀"));
    expect(literal).not.toContain("\x1b[1m");
    expect(preview.join("\n")).toContain(sanitizeTerminalText("\x1b[1mDo not render Markdown\x1b[22m"));
    expect(preview.at(-1)).toBe(f.theme.fg("muted", "… · ") + formatKeyHint(["o", "Read full"], f.theme));
    for (const [width, height] of [[60, 14], [24, 8], [3, 6], [2, 2], [1, 8], [1, 2], [60, 14], [60, 0], [0, 10]]) {
      const lines = f.picker.renderPreview(width!, height!);
      expect(lines.length).toBeLessThanOrEqual(height!);
      expect(lines.every((line) => visibleWidth(line) <= width!)).toBe(true);
      expect(lines.join("\n")).not.toContain("\x1b[2J");
    }
    // A legacy entry without metadata still has useful instructions to preview.
    f.library({ entries: [{ ...entry, metadata: undefined, body: "Legacy **literal** body" }], errors: {} });
    await f.picker.refresh();
    expect(f.picker.renderPreview(60, 8)).toEqual([
      f.theme.fg("text", f.theme.bold(entry.name)), f.theme.fg("text", "Legacy **literal** body"),
    ]);
    expect(f.state.selected).toEqual([]);
    expect(f.save).not.toHaveBeenCalled();
    f.picker.handleInput("/"); f.picker.handleInput("no matches");
    expect(f.picker.renderPreview(60, 8)).toEqual([]);
    f.picker.dispose();
    expect(f.picker.renderPreview(60, 8)).toEqual([]);
  });

  it.each(["dark", "light"])("previews the checked snapshot when its source changes or disappears (%s)", async (themeName) => {
    const f = fixture([first], [selectPreference(first)], themeName); await Promise.resolve();
    f.library({ entries: [{ ...first, version: 2, name: "New library name", body: "New library body" }], errors: {} });
    await f.picker.refresh();
    let preview = f.picker.renderPreview(100, 10).join("\n");
    expect(preview).toContain("Original body");
    expect(preview).not.toContain("New library body");
    expect(preview).toContain(f.theme.fg("warning", "⚠ Source changed; selected snapshot retained. Deselect and reselect to use the current entry."));
    for (const errors of [{}, { project: "Unavailable" }]) {
      f.library({ entries: [], errors }); await f.picker.refresh();
      preview = f.picker.renderPreview(100, 10).join("\n");
      expect(preview).toContain("Original body");
      expect(preview).toContain(f.theme.fg("warning", "⚠").split("⚠")[0] + "⚠");
    }
    expect(f.state.selected).toEqual([selectPreference(first)]);
    expect(f.save).not.toHaveBeenCalled();
    f.picker.dispose();
  });

  it("reuses instruction wrapping across focus and height changes, and refreshes changed content", async () => {
    const f = fixture([first], [selectPreference(first)]); await Promise.resolve();
    const clean = vi.spyOn(presentation, "sanitizeTerminalText");
    const preparations = () => clean.mock.calls.filter(([text]) => text === first.body).length;
    f.picker.renderPreview(60, 10);
    const count = preparations();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < 10; i++) {
      f.picker.focused = i % 2 === 0;
      f.picker.setTarget(1, i % 2 === 0);
      f.picker.renderPreview(60, i % 2 === 0 ? 12 : 8);
    }
    f.picker.setTarget(1, true);
    expect(preparations()).toBe(count);
    f.state.selected[0]!.body = "Updated snapshot **literal**";
    expect(stripVTControlCharacters(f.picker.renderPreview(60, 10).join("\n"))).toContain("Updated snapshot **literal**");
    expect(clean).toHaveBeenCalledWith("Updated snapshot **literal**");
    f.picker.invalidate();
    f.picker.renderPreview(24, 10);
    expect(f.load).toHaveBeenCalledTimes(1);
    expect(f.save).not.toHaveBeenCalled();
    f.picker.dispose();
  });

  it.each(["dark", "light"])("reserves right-aligned source columns through focus, scrolling and resize (%s)", async (themeName) => {
    const entries = [
      { ...second, name: "Long 中文😀\x1b[31m " + "名称".repeat(30) },
      { ...first, name: "Short 中文😀" },
    ];
    const f = fixture(entries, [], themeName); await Promise.resolve();
    for (const active of [true, false, true]) {
      f.picker.setTarget(1, active);
      for (const width of [1, 2, 3, 8, 12, 24, 27, 28, 36, 60, 24]) {
        const lines = f.render(width, 16);
        const labels = width >= 28 ? [" Global", "Project"] : ["G", "P"];
        const rows = lines.filter((line) => labels.some((label) => line.includes(f.theme.fg("muted", label))));
        expect(rows).toHaveLength(2);
        for (const [index, row] of rows.entries()) {
          const label = labels[index]!;
          const source = f.theme.fg("muted", label);
          expect(visibleWidth(row.slice(0, row.indexOf(source))) + visibleWidth(label)).toBe(width);
          expect(visibleWidth(row)).toBe(width);
          expect(row.slice(row.indexOf(source))).not.toContain("\x1b[1m");
          expect(row).not.toContain("\x1b[31m");
        }
        if (width >= 12) expect(stripVTControlCharacters(rows[0]!)).toContain("…");
        expect(f.render(width, 16)).toEqual(lines);
      }
    }
    f.picker.handleInput("\x1b[B"); f.picker.handleInput(" ");
    for (const width of [24, 60, 24]) {
      const row = f.render(width, 3).find((line) => line.includes(f.theme.fg("muted", width >= 28 ? "Project" : "P")))!;
      expect(row).toBeDefined();
      expect(visibleWidth(row)).toBe(width);
      expect(row).toContain(f.theme.bg("selectedBg", "").split("\x1b[49m")[0]);
    }
    expect(f.state.selected).toEqual([selectPreference(entries[1]!)]);
    expect(f.save).toHaveBeenCalledOnce(); expect(f.load).toHaveBeenCalledOnce();
    f.picker.dispose();
  });

  it.each(["dark", "light"])("keeps snapshot warning markers independent of the source column down to one cell (%s)", async (themeName) => {
    for (const state of ["deleted", "changed", "unavailable"]) {
      const entry = { ...first, name: "Retained 中文😀 " + "长".repeat(30) };
      const f = fixture(state === "deleted" ? [] : [{ ...entry, version: state === "changed" ? 2 : 1 }], [selectPreference(entry)], themeName);
      if (state === "unavailable") f.library({ entries: [], errors: { project: "Offline" } });
      await f.picker.refresh();
      for (const width of [1, 2, 3, 8, 12, 24, 28, 36]) {
        const source = f.theme.fg("muted", width >= 28 ? "Project" : "P");
        const row = f.render(width, 16).find((line) => line.includes(source))!;
        expect(row).toBeDefined(); expect(visibleWidth(row)).toBe(width);
        expect(visibleWidth(row.slice(0, row.indexOf(source))) + visibleWidth(width >= 28 ? "Project" : "P")).toBe(width);
        if (width > 1) expect(row).toContain(f.theme.fg("warning", width >= 12 ? "! " : "!"));
        if (width <= 3) expect(stripVTControlCharacters(row)).toBe(width === 1 ? "P" : width === 2 ? "!P" : "! P");
      }
      expect(f.state.selected).toEqual([selectPreference(entry)]);
      expect(f.save).not.toHaveBeenCalled(); f.picker.dispose();
    }
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

  it("reuses nonempty search results across cloned controller selections and invalidates on changes", async () => {
    const controller = new RefineController({ complete: vi.fn(), maxDraftChars: 16000, timeoutMs: 1000, onState() {} }, { provider: "p", id: "m" });
    controller.setSession("s");
    const input = { draft: "Original", sessionId: "s", branchLeafId: null, model: { provider: "p", id: "m" },
      systemPrompt: "Policy", history: selectHistory([], 0, 0), preferences: [selectPreference(first)] };
    controller.createDraft(input);
    const original = controller.getHistory()[0]!;
    const entries = [first, ...Array.from({ length: 400 }, (_, index) => ({ ...second, id: `item-${index}`,
      scope: index < 200 ? "project" as const : "global" as const, body: "Original body 中文😀 ".repeat(40) }))];
    const load = vi.fn(async () => ({ entries: structuredClone(entries), errors: {} }));
    // Match extension.ts's original-row adapter: each lookup is a detached controller read.
    const target = (id: number) => {
      const source = controller.getOriginalRecord(id);
      return source && { selected: source.input.preferences ?? [], save: source.status === "unsent"
        ? (selected: SelectedPreference[]) => controller.updateDraftPreferences(source, selected) : undefined };
    };
    expect(target(original.id)!.selected).not.toBe(target(original.id)!.selected);
    const picker = new InlinePreferences({ load, save: vi.fn(), remove: vi.fn() }, target,
      getThemeByName("dark")!, getKeybindings(), vi.fn());
    try {
      picker.setTarget(original.id, true); await Promise.resolve();
      picker.handleInput("/"); picker.handleInput("Original"); picker.handleInput("\r");
      const search = vi.spyOn(preferences, "searchPreferences");
      const start = performance.now();
      picker.render(80, 10);
      for (let index = 0; index < 30; index++) {
        picker.focused = index % 2 === 0;
        picker.setTarget(original.id, index % 2 === 0);
        picker.render(index % 2 === 0 ? 24 : 100, index % 2 === 0 ? 5 : 12);
        picker.handleInput("\x1b[B");
      }
      if (process.env.REFINE_PERF === "1") console.log({ elapsedMs: performance.now() - start, searches: search.mock.calls.length });
      expect(search).toHaveBeenCalledTimes(1);
      expect(load).toHaveBeenCalledTimes(1);
      const searches = () => search.mock.calls.length;
      // Same query, new selected content: both filtering and snapshot display must update.
      const source = controller.getOriginalRecord(original.id)!;
      const selected = structuredClone(source.input.preferences!);
      selected[0]!.body = "No longer matches";
      expect(controller.updateDraftPreferences(source, selected)).toBeUndefined();
      picker.render(80, 10); expect(searches()).toBe(2);
      // Query changes and library refreshes also invalidate the cache.
      picker.handleInput("/"); picker.handleInput(" body"); picker.handleInput("\r");
      picker.render(80, 10); expect(searches()).toBe(3);
      await picker.refresh(); picker.render(80, 10); expect(searches()).toBe(4);
      const current = controller.getOriginalRecord(original.id)!;
      const next = structuredClone(current.input.preferences!);
      next[0]!.metadata!.description = "Original body from snapshot";
      expect(controller.updateDraftPreferences(current, next)).toBeUndefined();
      picker.handleInput("\x1b[F"); // Task snapshots follow the rewriting group.
      expect(stripVTControlCharacters(picker.render(80, 10).join("\n"))).toContain("[x] ! Keep 中文😀");
      expect(searches()).toBe(5);
      // No internal preference array/metadata is exposed by controller reads.
      const detached = target(original.id)!.selected;
      detached[0]!.metadata!.description = "Caller mutation";
      expect(target(original.id)!.selected[0]!.metadata!.description).toBe("Original body from snapshot");
      expect(controller.updateDraftPreferences(controller.getOriginalRecord(original.id)!, [])).toBeUndefined();
      picker.render(80, 10); expect(searches()).toBe(6);
    } finally { picker.dispose(); controller.setSession("other"); }
  });

  it("invalidates the cached selection value even if a caller mutates its array in place", async () => {
    const f = fixture([first], [selectPreference(first)]); await Promise.resolve();
    f.picker.handleInput("/"); f.picker.handleInput("Literal"); f.picker.handleInput("\r");
    expect(f.text()).toContain("[x] Keep 中文😀");
    f.state.selected[0]!.metadata!.description = "No match";
    expect(f.text()).toContain("No matches");
    f.picker.dispose();
  });

  it("retains independent document positions across focus changes and originals, but refreshes source comparisons", async () => {
    const f = fixture(); await Promise.resolve();
    f.picker.handleInput("\x1b[F");
    f.picker.handleInput("o"); f.text(50, 8);
    f.picker.handleInput("\x1b[6~");
    const scrolled = f.text(50, 8);
    expect(scrolled).not.toContain("Library entry");
    f.picker.setTarget(1, false); f.text(); f.picker.setTarget(1, true);
    expect(f.text(50, 8)).toBe(scrolled);
    f.picker.setTarget(2, true); expect(f.picker.hints).toBe("select");
    f.picker.setTarget(1, true); expect(f.text(50, 8)).toBe(scrolled);
    f.picker.handleInput("\x1b"); f.picker.handleInput("o");
    expect(f.text(50, 8)).toBe(scrolled);
    f.library({ entries: [{ ...first, version: 2, body: "Changed body" }], errors: {} });
    await f.picker.refresh(); expect(f.picker.hints).toBe("select");
    f.picker.handleInput("o"); expect(f.text()).toContain("Changed body");
    f.picker.dispose();
  });

  it("uses only Space to toggle and returns without changing selections on Esc or Tab", async () => {
    const f = fixture(); await Promise.resolve();
    f.picker.handleInput("\x1b[F");
    for (const key of ["\x1b", "\t", "\x1b[Z", "\x1b[9u"]) {
      expect(f.picker.handleInput(key)).toBe("back");
      expect(f.state.selected).toEqual([]);
    }
    expect(f.save).not.toHaveBeenCalled();
    f.picker.handleInput(" ");
    expect(f.state.selected).toEqual([selectPreference(first)]);
    for (const key of ["\t", "\x1b", "\x1b[Z"]) {
      expect(f.picker.handleInput(key)).toBe("back");
      expect(f.state.selected).toEqual([selectPreference(first)]);
    }
    expect(f.save).toHaveBeenCalledTimes(1);
    f.picker.handleInput(" ");
    expect(f.state.selected).toEqual([]);
    expect(f.save).toHaveBeenCalledTimes(2);
    f.picker.dispose();
  });

  it("returns submission only from selection, including an empty library, never from search or full text", async () => {
    for (const entries of [[], [first]]) {
      const f = fixture(entries); await Promise.resolve();
      expect(f.picker.handleInput("\r")).toBe("submit");
      expect(f.save).not.toHaveBeenCalled();
      f.picker.handleInput("/"); f.picker.handleInput("Keep");
      for (const key of ["\t", "\x1b[Z"]) expect(f.picker.handleInput(key)).toBeUndefined();
      expect(f.picker.hints).toBe("search");
      expect(f.picker.handleInput("\r")).toBeUndefined();
      expect(f.picker.hints).toBe("select");
      if (entries.length) {
        f.picker.handleInput("o");
        expect(f.picker.hints).toBe("read");
        for (const key of ["\r", "\t", "\x1b[Z", "\x13", "p", " "]) expect(f.picker.handleInput(key)).toBeUndefined();
        expect(f.picker.hints).toBe("read");
        f.picker.handleInput("\x1b");
      }
      expect(f.picker.handleInput("\r")).toBe("submit");
      f.state.editable = false;
      expect(f.picker.handleInput("\r")).toBe("back");
      f.picker.dispose();
    }
  });

  it("recovers its cursor after End on an empty or loading library and enforces the item limit", async () => {
    const f = fixture();
    f.picker.handleInput("\x1b[F"); // Before the initial asynchronous load settles.
    await Promise.resolve(); expect(f.text()).toContain("› [ ] Rewrite");
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
