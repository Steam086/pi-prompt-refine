import { CURSOR_MARKER, getKeybindings, TuiAltScreen, TuiMainScreen, visibleWidth, type Terminal, type TUI } from "@earendil-works/pi-tui";
import { stripVTControlCharacters as strip } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { selectHistory } from "../../src/context.js";
import type { RefineRecord } from "../../src/history.js";
import { formatKeyHint } from "../../src/key-hints.js";
import { PreviewPanel } from "../../src/preview.js";
import { TaskPanel } from "../../src/task-panel.js";
import { workspaceHeight } from "../../src/workspace-overlay.js";
import { RefineWorkspace } from "../../src/workspace.js";
import { getThemeByName } from "../support/pi-theme.js";

const esc = "\x1b", tab = "\t", ctrlS = "\x13", ctrlE = "\x05";
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function setup(name: string, rows = 40, columns = 100, host?: TUI) {
  const theme = getThemeByName(name)!;
  // Non-TTY Chalk disables weight; exercise actual SGR boundaries explicitly.
  vi.spyOn(theme, "bold").mockImplementation((text) => `\x1b[1m${text}\x1b[22m`);
  const terminal = (host?.terminal ?? { rows, columns }) as { rows: number; columns: number };
  const tui = host ?? { terminal, requestRender: vi.fn() } as unknown as TUI;
  const input = { sessionId: "session", branchLeafId: "leaf", draft: "ORIGINAL 中文😀", model: { provider: "p", id: "model" },
    systemPrompt: "Policy", history: selectHistory([], 0, 0) };
  const record: RefineRecord = { id: 3, taskId: 1, createdAt: 0, kind: "refine", status: "generated", input,
    candidate: { ...input, requestId: 3, version: 1, generation: 0, text: "RESULT 中文😀\n".repeat(80) } };
  const preview = new PreviewPanel({ state: { phase: "ready", requestId: 3, pendingSend: false }, candidateText: record.candidate!.text,
    draft: input.draft, contextLabel: "", openHint: "", elapsedSeconds: 0, canRestore: false }, theme, () => terminal.rows, () => tui.requestRender());
  const submit = vi.fn((_text: string): string | undefined => "Feedback rejected 中文😀");
  const label = "Run #3 · openai-codex/gpt-6-luna";
  const workspace = new RefineWorkspace(preview, tui, theme, getKeybindings(), {
    context: () => ({ instructions: "off", tree: false, skills: false }), contextEnabled: () => true,
    submit: vi.fn(), saveContext: async () => ({ message: "Saved", persisted: true }),
    revision: () => ({ key: "run-3", label, submit }),
    preferences: { key: "alt+p", maxChars: 16000, repository: {
      load: async () => ({ entries: [], errors: {} }), save: async () => { throw new Error("Read-only fixture"); }, remove: async () => {},
    } },
    tasks: { records: () => [record], appliedId: () => 3, activate: () => true, run() {}, stop() {} },
  });
  workspace.focused = true;
  return { workspace, terminal, preview, theme, record, submit, label };
}

const output = (workspace: RefineWorkspace, width = 100) => workspace.render(width).join("\n");

