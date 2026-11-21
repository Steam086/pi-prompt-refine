import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createDesktopService, parseDesktopCall } from "../../packages/t3-code/src/service.js";
import type { DesktopCall, DesktopReply } from "../../packages/t3-code/src/protocol.js";
import type { DesktopRegistry } from "../../packages/t3-code/src/runtime.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "refine-t3-test-"));
  directories.push(cwd);
  const model = { provider: "test", id: "rewriter", name: "Test rewriter", contextWindow: 128_000,
    maxTokens: 16_384, reasoning: false } as Model<Api>;
  const complete = vi.fn(async () => ({ content: [{ type: "text", text: '{"prompt":"Rewrite 中文 ✅"}' }], stopReason: "stop" }));
  const streamSimple = vi.fn(() => ({ result: complete }));
  const registry: DesktopRegistry = {
    find: () => model, getAvailable: () => [model], isUsingOAuth: () => false,
    streamSimple: streamSimple as unknown as DesktopRegistry["streamSimple"],
  };
  const path = join(cwd, "prompt-refine.json");
  await writeFile(path, JSON.stringify({ version: 1, model: { provider: model.provider, id: model.id } }));
  const desktop = await createDesktopService(cwd, registry);
  const thread = { cwd, sessionId: "thread-id", anchor: "",
    loadHistory: vi.fn(async () => [{ role: "assistant" as const, text: "We discussed the release timing." }]) };
  async function send(call: DesktopCall): Promise<DesktopReply> {
    const parsed = parseDesktopCall(JSON.stringify(call));
    if (!parsed) throw new Error("Test sent invalid Refine input");
    return JSON.parse(await desktop.request(thread, parsed)) as DesktopReply;
  }
  async function open(text: string) {
    const response = await send({ method: "open", text });
    if (response.kind !== "open") throw new Error(JSON.stringify(response));
    return response;
  }
  return { path, model, complete, streamSimple, desktop, thread, send, open };
}

describe("T3 desktop Refine", () => {
  it("keeps one automatic submission per round and reopens an identical draft", async () => {
    const { thread, streamSimple, open, send } = await fixture();
    const first = await open("Make that clearer");
    expect(first.runId).toBeDefined();
    await vi.waitFor(() => expect(streamSimple).toHaveBeenCalledTimes(1));
    expect(streamSimple.mock.calls[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ messages: [expect.objectContaining({ content: [expect.objectContaining({
        text: expect.stringContaining("release timing"),
      })] })], tools: [] }),
    ]));

    const duplicate = await open("Make that clearer");
    expect(duplicate.runId).toBe(first.runId);
    const candidate = await send({ method: "run", binding: first.snapshot.binding, id: first.runId! });
    if (candidate.kind !== "run") throw new Error(JSON.stringify(candidate));
    const adopted = await send({ method: "open", text: candidate.value.text!,
      adopted: { binding: first.snapshot.binding, runId: candidate.value.id, version: candidate.value.version } });
    expect(adopted).toMatchObject({ kind: "open", runId: first.runId });
    const second = await open("A different draft");
    expect(second.runId).toBeUndefined();
    expect(thread.loadHistory).toHaveBeenCalledTimes(1);
    expect(streamSimple).toHaveBeenCalledTimes(1);

    const task = second.snapshot.tasks.find((item) => item.id === second.taskId)!;
    const started = await send({ method: "mutate", binding: second.snapshot.binding,
      mutation: { method: "startRun", taskId: task.id, expectedVersion: task.version } });
    expect(started.kind).toBe("receipt");
    await vi.waitFor(() => expect(streamSimple).toHaveBeenCalledTimes(2));

    thread.anchor = "message-2";
    expect((await open("Now revise the timeline")).runId).toBeDefined();
    await vi.waitFor(() => expect(streamSimple).toHaveBeenCalledTimes(3));
    expect(thread.loadHistory).toHaveBeenCalledTimes(2);
    const run = await send({ method: "run", binding: first.snapshot.binding, id: first.runId! });
    expect(run).toMatchObject({ kind: "run", value: { archived: true, text: "Rewrite 中文 ✅" } });
  });

  it("opens and saves settings without calling a model and rejects stale writes", async () => {
    const { path, open, streamSimple, send } = await fixture();
    const { snapshot } = await open("");
    const settings = await send({ method: "settings", binding: snapshot.binding });
    if (settings.kind !== "settings") throw new Error(JSON.stringify(settings));

    const request = { method: "saveSettings" as const, binding: snapshot.binding,
      version: settings.value.version, fields: { maxMessages: 0, timeoutMs: 30_000 } };
    const saved = await send(request);
    expect(saved).toMatchObject({ kind: "settings", saved: true, value: { fields: request.fields } });
    expect(await send(request)).toEqual({ kind: "conflict", code: "optimizer-version" });
    const persisted = JSON.parse(await readFile(path, "utf8"));
    expect(persisted).toMatchObject({ context: { maxMessages: 0 }, timeoutMs: 30_000 });
    expect(streamSimple).not.toHaveBeenCalled();
  });

  it("rejects cross-thread bindings and out-of-scope payloads", async () => {
    const { desktop, thread, open, streamSimple } = await fixture();
    const { snapshot } = await open("");
    const other = { ...thread, sessionId: "another-thread" };
    await desktop.request(other, { method: "open", text: "" });
    expect(JSON.parse(await desktop.request(other, { method: "snapshot", binding: snapshot.binding, all: false })))
      .toEqual({ kind: "conflict", code: "binding-stale" });
    expect(parseDesktopCall('{"method":"open","text":"hello","cwd":"/elsewhere"}')).toBeUndefined();
    expect(parseDesktopCall(JSON.stringify({ method: "mutate", binding: snapshot.binding,
      mutation: { method: "optimizeText", text: "Unbound explicit start" } }))).toBeUndefined();
    expect(streamSimple).not.toHaveBeenCalled();
  });
});

it("checks the authoritative thread again before submitting after context capture", async () => {
  const { desktop, thread, streamSimple } = await fixture();
  const changed = { ...thread, isCurrent: async () => false };
  const attempt = await desktop.request(changed, { method: "open", text: "An old draft" });
  expect(JSON.parse(attempt)).toEqual({ kind: "conflict", code: "binding-stale" });
  expect(streamSimple).not.toHaveBeenCalled();
});
