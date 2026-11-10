import { visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatKeyHint } from "../../src/key-hints.js";
import { panelLayout, workspaceTabs } from "../../src/panel-layout.js";
import { create, record } from "../support/task-panel.js";

afterEach(() => vi.restoreAllMocks());

describe("short and narrow feedback", () => {
  it.each(["dark", "light"])("keeps overflow diagnostics scrollable in %s", (name) => {
    const failed = record();
    failed.status = "error"; failed.error = "truncated"; failed.candidate = undefined;
    failed.usage = { output: 2048, reasoning: 2048 };
    const { panel, size, theme } = create(name, false, [failed]);
    panel.handleInput("\r");
    for (const [width, rows] of [[100, 12], [40, 8], [20, 12], [100, 40]] as const) {
      size.rows = rows;
      let all = "";
      for (let i = 0; i < 100; i++) {
        const lines = panel.render(width);
        expect(lines).toHaveLength(panelLayout(width, rows).height);
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
        all += stripVTControlCharacters(lines.join("\n")).replace(/\n\s*/g, "") + "\n";
        panel.handleInput("\x1b[B");
      }
      expect(all).toContain("Error: truncated");
      expect(all.replace(/\s+/g, " ")).toContain("maxOutputTokens");
      for (let i = 0; i < 100; i++) panel.handleInput("\x1b[5~");
    }
    size.rows = 12;
    panel.render(100);
    const frames = panel.render(100).join("\n");
    expect(frames).toContain(theme.fg("error", "Error: truncated"));
  });

  it.each(["dark", "light"])("keeps short-layout notices visible and full feedback readable in %s", (name) => {
    const restored = record(); restored.input.contextUnavailable = true;
    const { panel, size, position, actions, text } = create(name, false, [restored]);
    size.rows = 12;
    panel.handleInput("m");
    expect(text(100)).toContain("Background not saved");
    panel.handleInput("\x1b[B");
    expect(text(100)).toContain("Background not saved");
    size.rows = 8;
    expect(text(40)).toContain("Background not saved");
    expect(text(40)).toContain("? Help");
    panel.handleInput("?");
    let all = "";
    for (let i = 0; i < 40; i++) {
      // At eight terminal rows the document viewport is one line, so assemble
      // that viewport rather than inserting repeated frame chrome into the text.
      all += stripVTControlCharacters(panel.render(40).at(-1)!).trim() + " ";
      panel.handleInput("\x1b[B");
    }
    expect(all).toContain("Press i to copy into current round");
    for (const key of ["a", "s", "f", "d", "m", "i", "\x1b[C", "\x1b[D"]) panel.handleInput(key);
    expect(actions.accept).not.toHaveBeenCalled(); expect(actions.activate).not.toHaveBeenCalled();
    expect(actions.chooseModel).not.toHaveBeenCalled(); expect(actions.editOriginal).not.toHaveBeenCalled();
    expect(position.selectedId).toBe(1);
    panel.handleInput("\x1b");
    expect(text(100)).toContain("Background not saved");
  });

  it.each(["dark", "light"])("prioritizes core actions and offers complete read-only help in %s", (name) => {
    const { panel, text, size, position, actions, theme } = create(name);
    vi.spyOn(theme, "bold").mockImplementation((value) => `\x1b[1m${value}\x1b[22m`);
    panel.handleInput("\r");
    for (const width of [20, 40, 80, 100]) {
      const output = text(width);
      expect(output).toContain("a Accept");
      expect(output).toMatch(/s Send(?: to Pi)?/);
      expect(output).toMatch(/\? (Help|Actions)/);
      expect(output).toContain("Esc Back");
      const styled = panel.render(width).join("\n");
      for (const [key, label] of [["a", "Accept"], ["s", width < 60 ? "Send" : "Send to Pi"], ["Esc", "Back"]]) {
        expect(styled).toContain(theme.fg("text", theme.bold(key!)) + " " + theme.fg("muted", label!));
        expect(styled).not.toContain(theme.bold(label!));
      }
    }
    panel.handleInput("?");
    let all = "";
    for (let i = 0; i < 50; i++) { all += text(40); panel.handleInput("\x1b[B"); }
    for (const action of ["Accept", "Send to Pi", "Edit result", "Revise"]) expect(all).toContain(action);
    for (const key of ["a", "s", "f", "m"]) panel.handleInput(key);
    expect(actions.accept).not.toHaveBeenCalled(); expect(actions.activate).not.toHaveBeenCalled();
    expect(position.selectedId).toBe(1);
    panel.handleInput("\x1b");
    size.rows = 8;
    expect(text(40)).toContain("a Accept"); expect(text(40)).toContain("s Send");
    expect(text(40)).toContain("? Help"); expect(text(40)).not.toContain("Enter Inspect");
    panel.handleInput("a"); expect(actions.accept).toHaveBeenCalledWith(1);
  });

  it("only advertises comparison focus switching when a comparison is active", () => {
    const { panel, text } = create("dark", false, [record(1), record(2)]);
    panel.handleInput("\r"); panel.handleInput("?");
    let help = "";
    for (let i = 0; i < 20; i++) { help += text(); panel.handleInput("\x1b[B"); }
    expect(help).not.toContain("Switch compared result");
    panel.handleInput("\x1b"); panel.handleInput("c"); panel.handleInput("?");
    help = "";
    for (let i = 0; i < 20; i++) { help += text(); panel.handleInput("\x1b[B"); }
    expect(help).toContain("Switch compared result");
  });

  it("describes the current arrow-key focus without changing the selected target", () => {
    const { panel, text, position } = create();
    expect(text(40)).toContain("↑↓ select");
    panel.handleInput("\t");
    expect(text(40)).toContain("↑↓ scroll"); expect(text(100)).toContain("↑↓ scroll");
    panel.handleInput("\x1b[B");
    expect(position.selectedId).toBe(1);
    panel.handleInput("\t"); expect(text(40)).toContain("↑↓ select");
  });
});

