import { visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RefineRecord } from "../../src/history.js";
import { panelLayout } from "../../src/panel-layout.js";
import { sanitizeTerminalText } from "../../src/presentation.js";
import { getThemeByName } from "../support/pi-theme.js";
import { create, record } from "../support/task-panel.js";

afterEach(() => vi.restoreAllMocks());
describe("prompt tree and inspection", () => {

  it.each(["dark", "light"])("keeps model identities neutral and archived statuses semantic (%s)", (name) => {
    const records = [record(1), record(2), record(3), record(4)];
    records[1]!.status = "error"; records[1]!.error = "timeout";
    records[2]!.status = "generating";
    records[3]!.status = "cancelled";
    for (const record of records) record.archivedAt = 1;
    const { panel, theme } = create(name, true, records);
    const fg = vi.spyOn(theme, "fg");
    const lines = panel.render(100);
    for (const record of records) {
      const row = lines.find((line) => /[├└]/.test(stripVTControlCharacters(line)) && stripVTControlCharacters(line).includes(record.input.model.id))!;
      expect(row).toBeDefined();
      expect(fg.mock.calls.some(([color, value]) => color === "text" && value.includes(record.input.model.id) && /[├└]/.test(value))).toBe(true);
      expect(fg.mock.calls.some(([color, value]) => color !== "text" && value.includes(record.input.model.id) && /[├└]/.test(value))).toBe(false);
    }
    for (const [color, badge] of [["success", "✓ Done"], ["error", "! Timed out"], ["accent", "◌ Running"], ["warning", "× Cancelled"]] as const) {
      expect(lines.join("\n")).toContain(theme.fg(color, badge));
    }
    expect(lines.join("\n")).toContain(theme.fg("muted", "Earlier · "));
  });

  it.each(["dark", "light"])("keeps neighbouring runs visible without moving the action target on resize (%s)", (name) => {
    const f = create(name, false, Array.from({ length: 24 }, (_, i) => record(24 - i)));
    for (const [width, rows] of [[100, 40], [45, 14], [100, 20]]) {
      f.size.rows = rows!; f.position.selectedTaskId = undefined; f.position.selectedId = 24;
      for (let id = 24; id >= 1; id--) {
        const frame = f.panel.render(width!);
        const left = frame.map((line) => stripVTControlCharacters(line).split("│")[0]).join("\n");
        expect(left).toMatch(new RegExp(`model-${id}(?!\\d)`));
        if (id > 1) expect(left).toMatch(new RegExp(`model-${id - 1}(?!\\d)`));
        const active = frame.find((line) => stripVTControlCharacters(line).includes("›"))!;
        expect(active).toContain(f.theme.bg("selectedBg", "probe").split("probe")[0]);
        expect(frame.every((line) => visibleWidth(line) <= width!)).toBe(true);
        expect(f.panel.render(width!)).toEqual(frame);
        expect(f.position.selectedId).toBe(id);
        f.panel.handleInput("\x1b[B");
      }
      for (let id = 2; id <= 24; id++) {
        f.panel.handleInput("\x1b[A");
        const left = f.text(width!).split("\n").map((line) => line.split("│")[0]).join("\n");
        expect(f.position.selectedId).toBe(id);
        if (id < 24) expect(left).toMatch(new RegExp(`model-${id + 1}(?!\\d)`));
      }
    }
    expect(f.actions.activate).not.toHaveBeenCalled();
    expect(f.actions.run).not.toHaveBeenCalled();
  });

  it.each(["dark", "light"])("follows only an explicitly submitted run in %s, including queued starts and resize", (name) => {
    for (const usage of [false, true]) for (const status of ["generating", "queued"] as const) {
      const draft = record(2, 2);
      draft.status = "unsent"; draft.candidate = undefined;
      draft.input.draft = "Draft 中文😀\x1b[2J";
      const f = create(name, usage, [draft, record(1)]);
      Object.assign(f.position, { selectedTaskId: 2, scroll: 8, scrolls: { "task-2": 8 } });
      f.actions.run.mockImplementation(() => { draft.status = status; });
      f.panel.handleInput("\r");
      expect(f.actions.run).toHaveBeenCalledExactlyOnceWith(2);
      expect(f.position.selectedId).toBe(2);
      expect(f.position.selectedTaskId).toBeUndefined();
      expect(f.position.scroll).toBe(0);
      expect(f.position.scrolls?.["task-2"]).toBe(8);
      for (const [width, rows] of [[100, 40], [40, 12], [120, 50]]) {
        f.size.rows = rows!;
        const lines = f.panel.render(width!);
        expect(lines.length).toBeLessThanOrEqual(rows!);
        for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width!);
        const selected = lines.find((line) => stripVTControlCharacters(line).includes("›"))!;
        expect(stripVTControlCharacters(selected)).toContain("└ model-2");
        const selectionStyle = f.theme.bg("selectedBg", "probe").split("probe")[0]!;
        expect(selectionStyle).toMatch(/\x1b\[/);
        expect(selected).toContain(selectionStyle);
        expect(lines.join("\n")).not.toContain("\x1b[2J");
      }
      f.panel.handleInput("\x1b[B"); // Browse another original before completion.
      const position = structuredClone(f.position);
      draft.status = "generated"; draft.candidate = record(2, 2).candidate;
      f.panel.render(100);
      expect(f.position).toEqual(position);
      expect(f.actions.activate).not.toHaveBeenCalled();
    }
  });

  it("keeps the Unsent original selected when explicit startup is rejected", () => {
    const draft = record(); draft.status = "unsent"; draft.candidate = undefined;
    const f = create("dark", false, [draft]);
    Object.assign(f.position, { selectedTaskId: draft.taskId, scroll: 3 });
    f.panel.handleInput("\r");
    expect(f.actions.run).toHaveBeenCalledExactlyOnceWith(draft.id);
    expect(f.position.selectedTaskId).toBe(draft.taskId);
    expect(f.position.scroll).toBe(3);
    expect(f.text()).toContain("› ○ Unsent");
  });

  it("orders all Usage tasks and runs newest first, keeps archived work last and preserves selection", () => {
    const older = { ...record(9, 3), archivedAt: 1 };
    const { panel, position, records, text } = create("dark", true, [record(1), record(2, 2), record(3), older]);
    const output = text();
    const left = output.split("\n").filter((line) => line.includes(" │ ")).map((line) => line.split(" │ ")[0]).join("\n");
    expect(left.indexOf("model-3")).toBeLessThan(left.indexOf("model-1"));
    expect(left.indexOf("model-1")).toBeLessThan(left.indexOf("model-2"));
    expect(left.indexOf("model-2")).toBeLessThan(left.indexOf("model-9"));
    records.push(record(10, 4));
    expect(text()).toContain("Result 1");
    expect(position.selectedId).toBe(1);
    records[0]!.archivedAt = 1;
    expect(text()).not.toContain("Uses earlier conversation context");
    expect(text()).toContain("Earlier ·");
    panel.handleInput("\r");
    let details = "";
    for (let i = 0; i < 6; i++) { details += text(80); panel.handleInput("\x1b[6~"); }
    expect(details).toContain("Earlier context");
    for (let i = 0; i < 6; i++) panel.handleInput("\x1b[5~");
    const fg = vi.spyOn(getThemeByName("dark")!, "fg");
    expect(text()).toContain("正文 中文😀");
    expect(fg).not.toHaveBeenCalledWith("dim", records[0]!.candidate!.text);
  });

  it.each(["dark", "light"])("keeps archived and restored trees out of Preview, including stale remembered selections (%s)", (name) => {
    const old = { ...record(9, 3), archivedAt: 1 };
    const restored = { ...record(10, 4), archivedAt: 2, input: { ...record(10, 4).input, contextUnavailable: true } };
    const f = create(name, false, [old, restored, record(2, 2)]);
    expect(f.text()).toContain("model-2");
    expect(f.text()).not.toContain("model-9");
    expect(f.text()).not.toContain("model-10");
    expect(f.position.selectedTaskId).toBe(2);
    f.panel.handleInput("\x1b[B"); f.panel.handleInput("a");
    expect(f.actions.accept).toHaveBeenCalledExactlyOnceWith(2);
    const usage = create(name, true, f.records);
    expect(usage.text()).toContain("Earlier ·");
    expect(usage.text()).toContain("model-9");
    expect(usage.text()).toContain("model-10");
  });

  it.each(["dark", "light"])("retains only an open archived view until explicit Back, without following late completions (%s)", (name) => {
    for (const inspecting of [false, true]) {
      const f = create(name, false, [record(1), record(2, 2)]);
      f.text(); // Establish a live viewing target, not merely a stale saved position.
      if (inspecting) f.panel.handleInput("\r");
      const archived = f.records[0]!;
      archived.archivedAt = 1;
      f.records[1]!.archivedAt = 1;
      f.records.push(record(3, 3));
      const saved = structuredClone(f.position);
      for (const [width, rows] of [[100, 40], [40, 24], [20, 12], [100, 40]]) {
        f.size.rows = rows!;
        const frame = f.panel.render(width!);
        expect(frame.every((line) => visibleWidth(line) <= width!)).toBe(true);
        expect(f.position.selectedId).toBe(saved.selectedId);
        expect(f.position.selectedTaskId).toBe(saved.selectedTaskId);
        expect(f.position.scroll).toBe(saved.scroll);
        if (width! >= 40) {
          expect(stripVTControlCharacters(frame.join("\n"))).toContain("Earlier");
          expect(stripVTControlCharacters(frame.join("\n"))).toContain("Result 1");
          if (width! >= 100) expect(frame.join("\n")).toContain(f.theme.fg("text", f.theme.bold("#1 model-1")));
        }
      }
      f.records[1]!.candidate!.text = "Late old result";
      expect(f.text()).not.toContain("Late old result");
      expect(f.text()).not.toContain("model-2");
      f.panel.handleInput("a");
      expect(f.actions.accept).toHaveBeenCalledExactlyOnceWith(1);
      f.panel.handleInput("\x1b");
      expect(f.text()).toContain("model-3");
      expect(f.text()).not.toContain("Earlier · kept open");
      expect(f.position.selectedId).toBe(3);
      expect(f.actions.run).not.toHaveBeenCalled();
    }
  });

  it("exposes archived background work in Usage without restoring it to Preview", () => {
    const running: RefineRecord = { ...record(1), archivedAt: 1, status: "generating", candidate: undefined };
    const f = create("dark", false, [running, record(2, 2)]);
    expect(f.text()).toContain("1 running / queued");
    expect(f.text()).toContain("Run: Default model");
    expect(f.text()).not.toContain("model-1");
    const usage = create("dark", true, f.records);
    usage.panel.handleInput("x");
    expect(usage.actions.stop).toHaveBeenCalledExactlyOnceWith(1);
    running.status = "generated";
    running.candidate = record(1).candidate;
    expect(f.text()).not.toContain("1 running / queued");
    expect(f.text()).toContain("model-2");
    expect(f.position.selectedId).toBe(2);
  });

  it("does not submit or edit an Unsent whose open view has just been archived", () => {
    const source: RefineRecord = { ...record(), status: "unsent", candidate: undefined };
    const f = create("dark", false, [source]);
    f.text(); source.archivedAt = 1;
    f.panel.handleInput("\r");
    expect(f.text()).toContain("Earlier");
    expect(f.text()).not.toContain("Enter Run");
    expect(f.actions.run).not.toHaveBeenCalled();
    f.panel.handleInput("\x1b");
    expect(f.text()).not.toContain("Original prompt");
  });

  it.each(["dark", "light"])("explains the historical destination even in short and narrow Preview empty states (%s)", (name) => {
    const f = create(name, false, [{ ...record(), archivedAt: 1 }]);
    for (const [width, rows] of [[100, 40], [40, 24], [20, 12], [100, 40]]) {
      f.size.rows = rows!;
      const frame = f.panel.render(width!);
      const text = stripVTControlCharacters(frame.join("\n"));
      expect(text).toContain("Usage");
      expect(frame.every((line) => visibleWidth(line) <= width!)).toBe(true);
      if (width! >= 40) {
        expect(text).toContain("No current prompts");
        expect(text).toContain("History");
      }
    }
    expect(f.panel.render(100).join("\n")).toContain(f.theme.fg("muted", " · Current round · History → Usage · 1 earlier prompt"));
    const usage = create(name, true, f.records);
    expect(usage.text()).toContain("Current + history");
    usage.panel.handleInput("?");
    expect(usage.text()).toContain("All rounds: current prompts");
    expect(f.actions.run).not.toHaveBeenCalled();
  });

  it("uses selectable original roots; Enter runs unsent and otherwise inspects without Apply", () => {
    const draft: RefineRecord = { ...record(), status: "unsent", candidate: undefined };
    const { panel, actions, text, position } = create("dark", false, [draft]);
    expect(text()).toContain("Original prompt");
    expect(position.selectedTaskId).toBe(1);
    panel.handleInput("i"); panel.handleInput("e"); panel.handleInput("n"); panel.handleInput("m");
    expect(actions.editOriginal.mock.calls).toEqual([[1], []]);
    expect(actions.chooseModel).toHaveBeenCalledWith(1);
    panel.handleInput("\r");
    expect(actions.run).toHaveBeenCalledWith(1);
    draft.status = "generated";
    panel.handleInput("\r");
    expect(text()).toContain("Prompt details");
    expect(actions.activate).not.toHaveBeenCalled();
  });

  it("opens Preferences for empty, original and child rows, equally before and after Inspect", () => {
    for (const status of ["unsent", "queued", "generating", "generated"] as const) {
      for (const contextUnavailable of [false, true]) {
        const source = { ...record(), status, input: { ...record().input, contextUnavailable } };
        const f = create("dark", false, [source]);
        f.position.selectedTaskId = 1;
        f.panel.handleInput("p"); f.panel.handleInput("\x1bp");
        expect(f.actions.preferences.mock.calls).toEqual([[1, true], [1, true]]);
        f.panel.handleInput("?"); expect(f.text()).toContain("p Preferences");
        f.panel.handleInput("p"); expect(f.actions.preferences).toHaveBeenCalledTimes(2);
        f.panel.handleInput("\x1b");
        if (status !== "unsent") {
          for (const original of [true, false]) {
            f.position.selectedTaskId = original ? 1 : undefined; f.position.selectedId = 1;
            f.panel.handleInput("p"); f.panel.handleInput("\r"); f.panel.handleInput("p");
            expect(f.actions.preferences.mock.calls.slice(-2)).toEqual([[1, original], [1, original]]);
            expect(f.text()).toContain("p Preferences");
            f.panel.handleInput("\x1b");
          }
        }
        expect(f.actions.run).not.toHaveBeenCalled(); expect(f.actions.activate).not.toHaveBeenCalled();
      }
    }
    const f = create("light", false, []);
    expect(f.text()).toContain("p Preferences");
    f.panel.handleInput("p"); expect(f.actions.preferences).toHaveBeenCalledWith(undefined, undefined);
  });

  it.each(["dark", "light"])("shows selected Unsent snapshots with neutral semantic styling and bounded %s layouts", (name) => {
    const source = { ...record(), status: "unsent" as const, candidate: undefined };
    source.input.preferences = [{ id: "a", scope: "project", version: 1, name: "Bullets 中文😀\x1b[2J", body: "Keep **literal** 中文😀", sourceBody: "Keep **literal** 中文😀" }];
    source.input.editingInstruction = source.input.preferences[0]!.body;
    const f = create(name, false, [source]);
    const full = f.panel.render(100).join("\n");
    expect(full).toContain(f.theme.fg("muted", sanitizeTerminalText(`Preferences: 1 · ${source.input.preferences[0]!.name}`)));
    expect(f.text()).toContain("p Preferences");
    expect(full).not.toContain("\x1b[2J");
    for (const [width, rows] of [[100, 40], [40, 16], [20, 8], [12, 6], [100, 40]]) {
      f.size.rows = rows!;
      for (const key of ["\t", "\x1b[B", "\x1b[6~", "\x1b[5~", "\t"]) {
        f.panel.handleInput(key);
        const lines = f.panel.render(width!);
        expect(lines).toHaveLength(panelLayout(width!, rows!).height);
        for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width!);
        expect(lines.join("\n")).not.toContain("\x1b[2J");
      }
    }
    expect(f.text(40)).toContain("P:1");
    expect(f.actions.run).not.toHaveBeenCalled();
    f.panel.handleInput("\r"); expect(f.actions.run).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("directly accepts/stops only the selected child, never its siblings or parent", () => {
    const { panel, actions, records, position } = create("dark", false, [record(), record(2)]);
    panel.handleInput("a");
    expect(actions.accept).toHaveBeenCalledWith(1);
    panel.handleInput("x");
    expect(actions.stop).not.toHaveBeenCalled();
    records[0]!.status = "generating";
    panel.handleInput("x");
    expect(actions.stop).toHaveBeenCalledWith(1);
    position.selectedTaskId = 1;
    panel.handleInput("a"); panel.handleInput("x");
    expect(actions.accept).toHaveBeenCalledTimes(1);
    expect(actions.stop).toHaveBeenCalledTimes(1);
    for (const key of ["s", "f", "g", "c", "[", "]", "d", "z"]) expect(panel.handleInput(key)).toBe(true);
    expect(actions.activate).not.toHaveBeenCalled();
  });

  it.each([80, 100, 160])("right-aligns variable statuses without reserving a fixed column at %s", (width) => {
    const { records, text } = create("dark", false, [record(1), record(2), record(3)]);
    records[0]!.input.model.id = "模型😀";
    records[1]!.acceptedAt = 1;
    records[2]!.status = "generating";
    const children = text(width).split("\n").filter((line) => /[├└]/.test(line)).map((line) => line.split(" │ ")[0]!.trimEnd());
    expect(children).toHaveLength(3);
    expect(new Set(children.map(visibleWidth)).size).toBe(1);
    expect(children.some((line) => line.includes("模型😀"))).toBe(true);
    expect(children.every((line) => !line.includes(" · "))).toBe(true);
  });

  it("truncates long model names without escaping its own ANSI resets or hiding the status", () => {
    const { records, text } = create();
    records[0]!.input.model.id = "claude-sonnet-long-model-name";
    records[0]!.status = "generating";
    records[0]!.candidate = undefined;
    const output = text(80);
    const child = output.split("\n").find((line) => line.includes("› └"))!;
    expect(child.split(" │ ")[0]).toContain("Running");
    expect(output).not.toContain("�");
    expect(output).not.toContain("[0m");
  });
});

describe("delete confirmation", () => {
  it("requires explicit confirmation and captures the selected run", () => {
    const { panel, actions, text, position } = create();
    const remove = vi.fn(() => true);
    Object.assign(actions, { deleteRecords: remove });
    expect(text()).toContain("Delete");
    panel.handleInput("d");
    expect(text()).toContain("Delete run #1?");
    expect(text()).toContain("Running requests will be stopped");
    panel.handleInput("\r");
    panel.handleInput("\x1b[B");
    expect(remove).not.toHaveBeenCalled();
    expect(position.selectedId).toBe(1);
    panel.handleInput("\x1b");
    expect(panel.isConfirmingDelete()).toBe(false);
    panel.handleInput("d");
    panel.handleInput("y");
    expect(remove).toHaveBeenCalledWith([1]);
  });

  it("confirms the original's entire group without including later additions", () => {
    const { panel, actions, position, records, text } = create("dark", false, [record(1), record(2)]);
    const remove = vi.fn(() => true);
    Object.assign(actions, { deleteRecords: remove });
    position.selectedTaskId = 1;
    panel.handleInput("d");
    expect(text()).toContain("all 2 request(s)");
    records.push(record(3));
    panel.handleInput("y");
    expect(remove).toHaveBeenCalledWith([1, 2]);
  });
});
