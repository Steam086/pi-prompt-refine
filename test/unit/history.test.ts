import { describe, expect, it } from "vitest";
import { selectHistory } from "../../src/context.js";
import type { RefineRequestInput } from "../../src/controller.js";
import { RefineHistory, type RefineRecord } from "../../src/history.js";

const input: RefineRequestInput = {
  draft: "Original 原文😀", model: { provider: "provider", id: "model" }, sessionId: "session", branchLeafId: "leaf",
  history: selectHistory([], 12, 100), systemPrompt: "Policy", roundId: 1,
};
function record(id: number): RefineRecord {
  return { id, taskId: id, kind: "refine", createdAt: 1, input, status: "generated", usage: { totalTokens: 12 },
    candidate: { ...input, requestId: id, version: id, generation: 0, recordId: id, text: `Result ${id}\n` + "正文 中文😀\n".repeat(100) } };
}
describe("runtime request journal", () => {
  it("bounds records, freezes snapshots and isolates sessions", () => {
    const history = new RefineHistory(2);
    const mutable = structuredClone(input);
    const first = history.start(1, mutable);
    mutable.draft = "Changed";
    expect(history.list("session")[0]?.input.draft).toBe(input.draft);
    history.captureInput(first, "Exact packet");
    const candidate = record(1).candidate!;
    history.update(first, { status: "generated", candidate, acceptedAt: 10 });
    candidate.text = "Changed externally";
    expect(history.list("session")[0]?.candidate?.text).toContain("Result 1");
    expect(history.list("session")[0]?.input.preparedInput).toBe("Exact packet");
    history.start(2, input);
    history.start(3, { ...input, sessionId: "other" });
    expect(history.list("session").map((record) => record.taskId)).toEqual([2]);
    expect(history.list("other")).toHaveLength(1);
  });
  it("projects detached task rows without copying frozen request background", () => {
    const history = new RefineHistory();
    const source = record(1);
    history.restore([source, { ...record(2), input: { ...input, sessionId: "other" } }]);
    history.captureInput(1, "Prepared packet", { referencedDirectoryCount: 2, warnings: ["Directory limit reached"] });
    const rows = history.listForDisplay("session");
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.input.draft).toBe(source.input.draft);
    expect(row.candidate).toEqual({ text: source.candidate!.text });
    expect(row.input.projectDiagnostics?.warnings).toEqual(["Directory limit reached"]);
    expect(row).not.toHaveProperty("originalInput");
    for (const key of ["systemPrompt", "preparedInput", "history"]) expect(row.input).not.toHaveProperty(key);
    row.input.model.id = "changed";
    row.input.projectDiagnostics!.warnings.pop();
    row.usage!.totalTokens = 0;
    expect(history.get(1, "session")).toMatchObject({ input: { model: input.model, preparedInput: "Prepared packet",
      projectDiagnostics: { warnings: ["Directory limit reached"] } }, usage: source.usage });
  });
  it("reuses immutable display rows until the corresponding visible record changes", () => {
    const history = new RefineHistory(3);
    history.restore([record(1), { ...record(2), status: "unsent", candidate: undefined }]);
    const before = history.displaySnapshot("session");
    expect(history.displaySnapshot("session")).toBe(before);
    expect(Object.isFrozen(before)).toBe(true);
    expect(Object.isFrozen(before[0]!.input.model)).toBe(true);
    history.captureInput(1, "Updated packet");
    expect(history.displaySnapshot("session")).toBe(before);

    history.captureInput(1, "Updated packet", { referencedDirectoryCount: 1, warnings: ["Context warning"] });
    const withWarning = history.displaySnapshot("session");
    expect(withWarning[0]).not.toBe(before[0]);
    expect(withWarning[0]!.input.projectDiagnostics?.warnings).toEqual(["Context warning"]);
    expect(withWarning[1]).toBe(before[1]);

    history.setModel(2, { provider: "other", id: "model" }, "high");
    const withModel = history.displaySnapshot("session");
    expect(withModel[0]).toBe(withWarning[0]);
    expect(withModel[1]!.input.model.provider).toBe("other");
    expect(before[1]!.input.model.provider).toBe("provider");
    expect(history.displaySnapshot("other")).toEqual([]);

    history.removeDraft(2);
    expect(history.displaySnapshot("session")).toEqual([withModel[0]]);
    history.restore([record(1)]);
    expect(history.displaySnapshot("session")[0]).not.toBe(withModel[0]);
  });
  it("never evicts unsent, queued or running work and archives only the matching round/session", () => {
    const history = new RefineHistory(3);
    history.start(1, input, undefined, "refine", "unsent");
    history.start(2, { ...input, roundId: 2 }, undefined, "refine", "queued");
    history.start(3, { ...input, sessionId: "other" });
    expect(history.canStart()).toBe(false);
    expect(() => history.start(4, input)).toThrow("full");
    history.archive("session", 1);
    expect(history.list("session").map((r) => r.archivedAt !== undefined)).toEqual([true, false]);
    expect(history.list("other")[0]?.archivedAt).toBeUndefined();
  });
});

describe("original snapshots", () => {
  it("retains the original packet when bounded history evicts the first call", () => {
    const history = new RefineHistory(2);
    const first = history.start(1, input);
    history.captureInput(first, "Original packet");
    history.update(first, { status: "generated" });
    const revised = history.start(1, { ...input, revision: { previousCandidate: "Output", instruction: "Shorter" } }, first);
    history.captureInput(revised, "Revision packet");
    history.update(revised, { status: "generated" });
    history.start(2, input);
    const retained = history.get(revised, "session")!;
    expect(history.get(first, "session")).toBeUndefined();
    expect(retained.input.preparedInput).toBe("Revision packet");
    expect(retained.originalInput?.preparedInput).toBe("Original packet");
    expect(retained.originalInput?.revision).toBeUndefined();
  });
});
