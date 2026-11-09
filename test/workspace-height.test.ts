import { stripVTControlCharacters as strip } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { PreviewPanel } from "../src/preview.js";
import { RefineWorkspace } from "../src/workspace.js";
import { workspaceHeight, workspaceLayout, workspaceViewport } from "../src/workspace-overlay.js";
import { selectHistory } from "../src/context.js";
import type { RefineRecord } from "../src/history.js";
import type { TaskPanelPosition } from "../src/task-panel.js";
import type { PreferenceLibrary, RevisionDraft } from "../src/revision-preferences.js";

function fixture(themeName = "dark", draft = "Short 中文😀", drafts = new Map<string, RevisionDraft>()) {
  const terminal = { columns: 100, rows: 60 };
  const tui = { terminal, requestRender: vi.fn() } as unknown as TUI;
  const theme = getThemeByName(themeName)!;
  const input = { draft, model: { provider: "p", id: "m" }, sessionId: "s", branchLeafId: null,
    systemPrompt: "Policy", history: selectHistory([], 0, 0) };
  const original: RefineRecord = { id: 1, taskId: 1, kind: "refine", status: "unsent", createdAt: 1, input };
  const result: RefineRecord = { id: 2, taskId: 2, kind: "refine", status: "generated", createdAt: 2, input: { ...input },
    candidate: { ...input, requestId: 2, version: 1, generation: 0, text: Array.from({ length: 120 }, (_, i) => `RESULT ${i} 中文😀`).join("\n") } };
  const records = [original, result];
  const position: TaskPanelPosition = { selectedTaskId: 1 };
  let resolveLibrary!: (library: PreferenceLibrary) => void;
  const load = vi.fn(() => new Promise<PreferenceLibrary>((resolve) => { resolveLibrary = resolve; }));
  const run = vi.fn(); const accept = vi.fn(); const submit = vi.fn(() => undefined);
  const panel = new PreviewPanel({ state: { phase: "ready", requestId: 2, pendingSend: false },
    candidateText: result.candidate!.text, draft, contextLabel: "Draft only", elapsedSeconds: 0, openHint: "ctrl+\\", canRestore: false,
  }, theme, () => terminal.rows, () => tui.requestRender());
  const workspace = new RefineWorkspace(panel, tui, theme, new KeybindingsManager(TUI_KEYBINDINGS), {
    tasks: { records: () => records, appliedId: () => undefined, activate: () => true, run, accept, stop() {}, deleteRecords: () => true }, taskPosition: position,
    history: () => records, context: () => ({ instructions: "always", tree: false, skills: false }), contextEnabled: () => true,
    saveContext: async () => ({ message: "Saved", persisted: true }), submit: () => undefined,
    original: () => ({ text: original.input.draft, save: () => undefined, cancel() {} }), revisionDrafts: drafts,
    revision: () => ({ key: "s:result-2", label: "Run #2 · p/m", submit }),
    preferences: { key: "alt+p", maxChars: 16000, repository: { load, save: vi.fn(), remove: vi.fn() } },
    draftPreferences: () => ({ selected: [], save: () => undefined }),
  });
  workspace.focused = true;
  const frame = () => workspace.render(terminal.columns);
  const text = () => strip(frame().join("\n"));
  return { workspace, panel, frame, text, position, terminal, records, original, result, run, accept, load, theme, submit,
    resolveLibrary: () => resolveLibrary({ errors: {}, entries: [{ id: "p1", version: 1, scope: "project", name: "Preference 中文😀", body: "Keep literals" }] }) };
}

