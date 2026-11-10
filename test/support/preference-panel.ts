import { KeybindingsManager, TUI_KEYBINDINGS, type KeyId, type TUI } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { expect, vi } from "vitest";
import { selectHistory } from "../../src/context.js";
import { RefineController } from "../../src/controller.js";
import { PreferencePanel } from "../../src/preference-panel.js";
import { PreviewPanel } from "../../src/preview.js";
import { type PreferenceLibrary, type PreferenceRepository, type RevisionPreference, type SelectedPreference } from "../../src/revision-preferences.js";
import { RefineWorkspace } from "../../src/workspace.js";
import { getThemeByName } from "./pi-theme.js";

export const esc = "\x1b", enter = "\r", tab = "\t", backTab = "\x1b[Z", down = "\x1b[B", left = "\x1b[D", right = "\x1b[C";

export const ctrlS = "\x13", altP = "\x1bp", bringBack = "\x1b[13;3u";

export const a: RevisionPreference = { id: "a", version: 1, scope: "global", name: "Concise 中文", body: "Keep hard constraints." };

export const b: RevisionPreference = { id: "b", version: 1, scope: "project", name: "Literal", body: "Keep commands unchanged." };

export function repository(entries: RevisionPreference[] = [a, b]) {
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

export function setup(selected: SelectedPreference[] = [], free = "Extra", themeName = "dark", entries = [a, b], purpose: "revise" | "refine" | "manage" = "revise") {
  const terminal = { rows: 40, columns: 100 };
  const tui = { terminal, requestRender: vi.fn() } as unknown as TUI;
  const theme = getThemeByName(themeName)!;
  const keys = new KeybindingsManager(TUI_KEYBINDINGS);
  const { repo, library } = repository(entries); const close = vi.fn();
  const panel = new PreferencePanel(tui, theme, keys, repo, selected, free, 16000, close, purpose);
  panel.focused = true;
  return { panel, repo, library, close, terminal, tui, theme, keys };
}

export const text = (panel: { render(width: number): string[] }, width = 100) => stripVTControlCharacters(panel.render(width).join("\n"));

export async function loaded(panel: { render(width: number): string[] }) { await vi.waitFor(() => expect(text(panel)).not.toContain("Working…")); }

export function search(panel: PreferencePanel, query: string) {
  panel.handleInput("/"); panel.handleInput("\x15"); panel.handleInput(query); panel.handleInput(enter);
}

export function save(panel: { handleInput(data: string): unknown }) {
  panel.handleInput(backTab);
  panel.handleInput(enter);
}

export const listRows = (panel: PreferencePanel, width = 70) => text(panel, width).split("\n").filter((line) => /\[[x ]\]/.test(line));

export const highlightedRow = (panel: PreferencePanel, width = 70) => listRows(panel, width).find((line) => line.includes("›"));

export function unsentWorkspaceSetup(key: KeyId | null = "alt+p", conflict = false, theme = "dark", maxChars = 16000, maxConcurrent = 4) {
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

export function workspaceSetup(key: KeyId | null = "alt+p", conflict = false, theme = "dark") {
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
