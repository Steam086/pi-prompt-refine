import { frameHints } from "../support/panel-chrome.js";
import { getKeybindings, Input, sliceByColumn, TuiAltScreen, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters as strip } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { PreviewPanel } from "../../src/preview.js";
import type { TaskPanelPosition } from "../../src/task-panel.js";
import { REFINE_OVERLAY_OPTIONS } from "../../src/workspace-overlay.js";
import { RefineWorkspace } from "../../src/workspace.js";
import { getThemeByName } from "../support/pi-theme.js";
import { createRecordingTerminal } from "../support/recording-terminal.js";
import { record } from "../support/task-panel.js";

const sizes = [[60, 20], [100, 30], [160, 45]] as const;
const themes = ["dark", "light"] as const;
const tabs = ["Preview", "Usage", "Settings"] as const;
type Page = typeof tabs[number];

const widthOfContent = (line: string) => visibleWidth(strip(line).replace(/│$/, "").trimEnd());

function screenLines(tui: TuiMainScreen | TuiAltScreen) {
  if (tui.mode === "fullscreen") return tui.getScreenLines();
  const { previousLines, previousViewportTop, previousHeight } = tui.captureRenderState();
  return previousLines.slice(previousViewportTop, previousViewportTop + previousHeight);
}

// Compare composited frames from the same overlay, not independently rendered panels.
describe.each(["regular", "fullscreen"] as const)("workspace consistency (%s)", (mode) => {
  describe.each(themes)("%s theme", (themeName) => {
    it.each(sizes)("keeps shared chrome and action hierarchy at %i×%i", async (columns, rows) => {
      vi.useFakeTimers();
      const { terminal, input } = createRecordingTerminal({ columns, rows });
      const tui = mode === "regular" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
      const theme = getThemeByName(themeName)!;
      // Pi's color tokens are real; pin emphasis so Chalk's TTY detection does not affect the test.
      const bold = vi.spyOn(theme, "bold").mockImplementation((value) => `\x1b[1m${value}\x1b[22m`);

      const records = [record(1), record(2)];
      records[0]!.candidate!.text = "Result 1\nLiteral **正文** 中文😀\nAnother line\x1b[31m";
      const run = vi.fn();
      const accept = vi.fn();
      const submit = vi.fn();
      const saveContext = vi.fn(async () => ({ message: "Saved", persisted: true }));
      const revise = vi.fn();
      const position: TaskPanelPosition = { selectedId: 1 };
      const preview = new PreviewPanel({ state: { phase: "idle", requestId: 0, pendingSend: false }, contextLabel: "Draft only",
        elapsedSeconds: 0, canRestore: false, openHint: "" }, theme, () => terminal.rows, () => tui.requestRender());
      const workspace = new RefineWorkspace(preview, tui, theme, getKeybindings(), {
        tasks: { records: () => records, appliedId: () => undefined, activate: () => false, run, stop() {}, accept },
        taskPosition: position, usagePosition: { selectedId: 1 }, history: () => records,
        context: () => ({ instructions: "always", tree: false, skills: false }), contextEnabled: () => true, saveContext,
        optimizer: () => ({ model: "provider/rewrite-model", thinking: "high", thinkingEnabled: true, thinkingDetail: "Inherited from current session." }),
        editSystemPrompt: vi.fn(),
        submit, revision: () => ({ key: "run:1", label: "Run #1 · model-1", submit: revise }),
        preferences: { key: null, maxChars: 16000, repository: {
          load: async () => ({ entries: [{ id: "literal", scope: "global", version: 1, name: "Preserve 中文😀", body: "Keep literals" }], errors: {} }),
          save: vi.fn(), remove: vi.fn(),
        } },
      });
      const editor = new Input(); editor.setValue("Host draft 中文😀");
      tui.addChild(editor); tui.setFocus(editor);
      const overlay = tui.showOverlay(workspace, REFINE_OVERLAY_OPTIONS);
      const golden = mode === "regular" && themeName === "dark" && columns === 60;
      const snapshots: string[] = [];
      let tabOrigin: readonly [row: number, column: number] | undefined;
      function frame(name: string, snapshot = true) {
        tui.renderNow();
        const width = Math.floor(terminal.columns * 0.98);
        const height = Math.floor(terminal.rows * 0.96);
        const expected = { col: Math.floor((terminal.columns - width) / 2), row: Math.floor((terminal.rows - height) / 2), width, height };
        expect(overlay.getBounds(), name).toEqual(expected);
        expect(overlay.isFocused(), name).toBe(true);
        expect(editor.focused, name).toBe(false);
        const screen = screenLines(tui);
        expect(screen.every((line) => visibleWidth(line) <= terminal.columns), name).toBe(true);
        const lines = screen.slice(expected.row, expected.row + height).map((line) => sliceByColumn(line, expected.col, width));
        const plain = lines.map(strip);
        expect(plain, name).toHaveLength(height);
        expect(plain[0], name).toBe(`╭${"─".repeat(width - 2)}╮`);
        expect(plain.at(-1), name).toBe(`╰${"─".repeat(width - 2)}╯`);
        expect(plain.slice(1, -1).every((line) => line.startsWith("│") && line.endsWith("│")), name).toBe(true);
        expect(lines.map(visibleWidth), name).toEqual(Array<number>(height).fill(width));
        if (golden && snapshot) snapshots.push(`=== ${name} ===\n${plain.join("\n")}`);
        return lines;
      }
      function passivePage(name: string, active: Page, action: readonly [key: string, description: string]) {
        const lines = frame(name);
        // The tab's location is measured at the beginning of the strip, not at the active label.
        const row = lines.findIndex((line) => / Preview +Usage +Settings /.test(strip(line)));
        expect(row, `${name}\n${lines.map(strip).join("\n")}`).toBeGreaterThan(0);
        const line = lines[row]!;
        const column = visibleWidth(strip(line).split("Preview")[0]!);
        tabOrigin ??= [row, column];
        expect([row, column], name).toEqual(tabOrigin);
        for (const tab of tabs) {
          expect(line, name).toContain(tab === active
            ? theme.bg("selectedBg", theme.fg("text", theme.bold(` ${tab} `)))
            : theme.fg("muted", ` ${tab} `));
        }
        const bodyText = (line: string) => strip(line).slice(1, -1).trim();
        expect(bodyText(lines[row - 1]!), name).toMatch(/^(?:Prompt refine|Usage|Settings|[A-Za-z]+ characters)/);
        const divider = lines.findIndex((line, i) => i > row && /^─+$/u.test(bodyText(line)));
        expect(divider, name).toBeGreaterThan(row);
        const hints = frameHints(lines);
        const hintStrip = hints.join("\n");
        expect(hints.length, name).toBeGreaterThanOrEqual(1);
        expect(hints.length, name).toBeLessThanOrEqual(2);
        expect(hintStrip, name).not.toContain("\x1b[1m");
        expect(hintStrip, name).toContain(`${theme.fg("muted", `${action[0]}:`)} ${theme.fg("muted", action[1])}`);
        expect(bodyText(lines[divider + 1]!), name).not.toBe("");
        expect(strip(hintStrip), name).not.toMatch(/\s(?:Space|←|→|↑↓|b|d|p|m|f): /);
        if (active === "Preview") expect(hintStrip).toContain(`${theme.fg("muted", "a:")} ${theme.fg("muted", "Accept")}`);
        if (active !== "Settings") expect(strip(hintStrip)).toContain("?: Help");
        if (columns >= 100) {
          expect(hints, name).toHaveLength(1);
          expect(strip(line), name).toContain(`${action[0]}: ${action[1]}`);
          expect(visibleWidth(strip(line).replace(/│$/, "").trimEnd()), name).toBe(widthOfContent(lines[divider]!));
        }
        return lines;
      }
      function operationHint(output: string, key: string, description: string) {
        expect(output).toContain(`${theme.fg("text", theme.bold(key))} ${theme.fg("muted", description)}`);
      }
      try {
        tui.start();
        const previewFrame = passivePage("Preview", "Preview", ["Enter", "Inspect"]);
        input("\x1b[C");
        const usageFrame = passivePage("Usage", "Usage", ["Enter", "Inspect"]);
        for (const browse of [previewFrame, usageFrame]) {
          const selected = browse.find((line) => strip(line).includes("› └─ model-1"));
          expect(selected).toContain(theme.getBgAnsi("selectedBg"));
          expect(selected).toContain(`${theme.getFgAnsi("text")}\x1b[1mmodel-1`);
        }
        input("\x1b[C");
        const settings = passivePage("Settings", "Settings", ["Ctrl+S", "Save"]);
        const focusedSetting = settings.find((line) => strip(line).includes("› Project instructions"));
        expect(focusedSetting).toContain(theme.getBgAnsi("selectedBg"));
        expect(focusedSetting).toMatch(/\x1b\[1mProject instructions *\x1b\[22m/);
        input("\t"); input("\x1b[A");
        const optimizer = passivePage("Settings / Optimizer", "Settings", ["Ctrl+S", "Save"]);
        const optimizerText = optimizer.map(strip).join("\n");
        expect(optimizerText).toMatch(/Default model:? +provider\/rewrite-model/);
        expect(optimizerText).toMatch(/Thinking:? +high/);
        expect(optimizerText).not.toContain("Advanced");
        expect(optimizerText).toMatch(/› Draft character limit:? +16000 characters/);
        expect(optimizerText.replace(/\s*│\n│\s*/g, " ")).toContain("Oversized drafts and revision instructions are rejected, not truncated.");
        input("\t");
        input("\x1b[A"); input("\x1b[A"); input("\r"); // Reach History characters from Project instructions.
        passivePage("Settings / number", "Settings", ["Esc", "Cancel"]);
        input("\x15"); input("-1"); input("\r");
        expect(frame("Settings / validation").join("\n")).toContain(theme.fg("warning", "Enter 0–100000 characters (whole numbers)."));
        Object.assign(terminal, { columns: 32, rows: 9 }); workspace.invalidate();
        const short = frame("Settings / validation after resize", false).join("\n");
        expect(short).toContain(`${theme.fg("muted", "Esc:")} ${theme.fg("muted", "Cancel")}`);
        expect(short).toContain(theme.getFgAnsi("warning") + "Enter 0–100000");
        Object.assign(terminal, { columns, rows }); workspace.invalidate();
        input("\x1b"); input("\x1b");
        expect(frame("Back to Preview", false)).toEqual(previewFrame);
        expect(position.selectedId).toBe(1);
        input("\r");
        const details = frame("Result details").join("\n");
        operationHint(details, "a", "Accept");
        operationHint(details, "Esc", "Back");
        expect(details).toContain(theme.getFgAnsi("text") + "Literal **正文** 中文😀");
        expect(details).not.toContain("\x1b[31m");
        input("c");
        const compare = frame("Compare").join("\n");
        operationHint(compare, "Esc", "Back");
        expect(strip(compare)).toContain("A · Run #1");
        expect(strip(compare)).toContain("B · Run #2");
        input("f"); input("Keep 中文😀");
        const revision = frame("Revise").join("\n");
        operationHint(revision, "Ctrl+S", "Revise");
        expect(revision).toContain(theme.fg("text", theme.bold(columns === 60 ? "Revise" : "Revise current result"))
          + theme.fg("muted", " · Run #1 · model-1"));
        expect(strip(revision)).not.toMatch(/\b(?:Accept|Send)\b/);
        input("\t"); input("\r"); // Revise's Preferences control owns Enter, not the editor underneath.
        await vi.waitFor(() => {
          tui.renderNow();
          expect(strip(screenLines(tui).join("\n"))).toContain("Preserve 中文😀");
        });
        const preferences = frame("Preferences / library").join("\n");
        expect(strip(preferences)).toContain("Focus: Library");
        operationHint(preferences, "Alt+Enter", "Bring back");
        expect(preferences).toContain(theme.fg("text", theme.bold("Preserve 中文😀")));
        input("\r");
        const reading = frame("Preferences / read").join("\n");
        operationHint(reading, "Esc", "Back");
        expect(reading).toContain(theme.fg("text", "Keep literals"));
        input("\r"); input("\t"); // Reading consumes both keys without leaving the child page.
        expect(frame("Preferences / read after input", false).join("\n")).toBe(reading);
        input("\x1b"); input("\x1b");
        expect(frame("Back to Revise", false).join("\n")).toBe(revision);
        expect(position.selectedId).toBe(1);
        expect(revise).not.toHaveBeenCalled();
        expect(saveContext).not.toHaveBeenCalled();
        expect(accept).not.toHaveBeenCalled();
        expect(run).not.toHaveBeenCalled();
        expect(submit).not.toHaveBeenCalled();
        expect(editor.getValue()).toBe("Host draft 中文😀");
        overlay.hide(); tui.renderNow();
        expect(editor.focused).toBe(true);
        expect(strip(screenLines(tui).join("\n"))).toContain("Host draft 中文😀");
        if (golden) expect(snapshots.join("\n\n")).toMatchSnapshot("compact workspace flow");
      } finally {
        workspace.dispose(); tui.stop(); bold.mockRestore(); vi.useRealTimers();
      }
    });
  });
});
