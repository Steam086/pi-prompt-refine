import { describe, expect, it, vi } from "vitest";
import { createConfigService } from "../../src/app/config-service.js";
import { DEFAULT_CONFIG, modelKey, type ConfigReader } from "../../src/config.js";
import { deferred, flushPromises } from "../support/helpers.js";

const optimizer = { provider: "local", id: "optimizer" };
const comparison = { provider: "other", id: "comparison" };

function fixture() {
  const unsaved = vi.fn();
  const writes = [deferred<void>(), deferred<void>(), deferred<void>(), deferred<void>()];
  let index = 0;
  const write = vi.fn((_snapshot: ReturnType<ConfigReader>) => writes[index++]!.promise);
  const config = createConfigService(DEFAULT_CONFIG, { defaultSystemPrompt: "Default policy", write, changed: () => {}, unsaved });
  return { config, writes, write, unsaved };
}

describe("configuration ownership", () => {
  it("serializes interleaved optimizer, comparison and Settings writes with their accepted snapshots", async () => {
    const { config, writes, write, unsaved } = fixture();
    const initial = config.read();
    const selected = config.setOptimizer(optimizer, "high", "high");
    const remembered = config.rememberComparisonThinking(comparison, "medium");
    const settings = config.saveContext({ instructions: "off", tree: true, skills: true, maxDraftChars: 200 });
    const policy = config.saveSystemPrompt(undefined, "Custom policy");
    expect(config.optimizerState()).toEqual({ version: 2, persistence: "pending" });
    expect(config.rememberComparisonThinking(comparison, "medium")).toBeUndefined();
    expect(config.read().maxDraftChars).toBe(200);
    expect(config.read().systemPrompt).toBe("Custom policy");
    expect(initial.maxDraftChars).toBe(DEFAULT_CONFIG.maxDraftChars);
    expect(initial.projectContext.tree.enabled).toBe(false);
    expect(Object.isFrozen(initial.projectContext.tree.exclude)).toBe(true);
    expect(Object.isFrozen(config.read().modelThinkingLevels)).toBe(true);

    await flushPromises();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]![0].modelThinkingLevels).toEqual({ [modelKey(optimizer)]: "high" });
    writes[0]!.reject(new Error("write failed"));
    expect(await selected).toBe(false);
    expect(unsaved).toHaveBeenCalledExactlyOnceWith("failed");
    expect(config.optimizerState()).toEqual({ version: 2, persistence: "pending" });
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1]![0].modelThinkingLevels[modelKey(comparison)]).toBe("medium");
    expect(write.mock.calls[1]![0].maxDraftChars).toBe(initial.maxDraftChars);
    writes[1]!.resolve(undefined);
    expect(await remembered).toBe(true);
    expect(config.optimizerState()).toEqual({ version: 2, persistence: "persisted" });
    expect(write.mock.calls[2]![0].systemPrompt).toBeUndefined();
    writes[2]!.resolve(undefined);
    expect(await settings).toBe(true);
    expect(write.mock.calls[3]![0]).toEqual(config.read());
    writes[3]!.resolve(undefined);
    expect(await policy).toBe("saved");
    expect(await config.flush()).toBe(true);
    expect(write).toHaveBeenCalledTimes(4);
  });

  it("keeps a newer optimizer pending until its write settles and reports failure without rolling back", async () => {
    const { config, writes } = fixture();
    const older = config.setOptimizer(optimizer, "high", "high");
    const newer = config.setOptimizer(comparison, undefined, "off", { model: optimizer, thinking: "high" });
    writes[0]!.resolve(undefined);
    expect(await older).toBe(true);
    expect(config.optimizerState()).toEqual({ version: 3, persistence: "pending" });
    writes[1]!.reject(new Error("write failed"));
    expect(await newer).toBe(false);
    expect(config.optimizerState()).toEqual({ version: 3, persistence: "failed" });
    expect(config.read()).toMatchObject({ model: comparison, thinkingLevel: undefined,
      modelThinkingLevels: { [modelKey(optimizer)]: "high", [modelKey(comparison)]: "off" } });
  });

  it("rejects stale policy edits and distinguishes memory-only changes when writing is blocked", async () => {
    const unsaved = vi.fn();
    const config = createConfigService(DEFAULT_CONFIG, { defaultSystemPrompt: "Default policy", changed: () => {}, unsaved });
    expect(await config.saveSystemPrompt(undefined, "Default policy")).toBe("unchanged");
    expect(await config.saveSystemPrompt(undefined, "Updated policy")).toBe("memory-only");
    expect(await config.saveSystemPrompt(undefined, "Older editor")).toBe("stale");
    expect(await config.saveSystemPrompt("Updated policy", "  ")).toBe("empty");
    expect(config.read().systemPrompt).toBe("Updated policy");
    expect(config.optimizerState()).toEqual({ version: 1, persistence: "blocked" });
    expect(unsaved).toHaveBeenCalledExactlyOnceWith("blocked");
  });
});