describe("history storage details", () => {
  it.each(["dark", "light"])("shows live status, saved IDs, omissions and a sanitized path in %s", (name) => {
    const { panel, actions, size, position, text, theme } = create(name, true);
    const status = { state: "saved" as "saved" | "save-error", path: "/项目/中文😀\x1b[2J/session.jsonl.prompt-refine.json", savedIds: [1], memoryOnlyIds: [2], omittedIds: [2] };
    Object.assign(actions, { historyStorage: () => status });
    expect(text(40)).toContain("b Storage");
    panel.handleInput("b");
    const first = panel.render(100).join("\n");
    expect(first).toContain("Confirmed saved runs"); expect(first).toContain("#1");
    expect(first).toContain("Memory-only / pending runs"); expect(first).toContain("#2");
    expect(first).not.toContain("\x1b[2J");
    status.state = "save-error";
    expect(panel.render(100).join("\n")).toContain(theme.fg("error", "Save failed · saving paused until reload"));
    for (const [width, rows] of [[20, 12], [40, 8], [100, 40]] as const) {
      size.rows = rows;
      for (const key of ["\x1b[H", "\x1b[6~", "\x1b[F"]) {
        panel.handleInput(key);
        const lines = panel.render(width);
        expect(lines).toHaveLength(panelLayout(width, rows).height);
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      }
    }
    panel.handleInput("a"); panel.handleInput("m"); panel.handleInput("d");
    expect(actions.accept).not.toHaveBeenCalled(); expect(actions.chooseModel).not.toHaveBeenCalled();
    panel.handleInput("\x1b"); expect(position.selectedId).toBe(1);
    expect(text()).toContain("Usage · All rounds");
  });
});

