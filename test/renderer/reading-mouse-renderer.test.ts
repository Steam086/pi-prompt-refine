import { getKeybindings, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters as strip } from "node:util";
import { expect, it, vi } from "vitest";
import { PreviewPanel } from "../../src/preview.js";
import { RefineWorkspace } from "../../src/workspace.js";
import { REFINE_OVERLAY_OPTIONS } from "../../src/workspace-overlay.js";
import { getThemeByName } from "../support/pi-theme.js";
import { createRecordingTerminal } from "../support/recording-terminal.js";
import { record } from "../support/task-panel.js";

it("scrolls and copies only the chosen reading column through the native overlay", () => {
  vi.useFakeTimers();
  const { terminal, input } = createRecordingTerminal({ columns: 140, rows: 36 });
  const tui = new TuiAltScreen(terminal);
  const theme = getThemeByName("dark")!;
  const documents = (label: string) => Array.from({ length: 80 }, (_, i) => `${label} ${String(i).padStart(2, "0")} 中文😀`).join("\n");
  const first = record(1);
  const second = record(2);
  first.input.draft = documents("Reference");
  first.candidate!.text = documents("ResultOne");
  second.candidate!.text = documents("ResultTwo");
  const position = { selectedId: 1 };
  const copy = vi.fn();
  const accept = vi.fn();
  const preview = new PreviewPanel({ state: { phase: "idle", requestId: 0, pendingSend: false },
    contextLabel: "", elapsedSeconds: 0, canRestore: false, openHint: "" }, theme, () => terminal.rows, () => tui.requestRender());
  const workspace = new RefineWorkspace(preview, tui, theme, getKeybindings(), {
    tasks: { records: () => [first, second], appliedId: () => 1, activate: () => false, run() {}, stop() {}, accept },
    taskPosition: position, context: () => ({ instructions: "off", tree: false, skills: false }),
    contextEnabled: () => true, submit: vi.fn(), saveContext: async () => ({ message: "Saved", persisted: true }),
  }, copy);
  const overlay = tui.showOverlay(workspace, REFINE_OVERLAY_OPTIONS);
  const screen = () => {
    tui.renderNow();
    return tui.getScreenLines().map(strip);
  };
  function find(mark: string) {
    const lines = screen();
    const y = lines.findIndex((line) => line.includes(mark));
    expect(y).toBeGreaterThanOrEqual(0);
    return { x: visibleWidth(lines[y]!.slice(0, lines[y]!.indexOf(mark))), y };
  }
  const mouse = (code: number, x: number, y: number, release = false) => input(`\x1b[<${code};${x + 1};${y + 1}${release ? "m" : "M"}`);
  try {
    tui.start();
    screen();
    input("\r");
    const reference = find("Reference 00");
    for (let i = 0; i < 4; i++) mouse(65, reference.x, reference.y);
    expect(screen().join("\n")).toContain("ResultOne 00");
    expect(screen().join("\n")).not.toContain("Reference 00");
    expect(position.selectedId).toBe(1);

    input("c");
    const left = find("ResultOne 00");
    const right = find("ResultTwo 00");
    for (let i = 0; i < 4; i++) mouse(65, right.x, right.y);
    expect(screen().join("\n")).not.toContain("ResultTwo 00");
    expect(screen().join("\n")).toContain("ResultOne 00");
    mouse(0, left.x + visibleWidth("ResultOne 00 ") + 1, left.y);
    mouse(32, right.x + 3, left.y);
    screen();
    mouse(0, right.x + 3, left.y, true);
    expect(copy).toHaveBeenCalledExactlyOnceWith("中文😀");
    expect(position.selectedId).toBe(1);
    expect(accept).not.toHaveBeenCalled();
  } finally {
    overlay.hide();
    workspace.dispose();
    tui.stop();
    vi.useRealTimers();
  }
});
