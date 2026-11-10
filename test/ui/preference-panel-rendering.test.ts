import { CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TUI } from "@earendil-works/pi-tui";
import { performance } from "node:perf_hooks";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatKeyHint, type KeyHint } from "../../src/key-hints.js";
import { panelLayout } from "../../src/panel-layout.js";
import { PreferencePanel } from "../../src/preference-panel.js";
import * as presentation from "../../src/presentation.js";
import * as preferences from "../../src/revision-preferences.js";
import { composeRevision, selectPreference } from "../../src/revision-preferences.js";
import { getThemeByName } from "../support/pi-theme.js";
import { a, b, bringBack, down, enter, esc, highlightedRow, listRows, loaded, repository, save, search, setup, tab, text } from "../support/preference-panel.js";

afterEach(() => vi.restoreAllMocks());

describe("preference rendering and responsiveness", () => {
  it.each(["dark", "light"])("reserves right-aligned muted source columns by list width through resize (%s)", async (themeName) => {
    const entries = [
      { ...a, name: "Global 中文😀\u001b[31m " + "长名称".repeat(30) },
      { ...b, name: "Project 短" },
    ];
    const f = setup(entries.map(selectPreference), "", themeName, entries); await loaded(f.panel);
    vi.spyOn(f.theme, "bold").mockImplementation((value) => `\x1b[1m${value}\x1b[22m`);
    f.panel.handleInput("s"); // Stable snapshot order, with Global focused.
    // 31/32 straddle the 28-column list threshold. At 80 the preview splits
    // the pane; a short viewport at 100 instead gives the list all 96 columns.
    for (const [width, rows, listWidth, full] of [
      [100, 40, 41, true], [31, 40, 27, false], [32, 40, 28, true],
      [79, 40, 75, true], [80, 24, 32, true], [40, 16, 36, true],
      [20, 10, 16, false], [12, 10, 12, false], [3, 10, 3, false],
      [2, 10, 2, false], [1, 10, 1, false], [100, 10, 96, true], [100, 40, 41, true],
    ] as const) {
      f.terminal.rows = rows;
      const lines = f.panel.render(width);
      const layout = panelLayout(width, rows);
      expect(lines).toHaveLength(layout.height);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      const labels = full ? [" Global", "Project"] : ["G", "P"];
      const sourceRows = lines.filter((line) => labels.some((label) => line.includes(f.theme.fg("muted", label))));
      expect(sourceRows).toHaveLength(2);
      for (const [index, row] of sourceRows.entries()) {
        const label = labels[index]!;
        const plain = stripVTControlCharacters(row);
        expect(row).toContain(f.theme.fg("muted", label));
        expect(row).not.toContain(f.theme.bold(label));
        const sourceStart = row.indexOf(f.theme.fg("muted", label));
        expect(visibleWidth(row.slice(0, sourceStart)) + visibleWidth(label)).toBe(layout.inset + listWidth);
        expect(plain).not.toContain(` · ${label.trim()}`);
      }
      const focused = sourceRows[0]!;
      expect(focused).toContain(f.theme.bg("selectedBg", "").split("\x1b[49m")[0]);
      expect(lines.join("\n")).not.toContain("\u001b[31m");
      if (listWidth >= 12) {
        const budget = listWidth - (full ? 7 : 1) - 1 - 6;
        const name = presentation.sanitizeTerminalText(entries[0]!.name);
        expect(focused).toContain(f.theme.fg("text", f.theme.bold(truncateToWidth(name, budget, "…"))));
        expect(stripVTControlCharacters(focused)).toContain("…");
        expect(stripVTControlCharacters(focused)).toContain("› [x]");
      }
    }
    // Moving focus preserves checkbox selection and keeps the source regular/muted.
    f.panel.handleInput(down);
    const selected = f.panel.render(100).find((line) => stripVTControlCharacters(line).includes("› [x]"))!;
    expect(selected).toContain(f.theme.fg("text", f.theme.bold(entries[1]!.name)));
    expect(selected).toContain(f.theme.fg("muted", "Project"));
    f.panel.handleInput(tab);
    expect(f.panel.render(100).join("\n")).toContain(f.theme.fg("muted", "Project"));
    f.panel.handleInput(bringBack);
    expect(f.close).toHaveBeenCalledWith(entries.map(selectPreference));
  });

  it.each(["dark", "light"])("keeps warnings separate from source labels down to two columns (%s)", async (themeName) => {
    for (const state of ["unavailable", "deleted", "snapshot kept"] as const) {
      const entry = { ...a, name: "Warning 中文😀 " + "long ".repeat(20) };
      const source = state === "deleted" ? [] : [{ ...entry, version: state === "snapshot kept" ? 2 : 1 }];
      const { repo } = repository(source);
      repo.load.mockResolvedValueOnce({ entries: source, errors: state === "unavailable" ? { global: "Offline" } : {} });
      const terminal = { rows: 40, columns: 100 };
      const theme = getThemeByName(themeName)!;
      const panel = new PreferencePanel({ terminal, requestRender: vi.fn() } as unknown as TUI, theme,
        new KeybindingsManager(TUI_KEYBINDINGS), repo, [selectPreference(entry)], "", 16000, vi.fn());
      await loaded(panel); panel.handleInput("s");
      for (const [width, rows] of [[100, 40], [32, 16], [20, 8], [12, 8], [6, 8], [3, 8], [2, 8], [1, 8], [100, 40]]) {
        terminal.rows = rows!;
        const lines = panel.render(width!);
        expect(lines.every((line) => visibleWidth(line) <= width!)).toBe(true);
        const label = width! >= 32 ? " Global" : "G";
        const row = lines.find((line) => line.includes(theme.fg("muted", label)))!;
        expect(row).toBeDefined();
        expect(row).not.toContain(theme.fg("warning", label));
        if (width! > 1) expect(row).toContain(theme.fg("warning", width! >= 12 ? "! " : "!"));
        if (width! <= 3) expect(stripVTControlCharacters(row)).toBe(width === 1 ? "G" : width === 2 ? "!G" : "! G");
      }
      terminal.rows = 40;
      panel.handleInput(enter);
      const details = text(panel);
      expect(details).toContain(`global · ${entry.id}`); // Full source and UUID stay discoverable.
      expect(details).toContain(state === "unavailable" ? "Library unavailable" : state === "deleted" ? "Source deleted" : "Library changed; snapshot kept");
    }
  });

  it.each(["dark", "light"])("keeps concise names, muted scope and semantic snapshot warnings styled through audit/resize (%s)", async (themeName) => {
    const long = { ...a, name: "长名称 😀\u001b[2J ".repeat(10), id: "wide", metadata: {
      kind: "rewrite" as const, activation: "manual" as const, description: "Detailed provenance 中文" } };
    const selected = [selectPreference(long), selectPreference(b)];
    const f = setup(selected, "", themeName, [{ ...long, metadata: { ...long.metadata, description: "Changed metadata only" } }, b]);
    await loaded(f.panel);
    vi.spyOn(f.theme, "bold").mockImplementation((value) => `\x1b[1m${value}\x1b[22m`);
    f.panel.invalidate(); f.panel.handleInput("s"); f.panel.handleInput(down);
    let lines = f.panel.render(70);
    const focused = lines.find((line) => stripVTControlCharacters(line).includes("› [x]"))!;
    expect(focused).toContain(f.theme.fg("text", f.theme.bold(b.name)));
    expect(focused).toContain(f.theme.fg("muted", "Project"));
    expect(focused).not.toContain(f.theme.bold("Project"));
    expect(focused).toContain(f.theme.bg("selectedBg", "").split("\x1b[49m")[0]);
    const warning = lines.find((line) => stripVTControlCharacters(line).includes("!"))!;
    expect(warning).toContain(f.theme.fg("warning", "! "));
    expect(warning).not.toContain("\x1b[1m"); // An unfocused name is never bold.
    expect(warning).not.toContain(" · rewrite"); // Classification belongs in details, not every row.
    expect(warning).not.toContain("\u001b[2J");
    f.panel.handleInput("\x1b[H"); f.panel.handleInput(enter);
    expect(text(f.panel)).toContain("Library changed; snapshot kept");
    expect(text(f.panel)).toContain("Manually selected");
    f.panel.handleInput(esc);
    for (const [width, rows] of [[100, 40], [40, 16], [20, 8], [12, 5], [80, 24], [70, 40]]) {
      f.terminal.rows = rows!;
      lines = f.panel.render(width!);
      expect(lines).toHaveLength(panelLayout(width!, rows!).height);
      expect(lines.every((line) => visibleWidth(line) <= width!)).toBe(true);
      expect(lines.join("\n")).not.toContain("\u001b[2J");
      if (width! >= 40 && rows! >= 16) expect(lines.join("\n")).toContain(formatKeyHint(["s", "All"], f.theme));
      f.panel.handleInput("\x1b[6~"); f.panel.handleInput("\x1b[5~");
    }
    f.panel.handleInput("\x1b[H");
    expect(listRows(f.panel)[0]).toContain("长名称 😀");
    f.panel.handleInput(" ");
    expect(highlightedRow(f.panel)).toContain(b.name);
    f.panel.handleInput(bringBack);
    expect(f.close).toHaveBeenCalledWith([selectPreference(b)]);
  });

  it.each(["dark", "light"])("styles visible actions and footers consistently on all pages (%s)", async (themeName) => {
    const f = setup([], "Extra", themeName); await loaded(f.panel);
    vi.spyOn(f.theme, "bold").mockImplementation((value) => `\x1b[1m${value}\x1b[22m`);
    const check = (...hints: KeyHint[]) => {
      const footer = f.panel.render(100).slice(-2).join("\n");
      for (const hint of hints) {
        expect(footer).toContain(formatKeyHint(hint, f.theme));
        expect(footer).not.toContain(f.theme.bold(hint[1]));
      }
      expect(footer).toContain("\x1b[1m");
    };
    check(["Alt+Enter", "Bring back"], ["Enter", "Read"], ["Esc", "Cancel selection"], ["Space", "Select"]);
    for (const hint of [["n", "Add"], ["e", "Edit"], ["d", "Delete"]] as KeyHint[]) expect(f.panel.render(100).join("\n")).toContain(formatKeyHint(hint, f.theme));
    f.panel.handleInput(enter); check(["↑↓ / PgUp / PgDn", "Scroll"], ["Esc", "Back"]); f.panel.handleInput(esc);
    f.panel.handleInput("n"); check(["Enter", "Next field"], ["Tab / Shift+Tab", "Fields"], ["Esc", "Back"]);
    f.panel.handleInput("Name"); f.panel.handleInput(tab); check(["Enter", "Newline"]);
    f.panel.handleInput(tab); check(["Enter", "Change scope"]);
    f.panel.handleInput(tab); check(["Enter", "Change type"]);
    f.panel.handleInput(tab); check(["Enter", "Next field"]);
    f.panel.handleInput(tab); check(["Enter", "Save to library"]);
    f.panel.handleInput(esc); check(["y", "Discard"], ["n / Esc", "Keep editing"]);
    f.panel.handleInput("y"); f.panel.handleInput("d"); check(["y", "Delete"], ["n / Esc", "Cancel"]);
  });

  it.each(["dark", "light"])("bounds all pages, highlights focus, and retains styled cancel at small sizes (%s)", async (themeName) => {
    const f = setup([], "中文 😀\n".repeat(100), themeName); await loaded(f.panel);
    vi.spyOn(f.theme, "bold").mockImplementation((value) => `\x1b[1m${value}\x1b[22m`);
    const check = () => {
      for (const rows of [5, 8, 16, 40]) for (const width of [1, 12, 20, 40, 80, 100]) {
        f.terminal.rows = rows;
        const lines = f.panel.render(width);
        expect(lines).toHaveLength(panelLayout(width, rows).height);
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      }
      f.terminal.rows = 40;
    };
    check(); f.panel.handleInput(tab); check(); f.panel.handleInput(tab); check();
    expect(f.panel.render(100).join("\n")).toContain(CURSOR_MARKER);
    f.panel.handleInput(enter); f.panel.handleInput(enter); check(); f.panel.handleInput(esc);
    f.panel.handleInput("n"); check(); f.panel.handleInput(tab); check();
    expect(f.panel.render(100).join("\n")).toContain(CURSOR_MARKER);
    f.panel.handleInput("Edited"); f.panel.handleInput(esc); check();
    f.terminal.rows = 8;
    expect(f.panel.render(20).at(-1)).toContain(formatKeyHint(["Esc", "Keep"], f.theme));
  });

  it.each(["dark", "light"])("separates reference headings, metadata and literal bodies (%s)", async (name) => {
    const f = setup([selectPreference(a)], "Extra", name); await loaded(f.panel);
    vi.spyOn(f.theme, "bold").mockImplementation((value) => `\x1b[1m${value}\x1b[22m`);
    f.panel.invalidate();
    const preview = f.panel.render(100).join("\n");
    expect(preview).toContain(f.theme.fg("text", f.theme.bold(a.name)));
    expect(preview).not.toContain(f.theme.fg("muted", `${a.scope} · ${a.id}`));
    expect(preview).toContain(f.theme.fg("text", a.body));
    expect(preview).not.toContain(f.theme.bold(a.body));
    f.panel.handleInput(enter);
    const reading = f.panel.render(100).join("\n");
    expect(reading).toContain(f.theme.fg("muted", `${a.scope} · ${a.id}`));
    expect(reading).toContain(f.theme.fg("text", a.body));
    expect(reading).toContain(f.theme.fg("text", f.theme.bold("Selected snapshot")));
    expect(reading).toContain(f.theme.fg("muted", "Saved snapshot"));
  });

  it.each(["dark", "light"])("keeps load/write/validation failures visible and semantic at short sizes (%s)", async (name) => {
    const f = setup([], "Extra", name); await loaded(f.panel);
    f.panel.handleInput("n"); save(f.panel);
    expect(f.panel.render(100).join("\n")).toContain(f.theme.fg("warning", "⚠ Name must contain 1–120 characters."));
    f.panel.handleInput(tab); f.panel.handleInput("Name");
    f.repo.save.mockRejectedValueOnce(new Error("Write conflict 中文😀")); save(f.panel); await loaded(f.panel);
    for (const rows of [40, 12, 8, 5]) for (const width of [20, 40, 100]) {
      f.terminal.rows = rows; f.terminal.columns = width;
      const lines = f.panel.render(width);
      expect(lines).toHaveLength(panelLayout(width, rows).height);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(stripVTControlCharacters(lines.join("\n"))).toContain("Write conflict");
      expect(lines.join("\n")).toContain(f.theme.fg("error", "⚠ Write conflict 中文😀").split("⚠")[0]);
      if (rows >= 8) expect(lines.at(-1)).toContain(formatKeyHint(["Esc", "Back"], f.theme));
    }
    const failure = setup([], "Extra", name); await loaded(failure.panel);
    failure.library.errors.project = "Permission denied";
    failure.panel.handleInput("n"); failure.panel.handleInput("Saved"); save(failure.panel); await loaded(failure.panel);
    expect(failure.panel.render(100).join("\n")).toContain(failure.theme.fg("error", "⚠ Refresh failed after save; not selected. Permission denied"));
  });

  it.each(["dark", "light"])("marks over-limit requirements without submitting or losing selection (%s)", async (name) => {
    const f = setup([selectPreference(a)], "Extra".repeat(4000), name); await loaded(f.panel);
    const lines = f.panel.render(100);
    const chars = composeRevision([selectPreference(a)], "Extra".repeat(4000)).length;
    expect(lines.join("\n")).toContain(f.theme.fg("warning", `⚠ Too long · ${chars}/16000 chars`));
    f.panel.handleInput(bringBack);
    expect(f.close).toHaveBeenCalledWith([selectPreference(a)]);
    expect(f.repo.save).not.toHaveBeenCalled();
  });

  it("does not repeat library I/O, filtering or long-document layout on focus changes and scrolling", async () => {
    const body = "LONG_LITERAL 中文😀 command\n".repeat(80);
    const entries = Array.from({ length: 500 }, (_, i) => ({ ...a, id: `${i}`, name: `Preference ${i}`, body }));
    const searchSpy = vi.spyOn(preferences, "searchPreferences");
    const sanitize = vi.spyOn(presentation, "sanitizeTerminalText");
    const f = setup([], "Extra", "dark", entries); await loaded(f.panel);
    text(f.panel); searchSpy.mockClear(); sanitize.mockClear();
    const samples: number[] = [];
    for (let i = 0; i < 90; i++) {
      const start = performance.now();
      f.panel.handleInput(tab); text(f.panel);
      samples.push(performance.now() - start);
    }
    expect(searchSpy).not.toHaveBeenCalled();
    expect(sanitize.mock.calls.some(([value]) => value.includes("LONG_LITERAL"))).toBe(false);
    expect(f.repo.load).toHaveBeenCalledTimes(1);
    f.panel.handleInput(enter); text(f.panel); sanitize.mockClear();
    for (let i = 0; i < 20; i++) { f.panel.handleInput(down); text(f.panel); }
    expect(sanitize.mock.calls.some(([value]) => value.includes("LONG_LITERAL"))).toBe(false);
    text(f.panel, 80); expect(sanitize.mock.calls.some(([value]) => value.includes("LONG_LITERAL"))).toBe(true);
    f.panel.handleInput(esc); search(f.panel, "Preference 49"); text(f.panel);
    expect(searchSpy).toHaveBeenCalledTimes(1);
    if (process.env.REFINE_BENCHMARK) {
      samples.sort((a, b) => a - b);
      console.log(`Preferences: 500 entries, 90 focus+render samples: p50=${samples[45]!.toFixed(2)}ms p95=${samples[85]!.toFixed(2)}ms`);
    }
  });

  it("sanitizes external names, literal documents and long notices before styling", async () => {
    const unsafe = "\x1b[2J\x1b]52;c;payload\x07";
    const f = setup([], "Extra", "dark", [{ ...a, name: a.name + unsafe, body: a.body + unsafe }]); await loaded(f.panel);
    for (const output of [text(f.panel), f.panel.render(100).join("\n")]) {
      expect(output).not.toContain("\x1b[2J"); expect(output).not.toContain("\x1b]52");
    }
    const message = "Write failed 中文😀 " + "conflict ".repeat(6) + unsafe;
    f.repo.save.mockRejectedValueOnce(new Error(message));
    f.panel.handleInput("n"); f.panel.handleInput("Name"); save(f.panel); await loaded(f.panel);
    const output = f.panel.render(40).join("\n");
    expect(output).toContain("Write failed"); expect(output).not.toContain("\x1b[2J"); expect(output).not.toContain("\x1b]52");
    const firstLine = wrapTextWithAnsi(presentation.sanitizeTerminalText(message), panelLayout(40, 40).innerWidth)[0]!;
    expect(f.panel.render(40).slice(-2).join("\n")).toContain(f.theme.fg("error", firstLine));
  });
});