describe("top action hints", () => {
  it.each(["dark", "light"])("keeps empty pages full-width and advertises only usable actions in %s", (name) => {
    for (const usage of [false, true]) for (const archived of [false, true]) {
      if (usage && archived) continue;
      const f = create(name, usage, archived ? [{ ...record(), archivedAt: 1 }] : []);
      f.actions.launchModel = () => "provider/模型😀\x1b[2J";
      for (const [width, rows] of [[120, 40], [40, 24], [20, 12], [40, 8], [120, 40]] as const) {
        f.size.rows = rows;
        for (const key of ["\t", "\x1b[B", "\x1b[6~", "\t"]) f.panel.handleInput(key);
        const frame = f.panel.render(width);
        const plain = frame.map(stripVTControlCharacters);
        const text = plain.join("\n");
        const layout = panelLayout(width, rows);
        const empty = frame.find((line) => line.includes(usage ? "No records" : "No current"))!;
        expect(stripVTControlCharacters(empty).startsWith(" ".repeat(layout.inset) + "No ")).toBe(true);
        if (width === 120) expect(empty).toContain(f.theme.fg("muted", usage ? "No records yet. Return to Preview to create a prompt." : "No current prompts."));
        expect(text).not.toContain("│");
        for (const unavailable of ["0 prompts", "0 runs", "↑↓ select", "↑↓ scroll", "Inspect", "i Edit", "m Model", "Tab Read"]) {
          expect(text).not.toContain(unavailable);
        }
        expect(text).toContain("n New");
        expect(text).toContain("Esc Back");
        if (width >= 40 && rows >= 24) expect(frame.join("\n")).toContain(formatKeyHint(["p", "Preferences"], f.theme));
        if (!usage && width === 120) expect(text).toContain("Run: provider/模型😀");
        expect(frame.join("\n")).not.toContain("\x1b[2J");
        expect(frame).toHaveLength(layout.height);
        expect(frame.every((line) => visibleWidth(line) <= width)).toBe(true);
      }
      f.panel.handleInput("?");
      const help = f.text(120);
      for (const unavailable of ["Focus:", "Enter Inspect", "Tab Read", "i Edit original", "m Run model"]) expect(help).not.toContain(unavailable);
      expect(help).toContain("n New");
      expect(help).toContain("p Preferences");
      f.panel.handleInput("\x1b");
      f.panel.handleInput("n");
      expect(f.actions.editOriginal).toHaveBeenCalledExactlyOnceWith();
      expect(f.actions.run).not.toHaveBeenCalled();
      expect(f.actions.chooseModel).not.toHaveBeenCalled();
    }
  });
  it.each(["dark", "light"])("places empty Preview and Usage hints below tabs and above content in %s", (name) => {
    for (const usage of [false, true]) {
      const { panel, theme, size } = create(name, usage, []);
      for (const [width, rows] of [[100, 40], [40, 24], [20, 12], [40, 8], [100, 40]] as const) {
        size.rows = rows;
        const frame = panel.render(width);
        const lines = frame.map(stripVTControlCharacters);
        const layout = panelLayout(width, rows);
        const tabs = lines.findIndex((line) => line.includes(usage ? "Usage" : "Preview"));
        const back = lines.findIndex((line) => line.includes("Esc Back"));
        const content = lines.findIndex((line) => line.includes(usage ? "No records" : "No current"));
        expect(back).toBeGreaterThanOrEqual(0);
        expect(content).toBeGreaterThan(back);
        if (workspaceTabs(layout, usage ? "Usage" : "Preview", theme).length) {
          expect(back).toBeGreaterThan(tabs);
          expect(tabs).toBeGreaterThanOrEqual(0);
        }
        expect(frame[back]).toContain(formatKeyHint(["Esc", "Back"], theme));
        expect(frame).toHaveLength(layout.height);
        expect(frame.every((line) => visibleWidth(line) <= width)).toBe(true);
        expect(lines.slice(content).join("\n")).not.toContain("Esc Back");
      }
    }
  });
  it.each(["dark", "light"])("keeps hint columns and visibility fixed across Tab toggles in %s", (name) => {
    const { panel, theme, size } = create(name);
    for (let width = 20; width <= 140; width++) {
      const layout = panelLayout(width, size.rows);
      const start = layout.topSeparatorHeight + layout.headerHeight + workspaceTabs(layout, "Preview", theme).length;
      const hints = () => panel.render(width).slice(start, start + layout.footerHeight).map(stripVTControlCharacters);
      const before = hints();
      expect(before.join("\n")).toContain("Esc Back");
      panel.handleInput("\t");
      const after = hints();
      expect(after[0], `primary hints at width ${width}`).toBe(before[0]);
      expect(after[1]?.replace("Tab Select", "Tab Read  ").trimEnd(), `secondary hints at width ${width}`)
        .toBe(before[1]?.trimEnd());
      panel.handleInput("\t");
      expect(hints()).toEqual(before);
    }
  });
});
