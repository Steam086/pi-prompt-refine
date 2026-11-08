import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { PreviewPanel } from "../src/preview.js";
import { RefineWorkspace } from "../src/workspace.js";
import { selectHistory } from "../src/context.js";
import type { RefineRecord } from "../src/history.js";
import type { TaskPanelPosition } from "../src/task-panel.js";
import type { PreferenceLibrary } from "../src/revision-preferences.js";

function fixture(themeName = "dark", draft = "Short 中文😀", rows = 60, bindings = {}) {
  const terminal = { columns: 100, rows };
  const tui = { terminal, requestRender: vi.fn() } as unknown as TUI;
  const theme = getThemeByName(themeName)!;
  const keys = new KeybindingsManager({ ...TUI_KEYBINDINGS, ...bindings });
  const input = { draft, model: { provider: "p", id: "m" }, sessionId: "s", branchLeafId: null,
    systemPrompt: "Policy", history: selectHistory([], 0, 0) };
  const original: RefineRecord = { id: 1, taskId: 1, kind: "refine", status: "unsent", createdAt: 1, input };
  const result: RefineRecord = { id: 2, taskId: 2, kind: "refine", status: "generated", createdAt: 2, input: { ...input },
    candidate: { ...input, requestId: 2, version: 1, generation: 0, text: Array.from({ length: 90 }, (_, i) => `RESULT ${i} 中文😀`).join("\n") } };
  const records = [original, result];
  const position: TaskPanelPosition = { selectedTaskId: 1 };
  let resolveLibrary!: (library: PreferenceLibrary) => void;
  const load = vi.fn(() => new Promise<PreferenceLibrary>((resolve) => { resolveLibrary = resolve; }));
  const run = vi.fn();
  const accept = vi.fn();
  const panel = new PreviewPanel({ state: { phase: "ready", requestId: 2, pendingSend: false },
    candidateText: result.candidate!.text, draft, contextLabel: "Draft only", elapsedSeconds: 0, openHint: "ctrl+\\", canRestore: false,
  }, theme, () => terminal.rows, () => tui.requestRender());
  const workspace = new RefineWorkspace(panel, tui, theme, keys, {
    tasks: { records: () => records, appliedId: () => undefined, activate: () => true, run, accept, stop() {}, deleteRecords: () => true }, taskPosition: position,
    history: () => records,
    context: () => ({ instructions: "always", tree: false, skills: false }), contextEnabled: () => true,
    saveContext: async () => ({ message: "Saved", persisted: true }), submit: () => undefined,
    original: () => ({ text: original.input.draft, save: () => undefined, cancel() {} }),
    revision: () => ({ key: "result-2", label: "m · Run #2", submit: () => undefined }),
    preferences: { key: null, maxChars: 16000, repository: { load, save: vi.fn(), remove: vi.fn() } },
    draftPreferences: () => ({ selected: [], save: () => undefined }),
  });
  workspace.focused = true;
  const frame = () => workspace.render(terminal.columns);
  const text = () => stripVTControlCharacters(frame().join("\n"));
  return { workspace, panel, frame, text, position, terminal, records, original, result, run, accept, load, theme,
    resolveLibrary: (body = "Keep literals") => resolveLibrary({ errors: {}, entries: [{ id: "p1", version: 1, scope: "project", name: "Preference 中文😀", body }] }) };
}

