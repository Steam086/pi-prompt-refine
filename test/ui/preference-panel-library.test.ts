import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { panelLayout } from "../../src/panel-layout.js";
import { composeRevision, selectPreference, type RevisionPreference, type SelectedPreference } from "../../src/revision-preferences.js";
import { a, b, backTab, bringBack, ctrlS, down, enter, esc, loaded, right, save, search, setup, tab, text } from "../support/preference-panel.js";

afterEach(() => vi.restoreAllMocks());

describe("Library purpose groups", () => {
  it.each(["dark", "light"])("keeps the right preview compact while retaining full details (%s)", async (themeName) => {
    const entry: RevisionPreference = { ...a, id: "preview-uuid", metadata: {
      kind: "rewrite", activation: "manual", description: "整理并列要求 😀" } };
    const f = setup([], "", themeName, [entry]); await loaded(f.panel);
    const lines = f.panel.render(100);
    expect(lines.every((line) => visibleWidth(line) <= 100)).toBe(true);
    const preview = lines.map((line) => stripVTControlCharacters(line).split(" │ ")[1] ?? "").join("\n");
    expect(preview).toContain(entry.name);
    expect(preview).toContain("Prompt rewriting");
    expect(preview).toContain(entry.metadata!.description);
    expect(preview).toContain(entry.body);
    expect(preview.indexOf(entry.metadata!.description)).toBeLessThan(preview.indexOf(entry.body));
    for (const redundant of [entry.id, "Library entry", "· manual"]) expect(preview).not.toContain(redundant);
    expect(lines.join("\n")).toContain(f.theme.fg("muted", "Prompt rewriting"));
    expect(lines.join("\n")).toContain(f.theme.fg("text", entry.body));
    f.panel.handleInput(enter);
    const full = text(f.panel);
    expect(full).toContain(`global · ${entry.id}`);
    expect(full).toContain("Library entry");
    expect(full).toContain("Prompt rewriting · manual");
  });

  const task: RevisionPreference = { ...a, id: "task", name: "Z task 中文😀", metadata: { kind: "task", description: "", activation: "manual" } };
  const rewrite: RevisionPreference = { ...b, id: "rewrite", name: "A rewrite", metadata: { kind: "rewrite", description: "", activation: "manual" } };

  it.each(["dark", "light"])("groups by purpose without changing selection order or source styling (%s)", async (themeName) => {
    const f = setup([], "", themeName, [task, rewrite, b]);
    await loaded(f.panel);
    const lines = f.panel.render(100);
    const left = lines.map((line) => stripVTControlCharacters(line).split("│")[0]!).join("\n");
    expect(left.indexOf("Prompt rewriting")).toBeLessThan(left.indexOf(rewrite.name));
    expect(left.indexOf(rewrite.name)).toBeLessThan(left.indexOf("Task requirements"));
    expect(left.indexOf("Task requirements")).toBeLessThan(left.indexOf(task.name));
    expect(left.indexOf(task.name)).toBeLessThan(left.indexOf("Unclassified"));
    expect(lines.join("\n")).toContain(f.theme.fg("text", f.theme.bold("Task requirements")));
    expect(lines.join("\n")).toContain(f.theme.fg("text", f.theme.bold("Prompt rewriting")));
    expect(lines.join("\n")).toContain(f.theme.fg("muted", "Project"));
    expect(lines.join("\n")).toContain(f.theme.fg("muted", " Global"));
    // Navigation skips non-interactive headings and spacers; bring-back is shared.
    f.panel.handleInput(down); f.panel.handleInput(" "); f.panel.handleInput("\x1b[A"); f.panel.handleInput(" ");
    f.panel.handleInput(bringBack);
    const selected = f.close.mock.calls[0]![0] as SelectedPreference[];
    expect(selected.map((entry) => entry.id)).toEqual(["task", "rewrite"]);
    const composed = composeRevision(selected, "");
    expect(composed.indexOf("Main-agent task requirements")).toBeLessThan(composed.indexOf("Prompt rewriting instructions"));
  });

  it("wraps arrow navigation across groups and filtered/selected lists", async () => {
    const f = setup([selectPreference(rewrite), selectPreference(task)], "", "dark", [rewrite, task]);
    await loaded(f.panel);
    const position = () => text(f.panel).match(/(?:Library|Selected) (\d+)\/(\d+)/)?.slice(1);
    expect(position()).toEqual(["1", "2"]);
    f.panel.handleInput("\x1b[A"); expect(position()).toEqual(["2", "2"]);
    f.panel.handleInput(down); expect(position()).toEqual(["1", "2"]);
    f.panel.handleInput("s");
    f.panel.handleInput("\x1b[H"); f.panel.handleInput("\x1b[A"); expect(position()).toEqual(["2", "2"]);
    f.panel.handleInput(down); expect(position()).toEqual(["1", "2"]);
    f.panel.handleInput("s");
    search(f.panel, "Z task");
    for (const key of ["\x1b[A", down]) { f.panel.handleInput(key); expect(position()).toEqual(["1", "1"]); }
    search(f.panel, "No matching preference");
    for (const key of ["\x1b[A", down]) { f.panel.handleInput(key); expect(position()).toEqual(["0", "0"]); }
  });

  it("hides empty groups during search and retains Selected-only adoption order", async () => {
    const f = setup([selectPreference(task), selectPreference(rewrite)], "", "dark", [rewrite, task]);
    await loaded(f.panel);
    search(f.panel, "Z task");
    const left = text(f.panel).split("\n").map((line) => line.split("│")[0]).join("\n");
    expect(left).toContain("Task requirements");
    expect(left).not.toContain("Prompt rewriting");
    expect(left).not.toContain("Unclassified");
    search(f.panel, ""); f.panel.handleInput("s");
    const selected = text(f.panel).split("\n").map((line) => line.split("│")[0]).join("\n");
    expect(selected.indexOf(task.name)).toBeLessThan(selected.indexOf(rewrite.name));
    expect(selected).not.toContain("Task requirements");
    expect(selected).not.toContain("Prompt rewriting");
  });

  it.each(["dark", "light"])("keeps group context and focused entries visible through scroll and resize (%s)", async (themeName) => {
    const entries = Array.from({ length: 24 }, (_, i) => ({ ...(i < 12 ? rewrite : task), id: `entry-${i}`, name: `Item ${String(i).padStart(2, "0")} 中文😀` }));
    const f = setup([], "", themeName, entries); await loaded(f.panel);
    for (const [width, height] of [[100, 16], [45, 14], [100, 20], [100, 40], [45, 14]]) {
      f.terminal.rows = height!;
      f.panel.handleInput("\x1b[H");
      for (let i = 0; i < entries.length; i++) {
        const lines = f.panel.render(width!);
        expect(lines.every((line) => visibleWidth(line) <= width!)).toBe(true);
        const left = lines.map((line) => stripVTControlCharacters(line).split("│")[0]!).join("\n");
        expect(left).toContain(i < 12 ? "Prompt rewriting" : "Task requirements");
        expect(left).toContain(entries[i]!.name);
        if (i < entries.length - 1 && (i !== 11 || height! >= 20)) expect(left).toContain(entries[i + 1]!.name);
        expect(lines.join("\n")).toContain(f.theme.fg("text", f.theme.bold(entries[i]!.name)));
        expect(f.panel.render(width!)).toEqual(lines);
        if (i < entries.length - 1) f.panel.handleInput(down);
      }
      for (let i = entries.length - 2; i >= 0; i--) {
        f.panel.handleInput("\x1b[A");
        const left = text(f.panel, width!).split("\n").map((line) => line.split("│")[0]).join("\n");
        expect(left).toContain(entries[i]!.name);
        if (i > 0 && (i !== 12 || height! >= 20)) expect(left).toContain(entries[i - 1]!.name);
      }
    }
    expect(f.close).not.toHaveBeenCalled();
    expect(f.repo.save).not.toHaveBeenCalled();
  });
});

