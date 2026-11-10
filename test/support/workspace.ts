import { KeybindingsManager, TUI_KEYBINDINGS, type TUI } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { vi } from "vitest";
import type { RefineRecord } from "../../src/history.js";
import { PreviewPanel, type PreviewOptions } from "../../src/preview.js";
import { workspaceHeight, workspaceLayout, workspaceViewport } from "../../src/workspace-overlay.js";
import { RefineWorkspace, type SettingsResult } from "../../src/workspace.js";
import { getThemeByName } from "./pi-theme.js";

// Outer bounds and body offsets include the single shell, unlike child geometry.
export const panelLayout = (width: number, rows: number) => ({ ...workspaceLayout(width, rows), height: workspaceHeight(rows),
  topSeparatorHeight: workspaceViewport(width, rows).framed ? 1 : 0 });

// Settings lifts its action rows; Input and the legacy result reader retain bottom hints.
export const footer = (lines: string[]) => {
  const settings = lines.findIndex((line) => /(?:Ctrl\+S Save settings|\^S Save|Esc (?:Back|Discard))/.test(stripVTControlCharacters(line)));
  if (settings >= 0) return lines.slice(settings, settings + (stripVTControlCharacters(lines[settings + 1] ?? "").includes("Esc") ? 2 : 1));
  return stripVTControlCharacters(lines.at(-1)!).startsWith("╰") ? lines.slice(-3, -1) : lines.slice(-2);
};

export const options: PreviewOptions = {
  state: { phase: "ready", requestId: 1, pendingSend: false },
  candidateText: Array.from({ length: 80 }, (_, i) => `Result ${i}`).join("\n"),
  draft: "Original draft", contextLabel: "Draft only", elapsedSeconds: 0, openHint: "ctrl+\\", canRestore: false,
};

export function create(rows = 40, themeName = "dark", optimizer = false, inputText = "") {
  const terminal = { rows, columns: 80 };
  const tui = { terminal, requestRender: vi.fn() } as unknown as TUI;
  const theme = getThemeByName(themeName)!;
  const panel = new PreviewPanel(options, theme, () => terminal.rows, () => tui.requestRender());
  const actions = {
    inputDraft: { text: inputText, save: vi.fn() },
    history: vi.fn((): RefineRecord[] => []),
    context: () => ({ instructions: "always" as const, tree: true, skills: false }), contextEnabled: () => true,
    ...(optimizer ? {
      optimizer: () => ({ model: "provider/long-model-identifier-with-extra-details", thinking: "high · Extension setting", thinkingEnabled: true }),
      chooseModel: vi.fn(), editSystemPrompt: vi.fn(), cycleThinking: vi.fn(async (): Promise<SettingsResult> => ({ message: "Thinking level saved", persisted: true })),
    } : {}),
    saveContext: vi.fn(async (): Promise<SettingsResult> => ({ message: "Context saved", persisted: true })),
    submit: vi.fn((_text: string): string | undefined => undefined),
    revision: vi.fn((): { key: string; submit(text: string): string | undefined } | undefined => undefined),
  };
  const keys = new KeybindingsManager({
    ...TUI_KEYBINDINGS,
    "app.thinking.cycle": { defaultKeys: "shift+tab", description: "Cycle thinking level" },
  });
  const workspace = new RefineWorkspace(panel, tui, theme, keys, actions);
  workspace.focused = true;
  return { workspace, panel, terminal, actions, theme };
}

export const textOf = (lines: string[]) => lines.join("\n");
