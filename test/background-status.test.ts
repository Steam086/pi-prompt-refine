import { describe, expect, it } from "vitest";
import { BackgroundStatus } from "../src/background-status.js";
import type { RefineRecord } from "../src/history.js";
import { selectHistory } from "../src/context.js";

function record(id: number, status: RefineRecord["status"], extra: Partial<RefineRecord> = {}): RefineRecord {
  return { id, taskId: id, kind: "refine", status, createdAt: 0,
    input: { sessionId: "s", branchLeafId: "leaf", draft: "Private draft", model: { provider: "p", id: "m" },
      history: selectHistory([], 0, 0), systemPrompt: "Private context" }, ...extra };
}

describe("background attention status", () => {
  it("summarizes concurrent requests without exposing prompt, context or usage", () => {
    const status = new BackgroundStatus();
    expect(status.update("s", [record(1, "generating"), record(2, "generating", { archivedAt: 1 }),
      record(3, "queued"), record(4, "generated"), record(5, "error")], false, "ctrl+\\"))
      .toBe("Refine · 2 running · 1 queued · 1 new result · 1 failed · ctrl+\\ Open");
  });

  it("acknowledges completion on viewing, including completion while open, but not unfinished work", () => {
    const status = new BackgroundStatus();
    const records = [record(1, "generated"), record(2, "generating")];
    expect(status.update("s", records, true, "f6")).toBeUndefined();
    expect(status.update("s", records, false, "f6")).toBe("Refine · 1 running · f6 Open");
    records[1]!.status = "error";
    expect(status.update("s", records, false, "f6")).toBe("Refine · 1 failed · f6 Open");
    expect(status.update("s", records, true, "f6")).toBeUndefined();
    records.push(record(3, "generated"));
    expect(status.update("s", records, true, "f6")).toBeUndefined();
    expect(status.update("s", records, false, "f6")).toBeUndefined();
  });

  it("ignores archived/restored results, edits, accepted results and unsent/cancelled work", () => {
    const restored = record(2, "generated"); restored.input.contextUnavailable = true;
    expect(new BackgroundStatus().update("s", [record(1, "generated", { archivedAt: 1 }), restored,
      record(3, "generated", { kind: "edit" }), record(4, "generated", { acceptedAt: 1 }),
      record(5, "generated", { sentAt: 1 }), record(6, "unsent"), record(7, "cancelled")], false, "f6")).toBeUndefined();
  });

  it("drops deleted records and resets acknowledgement when switching sessions", () => {
    const status = new BackgroundStatus();
    expect(status.update("s", [record(1, "error")], false, "f6")).toContain("1 failed");
    expect(status.update("s", [], false, "f6")).toBeUndefined();
    status.update("s", [record(1, "generated")], true, "f6");
    expect(status.update("other", [record(1, "generated")], false, "f6")).toContain("1 new result");
  });
});
