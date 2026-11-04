import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, visibleWidth, type KeyId, type TUI } from "@earendil-works/pi-tui";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { PreferencePanel } from "../src/preference-panel.js";
import { RefineWorkspace } from "../src/workspace.js";
import { PreviewPanel } from "../src/preview.js";
import { composeRevision, selectPreference, type PreferenceLibrary, type PreferenceRepository, type RevisionPreference, type SelectedPreference } from "../src/revision-preferences.js";
import { panelLayout } from "../src/panel-layout.js";

const esc = "\x1b", enter = "\r", tab = "\t", down = "\x1b[B", left = "\x1b[D", ctrlS = "\x13", f2 = "\x1bOQ";
const a: RevisionPreference = { id: "a", version: 1, scope: "global", name: "Concise 中文", body: "Keep hard constraints." };
const b: RevisionPreference = { id: "b", version: 1, scope: "project", name: "Literal", body: "Keep commands unchanged." };
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
function setup(selected: SelectedPreference[] = [], free = "Extra", themeName = "dark") {
  const terminal = { rows: 40, columns: 100 };
  const tui = { terminal, requestRender: vi.fn() } as unknown as TUI;
  const theme = getThemeByName(themeName)!;
  const keys = new KeybindingsManager(TUI_KEYBINDINGS);
  const { repo, library } = repository(); const close = vi.fn();
  const panel = new PreferencePanel(tui, theme, keys, repo, selected, free, 16000, close);
  panel.focused = true;
  return { panel, repo, library, close, terminal, tui, theme, keys };
}
const text = (panel: { render(width: number): string[] }, width = 100) => stripVTControlCharacters(panel.render(width).join("\n"));
async function loaded(panel: { render(width: number): string[] }) { await vi.waitFor(() => expect(text(panel)).not.toContain("Working…")); }
function action(panel: { handleInput(data: string): unknown; render(width: number): string[] }, label: string) {
  for (let i = 0; i < 15; i++) {
    if (text(panel).split("\n").some((line) => line.includes("› [") && line.includes(label))) { panel.handleInput(enter); return; }
    panel.handleInput(tab);
  }
  throw new Error(`Could not focus ${label}: ${text(panel)}`);
}