describe("Revise visual hierarchy and feedback", () => {
  it.each(["dark", "light"])("separates headings, metadata and focus without repeating explanatory copy (%s)", (name) => {
    const f = setup(name); const w = f.workspace;
    w.handleInput("\r"); w.handleInput("f");
    const before = output(w);
    expect(before).toContain(f.theme.fg("text", f.theme.bold("Revise current result")) + f.theme.fg("muted", ` · ${f.label}`));
    expect(before).not.toContain(f.theme.bold(f.label));
    expect(before).toContain(f.theme.fg("muted", "Revision not submitted"));
    expect(before).not.toContain("Selected snapshots + additional requirements");
    expect(before.split("\n").find((line) => line.includes("Preferences: None"))).toContain("Review full requirements");
    expect(before).toContain(f.theme.bg("selectedBg", f.theme.fg("text", f.theme.bold("› Additional requirements:"))));
    expect(before).toContain("Read-only reference");
    expect(strip(before)).not.toMatch(/↑↓ scroll|o Reference|←.*Preview.*→/);
    const positions = strip(before).split("\n");
    expect(positions.findIndex((line) => line.includes("Revise current result · " + f.label)) - positions.findIndex((line) => line.includes("Read-only reference"))).toBeGreaterThan(1);
    w.handleInput("文字😀"); w.handleInput(tab);
    expect(output(w)).toContain(f.theme.bg("selectedBg", f.theme.fg("text", f.theme.bold("› Preferences: None"))));
    expect(output(w)).toContain(formatKeyHint(["Enter", "Preferences"], f.theme));
    expect(output(w)).not.toContain(CURSOR_MARKER);
    w.handleInput(tab);
    expect(output(w)).toContain(formatKeyHint(["Enter", "Review"], f.theme));
    w.handleInput(tab); expect(output(w)).toContain(CURSOR_MARKER);
    w.handleInput(esc);
    expect(strip(output(w))).toContain("↑↓ scroll result");
    w.handleInput("f"); expect(output(w)).toContain("文字😀");
  });

  it.each(["dark", "light"])("preserves warning color, retained input and Back after resizing (%s)", (name) => {
    const f = setup(name); const w = f.workspace;
    w.handleInput("f"); w.handleInput("Keep 中文😀 **literal**"); w.handleInput(ctrlS);
    for (const rows of [40, 16, 12, 8, 5]) for (const width of [20, 40, 100]) {
      f.terminal.rows = rows; f.terminal.columns = width;
      const lines = w.render(width);
      expect(lines).toHaveLength(workspaceHeight(rows));
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(lines.join("\n")).toContain(f.theme.fg("warning", "⚠ Feedback rejected 中文😀").split("⚠")[0]);
      expect(strip(lines.join("\n"))).toContain("Feedback");
      if (rows >= 8) {
        expect(lines.join("\n")).toContain(CURSOR_MARKER);
        expect(lines.slice(-3).join("\n")).toContain(formatKeyHint(["Esc", "Back"], f.theme));
      }
    }
    f.terminal.rows = 40; f.terminal.columns = 100;
    expect(output(w)).toContain("Keep 中文😀 **literal**");
    expect(f.submit).toHaveBeenCalledExactlyOnceWith("Keep 中文😀 **literal**");
    w.handleInput(tab); w.handleInput(tab); w.handleInput("\r");
    const read = output(w);
    expect(read).toContain(f.theme.fg("text", "Keep 中文😀 **literal**"));
    expect(read).not.toContain(f.theme.bold("Keep 中文😀 **literal**"));
    w.handleInput(ctrlS); expect(f.submit).toHaveBeenCalledTimes(1);
  });

  it.each(["dark", "light"])("only advertises available layout transitions (%s)", (name) => {
    const f = setup(name); const w = f.workspace;
    w.handleInput("f");
    expect(output(w)).toContain(formatKeyHint(["Ctrl+E", "Editor only"], f.theme));
    w.handleInput(ctrlE);
    expect(output(w)).toContain(formatKeyHint(["Ctrl+E", "Show source"], f.theme));
    expect(output(w)).not.toContain("Read-only reference");
    w.handleInput(ctrlE);
    f.terminal.rows = 12;
    expect(output(w)).not.toContain("Ctrl+E"); w.handleInput(ctrlE);
    f.terminal.rows = 40;
    expect(output(w)).toContain("Read-only reference");
    f.terminal.columns = 20;
    expect(output(w, 20)).not.toContain("Ctrl+E"); w.handleInput(ctrlE);
    f.terminal.columns = 100;
    expect(output(w)).toContain(formatKeyHint(["Ctrl+E", "Editor only"], f.theme));
  });

  it.each(["dark", "light"])("keeps warning badges independent of success and archived row colors (%s)", (name) => {
    const f = setup(name);
    f.record.input.budget = { status: "trimmed", message: "Trimmed", inputTokens: 1, outputTokens: 1, safetyTokens: 1, contextWindow: 4,
      outputLimit: 1, removedMessages: 1, removedProjectParts: [] };
    const panel = new TaskPanel({ records: () => [f.record], appliedId: () => 3, activate: () => true, run() {}, stop() {} }, f.theme, () => 40, getKeybindings(), true);
    const badge = f.theme.fg("warning", "⚠ ") + f.theme.fg("success", "✓ Done");
    expect(panel.render(100).join("\n")).toContain(badge);
    f.record.archivedAt = 1;
    expect(panel.render(100).join("\n")).toContain(f.theme.fg("warning", "⚠"));
    panel.handleInput("\r");
    expect(panel.render(100).join("\n")).toContain(badge);
  });

  it.each(["dark", "light"])("keeps compatibility source/reference bodies explicitly neutral (%s)", (name) => {
    const f = setup(name);
    const panel = new PreviewPanel({ state: { phase: "ready", requestId: 3, pendingSend: false }, candidateText: "**RESULT**", draft: "ORIGINAL",
      revisionInstruction: "INSTRUCTION", previousCandidate: "PREVIOUS", contextLabel: "", openHint: "", elapsedSeconds: 0, canRestore: false },
    f.theme, () => 80, vi.fn());
    panel.toggleSource();
    let rendered = panel.render(100).join("\n");
    panel.scrollBy(1000); rendered += panel.render(100).join("\n");
    for (const body of ["**RESULT**", "ORIGINAL", "INSTRUCTION", "PREVIOUS"]) {
      expect(rendered).toContain(f.theme.fg("text", body));
      expect(rendered).not.toContain(f.theme.bold(body));
    }
  });
});