describe("Preferences management without selection", () => {
  it.each(["dark", "light"])("keeps adopted snapshots read-only while managing current library entries (%s)", async (themeName) => {
    const snapshot = selectPreference(a);
    const f = setup([snapshot], "", themeName, [{ ...a, version: 2, body: "Current library body 中文😀" }], "manage");
    await loaded(f.panel);
    expect(text(f.panel)).toContain("1 frozen snapshots");
    expect(text(f.panel)).not.toContain("Bring back");
    expect(text(f.panel)).not.toContain("Space Select");
    f.panel.handleInput("s");
    f.panel.handleInput(" "); f.panel.handleInput(bringBack); f.panel.handleInput(ctrlS);
    expect(f.close).not.toHaveBeenCalled();
    expect(text(f.panel)).toContain("Library management only");
    f.panel.handleInput(enter);
    expect(text(f.panel)).toContain("Selected snapshot");
    expect(text(f.panel)).toContain(a.body);
    expect(text(f.panel)).toContain("Current library entry");
    expect(text(f.panel)).toContain("Current library body");
    expect(f.panel.render(100).join("\n")).toContain(f.theme.fg("text", a.body));
    for (const [width, rows] of [[100, 40], [40, 16], [20, 8], [12, 6], [100, 40]]) {
      f.terminal.rows = rows!;
      for (const key of ["\x1b[6~", "\x1b[5~"]) {
        f.panel.handleInput(key);
        const lines = f.panel.render(width!);
        expect(lines).toHaveLength(panelLayout(width!, rows!).height);
        expect(lines.every((line) => visibleWidth(line) <= width!)).toBe(true);
      }
    }
    f.panel.handleInput(esc); f.panel.handleInput("e");
    expect(text(f.panel)).toContain("Current library body");
    f.panel.handleInput("\x05"); f.panel.handleInput("\x15"); f.panel.handleInput("Changed name"); save(f.panel); await loaded(f.panel);
    expect(f.repo.save.mock.calls[0]![2]).toMatchObject({ version: 2, body: "Current library body 中文😀" });
    f.panel.handleInput("d"); f.panel.handleInput("y"); await loaded(f.panel);
    expect(f.repo.remove).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ version: 3, name: "Changed name" }));
    f.panel.handleInput(enter);
    expect(text(f.panel)).toContain("Source deleted"); expect(text(f.panel)).toContain(a.body);
    expect(snapshot).toEqual(selectPreference(a));
    f.panel.handleInput(esc); f.panel.handleInput(esc); expect(f.close.mock.calls).toEqual([[]]);
  });

  it("can Add with no adopted snapshots and never returns selections", async () => {
    const f = setup([], "", "dark", [], "manage"); await loaded(f.panel);
    expect(text(f.panel)).toContain("Library is empty");
    f.panel.handleInput("n"); f.panel.handleInput("First 中文😀"); f.panel.handleInput(tab); f.panel.handleInput("Keep literal commands.");
    for (let i = 0; i < 4; i++) f.panel.handleInput(tab);
    f.panel.handleInput(enter); await loaded(f.panel);
    expect(f.repo.save).toHaveBeenCalledOnce();
    f.panel.handleInput(" ");
    expect(text(f.panel)).toContain("0 frozen snapshots");
    f.panel.handleInput(" "); f.panel.handleInput(bringBack); f.panel.handleInput(ctrlS);
    expect(f.close).not.toHaveBeenCalled();
    f.panel.handleInput(esc); expect(f.close.mock.calls).toEqual([[]]);
  });
});

