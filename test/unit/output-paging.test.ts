import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { ApplicationApi, Binding, TaskDetail } from "../../src/app/api.js";
import { createSessionEventsBridge } from "../../src/adapters/session-events.js";
import { RESPONSE_EVENT } from "../../src/adapters/wire.js";
import { wirePacket } from "../support/application-wire.js";

function fixture() {
  let time = 0, current = true;
  const binding: Binding = { runtimeId: "runtime", sessionId: "session", lifecycleEpoch: 1 };
  const task: TaskDetail = { id: "task-1", version: 1, displayNumber: 1, archived: false,
    text: "中文😀".repeat(20_000), excerpt: "original", runIds: [], selectedNames: [], backgroundAvailable: true,
    actions: { edit: { enabled: true }, start: { enabled: true }, discard: { enabled: true }, copy: { enabled: true } } };
  const execute = vi.fn(async () => ({ kind: "rejected", code: "invalid-input" } as const));
  const api: ApplicationApi = {
    isCurrentBinding: (value) => current && value.runtimeId === binding.runtimeId && value.sessionId === binding.sessionId && value.lifecycleEpoch === binding.lifecycleEpoch,
    hello: () => ({ kind: "rejected", code: "not-ready" }),
    query: () => ({ kind: "ok", value: task, revision: 1 }), execute,
    subscribe: () => () => {},
  };
  const emitter = new EventEmitter();
  const bus = { on(name: string, listener: (value: unknown) => void) { emitter.on(name, listener); return () => { emitter.off(name, listener); }; },
    emit(name: string, value: unknown) { emitter.emit(name, value); } };
  const bridge = createSessionEventsBridge(api, bus, () => time);
  const query = () => wirePacket(bus, { action: "query", binding, query: { method: "task", taskId: "task-1" } });
  return { bus, bridge, query, execute, advance: () => { time += 60_001; }, invalidate: () => { current = false; } };
}

describe("demand-driven output paging", () => {
  it("emits one receipt/page per request, replays the last page and rejects other scopes/order/lifecycle", async () => {
    const f = fixture();
    const frames = vi.fn(); const off = f.bus.on(RESPONSE_EVENT, frames);
    try {
      const response = await f.query();
      expect(response.output.id).toBeTruthy();
      expect(frames).toHaveBeenCalledTimes(1);
      const read = { action: "readOutput", outputId: response.output.id, index: 0 };
      expect(await wirePacket(f.bus, read, "other-connection")).toEqual({ kind: "rejected", code: "transfer-expired" });
      const first = await wirePacket(f.bus, read);
      expect(first.part).toMatchObject({ index: 0, done: false, encoding: "base64" });
      expect(first.part.text.length).toBeLessThanOrEqual(48 * 1024);
      expect(await wirePacket(f.bus, read)).toEqual(first);
      expect(await wirePacket(f.bus, { ...read, index: 3 })).toEqual({ kind: "rejected", code: "invalid-input" });
      f.invalidate();
      expect(await wirePacket(f.bus, { ...read, index: 1 })).toEqual({ kind: "conflict", code: "binding-stale" });
      expect(f.execute).not.toHaveBeenCalled();
    } finally { off(); f.bridge.dispose(); }
  });
  it("reclaims per-connection slots on release, idle expiry and disconnect", async () => {
    const f = fixture();
    try {
      const outputs = [];
      for (let n = 0; n < 4; n++) outputs.push((await f.query()).output.id);
      expect(await f.query()).toEqual({ kind: "rejected", code: "resource-limit" });
      await wirePacket(f.bus, { action: "releaseOutput", outputId: outputs[0] });
      expect((await f.query()).output.id).toBeTruthy();
      f.advance();
      expect(await wirePacket(f.bus, { action: "readOutput", outputId: outputs[1], index: 0 })).toEqual({ kind: "rejected", code: "transfer-expired" });
      expect((await f.query()).output.id).toBeTruthy();
      await wirePacket(f.bus, { action: "close" });
      for (let n = 0; n < 4; n++) expect((await f.query()).output.id).toBeTruthy();
      expect(f.execute).not.toHaveBeenCalled();
    } finally { f.bridge.dispose(); }
  });
});