// Exercise the same focused/error states through both real Pi diff renderers.
describe("Revise terminal renderers", () => {
  it.each([["regular", "dark"], ["regular", "light"], ["fullscreen", "dark"], ["fullscreen", "light"]] as const)("retains styled feedback without clearing the screen (%s / %s)", (mode, name) => {
    vi.useFakeTimers();
    let input = (_text: string) => {}; const writes: string[] = [];
    const terminal = { rows: 40, columns: 100, kittyProtocolActive: true,
      start: (handler) => { input = handler; }, stop() {}, write: (text) => { writes.push(text); },
      async drainInput() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {},
      clearScreen: vi.fn(), setTitle() {}, setProgress() {}, setProgramStatus() {},
    } satisfies Terminal;
    const tui = mode === "regular" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
    const f = setup(name, 40, 100, tui);
    tui.addChild(f.workspace); tui.setFocus(f.workspace);
    try {
      tui.start(); tui.renderNow();
      const redraws = tui.fullRedraws; const clears = vi.mocked(terminal.clearScreen).mock.calls.length;
      writes.length = 0;
      for (const key of ["\r", "f", "Keep 中文😀", tab, tab, tab, ctrlS]) { input(key); tui.renderNow(); }
      const full = f.workspace.render(100).join("\n");
      expect(full).toContain(f.theme.fg("warning", "⚠ Feedback rejected 中文😀"));
      expect(tui.fullRedraws).toBe(redraws);
      expect(terminal.clearScreen).toHaveBeenCalledTimes(clears);
      expect(writes.join("")).not.toMatch(/\x1b\[(?:2J|3J|\?1049[hl])/);
      terminal.rows = 12; terminal.columns = 40;
      tui.requestRender(); tui.renderNow();
      expect(strip(f.workspace.render(40).join("\n"))).toContain("Feedback rejected");
      expect(strip(writes.join(""))).toContain("Feedback rejected");
      // A real terminal resize may require a full repaint; ordinary navigation must not.
      const resizedRedraws = tui.fullRedraws;
      const resizedClears = vi.mocked(terminal.clearScreen).mock.calls.length;
      writes.length = 0;
      input(esc); tui.renderNow();
      expect(tui.fullRedraws).toBe(resizedRedraws);
      expect(terminal.clearScreen).toHaveBeenCalledTimes(resizedClears);
      expect(writes.join("")).not.toMatch(/\x1b\[(?:2J|3J|\?1049[hl])/);
    } finally { f.workspace.dispose(); tui.stop(); }
  });
});
