import { describe, expect, it } from "vitest";
import { panelLayout } from "../../src/panel-layout.js";
import { TaskContent } from "../../src/ui/task-content.js";
import { renderTaskDocument } from "../../src/ui/task-documents.js";
import { getThemeByName } from "../support/pi-theme.js";

describe("TaskDocument reading seam", () => {
  it("returns clamped help offsets and matching line ranges without mutating the reading anchor", () => {
    const theme = getThemeByName("dark")!;
    const content = new TaskContent(theme);
    const page = Object.freeze({ kind: "help" as const, scroll: Number.MAX_SAFE_INTEGER });
    const layout = panelLayout(80, 16);
    const options = { notice: "", noticeColor: "muted" as const, inspecting: false, reading: false,
      retainedEarlier: false, usage: false, inline: false, preferences: false, revise: false, deleteRecords: false };
    const result = renderTaskDocument(layout, page, options, theme, content);
    expect(result.scroll).toBeGreaterThan(0);
    expect(result.scroll).toBeLessThan(page.scroll);
    const end = result.scroll + result.viewport;
    expect(result.lines.join("\n")).toContain(`${result.scroll + 1}–${end} / ${end} lines`);
    expect(page.scroll).toBe(Number.MAX_SAFE_INTEGER);
    expect(renderTaskDocument(layout, { ...page, scroll: result.scroll }, options, theme, content)).toEqual(result);
  });
});
