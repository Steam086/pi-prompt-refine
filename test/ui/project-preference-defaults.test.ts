import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { PreferencePanel } from "../../src/preference-panel.js";
import { panelLayout } from "../../src/panel-layout.js";
import { preferenceKey, selectPreference } from "../../src/revision-preferences.js";
import { formatKeyHint } from "../../src/key-hints.js";
import { a, b, bringBack, enter, esc, loaded, setup, text } from "../support/preference-panel.js";

describe.each(["dark", "light"])("project default controls (%s)", (themeName) => {
  it("styles defaults independently of selection, keeps only three management actions, and clears hidden selections", async () => {
    const f = setup([selectPreference(a), selectPreference(b)], "Keep free text.", themeName);
    await loaded(f.panel);
    const setProjectDefault = vi.fn(async (entry, enabled) => {
      f.library.projectDefaults = enabled ? [preferenceKey(entry)] : [];
      return structuredClone(f.library);
    });
    Object.assign(f.repo, { setProjectDefault });
    f.panel.handleInput("g");
    await vi.waitFor(() => expect(text(f.panel)).toContain("Project default enabled"));
    let lines = f.panel.render(100);
    expect(lines.join("\n")).toContain(f.theme.fg("muted", "* "));
    expect(lines.join("\n")).toContain(f.theme.fg("muted", "Project default: On · future drafts"));
    expect(lines.join("\n")).toContain(formatKeyHint(["g", "Project default"], f.theme));
    expect(lines.join("\n")).toContain(formatKeyHint(["c", "Clear all"], f.theme));
    for (const action of [["n", "Add"], ["e", "Edit"], ["d", "Delete"]] as const) {
      expect(lines.join("\n")).toContain(formatKeyHint(action, f.theme));
    }
    // A future default can be off for this request, with its star still present.
    f.panel.handleInput(" "); expect(text(f.panel)).toContain("[ ] * Concise 中文");
    f.panel.handleInput("/"); f.panel.handleInput("Literal"); f.panel.handleInput(enter);
    f.panel.handleInput("c"); expect(text(f.panel)).toContain("Selection cleared");
    for (const [width, rows] of [[100, 40], [40, 16], [20, 8], [12, 6], [1, 6], [100, 40]]) {
      f.terminal.rows = rows!; f.panel.invalidate(); lines = f.panel.render(width!);
      expect(lines).toHaveLength(panelLayout(width!, rows!).height);
      expect(lines.every((line) => visibleWidth(line) <= width!)).toBe(true);
      f.panel.handleInput("\x1b[6~"); f.panel.handleInput("\x1b[5~");
    }
    f.panel.handleInput(bringBack); expect(f.close).toHaveBeenCalledWith([]);
    expect(f.library.projectDefaults).toEqual([preferenceKey(a)]);
    expect(setProjectDefault).toHaveBeenCalledTimes(1);
    f.panel.dispose();
  });

  it("keeps save failure feedback semantic and visible at narrow/short sizes without changing selection", async () => {
    const f = setup([selectPreference(a)], "", themeName); await loaded(f.panel);
    Object.assign(f.repo, { setProjectDefault: vi.fn(async () => { throw new Error("Disk unavailable 中文😀\x1b[999C"); }) });
    f.panel.handleInput("g"); await vi.waitFor(() => expect(text(f.panel)).toContain("Project default not saved"));
    for (const [width, rows] of [[100, 40], [40, 16], [20, 8], [12, 6], [100, 40]]) {
      f.terminal.rows = rows!;
      const lines = f.panel.render(width!);
      expect(lines.every((line) => visibleWidth(line) <= width!)).toBe(true);
      expect(lines.join("\n")).toContain(f.theme.fg("error", "⚠").split("⚠")[0] + "⚠");
      expect(lines.join("\n")).not.toContain("\x1b[999C");
    }
    f.panel.handleInput(bringBack); expect(f.close).toHaveBeenCalledWith([selectPreference(a)]);
    f.panel.dispose();
  });

  it("consumes g/c as search text and in read pages without saving defaults or clearing selections", async () => {
    const f = setup([selectPreference(a)], "", themeName); await loaded(f.panel);
    const setProjectDefault = vi.fn(); Object.assign(f.repo, { setProjectDefault });
    f.panel.handleInput(enter); f.panel.handleInput("g"); f.panel.handleInput("c"); f.panel.handleInput(esc);
    f.panel.handleInput("/"); f.panel.handleInput("g"); f.panel.handleInput("c"); f.panel.handleInput(enter);
    expect(setProjectDefault).not.toHaveBeenCalled();
    f.panel.handleInput(bringBack); expect(f.close).toHaveBeenCalledWith([selectPreference(a)]);
    f.panel.dispose();
  });

  it("can disable deleted defaults even without a retained selected snapshot", async () => {
    const f = setup([], "", themeName); await loaded(f.panel); f.panel.dispose();
    const repo = { ...f.repo, load: vi.fn(async () => ({ entries: [], errors: { defaults: "1 default deleted; skipped" }, projectDefaults: ["global:missing"] })),
      setProjectDefault: vi.fn(async () => ({ entries: [], errors: {}, projectDefaults: [] })) };
    const panel = new PreferencePanel(f.tui, f.theme, f.keys, repo, [], "", 16000, f.close, "manage");
    await loaded(panel);
    expect(text(panel)).toContain("Unavailable default");
    panel.handleInput("g"); await vi.waitFor(() => expect(text(panel)).toContain("Project default disabled"));
    expect(repo.setProjectDefault).toHaveBeenCalledWith(expect.objectContaining({ id: "missing", scope: "global" }), false);
    panel.handleInput(esc); expect(f.close).toHaveBeenCalledWith();
    panel.dispose();
  });
});
