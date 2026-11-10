import { afterEach, describe, expect, it, vi } from "vitest";
import { formatKeyHint } from "../../src/key-hints.js";
import { PreferencePanel } from "../../src/preference-panel.js";
import * as presentation from "../../src/presentation.js";
import { composeRevision, selectPreference, type RevisionPreference } from "../../src/revision-preferences.js";
import { a, b, backTab, bringBack, ctrlS, down, enter, esc, highlightedRow, listRows, loaded, save, search, setup, tab, text } from "../support/preference-panel.js";

afterEach(() => vi.restoreAllMocks());

describe("selected-only preference audit", () => {
  it.each(["dark", "light"])("labels retained snapshot and actual updated source separately, snapshot first (%s)", async (themeName) => {
    const original: RevisionPreference = { ...a, name: "Retained name", body: "RETAINED_BODY", metadata: {
      kind: "rewrite", activation: "manual", description: "Retained description" } };
    const selected = selectPreference(original);
    const current: RevisionPreference = { ...a, version: 2, name: "Current name", body: "CURRENT_BODY", metadata: {
      kind: "task", activation: "manual", description: "Current description" } };
    const f = setup([selected], "", themeName, [current]); await loaded(f.panel);
    vi.spyOn(f.theme, "bold").mockImplementation((value) => `\x1b[1m${value}\x1b[22m`);
    f.panel.invalidate();
    // Cache All's source-first preview before switching to the audit document.
    expect(text(f.panel)).toContain(current.name);
    f.panel.handleInput("s");
    const preview = text(f.panel);
    expect(preview.indexOf("Selected snapshot")).toBeLessThan(preview.indexOf("Current library entry"));
    expect(preview).toContain("Library changed; snapshot kept");
    expect(preview).not.toContain(`global · ${original.id}`);
    expect(preview).not.toContain("· manual");
    expect(f.panel.render(100).join("\n")).toContain(f.theme.fg("warning", "Saved snapshot · Library changed; snapshot kept"));
    f.panel.handleInput(enter);
    const output = text(f.panel);
    const [snapshot, source] = output.split("Current library entry");
    for (const value of ["Selected snapshot", original.name, original.body, original.metadata!.description,
      "Prompt rewriting · manual", "Manually selected"]) expect(snapshot).toContain(value);
    for (const value of [current.name, current.body, current.metadata!.description, "Task requirements · manual"]) {
      expect(source).toContain(value);
      expect(snapshot).not.toContain(value);
    }
    expect(source).not.toContain(original.body);
    expect(output.split(original.body)).toHaveLength(2); // Never render the old snapshot twice.
    const styled = f.panel.render(100).join("\n");
    expect(styled).toContain(f.theme.fg("text", f.theme.bold("Selected snapshot")));
    expect(styled).toContain(f.theme.fg("text", f.theme.bold("Current library entry")));
    expect(styled).toContain(f.theme.fg("text", current.body));
    expect(styled).toContain(f.theme.fg("muted", current.metadata!.description));
    expect(styled).toContain(f.theme.fg("warning", "Saved snapshot · Library changed; snapshot kept"));
    f.panel.handleInput(esc); f.panel.handleInput("s"); f.panel.handleInput(enter);
    const all = text(f.panel);
    expect(all.indexOf(current.body)).toBeLessThan(all.indexOf("Selected snapshot"));
    expect(all.indexOf("Selected snapshot")).toBeLessThan(all.indexOf(original.body));
    expect(all).not.toContain("Current library entry"); // All keeps its existing source-first presentation.
  });

  it.each(["dark", "light"])("labels a deleted source as a retained snapshot, not a library entry (%s)", async (themeName) => {
    const f = setup([selectPreference(a)], "", themeName, []); await loaded(f.panel);
    f.panel.handleInput("s");
    expect(text(f.panel)).toContain("Source deleted");
    f.panel.handleInput(enter);
    const output = text(f.panel);
    expect(output).toContain("Selected snapshot");
    expect(output).toContain("Source deleted");
    expect(output).toContain(a.name);
    expect(output.split(a.body)).toHaveLength(2);
    expect(output).not.toContain("Library entry");
    expect(output).not.toContain("Current library entry");
  });

  it.each(["dark", "light"])("does not present unavailable or cached source text as current (%s)", async (themeName) => {
    for (const cached of [false, true]) {
      const current = { ...a, version: 2, name: "Unverified name", body: "UNVERIFIED_BODY" };
      const f = setup([selectPreference(a)], "", themeName); await loaded(f.panel); f.panel.dispose();
      f.repo.load.mockResolvedValueOnce({ entries: cached ? [current] : [], errors: { global: "Offline" } });
      const panel = new PreferencePanel(f.tui, f.theme, f.keys, f.repo, [selectPreference(a)], "", 16000, f.close);
      await loaded(panel); panel.handleInput("s"); panel.handleInput(enter);
      const output = text(panel);
      expect(output).toContain("Selected snapshot");
      expect(output).toContain("Library unavailable");
      expect(output.split(a.body)).toHaveLength(2);
      for (const value of ["Source deleted", "Library entry", "Current library entry", current.name, current.body]) expect(output).not.toContain(value);
      panel.dispose();
    }
  });

  it("does not duplicate an unchanged snapshot and reuses its document across focus changes", async () => {
    const f = setup([selectPreference(a)]); await loaded(f.panel);
    f.panel.handleInput("s"); text(f.panel);
    const sanitize = vi.spyOn(presentation, "sanitizeTerminalText");
    for (let i = 0; i < 6; i++) { f.panel.handleInput(tab); text(f.panel); }
    expect(sanitize.mock.calls.some(([value]) => value === a.body)).toBe(false);
    f.panel.handleInput(enter);
    expect(text(f.panel).split(a.body)).toHaveLength(2);
    expect(text(f.panel)).not.toContain("Current library entry");
    f.panel.handleInput(esc); f.panel.handleInput("s"); f.panel.handleInput(enter);
    expect(text(f.panel).split(a.body)).toHaveLength(3); // All's original library + selected snapshot sections.
    f.panel.handleInput(esc); f.panel.handleInput("s"); f.panel.handleInput(enter);
    expect(text(f.panel).split(a.body)).toHaveLength(2); // Mode change invalidates the document cache.
  });

  it("keeps selected-view edit and delete confirmation bound to the actual current source", async () => {
    const current = { ...a, version: 2, name: "Current source", body: "Current instruction" };
    const selected = selectPreference(a);
    const f = setup([selected], "", "dark", [current]); await loaded(f.panel); f.panel.handleInput("s");
    f.panel.handleInput("e"); f.panel.handleInput("\x05"); // Move the native input cursor past the name.
    expect(text(f.panel)).toContain("Name: Current source");
    expect(text(f.panel)).toContain(current.body);
    save(f.panel); await loaded(f.panel);
    expect(f.repo.save).toHaveBeenCalledWith(current.scope, { name: current.name, body: current.body }, current);
    f.panel.handleInput("d");
    const confirmation = text(f.panel);
    expect(confirmation.indexOf(current.body)).toBeLessThan(confirmation.indexOf("Selected snapshot"));
    expect(confirmation).toContain("Delete library entry?");
    f.panel.handleInput("y"); await loaded(f.panel);
    expect(f.repo.remove).toHaveBeenCalledWith({ ...current, version: 3 });
    f.panel.handleInput(bringBack);
    expect(f.close).toHaveBeenCalledWith([selected]);
  });

  it("audits snapshots in composition order regardless of all-view search or library rank", async () => {
    const deleted = { ...selectPreference(a), id: "deleted", name: "Gone", body: "Archived requirement", sourceBody: "Archived requirement",
      metadata: { kind: "rewrite" as const, description: "Retained requirements", activation: "manual" as const } };
    const selected = [selectPreference(b), selectPreference(a), deleted];
    const f = setup(selected, "Extra", "dark", [{ ...a, name: "Renamed", body: "Changed source", version: 2 }, b]);
    await loaded(f.panel);
    search(f.panel, "Literal");
    expect(listRows(f.panel)).toHaveLength(1);
    f.panel.handleInput("s");
    expect(text(f.panel)).toContain("Preferences · Selected only");
    expect(listRows(f.panel).map((row) => row.trim())).toEqual([
      expect.stringContaining(b.name), expect.stringContaining(a.name), expect.stringContaining(deleted.name),
    ]);
    expect(text(f.panel)).toContain("Search: ");
    f.panel.handleInput(down); f.panel.handleInput(enter);
    expect(text(f.panel)).toContain("Library changed; snapshot kept");
    expect(text(f.panel)).toContain(a.body);
    f.panel.handleInput(esc); f.panel.handleInput(down); f.panel.handleInput(enter);
    expect(text(f.panel)).toContain("Source deleted");
    expect(text(f.panel)).toContain("Manually selected");
    f.panel.handleInput(esc);
    search(f.panel, "keep");
    // Search would rank by name in All; Selected must keep the original sequence.
    expect(listRows(f.panel)).toHaveLength(2);
    expect(listRows(f.panel)[0]).toContain(b.name);
    expect(listRows(f.panel)[1]).toContain(a.name);
    f.panel.handleInput(" "); // Deselect the first visible snapshot, not a library-ranked result.
    expect(listRows(f.panel)).toHaveLength(1);
    f.panel.handleInput("s");
    expect(text(f.panel)).toContain("Search: Literal");
    expect(highlightedRow(f.panel)).toContain(b.name);
    f.panel.handleInput("s"); // Every audit starts unfiltered again.
    expect(listRows(f.panel)).toHaveLength(2);
    f.panel.handleInput(ctrlS);
    expect(f.close).not.toHaveBeenCalled();
    f.panel.handleInput(bringBack);
    expect(f.close).toHaveBeenCalledWith([selected[1], deleted]);
    expect(selected).toEqual([selectPreference(b), selectPreference(a), deleted]);
    expect(f.repo.load).toHaveBeenCalledTimes(1);
    expect(f.repo.save).not.toHaveBeenCalled();
  });

  it("keeps filtered selections in composition order even when an exact name would rank later", async () => {
    const first = { ...a, name: "Extended keep" }, second = { ...b, name: "keep" };
    const f = setup([selectPreference(first), selectPreference(second)], "", "dark", [second, first]);
    await loaded(f.panel); f.panel.handleInput("s"); search(f.panel, "keep");
    expect(listRows(f.panel)[0]).toContain(first.name);
    expect(listRows(f.panel)[1]).toContain(second.name);
    f.panel.handleInput(bringBack);
    expect(composeRevision(f.close.mock.calls[0]![0], "")).toBe(composeRevision([selectPreference(first), selectPreference(second)], ""));
  });

  it("restores the all-view query, highlight and scrolled viewport; cancels transactionally", async () => {
    const entries = Array.from({ length: 45 }, (_, i) => ({ ...a, id: `${i}`, name: `Entry ${i}` }));
    const initial = [selectPreference(entries[2]!)];
    const f = setup(initial, "", "dark", entries); await loaded(f.panel);
    f.terminal.rows = 16; search(f.panel, "Entry"); f.panel.handleInput("\x1b[F");
    const before = listRows(f.panel);
    expect(before.at(-1)).toContain("Entry 44");
    f.panel.handleInput(tab); // Actions owns the same view toggle, without a new focus stop.
    f.panel.handleInput("s"); expect(text(f.panel)).toContain("Focus: Actions");
    f.panel.handleInput(backTab); f.panel.handleInput(" ");
    expect(text(f.panel)).toContain("No selections");
    f.panel.handleInput("s");
    expect(text(f.panel)).toContain("Search: Entry");
    expect(listRows(f.panel)).toEqual(before);
    f.panel.handleInput(esc);
    expect(f.close).toHaveBeenCalledWith();
    expect(initial).toEqual([selectPreference(entries[2]!)]);
  });

  it("keeps s as text in Search and forms and advertises only current-focus actions", async () => {
    const f = setup([selectPreference(a)]); await loaded(f.panel);
    expect(f.panel.render(100).join("\n")).toContain(formatKeyHint(["s", "Selected only"], f.theme));
    f.panel.handleInput("s");
    expect(f.panel.render(100).join("\n")).toContain(formatKeyHint(["Space", "Deselect"], f.theme));
    f.panel.handleInput("/"); f.panel.handleInput("s");
    expect(text(f.panel)).toContain("Search: s");
    expect(text(f.panel)).toContain("Preferences · Selected only");
    expect(f.panel.render(100).slice(-2).join("\n")).not.toContain(formatKeyHint(["s", "All"], f.theme));
    f.panel.handleInput(enter); f.panel.handleInput("n"); f.panel.handleInput("s");
    expect(text(f.panel)).toContain("Name: s");
    f.panel.handleInput(tab); f.panel.handleInput("s");
    expect(f.repo.save).not.toHaveBeenCalled();
  });
});

