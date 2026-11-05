import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { BackgroundStatus, renderBackgroundStatus, type BackgroundSummary } from "../src/background-status.js";
import type { RefineRecord } from "../src/history.js";
import { selectHistory } from "../src/context.js";
import { formatKeyHint } from "../src/key-hints.js";

function record(id: number, status: RefineRecord["status"], extra: Partial<RefineRecord> = {}): RefineRecord {
  return { id, taskId: id, kind: "refine", status, createdAt: 0,
    input: { sessionId: "s", branchLeafId: "leaf", draft: "Private draft", model: { provider: "p", id: "m" },
      history: selectHistory([], 0, 0), systemPrompt: "Private context" }, ...extra };
}

function summary(extra: Partial<BackgroundSummary> = {}): BackgroundSummary {
  return { running: 0, queued: 0, newResults: 0, failed: 0, elapsedSeconds: undefined, openHint: "ctrl+\\", ...extra };
}

const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const text = (status: BackgroundSummary, width = 100) => renderBackgroundStatus(status, width, plainTheme)[0]!.trim();

describe("background attention status", () => {
  it("summarizes concurrent requests without exposing prompt, context or usage", () => {
    const status = new BackgroundStatus();
    const result = status.update("s", [record(1, "generating", { elapsedSeconds: 5 }),
      record(2, "generating", { archivedAt: 1, elapsedSeconds: 42 }),
      record(3, "queued", { elapsedSeconds: 100 }), record(4, "generated", { elapsedSeconds: 90 }),
      record(5, "error", { elapsedSeconds: 60 })], false, "ctrl+\\");
    expect(result).toEqual(summary({ running: 2, queued: 1, newResults: 1, failed: 1, elapsedSeconds: 42 }));
    expect(text(result!)).toBe("Refine · 2 running 42s · 1 queued · 1 new · 1 failed · ctrl+\\ Open");
  });

  it("takes the maximum running duration regardless of record order and never rotates", () => {
    const records = [record(1, "generating", { elapsedSeconds: 12 }), record(2, "generating", { elapsedSeconds: 7 }),
      record(3, "generating", { elapsedSeconds: 25 })];
    const status = new BackgroundStatus();
    for (const ordered of [records, [...records].reverse(), records, [records[1]!, records[2]!, records[0]!]]) {
      expect(status.update("s", ordered, false, "ctrl+\\")).toEqual(summary({ running: 3, elapsedSeconds: 25 }));
    }
    records[2]!.status = "generated";
    expect(status.update("s", records, false, "ctrl+\\")).toEqual(summary({ running: 2, newResults: 1, elapsedSeconds: 12 }));
  });

  it("shows the sole unseen result's final duration, including alongside queued or failed requests", () => {
    const records = [record(1, "generated", { elapsedSeconds: 7 }), record(2, "queued", { elapsedSeconds: 200 }),
      record(3, "error", { elapsedSeconds: 60 })];
    const status = new BackgroundStatus();
    expect(status.update("s", records, false, "ctrl+\\")).toEqual(summary({ queued: 1, newResults: 1, failed: 1, elapsedSeconds: 7 }));
    records.push(record(4, "generated", { elapsedSeconds: 30 }));
    expect(status.update("s", records, false, "ctrl+\\")).toEqual(summary({ queued: 1, newResults: 2, failed: 1 }));
  });

  it("does not infer running time from creation, queue, completed or failed records", () => {
    const status = new BackgroundStatus();
    const result = status.update("s", [record(1, "generating", { createdAt: 0 }), record(2, "queued", { elapsedSeconds: 200 }),
      record(3, "generated", { elapsedSeconds: 70 }), record(4, "error", { elapsedSeconds: 60 })], false, "ctrl+\\");
    expect(result).toEqual(summary({ running: 1, queued: 1, newResults: 1, failed: 1 }));
    expect(status.update("s", [record(2, "queued", { elapsedSeconds: 200 }), record(4, "error", { elapsedSeconds: 60 })], false, "ctrl+\\"))
      .toEqual(summary({ queued: 1, failed: 1 }));
  });

  it.each([0, undefined, -1, NaN, Infinity])("keeps zero valid but omits unknown or invalid duration %s", (elapsedSeconds) => {
    for (const phase of ["generating", "generated"] as const) {
      expect(new BackgroundStatus().update("s", [record(1, phase, { elapsedSeconds })], false, "ctrl+\\"))
        .toEqual(summary({ [phase === "generating" ? "running" : "newResults"]: 1, elapsedSeconds: elapsedSeconds === 0 ? 0 : undefined }));
    }
  });

  it("acknowledges completion on viewing, including completion while open, but not unfinished work", () => {
    const status = new BackgroundStatus();
    const records = [record(1, "generated", { elapsedSeconds: 10 }), record(2, "generating", { elapsedSeconds: 2 })];
    expect(status.update("s", records, true, "ctrl+\\")).toBeUndefined();
    expect(status.update("s", records, false, "ctrl+\\")).toEqual(summary({ running: 1, elapsedSeconds: 2 }));
    records[1]!.status = "error";
    expect(status.update("s", records, false, "ctrl+\\")).toEqual(summary({ failed: 1 }));
    expect(status.update("s", records, true, "ctrl+\\")).toBeUndefined();
    records.push(record(3, "generated"));
    expect(status.update("s", records, true, "ctrl+\\")).toBeUndefined();
    expect(status.update("s", records, false, "ctrl+\\")).toBeUndefined();
    records.push(record(4, "generated", { elapsedSeconds: 7 }));
    expect(status.update("s", records, false, "ctrl+\\")).toEqual(summary({ newResults: 1, elapsedSeconds: 7 }));
  });

  it("ignores archived/restored results, edits, accepted results and unsent/cancelled work", () => {
    const restored = record(2, "generated"); restored.input.contextUnavailable = true;
    expect(new BackgroundStatus().update("s", [record(1, "generated", { archivedAt: 1 }), restored,
      record(3, "generated", { kind: "edit" }), record(4, "generated", { acceptedAt: 1 }),
      record(5, "generated", { sentAt: 1 }), record(6, "unsent"), record(7, "cancelled")], false, "ctrl+\\")).toBeUndefined();
  });

  it("drops deleted records and resets acknowledgement when switching sessions", () => {
    const status = new BackgroundStatus();
    expect(status.update("s", [record(1, "error")], false, "ctrl+\\")).toEqual(summary({ failed: 1 }));
    expect(status.update("s", [], false, "ctrl+\\")).toBeUndefined();
    status.update("s", [record(1, "generated")], true, "ctrl+\\");
    expect(status.update("other", [record(1, "generated")], false, "ctrl+\\")).toEqual(summary({ newResults: 1 }));
  });
});