describe("workspace height lifecycle", () => {
  it.each([["dark", 80], ["dark", 100], ["light", 80], ["light", 100]] as const)("expands explicitly, restores result/reference anchors and keeps the action target (%s / %s columns)", (name, width) => {
    const f = fixture(name);
    f.terminal.columns = width;
    vi.spyOn(f.theme, "bold").mockImplementation((value) => `\x1b[1m${value}\x1b[22m`);
    try {
      const height = f.frame().length;
      const expand = f.theme.fg("text", f.theme.bold("Ctrl+E")) + " " + f.theme.fg("muted", "Expand");
      expect(f.frame().join("\n")).toContain(expand);
      f.position.selectedTaskId = undefined; f.position.selectedId = 2;
      f.result.input.draft = Array.from({ length: 100 }, (_, i) => `REFERENCE ${i}`).join("\n");
      f.workspace.handleInput("\r");
      for (const key of ["", "o"]) {
        if (key) f.workspace.handleInput(key);
        for (let i = 0; i < 20; i++) { f.workspace.handleInput("\x1b[6~"); f.frame(); }
        const before = f.frame();
        const position = structuredClone(f.position);
        f.workspace.handleInput("\x05");
        expect(f.frame()).toHaveLength(51);
        expect(f.text()).toContain("Collapse");
        expect(f.position).toEqual(position);
        f.workspace.handleInput("\x05");
        expect(f.frame()).toEqual(before);
        expect(f.frame()).toHaveLength(height);
      }
      f.workspace.handleInput("a");
      expect(f.accept).toHaveBeenCalledExactlyOnceWith(2);
      expect(f.run).not.toHaveBeenCalled();
      // The compatible result reader also retains its compact near-end anchor.
      f.workspace.openResult(); f.frame();
      f.panel.scrollBy(10000);
      const before = f.frame();
      f.workspace.handleInput("\x05"); expect(f.frame()).toHaveLength(51);
      f.workspace.handleInput("\x05"); expect(f.frame()).toEqual(before);
    } finally { f.workspace.dispose(); vi.restoreAllMocks(); }
  });

  it("preserves inline document anchors, while new scroll input starts at the effective offset", async () => {
    const f = fixture();
    try {
      f.frame();
      f.resolveLibrary(Array.from({ length: 60 }, (_, i) => `REQUIREMENT ${i}`).join("\n"));
      await Promise.resolve();
      f.workspace.handleInput("\t"); f.workspace.handleInput("o"); f.frame();
      f.workspace.handleInput("\x1b[F");
      const before = f.frame();
      f.workspace.handleInput("\x05"); expect(f.frame()).toHaveLength(51);
      f.workspace.handleInput("\x05"); expect(f.frame()).toEqual(before);
      f.workspace.handleInput("\x05"); f.frame();
      f.workspace.handleInput("\x1b[A"); // Move relative to the expanded visible position, not the old sentinel.
      expect(f.text()).not.toContain("REQUIREMENT 59");
      f.workspace.handleInput("\x1b"); f.workspace.handleInput("\x1b");
      f.position.selectedTaskId = undefined; f.position.selectedId = 2;
      f.workspace.handleInput("\r"); f.frame();
      for (let i = 0; i < 30; i++) { f.workspace.handleInput("\x1b[6~"); f.frame(); }
      f.workspace.handleInput("\x05"); f.frame();
      f.workspace.handleInput("\x05"); f.frame();
      f.workspace.handleInput("\x1b[A");
      expect(f.text()).not.toContain("RESULT 89 中文😀");
      expect(f.position.selectedId).toBe(2);
      expect(f.run).not.toHaveBeenCalled();
    } finally { f.workspace.dispose(); }
  });

  it("never steals expansion keys from inputs, search, child pages, help or confirmation", async () => {
    const f = fixture();
    try {
      const height = f.frame().length;
      f.resolveLibrary(); await Promise.resolve();
      for (const keys of [
        ["i", "\x05", "\x1b"],
        ["\x1b[Z", "/", "\x05", "\x1b", "\x1b"],
        ["p", "\x05", "\x1b"],
        ["?", "\x05", "\x1b"],
        ["d", "\x05", "\x1b"],
      ]) for (const key of keys) {
        f.workspace.handleInput(key);
        expect(f.frame()).toHaveLength(height);
      }
      f.workspace.openResult(); f.workspace.handleInput("f");
      expect(f.text()).toContain("Revise");
      f.workspace.handleInput("\x05");
      expect(f.frame()).toHaveLength(height);
      expect(f.text()).toContain("Collapse"); // Existing editor expansion, not outer height.
      f.workspace.handleInput("\x1b"); f.workspace.openTasks();
      expect(f.text()).toContain("Expand");
      expect(f.run).not.toHaveBeenCalled();
    } finally { f.workspace.dispose(); }
  });

  it("uses a non-conflicting fallback and disables unavailable transitions", () => {
    const f = fixture("dark", "Short", 60, { "app.test": { defaultKeys: "ctrl+e", description: "Conflict" } });
    const tiny = fixture("light", "Short", 8);
    const blocked = fixture("dark", "Short", 60, { "app.test": { defaultKeys: ["ctrl+e", "=", "+"], description: "All conflict" } });
    try {
      expect(f.text()).toContain("= Expand");
      const height = f.frame().length;
      f.workspace.handleInput("\x05"); expect(f.frame()).toHaveLength(height);
      f.workspace.handleInput("="); expect(f.frame()).toHaveLength(51);
      expect(f.text()).toContain("= Collapse");
      f.workspace.handleInput("="); expect(f.frame()).toHaveLength(height);
      f.workspace.handleInput("i"); f.workspace.handleInput("=");
      expect(f.frame()).toHaveLength(height); // Fallback is ordinary text in an editor.
      f.workspace.handleInput("\x1b");
      expect(tiny.text()).not.toMatch(/Expand|Collapse/);
      const tinyHeight = tiny.frame().length;
      tiny.workspace.handleInput("\x05"); expect(tiny.frame()).toHaveLength(tinyHeight);
      const blockedHeight = blocked.frame().length;
      expect(blocked.text()).not.toMatch(/Expand|Collapse/);
      for (const key of ["\x05", "=", "+"]) {
        blocked.workspace.handleInput(key);
        expect(blocked.frame()).toHaveLength(blockedHeight);
      }
    } finally { f.workspace.dispose(); tiny.workspace.dispose(); blocked.workspace.dispose(); }
  });

  it.each(["dark", "light"])("locks compact geometry through async loading, page/focus changes and updates (%s)", async (name) => {
    const f = fixture(name);
    try {
      const height = f.frame().length;
      expect(height).toBe(20);
      expect(f.load).toHaveBeenCalledTimes(1);
      f.resolveLibrary(); await Promise.resolve();
      for (const key of ["\t", "\t", " ", "/", "中文", "\x1b", "\x1b", "p", "\x1b", "\x1b[C", "\x1b[C", "\x1b[C", "i", "more", "\x1b"]) {
        f.workspace.handleInput(key);
        expect(f.frame()).toHaveLength(height);
      }
      f.original.input.draft = "Long original\n".repeat(100);
      f.result.candidate!.text = "New result\n".repeat(300);
      f.records.push({ ...f.result, id: 3 });
      f.workspace.invalidate();
      expect(f.frame()).toHaveLength(height);
      f.records.splice(2);
      expect(f.frame()).toHaveLength(height);
      f.workspace.openResult();
      expect(f.frame()).toHaveLength(height);
      f.workspace.handleInput("f");
      expect(f.frame()).toHaveLength(height);
      f.workspace.handleInput("\x05"); // Existing Revise expansion does not resize the workspace.
      expect(f.frame()).toHaveLength(height);
      f.workspace.handleInput("\t"); f.workspace.handleInput("\r");
      expect(f.text()).toContain("Preferences");
      expect(f.frame()).toHaveLength(height);
      f.workspace.handleInput("\x1b"); f.workspace.handleInput("\x1b");
      expect(f.run).not.toHaveBeenCalled();
    } finally { f.workspace.dispose(); }
  });

  it("measures the initially opened result instead of the hidden task summary", () => {
    const f = fixture();
    try {
      f.workspace.openResult();
      expect(f.frame()).toHaveLength(24);
      f.workspace.openTasks();
      expect(f.frame()).toHaveLength(24);
    } finally { f.workspace.dispose(); }
  });

  it("uses more space for long opening content, not for later selection changes", () => {
    const short = fixture();
    const long = fixture("dark", "Long original 中文😀\n".repeat(60));
    try {
      expect(short.frame().length).toBeLessThan(long.frame().length);
      expect(long.frame()).toHaveLength(24);
      const height = short.frame().length;
      short.position.selectedTaskId = undefined; short.position.selectedId = 2;
      expect(short.frame()).toHaveLength(height);
      short.workspace.handleInput("\r");
      expect(short.text()).toContain("RESULT 0");
      short.workspace.handleInput("\x1b[6~");
      expect(short.text()).not.toContain("RESULT 0 中文😀");
      expect(short.frame()).toHaveLength(height);
    } finally { short.workspace.dispose(); long.workspace.dispose(); }
  });

  it.each(["dark", "light"])("reflows only on resize and keeps every page bounded (%s)", (name) => {
    const f = fixture(name);
    try {
      f.frame();
      for (const [columns, rows] of [[40, 14], [20, 8], [100, 60], [180, 80]] as const) {
        Object.assign(f.terminal, { columns, rows });
        const height = f.frame().length;
        for (const key of ["\x1b[C", "\x1b[C", "\x1b[C", "i", "\x1b"]) {
          f.workspace.handleInput(key);
          const frame = f.frame();
          expect(frame).toHaveLength(height);
          expect(frame.length).toBeLessThanOrEqual(Math.max(1, rows - 4));
          expect(frame.every((line) => visibleWidth(line) <= columns)).toBe(true);
        }
      }
    } finally { f.workspace.dispose(); }
  });
});