describe("new preference save identity and reveal", () => {
  it.each(["query", "selected", "both", "none"])("reveals the returned NEW identity at Library focus under %s without selecting it", async (mode) => {
    const f = setup([selectPreference(b)]); await loaded(f.panel);
    if (mode === "query" || mode === "both") search(f.panel, "No match");
    if (mode === "selected" || mode === "both") f.panel.handleInput("s");
    if (mode === "both") search(f.panel, "Missing snapshot");
    f.panel.handleInput(tab); f.panel.handleInput("n"); f.panel.handleInput(a.name); // Duplicate name is not an identity.
    save(f.panel); await loaded(f.panel);
    expect(text(f.panel)).toContain("Focus: Library");
    expect(text(f.panel)).not.toContain("Preferences · Selected only");
    expect(text(f.panel)).not.toContain("Search: No match");
    expect(text(f.panel)).toContain("Saved; not selected.");
    expect(text(f.panel).includes("Filters reset to All.")).toBe(mode !== "none");
    expect(highlightedRow(f.panel)).toContain(`› [ ] ${a.name}`);
    f.panel.handleInput(enter);
    expect(text(f.panel)).toContain("project · new");
    expect(text(f.panel)).toContain("Extra");
    f.panel.handleInput(esc); f.panel.handleInput(bringBack);
    expect(f.close).toHaveBeenCalledWith([selectPreference(b)]);
  });

  it("keeps a NEW form, filters and snapshots on failure, then reveals a successful retry", async () => {
    const original = [selectPreference(a)]; const f = setup(original); await loaded(f.panel);
    search(f.panel, "Literal"); f.panel.handleInput("s"); search(f.panel, "Concise");
    f.repo.save.mockRejectedValueOnce(new Error("Disk full"));
    f.panel.handleInput("n"); f.panel.handleInput("Retry me"); save(f.panel); await loaded(f.panel);
    expect(text(f.panel)).toContain("Save new preference");
    expect(text(f.panel)).toContain("Name: Retry me");
    expect(text(f.panel)).toContain("Disk full");
    f.panel.handleInput(esc); f.panel.handleInput("n"); // Keep the failed form.
    expect(text(f.panel)).toContain("Name: Retry me");
    f.panel.handleInput(enter); await loaded(f.panel); // Save remains focused.
    expect(text(f.panel)).toContain("Filters reset to All.");
    expect(highlightedRow(f.panel)).toContain("Retry me");
    f.panel.handleInput(bringBack);
    expect(f.close).toHaveBeenCalledWith(original);
  });

  it.each(["throw", "scope"])("reveals the confirmed write but reports %s refresh failure instead of claiming a fresh library", async (failure) => {
    const f = setup([selectPreference(a)]); await loaded(f.panel);
    search(f.panel, "Hidden");
    if (failure === "throw") f.repo.load.mockRejectedValueOnce(new Error("Offline"));
    else f.repo.load.mockResolvedValueOnce({ entries: [a], errors: { project: "Offline" } });
    f.panel.handleInput("n"); f.panel.handleInput("Saved offline"); save(f.panel); await loaded(f.panel);
    expect(text(f.panel)).toContain("Refresh failed after save; not selected.");
    expect(text(f.panel)).toContain("Filters reset to All.");
    expect(highlightedRow(f.panel)).toContain("Saved offline");
    f.panel.handleInput(enter);
    expect(text(f.panel)).toContain("Library unavailable");
    expect(text(f.panel)).toContain("project · new");
    f.panel.handleInput(esc); f.panel.handleInput(bringBack);
    expect(f.close).toHaveBeenCalledWith([selectPreference(a)]);
  });

  it("reports a concurrently removed saved identity rather than highlighting another same-name entry as it", async () => {
    const f = setup(); await loaded(f.panel);
    f.repo.load.mockResolvedValueOnce({ entries: [a, b], errors: {} });
    f.panel.handleInput("n"); f.panel.handleInput(a.name); save(f.panel); await loaded(f.panel);
    expect(text(f.panel)).toContain("Saved entry no longer in library; could not reveal it.");
    expect(text(f.panel)).toContain("0 selected");
  });

  it("keeps edit query, selected-only mode and focus semantics while preserving the selected snapshot", async () => {
    const selected = [selectPreference(b), selectPreference(a)]; const f = setup(selected); await loaded(f.panel);
    f.panel.handleInput("s"); search(f.panel, "Concise"); f.panel.handleInput(tab);
    f.panel.handleInput("e"); f.panel.handleInput(" renamed"); save(f.panel); await loaded(f.panel);
    expect(text(f.panel)).toContain("Focus: Actions");
    expect(text(f.panel)).toContain("Preferences · Selected only");
    expect(text(f.panel)).toContain("Search: Concise");
    expect(listRows(f.panel)).toHaveLength(1);
    f.panel.handleInput(bringBack);
    expect(f.close).toHaveBeenCalledWith(selected);
  });
});
