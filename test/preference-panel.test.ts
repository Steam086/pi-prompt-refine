import { stripVTControlCharacters } from "node:util";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, truncateToWidth, visibleWidth, wrapTextWithAnsi, type KeyId, type TUI } from "@earendil-works/pi-tui";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { PreferencePanel } from "../src/preference-panel.js";
import { RefineWorkspace } from "../src/workspace.js";
import { PreviewPanel } from "../src/preview.js";
import { composeRevision, selectPreference, type PreferenceLibrary, type PreferenceRepository, type RevisionPreference, type SelectedPreference } from "../src/revision-preferences.js";
import * as preferences from "../src/revision-preferences.js";
import * as presentation from "../src/presentation.js";
import { panelLayout } from "../src/panel-layout.js";
import { formatKeyHint, type KeyHint } from "../src/key-hints.js";
import { RefineController } from "../src/controller.js";
import { selectHistory } from "../src/context.js";

const esc = "\x1b", enter = "\r", tab = "\t", backTab = "\x1b[Z", down = "\x1b[B", left = "\x1b[D", right = "\x1b[C";
const ctrlS = "\x13", altP = "\x1bp", bringBack = "\x1b[13;3u";
const a: RevisionPreference = { id: "a", version: 1, scope: "global", name: "Concise 中文", body: "Keep hard constraints." };
const b: RevisionPreference = { id: "b", version: 1, scope: "project", name: "Literal", body: "Keep commands unchanged." };
afterEach(() => vi.restoreAllMocks());
function repository(entries: RevisionPreference[] = [a, b]) {
  const library: PreferenceLibrary = { entries: structuredClone(entries), errors: {} };
  const repo = {
    load: vi.fn(async () => structuredClone(library)),
    save: vi.fn<PreferenceRepository["save"]>(async (scope, value, expected) => {
      const entry = { ...value, scope, id: expected?.id ?? "new", version: (expected?.version ?? 0) + 1 };
      library.entries = library.entries.filter((item) => item.id !== entry.id).concat(entry);
      return entry;
    }),
    remove: vi.fn<PreferenceRepository["remove"]>(async (entry) => { library.entries = library.entries.filter((item) => item.id !== entry.id); }),
  };
  return { repo, library };
}
function setup(selected: SelectedPreference[] = [], free = "Extra", themeName = "dark", entries = [a, b], purpose: "revise" | "refine" | "manage" = "revise") {
  const terminal = { rows: 40, columns: 100 };
  const tui = { terminal, requestRender: vi.fn() } as unknown as TUI;
  const theme = getThemeByName(themeName)!;
  const keys = new KeybindingsManager(TUI_KEYBINDINGS);
  const { repo, library } = repository(entries); const close = vi.fn();
  const panel = new PreferencePanel(tui, theme, keys, repo, selected, free, 16000, close, purpose);
  panel.focused = true;
  return { panel, repo, library, close, terminal, tui, theme, keys };
}
const text = (panel: { render(width: number): string[] }, width = 100) => stripVTControlCharacters(panel.render(width).join("\n"));
async function loaded(panel: { render(width: number): string[] }) { await vi.waitFor(() => expect(text(panel)).not.toContain("Working…")); }
function search(panel: PreferencePanel, query: string) {
  panel.handleInput("/"); panel.handleInput("\x15"); panel.handleInput(query); panel.handleInput(enter);
}
function save(panel: { handleInput(data: string): unknown }) {
  panel.handleInput(backTab);
  panel.handleInput(enter);
}

