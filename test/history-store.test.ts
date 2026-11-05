import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeHistory, encodeHistory, HISTORY_MAX_BYTES, HistoryStore } from "../src/history-store.js";
import type { RefineRecord } from "../src/history.js";
import { RefineController } from "../src/controller.js";
import { selectHistory } from "../src/context.js";

function record(id = 1): RefineRecord {
  const input = { draft: "Original 中文", model: { provider: "provider", id: "model" }, thinkingLevel: "high" as const,
    roundId: 3, sessionId: "s", branchLeafId: "private-leaf", systemPrompt: "private-policy",
    history: { ...selectHistory([], 1, 100), text: "private-conversation" },
    preparedInput: "private-payload", sentInput: "private-sent", projectDiagnostics: { warnings: ["private-diagnostic"], referencedDirectoryCount: 1 } };
  return { id, taskId: id, kind: "refine", input, originalInput: input, status: "generated", createdAt: 123,
    acceptedAt: 456, elapsedSeconds: 7, usage: { input: 100, cacheRead: 200, cacheWrite: 0, output: 20, cost: { total: 0.012 }, subscription: true },
    candidate: { ...input, recordId: id, requestId: id, version: 1, generation: 1, text: "Result", title: "private-title" } };
}
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "refine-history-")); dirs.push(dir);
  const path = join(dir, "session.jsonl.prompt-refine.json");
  const warn = vi.fn();
  const changed = vi.fn();
  return { dir, path, warn, changed, store: new HistoryStore(path, "s", warn, changed) };
}

