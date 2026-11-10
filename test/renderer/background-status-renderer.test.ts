import { TuiAltScreen, TuiMainScreen, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { renderBackgroundStatus, type BackgroundSummary } from "../../src/background-status.js";
import { getThemeByName } from "../support/pi-theme.js";
import { createRecordingTerminal } from "../support/recording-terminal.js";

// Real renderer I/O, not a claim about physical-terminal appearance or IME behavior.
describe.each(["regular", "fullscreen"])("background banner terminal rendering (%s)", (mode) => {
  it.each(["dark", "light"])("refreshes and resizes one non-focusing line in %s", (name) => {
    vi.useFakeTimers();
    const size = { rows: 8, columns: 100 };
    const { terminal, writes, input } = createRecordingTerminal(size);
    const tui = mode === "regular" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
    const colors = getThemeByName(name)!;
    const theme = { fg: colors.fg.bind(colors), bold: (value: string) => `\x1b[1m${value}\x1b[22m` };
    let status: BackgroundSummary = { running: 3, queued: 2, newResults: 1, failed: 1, elapsedSeconds: 42, openHint: "ctrl+\\" };
    const widget = { render: (width: number) => renderBackgroundStatus(status, width, theme), invalidate() {} };
    let draft = "Draft ";
    const editor = {
      focused: false, invalidate() {},
      render: (width: number) => [truncateToWidth(draft, width, "")],
      handleInput: (data: string) => { draft += data; tui.requestRender(); },
    };
    tui.addChild(widget);
    tui.addChild(editor);
    tui.setFocus(editor);
    try {
      tui.start();
      tui.renderNow();
      const initialRedraws = tui.fullRedraws;
      const output = writes.join("");
      expect(output).toContain(theme.fg("accent", "3 running"));
      expect(output).toContain(theme.fg("muted", "2 queued"));
      expect(output).toContain(theme.fg("success", "1 new"));
      expect(output).toContain(theme.fg("error", "1 failed"));
      expect(output).toContain(theme.fg("text", theme.bold("ctrl+\\")));
      input("中文😀");
      tui.renderNow();
      expect(draft).toBe("Draft 中文😀");
      writes.length = 0;
      for (const next of [
        { ...status, elapsedSeconds: 43 },
        { ...status, running: 1, queued: 0, newResults: 3, elapsedSeconds: 9 },
        { ...status, running: 0, queued: 0, newResults: 1, failed: 0, elapsedSeconds: 7 },
        { ...status, running: 0, queued: 0, newResults: 3, failed: 0, elapsedSeconds: undefined },
      ]) {
        status = next;
        tui.requestRender(); tui.renderNow();
        expect(widget.render(terminal.columns)).toHaveLength(1);
        expect(editor.focused).toBe(true);
      }
      expect(tui.fullRedraws).toBe(initialRedraws);
      expect(writes.join("")).not.toMatch(/\x1b\[(?:2J|3J|\?1049[hl])/);
      expect(writes.join("")).toContain(theme.fg("muted", " 7s"));
      expect(stripVTControlCharacters(widget.render(100)[0]!)).not.toMatch(/\d+s/);

      status = { running: 3, queued: 2, newResults: 1, failed: 1, elapsedSeconds: 42, openHint: "ctrl+\\" };
      for (const [columns, rows] of [[20, 3], [40, 6], [100, 10], [20, 3], [100, 8]] as const) {
        size.columns = columns; size.rows = rows;
        tui.requestRender(); tui.renderNow();
        const lines = widget.render(terminal.columns);
        expect(lines).toHaveLength(1);
        expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(terminal.columns);
        expect(stripVTControlCharacters(lines[0]!)).toContain("ctrl+\\ Open");
        expect(stripVTControlCharacters(lines[0]!)).toContain(terminal.columns === 100 ? "3 running 42s" : "3 run");
        const before = [...lines];
        tui.setFocus(widget); tui.renderNow();
        tui.setFocus(editor); tui.renderNow();
        expect(widget.render(terminal.columns)).toEqual(before);
        expect(draft).toBe("Draft 中文😀");
      }
      expect(writes.length).toBeGreaterThan(0);
    } finally {
      tui.stop();
      vi.useRealTimers();
    }
  });
});