describe("Library purpose groups", () => {
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

const listRows = (panel: PreferencePanel, width = 70) => text(panel, width).split("\n").filter((line) => /\[[x ]\]/.test(line));
const highlightedRow = (panel: PreferencePanel, width = 70) => listRows(panel, width).find((line) => line.includes("›"));

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
    f.panel.handleInput("s"); f.panel.handleInput(enter);
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

describe("preference rendering and responsiveness", () => {
  it.each(["dark", "light"])("reserves right-aligned muted source columns by list width through resize (%s)", async (themeName) => {
    const entries = [
      { ...a, name: "Global 中文😀\u001b[31m " + "长名称".repeat(30) },
      { ...b, name: "Project 短" },
    ];
    const f = setup(entries.map(selectPreference), "", themeName, entries); await loaded(f.panel);
    vi.spyOn(f.theme, "bold").mockImplementation((value) => `\x1b[1m${value}\x1b[22m`);
    f.panel.handleInput("s"); // Stable snapshot order, with Global focused.
    // 31/32 straddle the 28-column list threshold. At 80 the preview splits
    // the pane; a short viewport at 100 instead gives the list all 96 columns.
    for (const [width, rows, listWidth, full] of [
      [100, 40, 41, true], [31, 40, 27, false], [32, 40, 28, true],
      [79, 40, 75, true], [80, 24, 32, true], [40, 16, 36, true],
      [20, 10, 16, false], [12, 10, 12, false], [3, 10, 3, false],
      [2, 10, 2, false], [1, 10, 1, false], [100, 10, 96, true], [100, 40, 41, true],
    ] as const) {
      f.terminal.rows = rows;
      const lines = f.panel.render(width);
      const layout = panelLayout(width, rows);
      expect(lines).toHaveLength(layout.height);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      const labels = full ? [" Global", "Project"] : ["G", "P"];
      const sourceRows = lines.filter((line) => labels.some((label) => line.includes(f.theme.fg("muted", label))));
      expect(sourceRows).toHaveLength(2);
      for (const [index, row] of sourceRows.entries()) {
        const label = labels[index]!;
        const plain = stripVTControlCharacters(row);
        expect(row).toContain(f.theme.fg("muted", label));
        expect(row).not.toContain(f.theme.bold(label));
        const sourceStart = row.indexOf(f.theme.fg("muted", label));
        expect(visibleWidth(row.slice(0, sourceStart)) + visibleWidth(label)).toBe(layout.inset + listWidth);
        expect(plain).not.toContain(` · ${label.trim()}`);
      }
      const focused = sourceRows[0]!;
      expect(focused).toContain(f.theme.bg("selectedBg", "").split("\x1b[49m")[0]);
      expect(lines.join("\n")).not.toContain("\u001b[31m");
      if (listWidth >= 12) {
        const budget = listWidth - (full ? 7 : 1) - 1 - 6;
        const name = presentation.sanitizeTerminalText(entries[0]!.name);
        expect(focused).toContain(f.theme.fg("text", f.theme.bold(truncateToWidth(name, budget, "…"))));
        expect(stripVTControlCharacters(focused)).toContain("…");
        expect(stripVTControlCharacters(focused)).toContain("› [x]");
      }
    }
    // Moving focus preserves checkbox selection and keeps the source regular/muted.
    f.panel.handleInput(down);
    const selected = f.panel.render(100).find((line) => stripVTControlCharacters(line).includes("› [x]"))!;
    expect(selected).toContain(f.theme.fg("text", f.theme.bold(entries[1]!.name)));
    expect(selected).toContain(f.theme.fg("muted", "Project"));
    f.panel.handleInput(tab);
    expect(f.panel.render(100).join("\n")).toContain(f.theme.fg("muted", "Project"));
    f.panel.handleInput(bringBack);
    expect(f.close).toHaveBeenCalledWith(entries.map(selectPreference));
  });

  it.each(["dark", "light"])("keeps warnings separate from source labels down to two columns (%s)", async (themeName) => {
    for (const state of ["unavailable", "deleted", "snapshot kept"] as const) {
      const entry = { ...a, name: "Warning 中文😀 " + "long ".repeat(20) };
      const source = state === "deleted" ? [] : [{ ...entry, version: state === "snapshot kept" ? 2 : 1 }];
      const { repo } = repository(source);
      repo.load.mockResolvedValueOnce({ entries: source, errors: state === "unavailable" ? { global: "Offline" } : {} });
      const terminal = { rows: 40, columns: 100 };
      const theme = getThemeByName(themeName)!;
      const panel = new PreferencePanel({ terminal, requestRender: vi.fn() } as unknown as TUI, theme,
        new KeybindingsManager(TUI_KEYBINDINGS), repo, [selectPreference(entry)], "", 16000, vi.fn());
      await loaded(panel); panel.handleInput("s");
      for (const [width, rows] of [[100, 40], [32, 16], [20, 8], [12, 8], [6, 8], [3, 8], [2, 8], [1, 8], [100, 40]]) {
        terminal.rows = rows!;
        const lines = panel.render(width!);
        expect(lines.every((line) => visibleWidth(line) <= width!)).toBe(true);
        const label = width! >= 32 ? " Global" : "G";
        const row = lines.find((line) => line.includes(theme.fg("muted", label)))!;
        expect(row).toBeDefined();
        expect(row).not.toContain(theme.fg("warning", label));
        if (width! > 1) expect(row).toContain(theme.fg("warning", width! >= 12 ? "! " : "!"));
        if (width! <= 3) expect(stripVTControlCharacters(row)).toBe(width === 1 ? "G" : width === 2 ? "!G" : "! G");
      }
      terminal.rows = 40;
      panel.handleInput(enter);
      const details = text(panel);
      expect(details).toContain(`global · ${entry.id}`); // Full source and UUID stay discoverable.
      expect(details).toContain(state === "unavailable" ? "Library unavailable" : state === "deleted" ? "Source deleted" : "Library changed; snapshot kept");
    }
  });

  it.each(["dark", "light"])("keeps concise names, muted scope and semantic snapshot warnings styled through audit/resize (%s)", async (themeName) => {
    const long = { ...a, name: "长名称 😀\u001b[2J ".repeat(10), id: "wide", metadata: {
      kind: "rewrite" as const, activation: "manual" as const, description: "Detailed provenance 中文" } };
    const selected = [selectPreference(long), selectPreference(b)];
    const f = setup(selected, "", themeName, [{ ...long, metadata: { ...long.metadata, description: "Changed metadata only" } }, b]);
    await loaded(f.panel);
    vi.spyOn(f.theme, "bold").mockImplementation((value) => `\x1b[1m${value}\x1b[22m`);
    f.panel.invalidate(); f.panel.handleInput("s"); f.panel.handleInput(down);
    let lines = f.panel.render(70);
    const focused = lines.find((line) => stripVTControlCharacters(line).includes("› [x]"))!;
    expect(focused).toContain(f.theme.fg("text", f.theme.bold(b.name)));
    expect(focused).toContain(f.theme.fg("muted", "Project"));
    expect(focused).not.toContain(f.theme.bold("Project"));
    expect(focused).toContain(f.theme.bg("selectedBg", "").split("\x1b[49m")[0]);
    const warning = lines.find((line) => stripVTControlCharacters(line).includes("!"))!;
    expect(warning).toContain(f.theme.fg("warning", "! "));
    expect(warning).not.toContain("\x1b[1m"); // An unfocused name is never bold.
    expect(warning).not.toContain(" · rewrite"); // Classification belongs in details, not every row.
    expect(warning).not.toContain("\u001b[2J");
    f.panel.handleInput("\x1b[H"); f.panel.handleInput(enter);
    expect(text(f.panel)).toContain("Library changed; snapshot kept");
    expect(text(f.panel)).toContain("Manually selected");
    f.panel.handleInput(esc);
    for (const [width, rows] of [[100, 40], [40, 16], [20, 8], [12, 5], [80, 24], [70, 40]]) {
      f.terminal.rows = rows!;
      lines = f.panel.render(width!);
      expect(lines).toHaveLength(panelLayout(width!, rows!).height);
      expect(lines.every((line) => visibleWidth(line) <= width!)).toBe(true);
      expect(lines.join("\n")).not.toContain("\u001b[2J");
      if (width! >= 40 && rows! >= 16) expect(lines.join("\n")).toContain(formatKeyHint(["s", "All"], f.theme));
      f.panel.handleInput("\x1b[6~"); f.panel.handleInput("\x1b[5~");
    }
    f.panel.handleInput("\x1b[H");
    expect(listRows(f.panel)[0]).toContain("长名称 😀");
    f.panel.handleInput(" ");
    expect(highlightedRow(f.panel)).toContain(b.name);
    f.panel.handleInput(bringBack);
    expect(f.close).toHaveBeenCalledWith([selectPreference(b)]);
  });

  it.each(["dark", "light"])("styles visible actions and footers consistently on all pages (%s)", async (themeName) => {
    const f = setup([], "Extra", themeName); await loaded(f.panel);
    vi.spyOn(f.theme, "bold").mockImplementation((value) => `\x1b[1m${value}\x1b[22m`);
    const check = (...hints: KeyHint[]) => {
      const footer = f.panel.render(100).slice(-2).join("\n");
      for (const hint of hints) {
        expect(footer).toContain(formatKeyHint(hint, f.theme));
        expect(footer).not.toContain(f.theme.bold(hint[1]));
      }
      expect(footer).toContain("\x1b[1m");
    };
    check(["Alt+Enter", "Bring back"], ["Enter", "Read"], ["Esc", "Cancel selection"], ["Space", "Select"]);
    for (const hint of [["n", "Add"], ["e", "Edit"], ["d", "Delete"]] as KeyHint[]) expect(f.panel.render(100).join("\n")).toContain(formatKeyHint(hint, f.theme));
    f.panel.handleInput(enter); check(["↑↓ / PgUp / PgDn", "Scroll"], ["Esc", "Back"]); f.panel.handleInput(esc);
    f.panel.handleInput("n"); check(["Enter", "Next field"], ["Tab / Shift+Tab", "Fields"], ["Esc", "Back"]);
    f.panel.handleInput("Name"); f.panel.handleInput(tab); check(["Enter", "Newline"]);
    f.panel.handleInput(tab); check(["Enter", "Change scope"]);
    f.panel.handleInput(tab); check(["Enter", "Change type"]);
    f.panel.handleInput(tab); check(["Enter", "Next field"]);
    f.panel.handleInput(tab); check(["Enter", "Save to library"]);
    f.panel.handleInput(esc); check(["y", "Discard"], ["n / Esc", "Keep editing"]);
    f.panel.handleInput("y"); f.panel.handleInput("d"); check(["y", "Delete"], ["n / Esc", "Cancel"]);
  });

  it.each(["dark", "light"])("bounds all pages, highlights focus, and retains styled cancel at small sizes (%s)", async (themeName) => {
    const f = setup([], "中文 😀\n".repeat(100), themeName); await loaded(f.panel);
    vi.spyOn(f.theme, "bold").mockImplementation((value) => `\x1b[1m${value}\x1b[22m`);
    const check = () => {
      for (const rows of [5, 8, 16, 40]) for (const width of [1, 12, 20, 40, 80, 100]) {
        f.terminal.rows = rows;
        const lines = f.panel.render(width);
        expect(lines).toHaveLength(panelLayout(width, rows).height);
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      }
      f.terminal.rows = 40;
    };
    check(); f.panel.handleInput(tab); check(); f.panel.handleInput(tab); check();
    expect(f.panel.render(100).join("\n")).toContain(CURSOR_MARKER);
    f.panel.handleInput(enter); f.panel.handleInput(enter); check(); f.panel.handleInput(esc);
    f.panel.handleInput("n"); check(); f.panel.handleInput(tab); check();
    expect(f.panel.render(100).join("\n")).toContain(CURSOR_MARKER);
    f.panel.handleInput("Edited"); f.panel.handleInput(esc); check();
    f.terminal.rows = 8;
    expect(f.panel.render(20).at(-1)).toContain(formatKeyHint(["Esc", "Keep"], f.theme));
  });

  it.each(["dark", "light"])("separates reference headings, metadata and literal bodies (%s)", async (name) => {
    const f = setup([selectPreference(a)], "Extra", name); await loaded(f.panel);
    vi.spyOn(f.theme, "bold").mockImplementation((value) => `\x1b[1m${value}\x1b[22m`);
    f.panel.invalidate();
    const preview = f.panel.render(100).join("\n");
    expect(preview).toContain(f.theme.fg("text", f.theme.bold(a.name)));
    expect(preview).toContain(f.theme.fg("muted", `${a.scope} · ${a.id}`));
    expect(preview).toContain(f.theme.fg("text", a.body));
    expect(preview).not.toContain(f.theme.bold(a.body));
    f.panel.handleInput(enter);
    const reading = f.panel.render(100).join("\n");
    expect(reading).toContain(f.theme.fg("text", a.body));
    expect(reading).toContain(f.theme.fg("text", f.theme.bold("Selected snapshot")));
    expect(reading).toContain(f.theme.fg("muted", "Saved snapshot"));
  });

  it.each(["dark", "light"])("keeps load/write/validation failures visible and semantic at short sizes (%s)", async (name) => {
    const f = setup([], "Extra", name); await loaded(f.panel);
    f.panel.handleInput("n"); save(f.panel);
    expect(f.panel.render(100).join("\n")).toContain(f.theme.fg("warning", "⚠ Name must contain 1–120 characters."));
    f.panel.handleInput(tab); f.panel.handleInput("Name");
    f.repo.save.mockRejectedValueOnce(new Error("Write conflict 中文😀")); save(f.panel); await loaded(f.panel);
    for (const rows of [40, 12, 8, 5]) for (const width of [20, 40, 100]) {
      f.terminal.rows = rows; f.terminal.columns = width;
      const lines = f.panel.render(width);
      expect(lines).toHaveLength(panelLayout(width, rows).height);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(stripVTControlCharacters(lines.join("\n"))).toContain("Write conflict");
      expect(lines.join("\n")).toContain(f.theme.fg("error", "⚠ Write conflict 中文😀").split("⚠")[0]);
      if (rows >= 8) expect(lines.at(-1)).toContain(formatKeyHint(["Esc", "Back"], f.theme));
    }
    const failure = setup([], "Extra", name); await loaded(failure.panel);
    failure.library.errors.project = "Permission denied";
    failure.panel.handleInput("n"); failure.panel.handleInput("Saved"); save(failure.panel); await loaded(failure.panel);
    expect(failure.panel.render(100).join("\n")).toContain(failure.theme.fg("error", "⚠ Refresh failed after save; not selected. Permission denied"));
  });

  it.each(["dark", "light"])("marks over-limit requirements without submitting or losing selection (%s)", async (name) => {
    const f = setup([selectPreference(a)], "Extra".repeat(4000), name); await loaded(f.panel);
    const lines = f.panel.render(100);
    const chars = composeRevision([selectPreference(a)], "Extra".repeat(4000)).length;
    expect(lines.join("\n")).toContain(f.theme.fg("warning", `⚠ Too long · ${chars}/16000 chars`));
    f.panel.handleInput(bringBack);
    expect(f.close).toHaveBeenCalledWith([selectPreference(a)]);
    expect(f.repo.save).not.toHaveBeenCalled();
  });

  it("does not repeat library I/O, filtering or long-document layout on focus changes and scrolling", async () => {
    const body = "LONG_LITERAL 中文😀 command\n".repeat(80);
    const entries = Array.from({ length: 500 }, (_, i) => ({ ...a, id: `${i}`, name: `Preference ${i}`, body }));
    const searchSpy = vi.spyOn(preferences, "searchPreferences");
    const sanitize = vi.spyOn(presentation, "sanitizeTerminalText");
    const f = setup([], "Extra", "dark", entries); await loaded(f.panel);
    text(f.panel); searchSpy.mockClear(); sanitize.mockClear();
    const samples: number[] = [];
    for (let i = 0; i < 90; i++) {
      const start = performance.now();
      f.panel.handleInput(tab); text(f.panel);
      samples.push(performance.now() - start);
    }
    expect(searchSpy).not.toHaveBeenCalled();
    expect(sanitize.mock.calls.some(([value]) => value.includes("LONG_LITERAL"))).toBe(false);
    expect(f.repo.load).toHaveBeenCalledTimes(1);
    f.panel.handleInput(enter); text(f.panel); sanitize.mockClear();
    for (let i = 0; i < 20; i++) { f.panel.handleInput(down); text(f.panel); }
    expect(sanitize.mock.calls.some(([value]) => value.includes("LONG_LITERAL"))).toBe(false);
    text(f.panel, 80); expect(sanitize.mock.calls.some(([value]) => value.includes("LONG_LITERAL"))).toBe(true);
    f.panel.handleInput(esc); search(f.panel, "Preference 49"); text(f.panel);
    expect(searchSpy).toHaveBeenCalledTimes(1);
    if (process.env.REFINE_BENCHMARK) {
      samples.sort((a, b) => a - b);
      console.log(`Preferences: 500 entries, 90 focus+render samples: p50=${samples[45]!.toFixed(2)}ms p95=${samples[85]!.toFixed(2)}ms`);
    }
  });

  it("sanitizes external names, literal documents and long notices before styling", async () => {
    const unsafe = "\x1b[2J\x1b]52;c;payload\x07";
    const f = setup([], "Extra", "dark", [{ ...a, name: a.name + unsafe, body: a.body + unsafe }]); await loaded(f.panel);
    for (const output of [text(f.panel), f.panel.render(100).join("\n")]) {
      expect(output).not.toContain("\x1b[2J"); expect(output).not.toContain("\x1b]52");
    }
    const message = "Write failed 中文😀 " + "conflict ".repeat(6) + unsafe;
    f.repo.save.mockRejectedValueOnce(new Error(message));
    f.panel.handleInput("n"); f.panel.handleInput("Name"); save(f.panel); await loaded(f.panel);
    const output = f.panel.render(40).join("\n");
    expect(output).toContain("Write failed"); expect(output).not.toContain("\x1b[2J"); expect(output).not.toContain("\x1b]52");
    const firstLine = wrapTextWithAnsi(presentation.sanitizeTerminalText(message), panelLayout(40, 40).innerWidth)[0]!;
    expect(f.panel.render(40).slice(-2).join("\n")).toContain(f.theme.fg("error", firstLine));
  });
});

function unsentWorkspaceSetup(key: KeyId | null = "alt+p", conflict = false, theme = "dark", maxChars = 16000, maxConcurrent = 4) {
  const f = setup([], "", theme); f.panel.dispose();
  if (conflict) f.keys.setUserBindings({ "tui.editor.cursorLineEnd": "alt+p" });
  const complete = vi.fn(async (_request: unknown) => ({ text: "Result", stopReason: "stop" as const }));
  const model = { provider: "p", id: "m" };
  const controller = new RefineController({ complete, maxDraftChars: maxChars, maxConcurrent, timeoutMs: 1000, onState() {} }, model);
  controller.setSession("s");
  for (const draft of ["Original task 中文😀 --literal", "Second original"]) controller.createDraft({ draft, model,
    sessionId: "s", branchLeafId: null, systemPrompt: "Policy", history: selectHistory([], 0, 0) });
  const originals = controller.getHistory();
  const position = { selectedTaskId: originals[0]!.taskId };
  const run = vi.fn((id: number) => { controller.startRecord(id); });
  const preview = new PreviewPanel({ state: { phase: "idle", requestId: 0, pendingSend: false },
    contextLabel: "Original", elapsedSeconds: 0, openHint: "ctrl+\\", canRestore: false }, f.theme, () => f.terminal.rows, () => {});
  const workspace = new RefineWorkspace(preview, f.tui, f.theme, f.keys, {
    preferences: { repository: f.repo, key, maxChars },
    draftPreferences: (id, original) => {
      const source = id === undefined ? undefined : controller.getRecord(id);
      if (id !== undefined && !source) return undefined;
      const selected = source?.input.preferences ?? [];
      if (!source || !original || source.status !== "unsent" || source.input.contextUnavailable) return { selected };
      return { selected, save: (selected) => controller.updateDraftPreferences(source, selected) };
    },
    taskPosition: position,
    history: () => controller.getHistory(),
    tasks: { records: () => controller.getHistory(), appliedId: () => undefined, activate: () => false, run, stop() {} },
    context: () => ({ instructions: "off", tree: false, skills: false }), contextEnabled: () => false,
    saveContext: async () => ({ message: "", persisted: true }), submit: () => "Unused",
  });
  workspace.focused = true;
  return { ...f, workspace, controller, complete, originals, position, run };
}

describe("Unsent preference selection", () => {
  it.each(["dark", "light"])("selects inline with one Tab and optimizes directly with Enter (%s)", async (theme) => {
    const f = unsentWorkspaceSetup(null, false, theme); const w = f.workspace;
    text(w); await vi.waitFor(() => expect(text(w)).toContain(`[ ] ${a.name}`));
    w.handleInput(tab);
    expect(text(w)).toContain("Focus: Preferences");
    expect(text(w)).not.toContain("Bring back");
    w.handleInput(" "); w.handleInput(down); w.handleInput("\x1b[32u");
    expect(f.controller.getRecord(f.originals[0]!.id)!.input.preferences).toEqual([selectPreference(a), selectPreference(b)]);
    expect(text(w)).toContain("2 selected");
    const styled = w.render(100).join("\n");
    expect(styled).toContain(f.theme.fg("text", f.theme.bold(b.name)));
    expect(styled).toContain(formatKeyHint(["Space", "Toggle"], f.theme));
    expect(styled).toContain(f.theme.fg("muted", " · P"));
    w.handleInput("o"); expect(text(w)).toContain(b.body);
    for (const key of [" ", "i", "f", "n", ctrlS, bringBack, enter]) w.handleInput(key);
    expect(f.run).not.toHaveBeenCalled(); expect(f.complete).not.toHaveBeenCalled();
    expect(f.repo.save).not.toHaveBeenCalled();
    w.handleInput(esc); // Close reading, keeping preference selection focused.
    expect(text(w)).toContain("Focus: Preferences");
    expect(f.controller.getRecord(f.originals[0]!.id)!.input.draft).toBe(f.originals[0]!.input.draft);
    w.handleInput(theme === "dark" ? enter : "\x1b[13u");
    expect(f.run).toHaveBeenCalledExactlyOnceWith(f.originals[0]!.id);
    expect(f.complete.mock.calls[0]![0]).toMatchObject({ editingInstruction: composeRevision([selectPreference(a), selectPreference(b)], "") });
    await Promise.resolve(); w.dispose();
  });

  it.each([{ name: "Esc", key: esc }, { name: "Tab", key: tab }, { name: "Shift+Tab", key: backTab }])("returns to tasks with $name without toggling, submitting or discarding selections", async ({ key }) => {
    const f = unsentWorkspaceSetup(); const w = f.workspace;
    text(w); await vi.waitFor(() => expect(text(w)).toContain(a.name));
    const before = structuredClone(f.position);
    w.handleInput(tab); w.handleInput(" "); w.handleInput(down);
    w.handleInput(key);
    expect(text(w)).not.toContain("Focus: Preferences");
    expect(f.position).toEqual(before);
    expect(f.controller.getRecord(f.originals[0]!.id)!.input.preferences).toEqual([selectPreference(a)]);
    expect(f.run).not.toHaveBeenCalled();
    expect(f.complete).not.toHaveBeenCalled();
    w.handleInput(tab);
    expect(text(w)).toContain(`› [ ] ${b.name}`);
    expect(text(w)).toContain(`Selected · 1`);
    w.handleInput(" "); w.handleInput(enter);
    expect(f.run).toHaveBeenCalledExactlyOnceWith(f.originals[0]!.id);
    expect(f.complete.mock.calls[0]![0]).toMatchObject({ editingInstruction: composeRevision([selectPreference(a), selectPreference(b)], "") });
    await Promise.resolve(); w.dispose();
  });

  it("isolates inline searches and choices by original, caches browsing, and preserves the full panel transaction", async () => {
    const f = unsentWorkspaceSetup(); const w = f.workspace;
    text(w); await vi.waitFor(() => expect(text(w)).toContain(a.name));
    const loads = f.repo.load.mock.calls.length;
    w.handleInput(backTab); w.handleInput("/"); w.handleInput("Literal");
    // Search owns all text and arrows; it cannot open another view or invoke task actions.
    for (const key of [left, right, ctrlS]) w.handleInput(key);
    expect(text(w)).toContain("Focus: Preferences · Search");
    expect(f.run).not.toHaveBeenCalled();
    w.handleInput(enter); w.handleInput(" ");
    expect(f.controller.getRecord(f.originals[0]!.id)!.input.preferences).toEqual([selectPreference(b)]);
    w.handleInput(esc); w.handleInput(tab);
    expect(text(w)).toContain("Search: Literal");
    expect(f.repo.load).toHaveBeenCalledTimes(loads);
    w.handleInput(esc);
    f.position.selectedTaskId = f.originals[1]!.taskId;
    text(w); w.handleInput(backTab);
    expect(text(w)).not.toContain("Search: Literal");
    w.handleInput(" ");
    expect(f.controller.getRecord(f.originals[1]!.id)!.input.preferences).toEqual([selectPreference(a)]);
    w.handleInput("p"); await loaded(w); w.handleInput(" "); w.handleInput(esc);
    expect(f.controller.getRecord(f.originals[1]!.id)!.input.preferences).toEqual([selectPreference(a)]);
    expect(text(w)).toContain("Focus: Preferences");
    w.handleInput("p"); await loaded(w); w.handleInput(" "); w.handleInput(bringBack);
    expect(f.controller.getRecord(f.originals[1]!.id)!.input.preferences).toEqual([]);
    expect(f.controller.getRecord(f.originals[0]!.id)!.input.preferences).toEqual([selectPreference(b)]);
    expect(f.complete).not.toHaveBeenCalled(); w.dispose();
  });

  it("rejects an over-limit inline addition without discarding the valid selection", async () => {
    const f = unsentWorkspaceSetup(null, false, "light", 90); const w = f.workspace;
    text(w); await vi.waitFor(() => expect(text(w)).toContain(a.name));
    w.handleInput(backTab); w.handleInput(" "); w.handleInput(down); w.handleInput(" ");
    expect(f.controller.getRecord(f.originals[0]!.id)!.input.preferences).toEqual([selectPreference(a)]);
    expect(text(w)).toContain("Editing requirements exceed 90");
    for (const [width, rows] of [[100, 40], [40, 16], [20, 8], [12, 6], [100, 40]]) {
      f.terminal.rows = rows!;
      const lines = w.render(width!);
      expect(lines.length).toBeGreaterThanOrEqual(Math.min(18, panelLayout(width!, rows!).height));
      expect(lines.length).toBeLessThanOrEqual(panelLayout(width!, rows!).height);
      expect(w.render(width!)).toHaveLength(lines.length);
      expect(lines.every((line) => visibleWidth(line) <= width!)).toBe(true);
      expect(lines.join("\n")).toContain(f.theme.fg("warning", "⚠").split("⚠")[0] + "⚠");
    }
    expect(f.complete).not.toHaveBeenCalled(); w.dispose();
  });

  it.each(["generating", "queued"])("follows a directly submitted %s run without resubmitting on the next Enter", async (status) => {
    const f = unsentWorkspaceSetup(null, false, "dark", 16000, 1); const w = f.workspace;
    f.complete.mockImplementation(() => new Promise(() => {}));
    if (status === "queued") f.controller.startRecord(f.originals[1]!.id);
    text(w); await vi.waitFor(() => expect(text(w)).toContain(a.name));
    w.handleInput(tab); w.handleInput(" "); w.handleInput(enter);
    expect(f.controller.getRecord(f.originals[0]!.id)!.status).toBe(status);
    expect(f.position.selectedTaskId).toBeUndefined();
    expect(text(w)).not.toContain("Focus: Preferences");
    w.handleInput(enter);
    expect(f.run).toHaveBeenCalledExactlyOnceWith(f.originals[0]!.id);
    w.dispose(); f.controller.setSession("other");
  });

  it("retains checked preferences and focus after a rejected start, then follows only the explicitly started run", async () => {
    const f = unsentWorkspaceSetup(); const w = f.workspace;
    text(w); await vi.waitFor(() => expect(text(w)).toContain(a.name));
    w.handleInput(tab); w.handleInput(" ");
    f.run.mockImplementationOnce(() => {});
    w.handleInput(enter);
    expect(text(w)).toContain("Focus: Preferences");
    expect(text(w)).toContain(`[x] ${a.name}`);
    expect(f.position.selectedTaskId).toBe(f.originals[0]!.taskId);
    expect(f.complete).not.toHaveBeenCalled();
    w.handleInput(enter);
    expect(f.run).toHaveBeenCalledTimes(2);
    expect(text(w)).not.toContain("Focus: Preferences");
    expect(f.position.selectedTaskId).toBeUndefined();
    w.handleInput(enter); // The submitted run is inspected, never submitted twice.
    expect(f.run).toHaveBeenCalledTimes(2);
    expect(f.complete).toHaveBeenCalledTimes(1);
    await Promise.resolve(); w.dispose();
  });

  it("consumes Enter after archival without running a new current target", async () => {
    const f = unsentWorkspaceSetup(); const w = f.workspace;
    text(w); await vi.waitFor(() => expect(text(w)).toContain(a.name));
    w.handleInput(tab); w.handleInput(" ");
    f.controller.onMessageStarted("Another Pi task");
    f.controller.createDraft({ ...f.originals[0]!.input, draft: "New current target" });
    text(w); w.handleInput(enter);
    expect(text(w)).toContain("Original changed or already started");
    expect(f.run).not.toHaveBeenCalled(); expect(f.complete).not.toHaveBeenCalled();
    expect(f.position.selectedTaskId).toBe(f.originals[0]!.taskId);
    w.dispose();
  });

  it("keeps search and full text isolated from submission and preserves explicit child bring-back", async () => {
    const f = unsentWorkspaceSetup(); const w = f.workspace;
    text(w); await vi.waitFor(() => expect(text(w)).toContain(a.name));
    w.handleInput("o"); expect(text(w)).toContain("Original prompt");
    w.handleInput(tab); w.handleInput("/"); w.handleInput(a.name);
    for (const key of [tab, backTab, ctrlS]) w.handleInput(key);
    expect(text(w)).toContain("Focus: Preferences · Search");
    w.handleInput(enter);
    expect(f.run).not.toHaveBeenCalled();
    w.handleInput("o");
    for (const key of [tab, backTab, enter, enter, ctrlS, bringBack]) w.handleInput(key);
    expect(text(w)).toContain("Focus: Preferences · Read-only");
    expect(f.run).not.toHaveBeenCalled();
    w.handleInput(esc); w.handleInput("p"); await loaded(w);
    w.handleInput(" "); w.handleInput(enter); w.handleInput(enter);
    expect(f.run).not.toHaveBeenCalled();
    w.handleInput(esc); w.handleInput(bringBack);
    expect(f.run).not.toHaveBeenCalled();
    expect(text(w)).toContain("Focus: Preferences");
    w.handleInput(enter);
    expect(f.run).toHaveBeenCalledExactlyOnceWith(f.originals[0]!.id);
    await Promise.resolve(); w.dispose();
  });

  it("consumes the focused Enter if its Unsent starts elsewhere, rather than inspecting or running another item", async () => {
    const f = unsentWorkspaceSetup(); const w = f.workspace;
    text(w); await vi.waitFor(() => expect(text(w)).toContain(a.name));
    w.handleInput(backTab);
    f.complete.mockImplementationOnce(() => new Promise(() => {}));
    f.controller.startRecord(f.originals[0]!.id);
    text(w); w.handleInput(enter);
    expect(text(w)).toContain("Original changed or already started");
    expect(text(w)).not.toContain("Prompt details");
    expect(f.run).not.toHaveBeenCalled();
    expect(f.controller.getRecord(f.originals[0]!.id)!.input.preferences).toBeUndefined();
    w.dispose(); f.controller.setSession("other");
  });

  it.each(["dark", "light"])("uses p independently of optional keys, freezes snapshots, and requests only on parent Enter (%s)", async (theme) => {
    const f = unsentWorkspaceSetup(null, false, theme); const w = f.workspace;
    expect(text(w)).toContain("Preferences · 0 selected");
    w.handleInput("p"); await loaded(w);
    expect(text(w)).toContain("Preferences · Unsent original");
    w.handleInput(" "); w.handleInput(ctrlS);
    expect(text(w)).toContain("press Enter on the Unsent original");
    expect(text(w)).not.toContain("Return to Revise");
    w.handleInput(enter); expect(text(w)).toContain("Full editing instruction");
    w.handleInput(ctrlS); expect(f.complete).not.toHaveBeenCalled();
    w.handleInput(esc); w.handleInput(bringBack);
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.repo.save).not.toHaveBeenCalled();
    expect(text(w)).toContain("Preferences · 1 selected");
    expect(text(w)).toContain(`[x] ${a.name}`);
    expect(f.controller.getRecord(f.originals[0]!.id)!.input.draft).toBe(f.originals[0]!.input.draft);
    f.library.entries[0]!.body = "Changed library text";
    w.handleInput(enter);
    expect(f.run).toHaveBeenCalledExactlyOnceWith(f.originals[0]!.id);
    expect(f.complete.mock.calls[0]![0]).toMatchObject({ editingInstruction: composeRevision([selectPreference(a)], ""), draft: f.originals[0]!.input.draft });
    await Promise.resolve(); w.dispose();
  });

  it("keeps p available when the configured modifier conflicts and does not leak child input", async () => {
    const f = unsentWorkspaceSetup("alt+p", true); const w = f.workspace;
    w.handleInput(altP); expect(text(w)).not.toContain("Bring back");
    w.handleInput("p"); await loaded(w);
    w.handleInput("n"); w.handleInput("New entry"); w.handleInput(tab);
    // Add must not prefill the original task as a reusable editing requirement.
    expect(text(w)).not.toContain(f.originals[0]!.input.draft);
    for (const key of ["p", "i", "f", enter, ctrlS]) w.handleInput(key);
    expect(f.run).not.toHaveBeenCalled(); expect(f.complete).not.toHaveBeenCalled();
    w.handleInput(esc); w.handleInput("y"); w.handleInput(esc);
    w.handleInput("p"); await loaded(w); w.handleInput(" "); w.handleInput(esc);
    expect(f.controller.getRecord(f.originals[0]!.id)!.input.preferences).toBeUndefined();
    w.dispose();
  });

  it("isolates selections by original, preserves deleted-source snapshots, and explicitly clears them", async () => {
    const f = unsentWorkspaceSetup(); const w = f.workspace;
    w.handleInput(altP); await loaded(w); w.handleInput(" "); w.handleInput(bringBack);
    f.position.selectedTaskId = f.originals[1]!.taskId;
    expect(text(w)).toContain("Preferences · 0 selected");
    expect(text(w).split("\n")[2]).not.toContain(a.name);
    w.handleInput("p"); await loaded(w); expect(text(w)).toContain("0 selected");
    w.handleInput(esc);
    f.position.selectedTaskId = f.originals[0]!.taskId;
    f.library.entries = f.library.entries.filter((entry) => entry.id !== a.id);
    w.handleInput("p"); await loaded(w);
    expect(text(w)).toContain("1 selected");
    expect(text(w)).toContain(a.name);
    // Filter to the retained deleted snapshot and remove it explicitly.
    w.handleInput("/"); w.handleInput(a.name); w.handleInput(enter); w.handleInput(" "); w.handleInput(bringBack);
    expect(f.controller.getRecord(f.originals[0]!.id)!.input.editingInstruction).toBeUndefined();
    expect(f.controller.getRecord(f.originals[1]!.id)!.input.preferences).toBeUndefined();
    expect(f.complete).not.toHaveBeenCalled(); w.dispose();
  });

  it("retains over-limit working selections and shows semantic warnings through resize", async () => {
    const f = unsentWorkspaceSetup(null, false, "light", 90); const w = f.workspace;
    w.handleInput("p"); await loaded(w);
    w.handleInput(" "); w.handleInput(down); w.handleInput(" "); w.handleInput(bringBack);
    expect(text(w)).toContain("Editing requirements exceed 90");
    expect(w.render(100).join("\n")).toContain(f.theme.fg("warning", "⚠ Editing requirements exceed 90 characters; reduce the selection."));
    for (const [width, rows] of [[100, 40], [40, 16], [20, 8], [12, 6], [80, 30]]) {
      f.terminal.rows = rows!;
      const lines = w.render(width!);
      expect(lines.length).toBeGreaterThanOrEqual(Math.min(18, panelLayout(width!, rows!).height));
      expect(lines.length).toBeLessThanOrEqual(panelLayout(width!, rows!).height);
      expect(w.render(width!)).toHaveLength(lines.length);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width!);
    }
    expect(f.controller.getRecord(f.originals[0]!.id)!.input.preferences).toBeUndefined();
    w.handleInput(" "); w.handleInput(bringBack);
    expect(f.controller.getRecord(f.originals[0]!.id)!.input.preferences).toHaveLength(1);
    expect(f.complete).not.toHaveBeenCalled(); w.dispose();
  });

  it("preserves selection through Usage for archived Unsent originals with intact background", async () => {
    const f = unsentWorkspaceSetup(); const w = f.workspace;
    f.controller.onMessageStarted("Another Pi task");
    w.openUsage({ id: f.originals[0]!.id, original: true });
    w.handleInput("p"); await loaded(w);
    expect(text(w)).toContain("Preferences · Unsent original");
    w.handleInput(" "); w.handleInput(bringBack);
    expect(f.controller.getRecord(f.originals[0]!.id)!.input.preferences).toEqual([selectPreference(a)]);
    expect(f.complete).not.toHaveBeenCalled();
    w.handleInput(enter);
    expect(f.run).toHaveBeenCalledExactlyOnceWith(f.originals[0]!.id);
    expect(f.complete.mock.calls[0]![0]).toMatchObject({ roundId: f.originals[0]!.input.roundId });
    await Promise.resolve(); w.dispose();
  });

  it("rejects bring-back if an editable original starts while the child is open", async () => {
    const f = unsentWorkspaceSetup(); const w = f.workspace;
    f.complete.mockImplementationOnce(() => new Promise(() => {}));
    w.handleInput("p"); await loaded(w); w.handleInput(" ");
    f.controller.startRecord(f.originals[0]!.id);
    w.handleInput(bringBack);
    expect(text(w)).toContain("already started");
    expect(f.controller.getRecord(f.originals[0]!.id)!.input.preferences).toBeUndefined();
    w.handleInput(esc); w.handleInput("p"); await loaded(w);
    expect(text(w)).not.toContain("Bring back");
    w.dispose(); f.controller.setSession("other");
  });

  it("keeps working snapshots in the child if the original changes before bring-back", async () => {
    const f = unsentWorkspaceSetup(); const w = f.workspace;
    w.handleInput("p"); await loaded(w); w.handleInput(" ");
    const source = f.originals[0]!;
    f.controller.updateDraft(source.id, source.input.draft, "Changed outside child");
    w.handleInput(bringBack);
    expect(text(w)).toContain("Cancel and reopen Preferences");
    w.handleInput(enter); expect(text(w)).toContain("Saved snapshot");
    expect(f.controller.getRecord(source.id)!.input.preferences).toBeUndefined();
    expect(f.complete).not.toHaveBeenCalled();
    w.handleInput(esc); w.handleInput(esc); w.dispose();
  });
});

