import { visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { alignedHints, panelFrame, panelGeometry, panelTabs, workspaceTabs, WORKSPACE_PAGES } from "../../src/panel-layout.js";
import { getThemeByName } from "../support/pi-theme.js";
import { workspaceHeight, workspaceLayout, workspaceViewport } from "../../src/workspace-overlay.js";

describe("overlay geometry", () => {
  it("uses the terminal budget rather than initial content demand", () => {
    expect(workspaceHeight(60)).toBe(57);
    expect(workspaceLayout(100, 60)).toEqual(workspaceLayout(100, 60));
    expect(workspaceLayout(100, 60).bodyHeight).toBeGreaterThan(40);
    expect(workspaceLayout(100, 80).bodyHeight).toBeGreaterThan(workspaceLayout(100, 60).bodyHeight);
  });

  it("reserves its border, centers a bounded canvas and never allocates negative body rows", () => {
    for (let rows = 1; rows <= 100; rows++) for (const width of [1, 2, 7, 8, 12, 20, 40, 100, 240]) {
      const viewport = workspaceViewport(width, rows);
      const layout = workspaceLayout(width, rows);
      expect(viewport.height).toBeLessThanOrEqual(rows);
      expect(layout.height + (viewport.framed ? 2 : 0)).toBe(viewport.height);
      expect(layout.bodyHeight).toBeGreaterThanOrEqual(1);
      expect(layout.inset + layout.innerWidth).toBeLessThanOrEqual(viewport.width);
      expect(layout.innerWidth).toBeLessThanOrEqual(156);
      expect(layout.topSeparatorHeight).toBe(0);
    }
    expect(workspaceLayout(240, 80).inset).toBeGreaterThan(20);
    expect(workspaceViewport(7, 40).framed).toBe(false);
    expect(workspaceViewport(100, 5).framed).toBe(false);
  });
});

describe("workspace tabs", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(["dark", "light"])("uses arrow-free page identities and all available columns (%s)", (name) => {
    const theme = getThemeByName(name)!;
    vi.spyOn(theme, "bold").mockImplementation((text) => `\x1b[1m${text}\x1b[22m`);
    vi.spyOn(theme, "underline").mockImplementation((text) => `\x1b[4m${text}\x1b[24m`);
    for (const width of [12, 24, 30, 40, 100, 160]) for (const active of WORKSPACE_PAGES) {
      const layout = panelGeometry(width, 40, width, false, false, 0);
      const tabs = workspaceTabs(layout, active, theme);
      const plain = stripVTControlCharacters(tabs.join("\n"));
      expect(plain).not.toMatch(/[←→]/);
      expect(tabs.join("\n")).toContain(theme.bg("selectedBg", theme.fg("text", theme.bold(` ${theme.underline(active)} `))));
      expect(tabs.join("\n")).not.toContain(theme.bg("toolPendingBg", "probe").split("probe")[0]);
      for (const label of WORKSPACE_PAGES.filter((label) => label !== active)) {
        expect(tabs.join("\n")).not.toContain(theme.underline(label));
        if (width >= 30) expect(tabs.join("\n")).toContain(theme.fg("muted", ` ${label} `));
      }
      expect(tabs.every((line) => visibleWidth(line) <= width)).toBe(true);
      if (width >= 30) for (const label of WORKSPACE_PAGES) expect(plain).toContain(label);
      else expect(plain.trim()).toBe(active);
    }
  });

  it.each(["dark", "light"])("leaves child group selection and tab geometry unchanged (%s)", (name) => {
    const theme = getThemeByName(name)!;
    const layout = panelGeometry(100, 40, 100, false, false, 0);
    const groups = panelTabs(layout, ["Context", "Optimizer", "Advanced"], 0, theme);
    expect(groups.join("\n")).toContain(theme.bg("toolPendingBg", theme.fg("text", theme.bold(" Context "))));
    expect(workspaceTabs(layout, "Preview", theme).map(stripVTControlCharacters)).toEqual([
      "", " Preview    Usage    Settings ", "",
    ]);
    for (const height of [1, 4, 8, 12, 40]) {
      const compact = panelGeometry(12, height, 12, false, false, 0);
      const tabs = workspaceTabs(compact, "Settings", theme);
      expect(tabs).toHaveLength(compact.bodyHeight < 4 ? 0 : compact.bodyHeight >= 8 ? 3 : 1);
    }
  });
});

describe("frame action placement", () => {
  it("lifts hints after tabs without changing content capacity or default footer placement", () => {
    const layout = panelGeometry(40, 12, 40, false, false, 0);
    const header = ["Title", "Status"];
    const body = ["Tabs", "", "Original 中文😀", "Result", "Last line"];
    const hints = ["Enter Inspect", "Esc Back"];
    const bottom = panelFrame(layout, header, body, hints, (text) => text);
    const top = panelFrame(layout, header, body, hints, (text) => text, { footerAfterBodyRows: 2 });
    expect(bottom.slice(-2)).toEqual(hints);
    expect(top.slice(0, 7)).toEqual([...header, ...body.slice(0, 2), ...hints, "─".repeat(40)]);
    expect(top.slice(7)).toEqual(bottom.slice(4, -3));
    expect(top).toHaveLength(layout.height);
    expect(top.join("\n")).toContain("Original 中文😀");
    expect(top.join("\n")).toContain("Last line");
  });
});

describe("aligned footer hints", () => {
  it("shares column starts rather than distributing each row independently", () => {
    expect(alignedHints([
      ["r Refine", "m Model", "x Cancel", "Enter won't send"],
      ["q Back", "? Help", "i Input", "→ Settings"],
    ], 96)).toEqual([
      "r Refine · m Model · x Cancel · Enter won't send",
      "q Back   · ? Help  · i Input  · → Settings",
    ]);
  });

  it("measures ANSI and wide text in terminal columns", () => {
    const lines = alignedHints([["\x1b[1m中😀\x1b[22m", "Next"], ["é", "Back"]], 30);
    expect(visibleWidth(lines[0].split(" · ")[0])).toBe(4);
    expect(visibleWidth(lines[1].split(" · ")[0])).toBe(4);
  });

  it.each([1, 8, 16, 20, 36, 76, 96])("omits whole columns without overflow at %i columns", (width) => {
    const lines = alignedHints([["a Accept", "e Edit", "Enter won't send"], ["q Back", "? Help"]], width);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      expect(line).not.toMatch(/ · $/);
    }
    expect(lines).toHaveLength(2);
  });

  it("does not leave separators for missing trailing cells", () => {
    expect(alignedHints([["Accept"], ["Back", "Help"]], 30)).toEqual(["Accept", "Back   · Help"]);
  });
});