describe("three-action preference library", () => {
  it.each(["dark", "light"])("sanitizes Edit names through failure/resize without rewriting untouched values (%s)", async (themeName) => {
    const entry = { ...a, name: "中文😀\t\x1b[999C\x1b]52;c;name-payload\x07\n\u009dC1\u009c" };
    const f = setup([], "", themeName, [entry]); await loaded(f.panel);
    const assertSafe = () => {
      for (const [width, rows] of [[100, 40], [40, 16], [20, 8], [12, 6], [100, 40]]) {
        f.terminal.rows = rows!;
        const lines = f.panel.render(width!);
        const output = lines.join("\n");
        expect(lines).toHaveLength(panelLayout(width!, rows!).height);
        expect(lines.every((line) => visibleWidth(line) <= width!)).toBe(true);
        for (const unsafe of ["\x1b[999C", "\x1b]52", "\u009d", "\u009c"]) expect(output).not.toContain(unsafe);
        if (width === 100) expect(output).toContain(f.theme.fg("text", f.theme.bold("Edit library entry")));
      }
    };
    f.panel.handleInput("e"); assertSafe();
    expect(text(f.panel).replace(/\x1b_pi:[^\x07]*\x07/g, "")).toContain("Name: 中文😀    �[999C�]52;c;name-payload� �C1�");
    f.panel.handleInput(esc); // Display normalization alone is not an unsaved change.
    expect(text(f.panel)).not.toContain("Discard unsaved form?");
    expect(text(f.panel)).not.toContain("Edit library entry");
    expect(f.repo.save).not.toHaveBeenCalled();
    f.panel.handleInput("e");
    f.repo.save.mockRejectedValueOnce(new Error("Write conflict 中文😀"));
    save(f.panel); await loaded(f.panel); assertSafe();
    expect(f.panel.render(100).join("\n")).toContain(f.theme.fg("error", "⚠ Write conflict 中文😀"));
    expect(f.repo.save).toHaveBeenLastCalledWith(entry.scope, { name: entry.name, body: entry.body }, entry);
    f.panel.handleInput(enter); await loaded(f.panel); // Explicit retry with the original name and conflict snapshot.
    expect(f.repo.save).toHaveBeenCalledTimes(2);
    expect(f.repo.save).toHaveBeenLastCalledWith(entry.scope, { name: entry.name, body: entry.body }, entry);
    expect(f.library.entries[0]!.name).toBe(entry.name);
  });

  it.each(["dark", "light"])("saves edited safe names and retains explicit discard boundaries (%s)", async (themeName) => {
    const entry = { ...a, name: "Original \x1b]52;c;name-payload\x07" };
    const f = setup([selectPreference(entry)], "", themeName, [entry]); await loaded(f.panel);
    f.panel.handleInput("e");
    f.panel.handleInput("\x05"); f.panel.handleInput("\x15"); f.panel.handleInput("Renamed 中文😀");
    f.panel.handleInput(esc); expect(text(f.panel)).toContain("Discard unsaved form?");
    f.panel.handleInput("n"); expect(text(f.panel)).toContain("Name: Renamed 中文😀");
    expect(f.repo.save).not.toHaveBeenCalled();
    save(f.panel); await loaded(f.panel);
    expect(f.repo.save).toHaveBeenCalledExactlyOnceWith(entry.scope, { name: "Renamed 中文😀", body: entry.body }, entry);
    f.panel.handleInput(bringBack);
    expect(f.close).toHaveBeenCalledWith([selectPreference(entry)]);
  });

  it.each(["dark", "light"])("sanitizes external metadata before editing while preserving untouched JSON (%s)", async (themeName) => {
    const entry: RevisionPreference = { ...a, metadata: { kind: "rewrite", activation: "manual", description: "Literal \u001b[31m红色\n第二行\t😀" } };
    const f = setup([], "", themeName, [entry]); await loaded(f.panel);
    f.panel.handleInput("e");
    const output = f.panel.render(100).join("\n");
    expect(output).not.toContain("\u001b[31m");
    expect(output).toContain("�[31m红色 第二行    😀");
    save(f.panel); await loaded(f.panel);
    expect(f.repo.save).toHaveBeenCalledWith("global", { name: entry.name, body: entry.body, metadata: entry.metadata }, entry);
  });

  it.each(["dark", "light"])("edits classification/description with manual-only selection and bounds each field (%s)", async (themeName) => {
    const f = setup([], "Preserve existing structure.", themeName); await loaded(f.panel);
    f.panel.handleInput("n"); f.panel.handleInput("Structure");
    f.panel.handleInput(tab); f.panel.handleInput(tab); f.panel.handleInput(tab);
    f.panel.handleInput(enter); // Task -> Rewrite.
    expect(text(f.panel)).toContain("Type: Prompt rewriting");
    f.panel.handleInput(tab); f.panel.handleInput("并列问题 😀");
    f.panel.handleInput(tab); // Description -> Save, with no adoption control.
    expect(text(f.panel)).toContain("Focus: Save");
    expect(text(f.panel)).not.toContain("Adoption:");
    for (let field = 0; field < 6; field++) {
      for (const rows of [5, 8, 16, 40]) for (const width of [1, 12, 40, 100]) {
        f.terminal.rows = rows;
        const lines = f.panel.render(width);
        expect(lines).toHaveLength(panelLayout(width, rows).height);
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      }
      f.panel.handleInput(tab);
    }
    f.terminal.rows = 40;
    f.panel.handleInput(enter); await loaded(f.panel);
    expect(f.repo.save).toHaveBeenCalledWith("project", { name: "Structure", body: "Preserve existing structure.",
      metadata: { kind: "rewrite", description: "并列问题 😀", activation: "manual" } }, undefined);
    expect(f.close).not.toHaveBeenCalled();
    expect(text(f.panel)).toContain("0 selected");
  });

  it("shows all three actions and cycles just three focus regions", async () => {
    const f = setup(); await loaded(f.panel);
    expect(text(f.panel)).toContain("Focus: Library");
    for (const label of ["n Add", "e Edit", "d Delete"]) expect(text(f.panel)).toContain(label);
    for (const removed of ["Show all selected", "Refresh library", "Save highlighted", "Current actual", "Preview after", "Edit selected for", "Clear search"]) {
      expect(text(f.panel)).not.toContain(removed);
    }
    f.panel.handleInput(tab); expect(text(f.panel)).toContain("Focus: Actions");
    expect(text(f.panel)).toContain("› n Add");
    f.panel.handleInput(right); expect(text(f.panel)).toContain("› e Edit");
    f.panel.handleInput(right); expect(text(f.panel)).toContain("› d Delete");
    f.panel.handleInput(tab); expect(text(f.panel)).toContain("Focus: Search");
    expect(f.panel.render(100).join("\n")).toContain(CURSOR_MARKER);
    f.panel.handleInput(tab); expect(text(f.panel)).toContain("Focus: Library");
    f.panel.handleInput(backTab); expect(text(f.panel)).toContain("Focus: Search");
    f.panel.handleInput(backTab); expect(text(f.panel)).toContain("Focus: Actions");
    expect(f.repo.load).toHaveBeenCalledTimes(1);
    expect(f.repo.save).not.toHaveBeenCalled(); expect(f.repo.remove).not.toHaveBeenCalled(); expect(f.close).not.toHaveBeenCalled();
  });

  it("opens Add directly, saves explicitly, and does not auto-select or submit", async () => {
    const f = setup([], "Reusable full text"); await loaded(f.panel);
    f.panel.handleInput("n"); expect(text(f.panel)).toContain("Save new preference");
    f.panel.handleInput("Saved"); f.panel.handleInput(ctrlS);
    expect(f.repo.save).not.toHaveBeenCalled();
    save(f.panel); await loaded(f.panel);
    expect(f.repo.save).toHaveBeenCalledWith("project", { name: "Saved", body: "Reusable full text",
      metadata: { kind: "task", description: "Saved", activation: "manual" } }, undefined);
    expect(text(f.panel)).toContain("0 selected");
    f.panel.handleInput(esc); expect(f.close).toHaveBeenCalledWith();
    expect(f.library.entries.find((entry) => entry.id === "new")?.body).toBe("Reusable full text");
  });

  it("opens the highlighted toolbar action with Enter, without Tab-ing through individual actions", async () => {
    const f = setup(); await loaded(f.panel);
    f.panel.handleInput(tab); f.panel.handleInput(right); f.panel.handleInput(enter);
    expect(text(f.panel)).toContain("Edit library entry");
    f.panel.handleInput(esc);
    expect(text(f.panel)).toContain("› e Edit");
    f.panel.handleInput(right); f.panel.handleInput(enter);
    expect(text(f.panel)).toContain("Delete library entry?");
    f.panel.handleInput("n"); expect(f.repo.remove).not.toHaveBeenCalled();
  });

  it("keeps search and form typing isolated from n/e/d shortcuts", async () => {
    const f = setup(); await loaded(f.panel);
    f.panel.handleInput("/"); f.panel.handleInput("ned");
    expect(text(f.panel)).toContain("Search: ned");
    expect(text(f.panel)).toContain("No matches");
    expect(text(f.panel)).not.toContain("Save new preference");
    f.panel.handleInput("\x15"); f.panel.handleInput(enter); f.panel.handleInput("n");
    f.panel.handleInput("ned"); f.panel.handleInput(tab); f.panel.handleInput("ned");
    expect(text(f.panel)).toContain("Name: ned");
    expect(f.repo.save).not.toHaveBeenCalled(); expect(f.repo.remove).not.toHaveBeenCalled();
  });

  it("edits a library entry without silently changing its selected snapshot", async () => {
    const f = setup([selectPreference(a)]); await loaded(f.panel);
    f.panel.handleInput("e"); f.panel.handleInput(tab); f.panel.handleInput(" Changed");
    f.panel.handleInput(backTab); save(f.panel); await loaded(f.panel);
    expect(f.repo.save).toHaveBeenCalledWith("global", { name: a.name, body: `${a.body} Changed` }, a);
    f.panel.handleInput(enter);
    let all = text(f.panel); f.panel.handleInput("\x1b[6~"); all += text(f.panel);
    expect(all).toContain("Library changed; snapshot kept"); expect(all).toContain("Changed");
    f.panel.handleInput(esc); f.panel.handleInput(bringBack);
    expect(f.close).toHaveBeenCalledWith([selectPreference(a)]);
  });

  it("keeps deleted selected snapshots visible and removable; delete still requires y", async () => {
    const f = setup([selectPreference(a)]); await loaded(f.panel);
    f.panel.handleInput("d"); f.panel.handleInput(enter);
    expect(f.repo.remove).not.toHaveBeenCalled();
    f.panel.handleInput("y"); await loaded(f.panel);
    expect(f.repo.remove).toHaveBeenCalledWith(a);
    expect(text(f.panel)).toContain("deleted");
    f.panel.handleInput(enter); expect(text(f.panel)).toContain("Source deleted"); f.panel.handleInput(esc);
    f.panel.handleInput(" ");
    f.panel.handleInput(bringBack); expect(f.close).toHaveBeenCalledWith([]);
  });

  it("keeps form text on write conflict and requires explicit discard", async () => {
    const f = setup(); await loaded(f.panel);
    f.repo.save.mockRejectedValueOnce(new Error("Conflict: changed elsewhere"));
    f.panel.handleInput("n"); f.panel.handleInput("New title"); save(f.panel); await loaded(f.panel);
    expect(text(f.panel)).toContain("Conflict"); expect(text(f.panel)).toContain("New title");
    f.panel.handleInput(esc); expect(text(f.panel)).toContain("Discard unsaved form?");
    f.panel.handleInput(esc); expect(text(f.panel)).toContain("New title");
    f.panel.handleInput(esc); f.panel.handleInput("y");
    expect(text(f.panel)).toContain("Form discarded"); expect(f.close).not.toHaveBeenCalled();
  });

  it("retains off-search selections and selection order; only Alt+Enter brings them back", async () => {
    const selected = [selectPreference(a)]; const f = setup(selected); await loaded(f.panel);
    f.panel.handleInput(" "); // Remove A.
    search(f.panel, "Literal"); f.panel.handleInput(" ");
    search(f.panel, "Concise"); f.panel.handleInput(" ");
    f.panel.handleInput(ctrlS); f.panel.handleInput(enter); f.panel.handleInput(ctrlS);
    expect(f.close).not.toHaveBeenCalled(); expect(f.repo.save).not.toHaveBeenCalled();
    f.panel.handleInput(esc); f.panel.handleInput(bringBack);
    expect((f.close.mock.calls[0]![0] as SelectedPreference[]).map((entry) => entry.id)).toEqual(["b", "a"]);
    expect(selected).toEqual([selectPreference(a)]);
    const cancelled = setup(selected); await loaded(cancelled.panel);
    cancelled.panel.handleInput(" "); cancelled.panel.handleInput(esc);
    expect(cancelled.close).toHaveBeenCalledWith(); expect(selected).toEqual([selectPreference(a)]);
  });

  it.each(["dark", "light"])("rejects identical cross-scope selections without hiding management entries (%s)", async (themeName) => {
    const copy = { ...a, id: "copy", scope: "project" as const, name: "Copy 中文😀" };
    const f = setup([selectPreference(a)], "", themeName, [a, copy]); await loaded(f.panel);
    f.panel.handleInput(down); f.panel.handleInput(" ");
    expect(text(f.panel)).toContain("1 selected");
    expect(text(f.panel)).toContain("Same requirements already selected");
    expect(f.panel.render(100).join("\n")).toContain(f.theme.fg("warning", "⚠ Same requirements already selected. Use Selected only (s) to inspect or remove them."));
    for (const [width, rows] of [[40, 16], [20, 8], [100, 40]]) {
      f.terminal.rows = rows!;
      const lines = f.panel.render(width!);
      expect(lines.every((line) => visibleWidth(line) <= width!)).toBe(true);
      expect(stripVTControlCharacters(lines.join("\n"))).toContain("Same requirem");
    }
    // Both sources remain manageable; refusing a duplicate never rewrites or deletes either.
    f.panel.handleInput("e"); expect(text(f.panel)).toContain("Edit library entry");
    f.panel.handleInput(esc); f.panel.handleInput("s"); f.panel.handleInput(" ");
    f.panel.handleInput("s"); f.panel.handleInput(" "); f.panel.handleInput(bringBack);
    expect(f.close).toHaveBeenCalledWith([selectPreference(copy)]);
    expect(f.repo.save).not.toHaveBeenCalled(); expect(f.repo.remove).not.toHaveBeenCalled();
  });

  it("shows empty and no-match states, prevents editing missing entries, and ignores function keys", async () => {
    const f = setup([], "Extra", "dark", []); await loaded(f.panel);
    expect(text(f.panel)).toContain("Library is empty");
    f.panel.handleInput("e"); expect(text(f.panel)).toContain("Select a saved preference");
    f.panel.handleInput("d"); expect(f.repo.remove).not.toHaveBeenCalled();
    for (const key of ["\x1bOP", "\x1bOQ", "\x1bOR", "\x1b[1;3Q"]) f.panel.handleInput(key);
    expect(text(f.panel)).toContain("Preferences");
    expect(f.close).not.toHaveBeenCalled();
    f.panel.handleInput("n"); expect(text(f.panel)).toContain("Save new preference");
  });

  it("ignores a write completion after disposal", async () => {
    const f = setup(); await loaded(f.panel);
    let finish!: (value: RevisionPreference) => void;
    f.repo.save.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    f.panel.handleInput("n"); f.panel.handleInput("Name"); save(f.panel);
    expect(text(f.panel)).toContain("Working…"); f.panel.dispose();
    const renders = vi.mocked(f.tui.requestRender).mock.calls.length;
    finish(a); await Promise.resolve(); await Promise.resolve();
    expect(f.close).not.toHaveBeenCalled(); expect(f.tui.requestRender).toHaveBeenCalledTimes(renders);
  });
});