describe("preference selection transaction", () => {
  it("distinguishes current and pending previews; cancelling retains the committed selection", async () => {
    const selected = [selectPreference(a)]; const f = setup(selected); await loaded(f.panel);
    f.panel.handleInput(enter); f.panel.handleInput(" "); // Remove A
    f.panel.handleInput(down); f.panel.handleInput(" "); // Select B
    action(f.panel, "Current actual");
    expect(text(f.panel)).toContain(a.body); expect(text(f.panel)).not.toContain(b.body);
    f.panel.handleInput(ctrlS); expect(f.close).not.toHaveBeenCalled();
    f.panel.handleInput(esc);
    action(f.panel, "Preview after");
    expect(text(f.panel)).toContain("NOT active"); expect(text(f.panel)).toContain(b.body); expect(text(f.panel)).not.toContain(a.body);
    f.panel.handleInput(enter); expect(f.close).not.toHaveBeenCalled();
    f.panel.handleInput(esc); f.panel.handleInput(esc);
    expect(f.close).toHaveBeenCalledWith(); expect(selected).toEqual([selectPreference(a)]);
    expect(f.repo.save).not.toHaveBeenCalled();
  });
  it("preserves off-search selections and click order across views and temporary edits", async () => {
    const f = setup(); await loaded(f.panel);
    f.panel.handleInput("Literal"); f.panel.handleInput(enter); f.panel.handleInput(" ");
    action(f.panel, "Clear search"); f.panel.handleInput(enter); f.panel.handleInput(" ");
    action(f.panel, "Show all selected");
    expect(text(f.panel)).toContain("2 selected");
    action(f.panel, "Edit selected for");
    f.panel.handleInput(" Temporary");
    actionFormSave(f.panel, true);
    action(f.panel, "Bring back");
    const chosen = f.close.mock.calls[0]![0] as SelectedPreference[];
    expect(chosen.map((entry) => entry.id)).toEqual(["b", "a"]);
    expect(chosen[0]!.body).toBe(`${b.body} Temporary`);
    expect(chosen[0]!.sourceBody).toBe(b.body);
    expect(f.repo.save).not.toHaveBeenCalled();
  });
  it("explicit library save survives selection cancellation without auto-selecting", async () => {
    const f = setup([], "Reusable full text"); await loaded(f.panel);
    action(f.panel, "Save new from");
    f.panel.handleInput("Saved"); f.panel.handleInput(ctrlS);
    expect(f.repo.save).not.toHaveBeenCalled();
    actionFormSave(f.panel);
    await loaded(f.panel);
    expect(f.repo.save).toHaveBeenCalledWith("project", { name: "Saved", body: "Reusable full text" }, undefined);
    expect(text(f.panel)).toContain("0 selected");
    f.panel.handleInput(esc); expect(f.close).toHaveBeenCalledWith();
    expect(f.library.entries.find((entry) => entry.id === "new")?.body).toBe("Reusable full text");
  });
  it("keeps form text on write conflict and requires explicit discard", async () => {
    const f = setup(); await loaded(f.panel);
    f.repo.save.mockRejectedValueOnce(new Error("Conflict: changed elsewhere"));
    action(f.panel, "Save new from"); f.panel.handleInput("New title"); actionFormSave(f.panel);
    await loaded(f.panel);
    expect(text(f.panel)).toContain("Conflict"); expect(text(f.panel)).toContain("New title");
    f.panel.handleInput(esc); expect(text(f.panel)).toContain("Discard unsaved form?");
    f.panel.handleInput(esc); expect(text(f.panel)).toContain("New title");
    f.panel.handleInput(esc); f.panel.handleInput("y");
    expect(text(f.panel)).toContain("Form discarded"); expect(f.close).not.toHaveBeenCalled();
  });
  it("refreshes changed/deleted sources without modifying selected snapshots", async () => {
    const f = setup([selectPreference(a)]); await loaded(f.panel);
    f.library.entries = [{ ...a, version: 2, body: "Changed" }, b];
    action(f.panel, "Refresh library"); await loaded(f.panel);
    expect(text(f.panel)).toContain("Library entry");
    expect(text(f.panel)).toContain("Changed");
    expect(text(f.panel)).toContain("Selected snapshot");
    expect(text(f.panel)).toContain(a.body);
    action(f.panel, "Show all selected");
    f.panel.handleInput(enter); expect(text(f.panel)).toContain("Library changed; snapshot kept");
    expect(text(f.panel)).toContain(a.body); f.panel.handleInput(esc);
    action(f.panel, "Delete library"); f.panel.handleInput(enter);
    expect(f.repo.remove).not.toHaveBeenCalled();
    f.panel.handleInput("y"); await loaded(f.panel);
    f.panel.handleInput(esc); // Cancel selection, committed snapshot untouched
    expect(f.close).toHaveBeenCalledWith();
  });
  it("distinguishes empty/no-match/load errors and retains the search", async () => {
    const f = setup(); await loaded(f.panel);
    f.panel.handleInput("nothing matches"); expect(text(f.panel)).toContain("No matches");
    action(f.panel, "Clear search"); expect(text(f.panel)).toContain(a.name);
    f.library.entries = []; action(f.panel, "Refresh library"); await loaded(f.panel);
    expect(text(f.panel)).toContain("Library is empty");
    f.library.errors.global = "global: unreadable";
    action(f.panel, "Refresh library"); await loaded(f.panel);
    expect(text(f.panel)).toContain("Load failed"); expect(text(f.panel)).not.toContain("Library is empty");
  });
  it("ignores a write completion after disposal", async () => {
    const f = setup(); await loaded(f.panel);
    let finish!: (value: RevisionPreference) => void;
    f.repo.save.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    action(f.panel, "Save new from"); f.panel.handleInput("Name"); actionFormSave(f.panel);
    expect(text(f.panel)).toContain("Working…"); f.panel.dispose();
    const renders = vi.mocked(f.tui.requestRender).mock.calls.length;
    finish(a); await Promise.resolve(); await Promise.resolve();
    expect(f.close).not.toHaveBeenCalled(); expect(f.tui.requestRender).toHaveBeenCalledTimes(renders);
  });
  it.each(["dark", "light"])("keeps all pages bounded and focused fields visible at small sizes (%s)", async (theme) => {
    const f = setup([], "中文 😀\n".repeat(100), theme); await loaded(f.panel);
    const check = () => {
      for (const rows of [5, 8, 16, 40]) for (const width of [12, 20, 40, 100]) {
        f.terminal.rows = rows;
        const lines = f.panel.render(width);
        expect(lines).toHaveLength(panelLayout(width, rows).height);
        for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
      f.terminal.rows = 40;
    };
    check(); f.panel.handleInput(enter); f.panel.handleInput(enter); check(); f.panel.handleInput(esc);
    action(f.panel, "Save new from"); check();
    f.panel.handleInput(tab); check();
    expect(f.panel.render(100).join("\n")).toContain(CURSOR_MARKER);
  });
});
function actionFormSave(panel: PreferencePanel, local = false) {
  for (let i = 0; i < (local ? 1 : 3); i++) panel.handleInput(tab);
  panel.handleInput(enter);
}

function workspaceSetup(key: KeyId | null = "f2", conflict = false) {
  const f = setup(); f.panel.dispose();
  if (conflict) f.keys.setUserBindings({ "tui.editor.cursorLineEnd": "f2" });
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
    const f = workspaceSetup("f2", true); const w = f.workspace;
    w.handleInput("f");
    expect(text(w)).toContain("Preferences key conflicts");
    w.handleInput(f2); expect(text(w)).toContain("Revise current result");
    w.handleInput(esc); w.handleInput("p"); await loaded(w);
    expect(text(w)).toContain("Preferences · only this revision");
  });
  it("does not let Undo restore another candidate's free input", () => {
    const f = workspaceSetup(); const w = f.workspace;
    w.handleInput("f"); w.handleInput("Private first feedback"); w.handleInput(esc);
    f.identity("two"); w.handleInput("f"); w.handleInput("Second feedback");
    w.handleInput("\x1b[45;5u"); // Kitty Ctrl+- (Editor undo)
    w.handleInput(ctrlS);
    expect(f.submit.mock.calls.at(-1)![0]).not.toContain("first feedback");
    expect(f.submit.mock.calls.at(-1)![0]).toBe("");
  });
  it("submits only on Revise Ctrl+S; preserves cursor, selection and candidate isolation", async () => {
    const f = workspaceSetup(); const w = f.workspace;
    w.handleInput("f"); w.handleInput("AB"); w.handleInput(left);
    w.handleInput(f2); await loaded(w);
    w.handleInput(enter); w.handleInput(" ");
    w.handleInput(ctrlS); w.handleInput(enter); w.handleInput(ctrlS); w.handleInput(esc);
    expect(f.submit).not.toHaveBeenCalled();
    action(w, "Bring back"); w.handleInput("X");
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
    w.handleInput(f2); await loaded(w);
    action(w, "Save new from"); w.handleInput("Paste");
    for (let i = 0; i < 3; i++) w.handleInput(tab); w.handleInput(enter); await loaded(w);
    expect(f.repo.save.mock.calls[0]![1].body).toBe(pasted);
    action(w, "Show all selected"); w.handleInput(esc); w.handleInput(ctrlS);
    expect(f.submit).toHaveBeenLastCalledWith(pasted);
  });
  it("has a non-function-key entry when the Revise binding is disabled", async () => {
    const f = workspaceSetup(null); const w = f.workspace;
    w.openResult(); w.handleInput("p"); await loaded(w);
    expect(text(w)).toContain("Preferences"); w.handleInput(esc);
    w.handleInput(f2); expect(text(w)).toContain("Revise current result");
    w.handleInput(ctrlS); expect(f.submit).toHaveBeenLastCalledWith(composeRevision([], ""));
  });
});