describe("minimal history persistence", () => {
  it("round-trips only the whitelist, never full input/candidate snapshots", () => {
    const source = record();
    const { content } = encodeHistory([source], "s");
    expect(content).not.toContain("private-");
    expect(content).not.toContain("systemPrompt");
    expect(content).not.toContain("preparedInput");
    const [restored] = decodeHistory(content, "s");
    expect(restored).toMatchObject({ id: 1, taskId: 1, acceptedAt: 456, archivedAt: 123, usage: source.usage,
      input: { draft: "Original 中文", contextUnavailable: true, systemPrompt: "", branchLeafId: null }, candidate: { text: "Result", contextUnavailable: true } });
    expect(source.input).not.toHaveProperty("contextUnavailable");
  });

  it("retains revision instruction and parent identity, but not previousCandidate/context", () => {
    const source = record(2);
    source.kind = "revise"; source.parentId = 1;
    source.input.revision = { instruction: "Shorter", previousCandidate: "private-previous" };
    const { content } = encodeHistory([source], "s");
    expect(content).not.toContain("private-");
    expect(decodeHistory(content, "s")[0]).toMatchObject({ parentId: 1, kind: "revise", input: { revision: { instruction: "Shorter" } } });
  });

  it("excludes unsubmitted drafts and other sessions; restores unfinished calls as interrupted", () => {
    const unsent = { ...record(), status: "unsent" as const };
    const pending = { ...record(2), status: "generating" as const, candidate: undefined, elapsedSeconds: 20 };
    const other = record(3); other.input.sessionId = "other";
    const restored = decodeHistory(encodeHistory([unsent, pending, other], "s").content, "s");
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ id: 2, status: "interrupted", input: { contextUnavailable: true } });
    expect(restored[0]!.candidate).toBeUndefined();
    expect(restored[0]!.elapsedSeconds).toBeUndefined();
  });

  it("bounds count and UTF-8 bytes without truncating usable text", () => {
    const records = Array.from({ length: 110 }, (_, i) => record(i + 1));
    expect(decodeHistory(encodeHistory(records, "s").content, "s").map((r) => r.id)).toEqual(records.slice(-100).map((r) => r.id));
    records.forEach((r) => { r.candidate!.text = "中".repeat(100_000); });
    const { content, omitted } = encodeHistory(records, "s");
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(HISTORY_MAX_BYTES);
    expect(omitted).toBeGreaterThan(100);
    const restored = decodeHistory(content, "s");
    expect(restored.at(-1)!.id).toBe(110);
    expect(restored.every((r) => r.candidate!.text.length === 100_000)).toBe(true);
  });

  it("rejects wrong ownership/version, duplicate IDs and malformed values", () => {
    const data = JSON.parse(encodeHistory([record()], "s").content);
    expect(() => decodeHistory(JSON.stringify(data), "other")).toThrow();
    for (const changed of [{ ...data, version: 2 }, { ...data, records: [...data.records, ...data.records] },
      { ...data, records: [{ ...data.records[0], model: null }] }, { ...data, records: [{ ...data.records[0], result: 42 }] }]) {
      expect(() => decodeHistory(JSON.stringify(changed), "s")).toThrow();
    }
    data.records[0].systemPrompt = "private-injected";
    expect(JSON.stringify(decodeHistory(JSON.stringify(data), "s"))).not.toContain("private-injected");
  });

  it("writes atomic private snapshots, coalesces changes and pauses after clear", async () => {
    const { store, path, dir, warn } = await fixture();
    expect(await store.load()).toEqual([]);
    const source = record();
    store.save([source]);
    source.candidate!.text = "Latest result";
    store.save([source]);
    await store.flush();
    expect(decodeHistory(await readFile(path, "utf8"), "s")[0]!.candidate!.text).toBe("Latest result");
    const reverted = structuredClone(source);
    source.candidate!.text = "Temporary change";
    store.save([source]); store.save([reverted]);
    await store.flush();
    expect(decodeHistory(await readFile(path, "utf8"), "s")[0]!.candidate!.text).toBe("Latest result");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    store.save([record(2)]);
    await store.clear();
    store.save([record(3)]);
    await store.flush();
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps corrupt/oversized files intact and refuses symlinks", async () => {
    const { path, store, warn, dir } = await fixture();
    await writeFile(path, "broken JSON");
    expect(await store.load()).toEqual([]);
    store.save([record()]); await store.flush();
    expect(await readFile(path, "utf8")).toBe("broken JSON");
    expect(warn).toHaveBeenCalledTimes(1);
    await store.clear();
    await writeFile(path, " ".repeat(HISTORY_MAX_BYTES + 1));
    expect(await new HistoryStore(path, "s", warn).load()).toEqual([]);
    await rm(path);
    const target = join(dir, "target"); await writeFile(target, "keep"); await symlink(target, path);
    expect(await new HistoryStore(path, "s", warn).load()).toEqual([]);
    const writer = new HistoryStore(path, "s", warn);
    writer.save([record()]); await writer.flush();
    expect(await readFile(target, "utf8")).toBe("keep");
  });

  it("does not create files for empty or unsent-only sessions", async () => {
    const { store, path } = await fixture();
    store.save([]); store.save([{ ...record(), status: "unsent" }]); await store.flush();
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports empty, pending, saved and changed versions without mistaking IDs for persisted state", async () => {
    const { store, path, changed } = await fixture();
    await store.load();
    const source = record();
    const unsent = { ...record(2), status: "unsent" as const };
    const other = record(3); other.input.sessionId = "other";
    const records = [source, unsent, other];
    expect(store.getStatus(records)).toEqual({ state: "empty", path, savedIds: [], memoryOnlyIds: [1], omittedIds: [] });
    store.save(records);
    expect(store.getStatus(records)).toMatchObject({ state: "saving", savedIds: [], memoryOnlyIds: [1] });
    await store.flush();
    expect(store.getStatus(records)).toEqual({ state: "saved", path, savedIds: [1], memoryOnlyIds: [], omittedIds: [] });
    source.candidate!.text = "New result version"; source.sentAt = 789;
    expect(store.getStatus(records)).toMatchObject({ state: "saved", savedIds: [1], memoryOnlyIds: [1] });
    store.save(records);
    expect(store.getStatus(records).state).toBe("saving");
    await store.flush();
    expect(store.getStatus(records).memoryOnlyIds).toEqual([]);
    const reloaded = new HistoryStore(path, "s", vi.fn());
    await reloaded.load();
    expect(reloaded.getStatus(records)).toMatchObject({ state: "saved", savedIds: [1], memoryOnlyIds: [] });
    await store.clear();
    store.save(records);
    expect(store.getStatus(records)).toEqual({ state: "cleared", path, savedIds: [], memoryOnlyIds: [1], omittedIds: [] });
    expect(changed).toHaveBeenCalled();
  });

  it("keeps load/write/clear failures queryable after their notification", async () => {
    const { store, path, warn } = await fixture();
    await writeFile(path, "invalid history"); await store.load();
    expect(store.getStatus([record()])).toMatchObject({ state: "load-error", savedIds: [], memoryOnlyIds: [1] });
    await store.clear();
    await mkdir(path);
    const writer = new HistoryStore(path, "s", warn);
    writer.save([record()]); await writer.flush();
    expect(writer.getStatus([record()])).toMatchObject({ state: "save-error", path, savedIds: [], memoryOnlyIds: [1] });
    writer.save([record(2)]);
    expect(writer.getStatus([record(2)]).state).toBe("save-error");
    await expect(writer.clear()).rejects.toThrow();
    expect(writer.getStatus([record()]).state).toBe("clear-error");
  });

  it("identifies exact capacity omissions without treating them as saved", async () => {
    const { store, path } = await fixture();
    const records = Array.from({ length: 9 }, (_, index) => record(index + 1));
    records.forEach((item) => { item.candidate!.text = "中".repeat(100_000); });
    store.save(records); await store.flush();
    const saved = decodeHistory(await readFile(path, "utf8"), "s").map((item) => item.id);
    const omitted = records.map((item) => item.id).filter((id) => !saved.includes(id));
    expect(omitted.length).toBeGreaterThan(0);
    expect(store.getStatus(records)).toMatchObject({ state: "saved", savedIds: saved, omittedIds: omitted, memoryOnlyIds: omitted });
    store.save([records.at(-1)!]); await store.flush();
    expect(store.getStatus([records.at(-1)!])).toMatchObject({ omittedIds: [], memoryOnlyIds: [] });
  });

  it("restores records without activating candidates, and guards every old-background execution path", () => {
    const complete = vi.fn(async () => ({ text: "new", stopReason: "stop" as const }));
    const controller = new RefineController({ complete, timeoutMs: 100, maxDraftChars: 1000, onState() {} });
    controller.setSession("s");
    controller.restoreHistory(decodeHistory(encodeHistory([record(9)], "s").content, "s"));
    expect(controller.getCandidate()).toBeUndefined();
    expect(controller.getAccepted()).toBeUndefined();
    expect(controller.getRoundId()).toBeUndefined();
    expect(controller.runOriginal(9, record().input.model)).toEqual({ kind: "stale-source" });
    expect(controller.rerunRecord(9, record().input.model)).toEqual({ kind: "stale-source" });
    expect(controller.applyResult(9)).toBe(true);
    const source = controller.getCandidate()!;
    expect(controller.trigger({ ...source, contextUnavailable: undefined, revision: { instruction: "change", previousCandidate: source.text } },
      { revisionToken: controller.getCandidateToken() })).toEqual({ kind: "stale-source" });
    expect(complete).not.toHaveBeenCalled();
    const write = vi.fn();
    expect(controller.acceptCandidate(controller.getCandidateToken()!, "Original 中文", false, write)).toBe(true);
    expect(write).toHaveBeenCalledWith("Result");
    const created = controller.createDraft(record().input);
    expect(created).toMatchObject({ kind: "captured", recordId: 10 });
    expect(controller.getRecord(10)).toMatchObject({ taskId: 10, input: { roundId: 4 } });
    controller.invalidateLifecycle(true);
  });
});
