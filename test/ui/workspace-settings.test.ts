import { frameHeader } from "../support/panel-chrome.js";
import { visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { formatKeyHint } from "../../src/key-hints.js";
import { workspaceLayout } from "../../src/workspace-overlay.js";
import { type SettingsResult } from "../../src/workspace.js";
import { create, footer, panelLayout, textOf } from "../support/workspace.js";

describe("shared refine workspace", () => {

  it.each([20, 40, 80])("keeps instruction values readable at %i columns", (width) => {
    const { workspace } = create();
    for (const [instructions, value] of [["first", "First"], ["always", "Always"], ["off", "Off"]] as const) {
      workspace.openSettings({ instructions, tree: true, skills: false });
      const selected = workspace.render(width).map(stripVTControlCharacters).find((line) => line.includes("› "));
      expect(selected).toContain(value);
    }
  });

  it.each(["dark", "light"])("renders aligned columns, group tabs and full row focus in %s", (name) => {
    const { workspace, theme } = create(40, name, true);
    workspace.openSettings();
    const rendered = workspace.render(100);
    const lines = rendered.map(stripVTControlCharacters);
    expect(rendered[1]).toContain(theme.fg("text", theme.bold("Settings")));
    expect(textOf(rendered)).toContain(theme.bg("selectedBg", theme.fg("text", theme.bold(" Context "))));
    const rules = lines.find((line) => line.includes("Project instructions"))!;
    const tree = lines.find((line) => line.includes("Directory tree"))!;
    const skills = lines.find((line) => line.includes("Skill metadata"))!;
    expect(rules.indexOf("Always")).toBe(tree.indexOf("[x] On"));
    expect(tree.indexOf("[x] On")).toBe(skills.indexOf("[ ] Off"));
    expect(rules.indexOf("Include rules")).toBe(tree.indexOf("Include the default"));
    expect(tree.indexOf("Include the default")).toBe(skills.indexOf("Include skill"));
    expect(textOf(lines)).not.toContain("Model");
    const before = lines.findIndex((line) => line.includes("Directory tree"));
    workspace.handleInput("\x1b[B");
    expect(workspace.render(100).findIndex((line) => line.includes("Directory tree"))).toBe(before);
    expect(textOf(workspace.render(100))).toContain(formatKeyHint(["Tab", "Group"], theme, 1, "secondary"));
  });

  it.each(["dark", "light"])("keeps a continuous highlight around clipped Unicode values in %s", (name) => {
    const { workspace, actions, theme } = create(40, name, true);
    actions.optimizer = () => ({ model: "provider/中文😀é".repeat(12), thinking: "high", thinkingEnabled: true });
    workspace.openSettings(undefined, 3);
    for (const width of [40, 80, 100]) {
      const row = workspace.render(width).find((line) => stripVTControlCharacters(line).includes("› Model"))!;
      expect(row).toContain("…");
      expect(row.slice(row.indexOf("›"), row.indexOf("\x1b[49m"))).not.toContain("\x1b[0m");
      expect(row).toContain(theme.bg("selectedBg", "").split("\x1b[49m")[0]);
      expect(visibleWidth(row)).toBe(width);
    }
  });

  it.each(["dark", "light"])("keeps focused setting names bold without emphasizing values across resize in %s", (name) => {
    const { workspace, terminal, actions, theme } = create(40, name, true);
    const bold = vi.spyOn(theme, "bold").mockImplementation((text) => `\x1b[1m${text}\x1b[22m`);
    actions.optimizer = () => ({ model: "provider/中文😀\x1b[31m".repeat(8), thinking: "Unavailable", thinkingEnabled: false });
    try {
      workspace.openSettings(undefined, 3);
      for (const rows of [40, 8, 16, 40]) for (const width of [20, 40, 80, 160, 40]) {
        terminal.rows = rows;
        const frame = workspace.render(width);
        const row = frame.find((line) => stripVTControlCharacters(line).includes("› Model"))!;
        expect(row).toContain(theme.bold(width >= 80 ? "Model".padEnd(22) : "Model"));
        expect(row).not.toContain(theme.bold("provider/"));
        expect(row).not.toContain(theme.bold("Model:"));
        expect(row.slice(row.indexOf("›"), row.indexOf("\x1b[49m"))).not.toContain("\x1b[0m");
        expect(row).toContain(theme.bg("selectedBg", "X").split("X")[0]);
        expect(frame.every((line) => visibleWidth(line) <= width)).toBe(true);
        expect(frame.join("\n")).not.toContain("\x1b[31m");
        expect(workspace.render(width)).toEqual(frame);
      }
      workspace.handleInput("\x1b[B");
      for (const width of [20, 40, 100]) {
        const frame = workspace.render(width);
        const current = frame.find((line) => stripVTControlCharacters(line).includes("› Thinking"))!;
        const previous = frame.find((line) => /Model(?::| {2})/.test(stripVTControlCharacters(line)))!;
        expect(current).toContain(theme.bold(width >= 100 ? "Thinking".padEnd(22) : "Thinking"));
        expect(current).toContain(theme.fg("dim", "X").split("X")[0]! + theme.bold(width >= 100 ? "Thinking".padEnd(22) : "Thinking"));
        expect(previous).toBeDefined();
        expect(previous).not.toContain("\x1b[1m");
      }
      expect(actions.chooseModel).not.toHaveBeenCalled();
      expect(actions.cycleThinking).not.toHaveBeenCalled();
      expect(actions.saveContext).not.toHaveBeenCalled();
      expect(actions.submit).not.toHaveBeenCalled();
    } finally { bold.mockRestore(); workspace.dispose(); }
  });

  it.each(["dark", "light"])("shares title, group strip and key styles between Main and Settings in %s", (name) => {
    const { workspace, theme } = create(40, name, true);
    const main = workspace.render(100);
    workspace.openSettings();
    const settings = workspace.render(100);
    expect(main[1]).toContain(theme.fg("text", theme.bold("Prompt refine")));
    expect(settings[1]).toContain(theme.fg("text", theme.bold("Settings")));
    expect(frameHeader(main).join("\n")).toContain(theme.bg("selectedBg", theme.fg("text", theme.bold(" Preview "))));
    expect(frameHeader(settings).join("\n")).toContain(theme.bg("selectedBg", theme.fg("text", theme.bold(" Settings "))));
    expect(textOf(settings)).toContain(theme.bg("selectedBg", theme.fg("text", theme.bold(" Context "))));
    expect(footer(main)[0]).toContain(formatKeyHint(["a", "Accept"], theme));
    expect(footer(settings)[0]).toContain(formatKeyHint(["Enter", "Change"], theme, 1, "secondary"));
    expect(main).toHaveLength(settings.length);
  });

  it.each(["dark", "light"])("places Settings hints below workspace tabs and above settings content in %s", (name) => {
    const { workspace, terminal, actions, theme } = create(40, name, true);
    actions.optimizer = () => ({ model: "provider/中文😀\x1b[31m".repeat(8), thinking: "high", thinkingEnabled: true });
    for (const rows of [40, 12, 8, 5, 40]) for (const width of [20, 40, 100]) {
      terminal.rows = rows;
      for (const cursor of [0, 3, 4]) {
        workspace.openSettings(undefined, cursor);
        const lines = workspace.render(width);
        const plain = lines.map(stripVTControlCharacters);
        const layout = workspaceLayout(width, rows);
        const hints = footer(lines);
        const output = hints.join("\n");
        const style = stripVTControlCharacters(output).includes(":") ? "secondary" : "secondary-compact";
        const save = [style === "secondary" ? "Ctrl+S" : "^S", "Save"] as const;
        if (layout.footerHeight > 1 || layout.innerWidth >= 20) expect(output).toContain(formatKeyHint(save, theme, 1, style));
        expect(output).toContain(formatKeyHint(["Esc", "Back"], theme, 1, style));
        if (layout.separatorHeight) {
          const divider = plain.findIndex((line) => /^[│ ]*─+[│ ]*$/u.test(line));
          expect(divider).toBeGreaterThan(0);
          expect(plain.findIndex((line) => line.includes("› "))).toBeGreaterThan(divider);
        }
        expect(lines).toHaveLength(panelLayout(width, rows).height);
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
        expect(lines.join("\n")).not.toContain("\x1b[31m");
        expect(workspace.render(width)).toEqual(lines);
      }
    }
    expect(actions.saveContext).not.toHaveBeenCalled();
    expect(actions.submit).not.toHaveBeenCalled();
  });

  it.each(["dark", "light"])("keeps optimizer values and detail bounded across widths in %s", (theme) => {
    for (const rows of [8, 16, 24, 40]) {
      for (const width of [12, 20, 40, 80, 160]) {
        const { workspace } = create(rows, theme, true);
        workspace.openSettings({ instructions: "off", tree: true, skills: false }, 3);
        for (const cursor of [3, 4]) {
          if (cursor === 4) workspace.handleInput("\x1b[B");
          const lines = workspace.render(width);
          expect(lines).toHaveLength(panelLayout(width, rows).height);
          for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
          if (width >= 20) expect(textOf(lines)).toContain(cursor === 3 ? "Model" : "Thinking");
        }
      }
    }
  });

  it("shows a full model value below the table and keeps long rows fixed", () => {
    const { workspace } = create(40, "dark", true);
    workspace.openSettings(undefined, 3);
    expect(textOf(workspace.render(100))).toContain("Model: provider/long-model-identifier-with-extra-details");
    const lines = workspace.render(40).map(stripVTControlCharacters);
    const model = lines.findIndex((line) => line.includes("› Model:"));
    expect(lines[model]).toContain("…");
    expect(lines[model]?.replace(/│\s*$/, "").trimEnd()).toMatch(/›$/);
    expect(lines[model + 1]).toContain("Thinking:");
    workspace.handleInput("\x1b[B");
    expect(workspace.render(40).findIndex((line) => line.includes("Model:"))).toBe(model);
  });

  it.each(["dark", "light"])("keeps the Settings hint stable across groups and widths in %s", (name) => {
    const { workspace, theme } = create(40, name, true);
    workspace.openSettings();
    for (const width of [20, 40, 100]) {
      const header = workspace.render(width).slice(0, 2);
      if (width >= 40) expect(frameHeader(workspace.render(width)).join("\n")).toContain(theme.fg("muted", "Applies to future requests"));
      for (const key of ["\x1b[C", "\x1b[D", "\t", "\t", "\t"]) {
        workspace.handleInput(key);
        const lines = workspace.render(width);
        expect(lines.slice(0, 2)).toEqual(header);
        expect(textOf(lines)).not.toMatch(/Ctrl\+S to save|Changes save on confirmation/);
        if (width === 100) expect(textOf(lines)).toContain(formatKeyHint(["Ctrl+S", "Save"], theme, 1, "secondary"));
      }
    }
    workspace.handleInput(" ");
    for (const key of ["\x1b[C", "\x1b[D", "\t", "\t", "\t"]) {
      workspace.handleInput(key);
      const lines = workspace.render(100);
      expect(frameHeader(lines).join("\n")).toContain(theme.fg("warning", "Unsaved settings changes"));
      expect(textOf(lines)).not.toContain("Applies to future requests");
      expect(stripVTControlCharacters(textOf(lines))).toContain("Esc: Discard");
    }
  });

  it.each([0, 3])("aligns Settings action and navigation rows at cursor %i", (cursor) => {
    const { workspace } = create(40, "dark", true);
    workspace.openSettings(undefined, cursor);
    const hints = footer(workspace.render(100)).map((line) => stripVTControlCharacters(line).replace(/^│|│$/g, "").trim());
    expect(hints).toEqual(["Ctrl+S: Save  Enter: Change  Tab: Group  Esc: Back"]);
  });

  it.each(["dark", "light"])("aligns Settings hints across groups, dirty/disabled states and resize in %s", (name) => {
    for (const optimizer of [false, true]) {
      const { workspace, actions, theme } = create(40, name, optimizer);
      if (optimizer) actions.optimizer = () => ({ model: "Not configured", thinking: "Unavailable", thinkingEnabled: false });
      for (const dirty of [false, true]) for (const cursor of optimizer ? [0, 3, 4, 5] : [0, 1, 2]) {
        workspace.openSettings({ ...actions.context(), tree: !dirty }, cursor);
        for (const width of [34, 40, 60, 80, 100, 160]) {
          const lines = workspace.render(width);
          const footerRows = footer(lines);
          const hints = footerRows.map(stripVTControlCharacters).join("\n");
          const action = cursor === 4 ? "Unavailable" : "Change";
          const back = dirty ? "Discard" : "Back";
          expect(hints).not.toMatch(/(?:Space|←|→|↑↓):|\t/);
          expect(hints).toMatch(/(?:Ctrl\+S:|\^S) Save/);
          expect(hints).toMatch(new RegExp(`Esc:? ${back}`));
          if (width >= 80) expect(footerRows).toHaveLength(1);
          else expect(footerRows.length).toBeLessThanOrEqual(2);
          expect(lines).toHaveLength(panelLayout(width, 40).height);
          for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
          if (width >= 80) {
            expect(hints).toContain(`Enter: ${action}  Tab: Group  Esc: ${back}`);
            expect(footerRows[0]).toContain(formatKeyHint(["Ctrl+S", "Save"], theme, 1, "secondary"));
            expect(footerRows[0]).toContain(formatKeyHint(["Esc", back], theme, 1, "secondary"));
          }
          // Cache hits must retain the packed frame unchanged.
          expect(workspace.render(width)).toEqual(lines);
        }
      }
      expect(actions.saveContext).not.toHaveBeenCalled();
      expect(actions.submit).not.toHaveBeenCalled();
    }
  });

  it("preserves compact and single-line Settings hint fallbacks", () => {
    const { workspace, terminal } = create(40, "dark", true);
    for (const cursor of [0, 3]) {
      workspace.openSettings(undefined, cursor);
      for (const width of [12, 20, 24, 30]) {
        const footerRows = footer(workspace.render(width)).map(stripVTControlCharacters);
        expect(footerRows[0]).toMatch(/Esc Back/);
        expect(footerRows.join("\n")).toMatch(/\^S Save/);
        for (const line of footerRows) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
      workspace.openSettings({ instructions: "always", tree: false, skills: false }, cursor);
      expect(footer(workspace.render(24)).map(stripVTControlCharacters).join("\n")).toMatch(/Esc:? Discard/);
    }
    terminal.rows = 5;
    expect(stripVTControlCharacters(footer(workspace.render(40)).at(-1)!).trim()).toBe("Esc Discard · ^S Save · ↵ Change");
    workspace.openSettings();
    expect(stripVTControlCharacters(footer(workspace.render(40)).at(-1)!).trim()).toBe("Esc Back · ^S Save · ↵ Change");
    expect(stripVTControlCharacters(footer(workspace.render(12)).at(-1)!).trim()).toBe("Esc Back");
  });

  it("keeps disabled context warnings visible and omits unavailable groups", () => {
    const { workspace, actions } = create();
    actions.contextEnabled = () => false;
    workspace.openSettings();
    const before = workspace.render(100);
    expect(textOf(before)).toContain("Project context is off");
    expect(textOf(before)).not.toContain("Optimizer");
    workspace.handleInput("\t");
    expect(stripVTControlCharacters(textOf(workspace.render(100)))).toContain("› Draft character limit");
    workspace.handleInput("\t");
    expect(workspace.render(100)).toEqual(before);
  });

  it("keeps selected settings visible in a tiny viewport and retains their cursor", () => {
    const { workspace } = create(8);
    workspace.handleInput("\x1b[D");
    for (const label of ["Project instructions: Always", "Directory tree: [x] On", "Skill metadata: [ ] Off"]) {
      expect(stripVTControlCharacters(textOf(workspace.render(40)))).toContain(`› ${label}`);
      workspace.handleInput("\x1b[B");
    }
    for (let i = 0; i < 5; i++) workspace.handleInput("\x1b[B");
    workspace.handleInput("q");
    workspace.handleInput("\x1b[D");
    expect(stripVTControlCharacters(textOf(workspace.render(40)))).toContain("› Directory tree: [x] On");
  });

  it.each([0, 1, 2, 3, 4, 5])("saves context with the same shortcut at cursor %i", async (cursor) => {
    const { workspace, actions } = create(40, "dark", true);
    workspace.openSettings();
    workspace.handleInput("\r");
    expect(actions.saveContext).not.toHaveBeenCalled();
    expect(stripVTControlCharacters(textOf(workspace.render(100)))).toMatch(/› Project instructions +Off/);
    if (cursor >= 3) workspace.handleInput("\t");
    for (let i = 0; i < cursor % 3; i++) workspace.handleInput("\x1b[B");
    expect(textOf(workspace.render(100))).toContain("Ctrl+S");
    workspace.handleInput("\x13");
    expect(actions.saveContext).toHaveBeenCalledExactlyOnceWith({ instructions: "off", tree: true, skills: false });
    expect(actions.chooseModel).not.toHaveBeenCalled();
    expect(actions.cycleThinking).not.toHaveBeenCalled();
    expect(actions.editSystemPrompt).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(textOf(workspace.render(100))).toContain("Context saved"));
  });

  it.each(["\x1b", "q", "\x1c"])("discards only pending context when returning with %j", (key) => {
    const { workspace, actions } = create(40, "dark", true);
    workspace.openSettings();
    workspace.handleInput("\r");
    workspace.handleInput(key);
    expect(stripVTControlCharacters(workspace.render(100)[1]!)).toContain("Prompt refine");
    workspace.openSettings();
    expect(stripVTControlCharacters(textOf(workspace.render(100)))).toMatch(/› Project instructions +Always/);
    expect(textOf(workspace.render(100))).not.toContain("Unsaved settings changes");
    expect(actions.saveContext).not.toHaveBeenCalled();
  });

  it.each([8, 12, 40])("retains context selections and visible save errors for retry at %i rows", async (rows) => {
    const { workspace, actions } = create(rows, "dark", true);
    actions.saveContext.mockRejectedValueOnce(new Error("write failed"));
    workspace.openSettings();
    workspace.handleInput("\r");
    workspace.handleInput("\x13");
    await vi.waitFor(() => expect(textOf(workspace.render(100))).toContain("Could not save settings"));
    for (const key of ["\x1b[C", "\x1b[D"]) {
      workspace.handleInput(key);
      const text = textOf(workspace.render(100));
      expect(text).toContain("Could not save settings");
      expect(text).toContain("Unsaved settings changes");
      expect(text).not.toContain("Applies to future requests");
    }
    expect(stripVTControlCharacters(textOf(workspace.render(100)))).toMatch(/› Project instructions +Off/);
    workspace.handleInput("\x13");
    await vi.waitFor(() => expect(actions.saveContext).toHaveBeenCalledTimes(2));
    expect(actions.saveContext).toHaveBeenLastCalledWith({ instructions: "off", tree: true, skills: false });
  });

  it("keeps Shift+Tab for thinking and blocks group/page navigation while saving", async () => {
    const { workspace, actions } = create(40, "dark", true);
    let resolve!: (notice: SettingsResult) => void;
    actions.cycleThinking!.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    workspace.openSettings();
    workspace.handleInput("\x1b[C");
    workspace.handleInput("\x1b[Z");
    expect(actions.cycleThinking).toHaveBeenCalledOnce();
    const saving = workspace.render(100);
    expect(stripVTControlCharacters(textOf(saving))).toContain("› Model");
    expect(textOf(saving)).toContain("Saving...");
    expect(textOf(saving)).not.toContain("Applies to future requests");
    for (const key of ["\x1b[D", "\x1b[C", "\t"]) {
      workspace.handleInput(key);
      expect(workspace.render(100)).toEqual(saving);
    }
    resolve({ message: "Thinking level saved", persisted: true });
    await vi.waitFor(() => expect(textOf(workspace.render(100))).toContain("Thinking level saved"));
    const status = workspace.render(100)[2];
    expect(status).not.toContain("Applies to future requests");
    workspace.handleInput("\x1b[D");
    expect(workspace.render(100)[2]).toBe(status);
    expect(stripVTControlCharacters(textOf(workspace.render(100)))).toContain("› Project instructions");
    expect(actions.saveContext).not.toHaveBeenCalled();
    expect(actions.chooseModel).not.toHaveBeenCalled();
    expect(actions.editSystemPrompt).not.toHaveBeenCalled();
  });

  it.each(["dark", "light"])("keeps clean-settings save failures semantic without leaving stale warning styles (%s)", async (name) => {
    const { workspace, actions, theme } = create(40, name, true);
    actions.saveContext.mockRejectedValueOnce(new Error("write failed"));
    workspace.openSettings(); workspace.handleInput("\x13");
    await vi.waitFor(() => expect(textOf(workspace.render(100))).toContain(theme.fg("warning", "Could not save settings. Retry with Ctrl+S.")));
    workspace.handleInput("\r"); workspace.handleInput("\r"); workspace.handleInput("\r");
    expect(textOf(workspace.render(100))).toContain(theme.fg("muted", "Applies to future requests"));
    actions.cycleThinking!.mockRejectedValueOnce(new Error("write failed"));
    workspace.openSettings(undefined, 4); workspace.handleInput("\r");
    await vi.waitFor(() => expect(textOf(workspace.render(100))).toContain(theme.fg("warning", "Could not save thinking level.")));
    workspace.handleInput("\r");
    await vi.waitFor(() => expect(textOf(workspace.render(100))).toContain(theme.fg("muted", "Thinking level saved")));
  });

  it.each(["dark", "light"])("warns on applied-but-unpersisted settings and allows retry in %s", async (name) => {
    const { workspace, actions, terminal, theme } = create(40, name, true);
    const failure = { message: "Context applied · Not persisted; check configuration", persisted: false };
    actions.saveContext.mockResolvedValueOnce(failure);
    workspace.openSettings(); workspace.handleInput("\r"); workspace.handleInput("\x13");
    await vi.waitFor(() => expect(textOf(workspace.render(100))).toContain(theme.fg("warning", `${failure.message} · Unsaved settings changes`)));
    expect(textOf(workspace.render(100))).toContain("Settings");
    expect(textOf(workspace.render(100))).not.toContain("Context saved");
    for (const rows of [8, 12, 40]) {
      terminal.rows = rows;
      expect(textOf(workspace.render(100))).toContain("Not persisted");
      expect(workspace.render(100)).toHaveLength(panelLayout(100, rows).height);
    }
    workspace.handleInput("\x13");
    await vi.waitFor(() => expect(textOf(workspace.render(100))).toContain("Context saved"));
    terminal.rows = 40;
    actions.cycleThinking!.mockResolvedValueOnce({ message: "Thinking applied · Not persisted; check configuration", persisted: false });
    workspace.openSettings(undefined, 4); workspace.handleInput("\r");
    await vi.waitFor(() => expect(textOf(workspace.render(100))).toContain(theme.fg("warning", "Thinking applied · Not persisted; check configuration")));
    workspace.handleInput("\r");
    await vi.waitFor(() => expect(textOf(workspace.render(100))).toContain(theme.fg("muted", "Thinking level saved")));
  });

  it("keeps thinking save feedback visible above a short viewport", async () => {
    const { workspace } = create(12, "dark", true);
    workspace.openSettings(undefined, 4);
    workspace.handleInput("\r");
    await vi.waitFor(() => expect(textOf(workspace.render(80))).toContain("Thinking level saved"));
  });

  it("renders disabled thinking without offering or executing a change", () => {
    const { workspace, actions, theme } = create(40, "dark", true);
    actions.optimizer = () => ({ model: "Not configured", thinking: "Unavailable — select model first", thinkingEnabled: false });
    workspace.openSettings(undefined, 4);
    const output = textOf(workspace.render(100));
    expect(stripVTControlCharacters(output)).toContain("Unavailable — select model first");
    expect(output).toContain(theme.fg("dim", "Thinking              "));
    expect(output).toContain("Enter");
    expect(output).not.toContain("Cycle");
    for (const key of ["\r", " ", "\x1b[Z"]) workspace.handleInput(key);
    expect(actions.cycleThinking).not.toHaveBeenCalled();
    expect(actions.saveContext).not.toHaveBeenCalled();
  });

  it.each(["dark", "light"])("highlights one full-width focus row in %s", (name) => {
    const { workspace, theme } = create(40, name, true);
    workspace.openSettings();
    const bg = vi.spyOn(theme, "bg");
    workspace.render(100);
    const selected = bg.mock.calls.filter(([color]) => color === "selectedBg");
    expect(selected).toHaveLength(3); // Page, group and keyboard focus.
    const focus = selected.filter(([, text]) => stripVTControlCharacters(text).startsWith("› "));
    expect(focus).toHaveLength(1);
    expect(visibleWidth(focus[0]![1])).toBe(panelLayout(100, 40).innerWidth);
    bg.mockRestore();
  });

  it("keeps the focused context option and its explanation together on short screens", () => {
    const { workspace } = create(12, "dark", true);
    workspace.openSettings(undefined, 2);
    const output = stripVTControlCharacters(textOf(workspace.render(80)));
    expect(output).toContain("› Skill metadata");
    expect(output).toContain("Include skill descriptions; never run skills.");
  });

  it("ignores late save completion and stale input after disposal", async () => {
    const { workspace, actions } = create();
    let resolve!: (notice: SettingsResult) => void;
    actions.saveContext.mockImplementation(() => new Promise((done) => { resolve = done; }));
    workspace.handleInput("\x1b[D");
    workspace.handleInput(" ");
    expect(textOf(workspace.render(80))).toContain("Unsaved settings changes");
    workspace.handleInput("\x13");
    workspace.handleInput("\x13");
    expect(actions.saveContext).toHaveBeenCalledTimes(1);
    workspace.dispose();
    resolve({ message: "saved", persisted: true });
    await Promise.resolve();
    expect(textOf(workspace.render(80))).toContain("Settings");
    workspace.handleInput("i");
    workspace.handleInput("\r");
    expect(actions.submit).not.toHaveBeenCalled();
  });
});
