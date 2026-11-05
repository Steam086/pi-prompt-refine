import { stripVTControlCharacters } from "node:util";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, visibleWidth, wrapTextWithAnsi, type KeyId, type TUI } from "@earendil-works/pi-tui";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { PreferencePanel } from "../src/preference-panel.js";
import { RefineWorkspace } from "../src/workspace.js";
import { PreviewPanel } from "../src/preview.js";
import { composeRevision, selectPreference, type PreferenceLibrary, type PreferenceRepository, type RevisionPreference, type SelectedPreference } from "../src/revision-preferences.js";
import * as preferences from "../src/revision-preferences.js";
import * as presentation from "../src/presentation.js";
import { panelLayout } from "../src/panel-layout.js";
import { formatKeyHint, type KeyHint } from "../src/key-hints.js";

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
function setup(selected: SelectedPreference[] = [], free = "Extra", themeName = "dark", entries = [a, b]) {
  const terminal = { rows: 40, columns: 100 };
  const tui = { terminal, requestRender: vi.fn() } as unknown as TUI;
  const theme = getThemeByName(themeName)!;
  const keys = new KeybindingsManager(TUI_KEYBINDINGS);
  const { repo, library } = repository(entries); const close = vi.fn();
  const panel = new PreferencePanel(tui, theme, keys, repo, selected, free, 16000, close);
  panel.focused = true;
  return { panel, repo, library, close, terminal, tui, theme, keys };
}
const text = (panel: { render(width: number): string[] }, width = 100) => stripVTControlCharacters(panel.render(width).join("\n"));
async function loaded(panel: { render(width: number): string[] }) { await vi.waitFor(() => expect(text(panel)).not.toContain("Working…")); }
function search(panel: PreferencePanel, query: string) {
  panel.handleInput("/"); panel.handleInput("\x15"); panel.handleInput(query); panel.handleInput(enter);
}
function save(panel: { handleInput(data: string): unknown }) {
  for (let i = 0; i < 3; i++) panel.handleInput(tab);
  panel.handleInput(enter);
}

describe("three-action preference library", () => {
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
    expect(f.repo.save).toHaveBeenCalledWith("project", { name: "Saved", body: "Reusable full text" }, undefined);
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
    f.panel.handleInput(tab); f.panel.handleInput(tab); f.panel.handleInput(enter); await loaded(f.panel);
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

describe("preference rendering and responsiveness", () => {
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
    expect(f.panel.render(40).slice(-2).join("\n")).toContain(f.theme.fg("muted", firstLine));
  });
});

function workspaceSetup(key: KeyId | null = "alt+p", conflict = false) {
  const f = setup(); f.panel.dispose();
  if (conflict) f.keys.setUserBindings({ "tui.editor.cursorLineEnd": "alt+p" });
  const preview = new PreviewPanel({ state: { phase: "ready", requestId: 1, pendingSend: false }, candidateText: "Source",
    contextLabel: "Original", elapsedSeconds: 0, openHint: "ctrl+\\", canRestore: false }, f.theme, () => f.terminal.rows, () => {});
  const submit = vi.fn((_text: string): string | undefined => "Keep editor open");
  let identity = "one";
  const workspace = new RefineWorkspace(preview, f.tui, f.theme, f.keys, {
    preferences: { repository: f.repo, key, maxChars: 16000 },
    context: () => ({ instructions: "off", tree: false, skills: false }), contextEnabled: () => false,
    saveContext: async () => "", submit: vi.fn(), revision: () => ({ key: identity, submit }),
  });
  workspace.focused = true;
  return { ...f, workspace, submit, identity: (id: string) => { identity = id; } };
}
describe("workspace preference integration", () => {
  it("disables a local key that conflicts with Pi's resolved bindings", async () => {
    const f = workspaceSetup("alt+p", true); const w = f.workspace;
    w.handleInput("f"); expect(text(w)).toContain("Preferences key conflicts");
    w.handleInput(altP); expect(text(w)).toContain("Revise current result");
    w.handleInput(esc); w.handleInput("p"); await loaded(w);
    expect(text(w)).toContain("Preferences");
  });
  it("does not let Undo restore another candidate's free input", () => {
    const f = workspaceSetup(); const w = f.workspace;
    w.handleInput("f"); w.handleInput("Private first feedback"); w.handleInput(esc);
    f.identity("two"); w.handleInput("f"); w.handleInput("Second feedback");
    w.handleInput("\x1b[45;5u"); w.handleInput(ctrlS);
    expect(f.submit.mock.calls.at(-1)![0]).toBe("");
  });
  it("submits only on Revise Ctrl+S; preserves cursor, selection and candidate isolation", async () => {
    const f = workspaceSetup(); const w = f.workspace;
    w.handleInput("f"); w.handleInput("AB"); w.handleInput(left);
    w.handleInput(altP); await loaded(w);
    w.handleInput(" "); w.handleInput(ctrlS); w.handleInput(enter); w.handleInput(ctrlS); w.handleInput(esc);
    expect(f.submit).not.toHaveBeenCalled();
    w.handleInput(bringBack); w.handleInput("X");
    w.handleInput(ctrlS); expect(f.submit).toHaveBeenLastCalledWith(`${a.body}\n\nAXB`);
    w.handleInput(esc); f.identity("two"); w.handleInput("f"); w.handleInput("Other"); w.handleInput(ctrlS);
    expect(f.submit).toHaveBeenLastCalledWith("Other");
    w.handleInput(esc); f.identity("one"); w.handleInput("f"); w.handleInput(ctrlS);
    expect(f.submit).toHaveBeenLastCalledWith(`${a.body}\n\nAXB`);
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
  it("keeps the result p entry when the Revise binding is disabled, and never uses F2", async () => {
    const f = workspaceSetup(null); const w = f.workspace;
    w.openResult(); w.handleInput("p"); await loaded(w);
    expect(text(w)).toContain("Preferences"); w.handleInput(esc);
    w.handleInput("\x1bOQ"); expect(text(w)).toContain("Revise current result");
    w.handleInput(ctrlS); expect(f.submit).toHaveBeenLastCalledWith(composeRevision([], ""));
  });
});