describe.each(["dark", "light"])("background banner (%s)", (name) => {
  const colors = getThemeByName(name)!;
  // Chalk disables weight in a non-TTY process; retain real SGR boundaries here.
  const theme = { fg: colors.fg.bind(colors), bold: (value: string) => `\x1b[1m${value}\x1b[22m` };
  const mixed = summary({ running: 3, queued: 2, newResults: 1, failed: 1, elapsedSeconds: 42 });
  const render = (status: BackgroundSummary, width = 100) => renderBackgroundStatus(status, width, theme);
  const plain = (status: BackgroundSummary, width = 100) => stripVTControlCharacters(render(status, width)[0]!).trim();

  it("uses semantic state colors and neutral bold branding/keys, not bold states", () => {
    const line = render(mixed)[0]!;
    for (const part of [theme.fg("text", theme.bold("Refine")), theme.fg("accent", "3 running"), theme.fg("accent", " 42s"),
      theme.fg("muted", "2 queued"), theme.fg("success", "1 new"), theme.fg("error", "1 failed"),
      theme.fg("muted", " · "), formatKeyHint(["ctrl+\\", "Open"], theme)]) expect(line).toContain(part);
    expect(line).not.toContain(theme.bold("3 running"));
    expect(plain(mixed)).toBe("Refine · 3 running 42s · 2 queued · 1 new · 1 failed · ctrl+\\ Open");
    expect(line).not.toMatch(/oldest|took|Private|Usage/);
  });

  it("mutes completed duration and renders a real zero instead of treating it as unknown", () => {
    const result = summary({ newResults: 1, elapsedSeconds: 7 });
    const line = render(result)[0]!;
    expect(line).toContain(theme.fg("success", "1 new") + theme.fg("muted", " 7s"));
    expect(plain(summary({ running: 1, elapsedSeconds: 0 }))).toContain("1 running 0s");
    expect(plain(summary({ newResults: 1, elapsedSeconds: 0 }))).toContain("1 new 0s");
    expect(plain(summary({ newResults: 2 }))).toBe("Refine · 2 new · ctrl+\\ Open");
    expect(plain(summary({ queued: 2 }))).toBe("Refine · 2 queued · ctrl+\\ Open");
  });

  it("drops time before branding or any status counts, then compacts whole labels", () => {
    expect(plain(mixed, 66)).toContain("3 running 42s");
    expect(plain(mixed, 65)).toBe("Refine · 3 running · 2 queued · 1 new · 1 failed · ctrl+\\ Open");
    expect(plain(mixed, 61)).toBe("3 running · 2 queued · 1 new · 1 failed · ctrl+\\ Open");
    expect(plain(mixed, 52)).toBe("3 run · 2 queue · 1 new · 1 fail · ctrl+\\ Open");
    const short = summary({ newResults: 1, elapsedSeconds: 777 });
    expect(plain(short, 30)).toBe("Refine · 1 new · ctrl+\\ Open");
  });

  it("preserves the primary state and open entry instead of truncating the right end", () => {
    expect(plain(mixed, 45)).toBe("3 run · 1 new · 1 fail · ctrl+\\ Open");
    expect(plain(mixed, 35)).toBe("3 run · 1 fail · ctrl+\\ Open");
    expect(plain(mixed, 20)).toBe("3 run · ctrl+\\ Open");
    expect(render(mixed, 20)[0]).toContain(theme.fg("accent", "3 run"));
    expect(render(mixed, 20)[0]).toContain(formatKeyHint(["ctrl+\\", "Open"], theme));
    expect(plain(summary({ queued: 2, newResults: 1, failed: 1 }), 20)).toBe("1 fail · ctrl+\\ Open");
    expect(plain(summary({ queued: 2 }), 20)).toBe("2 queue ctrl+\\ Open");
    expect(plain(mixed, 14)).toBe("3 run · ctrl+\\");
    expect(render(mixed, 14)[0]).toContain(formatKeyHint(["ctrl+\\", ""], theme));
    expect(plain(mixed, 12)).toBe("3 run ctrl+\\");
  });

  it("bounds a single line, sanitizes external text before styling and restores detail after resize", () => {
    const key = "中文😀\x1b[31m\nctrl+\\";
    const status = { ...mixed, openHint: key };
    const wide = render(status, 200);
    expect(wide[0]).toContain(formatKeyHint(["中文😀�[31m ctrl+\\", "Open"], theme));
    expect(stripVTControlCharacters(wide[0]!)).toContain("中文😀�[31m ctrl+\\ Open");
    for (let width = 1; width <= 110; width++) {
      const lines = render(status, width);
      expect(lines).toHaveLength(1);
      expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(Math.min(width, 100));
      expect(lines[0]).not.toContain("\n");
    }
    expect(render(status, 200)).toEqual(wide);
    expect(render(status, 0)).toEqual([]);
    expect(render(status, -1)).toEqual([]);
  });
});