describe("overlay workspace lifecycle", () => {
  it.each(["dark", "light"])("keeps one full-height aligned shell across pages, loading and confirmation (%s)", async (name) => {
    const f = fixture(name);
    try {
      const height = workspaceHeight(60);
      expect(f.frame()).toHaveLength(height);
      f.resolveLibrary(); await Promise.resolve();
      for (const key of ["\t", " ", "o", "\x1b", "\x1b", "p", "\x1b", "?", "\x1b", "d", "\x1b", "\x1b[C", "\x1b[C", "\x1b[C", "i", "中文😀", "\x1b"]) {
        f.workspace.handleInput(key);
        const frame = f.frame();
        expect(frame).toHaveLength(height);
        const plain = frame.map(strip);
        expect(plain[0]).toMatch(/^╭─+╮$/);
        expect(plain.at(-1)).toMatch(/^╰─+╯$/);
        expect(plain.slice(1, -1).every((line) => line.startsWith("│") && line.endsWith("│"))).toBe(true);
        expect(frame.every((line) => visibleWidth(line) === f.terminal.columns)).toBe(true);
      }
      f.original.input.draft = "Long original\n".repeat(100);
      f.result.candidate!.text = "New result\n".repeat(300);
      f.workspace.invalidate();
      expect(f.frame()).toHaveLength(height);
      expect(f.run).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
    } finally { f.workspace.dispose(); }
  });

  it("allocates the same space to short and long opening content without a reading expansion mode", () => {
    const short = fixture(); const long = fixture("dark", "Long original 中文😀\n".repeat(60));
    try {
      expect(short.frame()).toHaveLength(long.frame().length);
      expect(short.text()).not.toMatch(/Expand|Collapse|Ctrl\+E/);
      const before = short.frame();
      short.workspace.handleInput("\x05");
      expect(short.frame()).toEqual(before);
      short.workspace.openResult();
      expect(short.frame()).toHaveLength(workspaceHeight(60));
    } finally { short.workspace.dispose(); long.workspace.dispose(); }
  });

  it.each(["dark", "light"])("keeps cursor, bounds and action identity through tiny and wide resizes (%s)", (name) => {
    const f = fixture(name);
    try {
      f.position.selectedTaskId = undefined; f.position.selectedId = 2;
      f.workspace.handleInput("\r");
      for (const [columns, rows] of [[100, 60], [20, 12], [7, 5], [1, 1], [240, 80], [40, 24]] as const) {
        Object.assign(f.terminal, { columns, rows });
        const frame = f.frame();
        expect(frame).toHaveLength(workspaceHeight(rows));
        expect(frame.every((line) => visibleWidth(line) === columns)).toBe(true);
        expect(f.position.selectedId).toBe(2);
        f.workspace.handleInput("f"); f.workspace.handleInput("Keep 中文😀");
        const input = f.frame();
        expect(input).toHaveLength(frame.length);
        expect(input.join("\n")).toContain(CURSOR_MARKER);
        expect(input.every((line) => visibleWidth(line) <= columns)).toBe(true);
        f.workspace.handleInput("\x1b");
        const viewport = workspaceViewport(columns, rows);
        expect(workspaceLayout(columns, rows).height).toBe(viewport.rows);
      }
      f.workspace.handleInput("a");
      expect(f.accept).toHaveBeenCalledExactlyOnceWith(2);
      expect(f.run).not.toHaveBeenCalled();
    } finally { f.workspace.dispose(); }
  });

  it("keeps a larger Revise editor, restores source reading and does not resize the shell", () => {
    const f = fixture();
    try {
      f.position.selectedTaskId = undefined; f.position.selectedId = 2;
      f.workspace.handleInput("\r"); f.frame();
      for (let i = 0; i < 3; i++) { f.workspace.handleInput("\x1b[6~"); f.frame(); }
      const source = f.frame();
      f.workspace.handleInput("f");
      expect(f.text()).toContain("Read-only reference");
      expect(f.text()).toContain("Editor only");
      expect(f.text()).toContain("Revision not submitted");
      const inputStart = f.frame().findIndex((line) => strip(line).includes("Additional requirements:"));
      const footerStart = f.frame().findIndex((line) => strip(line).includes("Ctrl+S"));
      expect(footerStart - inputStart - 1).toBeGreaterThanOrEqual(5);
      f.workspace.handleInput("\x05");
      expect(f.text()).toContain("Show source"); expect(f.text()).not.toContain("Read-only reference");
      expect(f.frame()).toHaveLength(source.length);
      f.workspace.handleInput("\x1b");
      expect(f.frame()).toEqual(source);
    } finally { f.workspace.dispose(); }
  });

  it("keeps unsubmitted requirements across overlay instances without requesting a model", () => {
    const drafts = new Map<string, RevisionDraft>();
    const first = fixture("dark", "Original", drafts);
    first.workspace.openResult(); first.workspace.handleInput("f"); first.workspace.handleInput("Retained 中文😀");
    first.workspace.dispose();
    const next = fixture("light", "Original", drafts);
    try {
      next.workspace.openResult(); next.workspace.handleInput("f");
      expect(next.text()).toContain("Retained 中文😀");
      expect(next.submit).not.toHaveBeenCalled();
    } finally { next.workspace.dispose(); }
  });
});
