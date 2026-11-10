import { stat } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { extensionHarnessEnvironment, trigger } from "../support/extension-harness.js";

const { makeHarness, dispose } = extensionHarnessEnvironment();

describe("extension harness lifecycle", () => {
  it("isolates directories, handlers, editors and provider state for each harness", async () => {
    const first = await makeHarness();
    const second = await makeHarness();
    expect(first.agentDir).not.toBe(second.agentDir);
    expect(first.context.cwd).toBe(first.agentDir);
    expect(second.context.cwd).toBe(second.agentDir);
    expect(first.handlers).not.toBe(second.handlers);
    expect(first.shortcuts).not.toBe(second.shortcuts);
    first.setEditorText("Only the first editor");
    await trigger(first);
    expect(first.complete).toHaveBeenCalledOnce();
    expect(second.complete).not.toHaveBeenCalled();
    expect(second.getEditor()).toBe("Draft A");
    expect(second.editorWrites).toEqual([]);
  });

  it.each(["regular", "fullscreen"] as const)("shuts down and stops the %s renderer exactly once", async (mode) => {
    vi.useFakeTimers();
    const harness = await makeHarness({ renderer: { mode, theme: "dark" } });
    const shutdown = vi.fn(harness.handlers.get("session_shutdown")![0]!);
    harness.handlers.set("session_shutdown", [shutdown]);
    const stop = vi.spyOn(harness.renderer!.tui, "stop");
    await trigger(harness);
    await harness.dispose();
    await harness.dispose();
    expect(shutdown).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("removes temporary directories and restores the environment and timers", async () => {
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    vi.useFakeTimers();
    const harness = await makeHarness({ renderer: { mode: "regular", theme: "light" } });
    expect(process.env.PI_CODING_AGENT_DIR).toBe(harness.agentDir);
    expect((await stat(harness.agentDir)).isDirectory()).toBe(true);
    await dispose();
    expect(process.env.PI_CODING_AGENT_DIR).toBe(originalAgentDir);
    expect(vi.isFakeTimers()).toBe(false);
    await expect(stat(harness.agentDir)).rejects.toMatchObject({ code: "ENOENT" });
    await dispose();
  });

  it("finishes cleanup for every harness even when a shutdown handler fails", async () => {
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    vi.useFakeTimers();
    const first = await makeHarness({ renderer: { mode: "regular", theme: "dark" } });
    const second = await makeHarness({ renderer: { mode: "fullscreen", theme: "light" } });
    const firstShutdown = vi.fn(first.handlers.get("session_shutdown")![0]!);
    first.handlers.set("session_shutdown", [firstShutdown]);
    const shutdown = second.handlers.get("session_shutdown")![0]!;
    second.handlers.set("session_shutdown", [async (event, context) => {
      await shutdown(event, context);
      throw new Error("Test shutdown failure");
    }]);
    const firstStop = vi.spyOn(first.renderer!.tui, "stop");
    const secondStop = vi.spyOn(second.renderer!.tui, "stop");
    await expect(dispose()).rejects.toThrow("Extension harness shutdown failed");
    expect(firstShutdown).toHaveBeenCalledOnce();
    expect(firstStop).toHaveBeenCalledOnce();
    expect(secondStop).toHaveBeenCalledOnce();
    expect(process.env.PI_CODING_AGENT_DIR).toBe(originalAgentDir);
    expect(vi.isFakeTimers()).toBe(false);
    for (const harness of [first, second]) {
      await expect(stat(harness.agentDir)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});