function workspaceSetup(key: KeyId | null = "alt+p", conflict = false, theme = "dark") {
  const f = setup([], "Extra", theme); f.panel.dispose();
  if (conflict) f.keys.setUserBindings({ "tui.editor.cursorLineEnd": "alt+p" });
  const preview = new PreviewPanel({ state: { phase: "ready", requestId: 1, pendingSend: false }, candidateText: "Source",
    contextLabel: "Original", elapsedSeconds: 0, openHint: "ctrl+\\", canRestore: false }, f.theme, () => f.terminal.rows, () => {});
  const submit = vi.fn((_text: string): string | undefined => "Keep editor open");
  let identity = "one";
  const workspace = new RefineWorkspace(preview, f.tui, f.theme, f.keys, {
    preferences: { repository: f.repo, key, maxChars: 16000 },
    context: () => ({ instructions: "off", tree: false, skills: false }), contextEnabled: () => false,
    saveContext: async () => ({ message: "", persisted: true }), submit: vi.fn(), revision: () => ({ key: identity, submit }),
  });
  workspace.focused = true;
  return { ...f, workspace, submit, identity: (id: string) => { identity = id; } };
}
describe("workspace preference integration", () => {
  it.each(["dark", "light"])("reviews exact snapshots without submitting, restores input, and fits resized %s views", async (theme) => {
    const f = workspaceSetup("alt+p", false, theme); const w = f.workspace;
    w.handleInput("f"); w.handleInput("补充 中文😀\x1b[2J");
    w.handleInput(altP); await loaded(w); w.handleInput(" "); w.handleInput(bringBack);
    expect(text(w)).toContain("Preferences: 1");
    w.handleInput("\t"); w.handleInput("\t"); w.handleInput(enter);
    expect(text(w)).toContain("Full revision requirements");
    expect(text(w)).toContain(a.body);
    w.handleInput(ctrlS); expect(f.submit).not.toHaveBeenCalled();
    for (const [width, rows] of [[100, 40], [36, 16], [12, 8], [80, 30]]) {
      f.terminal.rows = rows!;
      const lines = w.render(width!);
      expect(lines.length).toBeGreaterThanOrEqual(Math.min(18, panelLayout(width!, rows!).height));
      expect(lines.length).toBeLessThanOrEqual(panelLayout(width!, rows!).height);
      expect(w.render(width!)).toHaveLength(lines.length);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width!);
      expect(lines.join("\n")).not.toContain("\x1b[2J");
      w.handleInput("\x1b[6~"); w.handleInput("\x1b[5~");
    }
    f.terminal.rows = 40;
    expect(w.render(100).join("\n")).toContain(f.theme.fg("text", f.theme.bold("Full revision requirements")));
    w.handleInput(esc); w.handleInput("!"); w.handleInput(ctrlS);
    expect(f.submit.mock.calls.at(-1)![0]).toContain(`${a.body}\n\nCurrent user instructions:\n补充 中文😀`);
    expect(f.submit.mock.calls.at(-1)![0]).toContain("!");
    w.handleInput(esc); w.handleInput("f");
    expect(text(w)).toContain("Preferences: 1");
  });

  it("disables a local key that conflicts with Pi's resolved bindings", async () => {
    const f = workspaceSetup("alt+p", true); const w = f.workspace;
    w.handleInput("f"); expect(text(w)).toContain("Preferences key conflicts");
    w.handleInput(altP); expect(text(w)).toContain("Revise current result");
    w.handleInput("\t"); w.handleInput(enter); await loaded(w);
    expect(text(w)).toContain("Bring back");
  });
  it("does not let Undo restore another candidate's free input", () => {
    const f = workspaceSetup(); const w = f.workspace;
    w.handleInput("f"); w.handleInput("Private first feedback"); w.handleInput(esc);
    f.identity("two"); w.handleInput("f"); w.handleInput("Second feedback");
    w.handleInput("\x1b[45;5u"); w.handleInput(ctrlS);
    expect(f.submit).not.toHaveBeenCalled();
    expect(text(w)).toContain("Select preferences or enter additional requirements");
  });
  it("submits only on Revise Ctrl+S; preserves cursor, selection and candidate isolation", async () => {
    const f = workspaceSetup(); const w = f.workspace;
    w.handleInput("f"); w.handleInput("AB"); w.handleInput(left);
    w.handleInput(altP); await loaded(w);
    w.handleInput(" "); w.handleInput(ctrlS); w.handleInput(enter); w.handleInput(ctrlS); w.handleInput(esc);
    expect(f.submit).not.toHaveBeenCalled();
    w.handleInput(bringBack); w.handleInput("X");
    w.handleInput(ctrlS); expect(f.submit).toHaveBeenLastCalledWith(composeRevision([selectPreference(a)], "AXB"));
    w.handleInput(esc); f.identity("two"); w.handleInput("f"); w.handleInput("Other"); w.handleInput(ctrlS);
    expect(f.submit).toHaveBeenLastCalledWith("Other");
    w.handleInput(esc); f.identity("one"); w.handleInput("f"); w.handleInput(ctrlS);
    expect(f.submit).toHaveBeenLastCalledWith(composeRevision([selectPreference(a)], "AXB"));
  });
  it("cancels local selection changes and saves expanded paste instead of placeholders", async () => {
    const f = workspaceSetup(); const w = f.workspace;
    const pasted = "中文 😀 command --literal\n".repeat(100);
    w.handleInput("f"); w.handleInput(`\x1b[200~${pasted}\x1b[201~`);
    w.handleInput(altP); await loaded(w);
    w.handleInput("n"); w.handleInput("Paste"); save(w); await loaded(w);
    expect(f.repo.save.mock.calls[0]![1].body).toBe(pasted);
    w.handleInput(" "); w.handleInput(esc); w.handleInput(ctrlS);
    expect(f.submit).toHaveBeenLastCalledWith(pasted);
  });
  it("offers a focusable Preferences control without a binding and removes result p", async () => {
    const f = workspaceSetup(null); const w = f.workspace;
    w.openResult(); w.handleInput("p");
    expect(text(w)).toContain("Press f to revise");
    w.handleInput("f"); w.handleInput("\t"); w.handleInput(enter); await loaded(w);
    expect(text(w)).toContain("Bring back"); w.handleInput(esc);
    w.handleInput("\x1bOQ"); expect(text(w)).toContain("Revise current result");
    w.handleInput(ctrlS); expect(f.submit).not.toHaveBeenCalled();
  });
});
