import { visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { panelGeometry, panelHeader, panelTabs, workspaceTabs, WORKSPACE_PAGES } from "../../src/panel-layout.js";
import { getThemeByName } from "../support/pi-theme.js";
import { workspaceHeight, workspaceLayout, workspaceViewport } from "../../src/workspace-overlay.js";

describe("overlay geometry", () => {
  it("uses the terminal budget rather than initial content demand", () => {
    expect(workspaceHeight(60)).toBe(45);
    expect(workspaceHeight(23)).toBe(17);
    expect(workspaceHeight(1)).toBe(1);
    expect(workspaceLayout(100, 60).height).toBe(43);
    expect(workspaceLayout(100, 60).bodyHeight).toBe(38);
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
      expect(tabs.join("\n")).toContain(theme.bg("selectedBg", theme.fg("text", theme.bold(` ${active} `))));
      expect(tabs.join("\n")).not.toContain(theme.bg("toolPendingBg", "probe").split("probe")[0]);
      for (const label of WORKSPACE_PAGES.filter((label) => label !== active)) {
        expect(tabs.join("\n")).not.toContain(theme.underline(label));
        if (width >= 48) expect(tabs.join("\n")).toContain(theme.fg("muted", ` ${label} `));
      }
      expect(tabs.every((line) => visibleWidth(line) <= width)).toBe(true);
      if (width >= 48) for (const label of WORKSPACE_PAGES) expect(plain).toContain(label);
      else expect(plain.trim()).toBe(active);
    }
  });

  it.each(["dark", "light"])("shares flat one-row tabs between pages and groups (%s)", (name) => {
    const theme = getThemeByName(name)!;
    const layout = panelGeometry(100, 40, 100, false, false, 0);
    const groups = panelTabs(layout, ["Context", "Optimizer", "Advanced"], 0, theme);
    expect(groups.join("\n")).toContain(theme.bg("selectedBg", theme.fg("text", theme.bold(" Context "))));
    expect(workspaceTabs(layout, "Preview", theme).map(stripVTControlCharacters)).toEqual([
      " Preview    Usage    Settings ",
    ]);
    for (const height of [1, 4, 8, 12, 40]) {
      const compact = panelGeometry(12, height, 12, false, false, 0);
      const tabs = workspaceTabs(compact, "Settings", theme);
      expect(tabs).toHaveLength(compact.bodyHeight < 4 ? 0 : 1);
    }
  });
});

describe("frame action placement", () => {
  it("keeps child page shortcuts at the bottom when status wraps onto its own row", () => {
    const layout = panelGeometry(36, 12, 36, false, false, 0);
    const title = "Edit original prompt";
    const actions = "Esc Back · Enter Save";
    const render = (status: string) =>
      panelHeader(layout, [title, status], [], actions).render(["Draft"], (line) => line);
    for (const status of ["", "Line 1", "The prompt exceeds the character limit."]) {
      const lines = render(status);
      const divider = lines.findIndex((line) => /^─+$/.test(line));
      expect(lines.slice(0, divider).join(" ")).not.toContain("Esc");
      expect(lines[divider + 1]).toBe("Draft");
      expect(lines.at(-1)).toBe(actions);
      expect(lines).toHaveLength(layout.height);
    }
  });

  it("keeps tabbed headlines to two rows and fixes action columns below the content", () => {
    const layout = panelGeometry(40, 12, 40, false, false, 0);
    const body = ["Original 中文😀", "Result", "Last line"];
    const first = panelHeader(layout, ["Title", "Status"], [" Tabs "], "Esc Back · Enter Inspect");
    const next = panelHeader(layout, ["Title", ""], [" Tabs "], "Esc Back · Enter Select");
    const before = first.render(body, (text) => text);
    const after = next.render(body, (text) => text);
    expect(first.layout.headerHeight).toBe(2);
    expect(next.layout.bodyHeight).toBe(first.layout.bodyHeight);
    expect(before.slice(2, -1)).toEqual(["─".repeat(40), ...after.slice(3, -1)]);
    expect(before[3]).toBe(body[0]);
    expect(before.at(-1)).toBe("Esc Back · Enter Inspect");
    expect(after.at(-1)).toBe("Esc Back · Enter Select");
    expect(before).toHaveLength(layout.height);
  });
});
