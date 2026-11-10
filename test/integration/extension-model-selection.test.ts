import type { Api, Model } from "@earendil-works/pi-ai";
import { visibleWidth } from "@earendil-works/pi-tui";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { type RefineConfig } from "../../src/config.js";
import { workspaceHeight } from "../../src/workspace-overlay.js";
import { extensionHarnessEnvironment, shortcut, trigger } from "../support/extension-harness.js";
import { flushPromises } from "../support/helpers.js";

const { makeHarness } = extensionHarnessEnvironment();

describe("Pi extension integration (mocked TUI and provider)", () => {

  it("opens the action panel instead of issuing a request when no model is configured", async () => {
    const harness = await makeHarness({ useDefaultShortcuts: true, configureModel: false });
    await shortcut(harness, "ctrl+\\")(harness.context);
    expect(harness.customCalls()).toBe(1);
    const frame = harness.panelLines().join("\n");
    expect(frame).toContain("Run: No model");
    expect(frame).toContain("n New");
    expect(frame).not.toContain("m Model");
    expect(harness.complete).not.toHaveBeenCalled();
  });

  it.each([
    { reasoning: true, thinkingLevel: "high" as const, expected: "high" },
    { reasoning: true, expected: "medium" },
    { reasoning: false, thinkingLevel: "high" as const, expected: "off" },
    { reasoning: true, thinkingLevel: "high" as const, config: { thinkingLevel: "low" as const }, expected: "low" },
  ])("shows effective idle thinking below the title: $expected", async (options) => {
    const harness = await makeHarness(options);
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    const lines = harness.panelLines();
    expect(stripVTControlCharacters(lines[2]!).replace(/^│|│$/g, "").trim()).toBe(`fake-provider/fake-chat · ${options.expected}`);
    expect(lines.join("\n").match(/fake-provider\/fake-chat/g)).toHaveLength(1);
    expect(lines.join("\n")).toContain("No result yet.");
    expect(harness.complete).not.toHaveBeenCalled();
    harness.panelInput("q");
    await view;
  });

  it.each(["ready", "accepted", "generating", "error"])("keeps %s header thinking tied to the request, not later session settings", async (phase) => {
    const harness = await makeHarness({ reasoning: true, thinkingLevel: "high" });
    if (phase === "generating") harness.complete.mockImplementation(() => new Promise(() => {}));
    if (phase === "error") harness.complete.mockRejectedValue(new Error("Provider failed"));
    await trigger(harness);
    if (phase === "accepted") {
      harness.setCustomAction("a");
      await harness.command("view", harness.context);
    }
    harness.context.thinkingLevel = "low";
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    const lines = harness.panelLines();
    expect(lines[2]).toContain("fake-provider/fake-chat · high");
    expect(lines[2]).not.toContain("low");
    if (phase === "accepted") expect(lines[2]).toContain("Accepted");
    expect(harness.complete).toHaveBeenCalledOnce();
    harness.panelInput("q");
    await view;
  });

  it("inherits the active session thinking level for optimizer requests", async () => {
    const harness = await makeHarness({ reasoning: true, thinkingLevel: "high" });
    await trigger(harness);
    expect((harness.complete.mock.calls[0] as any[])[2]).toMatchObject({ reasoning: "high" });
  });

  it("defaults to enabled medium thinking when the session level is unavailable", async () => {
    const harness = await makeHarness({ reasoning: true });
    await trigger(harness);
    expect((harness.complete.mock.calls[0] as any[])[2]).toMatchObject({ reasoning: "medium" });
  });

  it("cycles thinking with Shift+Tab and persists an explicit level override", async () => {
    const harness = await makeHarness({ reasoning: true, thinkingLevel: "medium" });
    harness.setCustomAction(["\x1b[Z", "\r"]);
    await harness.command("model", harness.context);
    const stored = JSON.parse(await readFile(join(harness.agentDir, "prompt-refine.json"), "utf8")) as RefineConfig;
    expect(stored.thinkingLevel).toBe("high");
    expect(harness.notifications.join(" ")).toContain("thinking level: high (Extension setting)");

    await trigger(harness);
    expect((harness.complete.mock.calls[0] as any[])[2]).toMatchObject({ reasoning: "high" });
  });

  it("remembers comparison-only thinking across reload and runs it with Enter without changing defaults", async () => {
    const harness = await makeHarness({ reasoning: true, thinkingLevel: "medium", config: { thinkingLevel: "low" } });
    const registry = harness.context.modelRegistry;
    const a = registry.getAvailable()[0]!;
    const b = { ...a, provider: "other-provider", name: "Other Model" } as Model<Api>;
    vi.mocked(registry.getAvailable).mockReturnValue([a, b]);
    vi.mocked(registry.find).mockImplementation((provider, id) => [a, b].find((model) => model.provider === provider && model.id === id));
    harness.holdPanel();
    const runComparison = async (adjust: boolean) => {
      const view = harness.command("", harness.context);
      harness.panelInput("m");
      await vi.waitFor(() => expect(harness.panelLines().join("\n")).toContain("Run original with another model"));
      if (adjust) harness.panelInput("\x1b[Z"); // low -> medium
      expect(harness.panelLines().join("\n")).toContain("Thinking level: medium");
      if (!adjust) expect(harness.panelLines().join("\n")).toContain("Last used for this model");
      harness.panelInput("\r");
      await vi.waitFor(() => expect(harness.panelLines().join("\n")).not.toContain("Run original with another model"));
      harness.panelInput("q");
      await view;
    };
    await trigger(harness);
    await runComparison(true);
    let saved = JSON.parse(await readFile(join(harness.agentDir, "prompt-refine.json"), "utf8"));
    expect(saved.model).toEqual({ provider: a.provider, id: a.id });
    expect(saved.thinkingLevel).toBe("low");
    expect(saved.modelThinkingLevels[`${b.provider}/${b.id}`]).toBe("medium");
    await harness.reload();
    await trigger(harness);
    await runComparison(false);
    expect(harness.complete.mock.calls.map((call) => (call as any[])[2].reasoning)).toEqual(["low", "medium", "low", "medium"]);
    expect(harness.context.thinkingLevel).toBe("medium");
    expect(harness.editorWrites).toEqual([]);
    saved = JSON.parse(await readFile(join(harness.agentDir, "prompt-refine.json"), "utf8"));
    expect(saved.thinkingLevel).toBe("low");
  });

  it("isolates picker edits by model across navigation and search, and discards them on cancel", async () => {
    const harness = await makeHarness({ reasoning: true, config: { modelThinkingLevels: {
      "fake-provider/fake-chat": "low", "other-provider/fake-chat": "high",
    } } });
    const registry = harness.context.modelRegistry;
    const a = registry.getAvailable()[0]!;
    const b = { ...a, provider: "other-provider", name: "Other Model" } as Model<Api>;
    vi.mocked(registry.getAvailable).mockReturnValue([a, b]);
    vi.mocked(registry.find).mockImplementation((provider, id) => [a, b].find((model) => model.provider === provider && model.id === id));
    const path = join(harness.agentDir, "prompt-refine.json");
    const before = await readFile(path, "utf8");
    harness.holdPanel();
    const picker = harness.command("model", harness.context);
    expect(harness.panelLines().join("\n")).toContain("Thinking level: low");
    harness.panelInput("\x1b[Z");
    expect(harness.panelLines().join("\n")).toContain("Thinking level: medium");
    harness.panelInput("\x1b[B");
    expect(harness.panelLines().join("\n")).toContain("Thinking level: high");
    harness.panelInput("\x1b[A");
    expect(harness.panelLines().join("\n")).toContain("Thinking level: medium");
    for (const key of "other") harness.panelInput(key);
    expect(harness.panelLines().join("\n")).toContain("Thinking level: high");
    harness.panelInput("\x1b");
    await picker;
    expect(await readFile(path, "utf8")).toBe(before);
    expect(harness.complete).not.toHaveBeenCalled();
  });

  it("restores remembered thinking on default model selection and favorite cycling", async () => {
    const harness = await makeHarness({ reasoning: true, config: { thinkingLevel: "low", favorites: [
      { provider: "fake-provider", id: "fake-chat" }, { provider: "other-provider", id: "fake-chat" },
    ], modelThinkingLevels: { "other-provider/fake-chat": "high" } } });
    const registry = harness.context.modelRegistry;
    const a = registry.getAvailable()[0]!;
    const b = { ...a, provider: "other-provider" } as Model<Api>;
    vi.mocked(registry.getAvailable).mockReturnValue([a, b]);
    vi.mocked(registry.find).mockImplementation((provider, id) => [a, b].find((model) => model.provider === provider && model.id === id));
    harness.setCustomAction(["\x1b[B", "\r"]);
    await harness.command("model", harness.context);
    const path = join(harness.agentDir, "prompt-refine.json");
    expect(JSON.parse(await readFile(path, "utf8")).thinkingLevel).toBe("high");
    await harness.command("cycle", harness.context);
    expect(JSON.parse(await readFile(path, "utf8")).thinkingLevel).toBe("low");
  });

  it.each([true, false])("clamps remembered thinking to current model capabilities (reasoning: %s)", async (reasoning) => {
    const harness = await makeHarness({ reasoning, config: { modelThinkingLevels: { "fake-provider/fake-chat": "max" } } });
    harness.holdPanel();
    const picker = harness.command("model", harness.context);
    expect(harness.panelLines().join("\n")).toContain(reasoning ? "Thinking level: high" : "not supported by this model");
    harness.panelInput("\r");
    await picker;
    expect(JSON.parse(await readFile(join(harness.agentDir, "prompt-refine.json"), "utf8")).modelThinkingLevels["fake-provider/fake-chat"]).toBe(reasoning ? "high" : "off");
    await trigger(harness);
    expect((harness.complete.mock.calls[0] as any[])[2].reasoning).toBe(reasoning ? "high" : undefined);
  });

  it("keeps comparison thinking in memory and warns if saving fails", async () => {
    const harness = await makeHarness({ reasoning: true, thinkingLevel: "low" });
    await trigger(harness);
    const path = join(harness.agentDir, "prompt-refine.json");
    await rm(path);
    await mkdir(path);
    harness.holdPanel();
    const view = harness.command("", harness.context);
    harness.panelInput("m");
    await vi.waitFor(() => expect(harness.panelLines().join("\n")).toContain("Run original with another model"));
    harness.panelInput("\x1b[Z");
    harness.panelInput("\r");
    await vi.waitFor(() => expect(harness.panelLines().join("\n")).not.toContain("Run original with another model"));
    expect(harness.notifications.join(" ")).toContain("not persisted");
    expect((harness.complete.mock.calls[1] as any[])[2].reasoning).toBe("medium");
    harness.panelInput("m");
    await vi.waitFor(() => expect(harness.panelLines().join("\n")).toContain("Run original with another model"));
    expect(harness.panelLines().join("\n")).toContain("Thinking level: medium");
    harness.panelInput("\x1b");
    await vi.waitFor(() => expect(harness.panelLines().join("\n")).not.toContain("Run original with another model"));
    harness.panelInput("q");
    await view;
  });

  it.each([true, false, undefined, "unchanged", "empty"] as const)("edits the optimization prompt with confirmation: %s", async (choice) => {
    const original = "Original optimization instructions";
    const harness = await makeHarness({ config: { systemPrompt: original } });
    const edited = choice === undefined ? undefined : choice === "unchanged" ? original : choice === "empty" ? " \n " : "Custom optimization instructions";
    vi.mocked(harness.context.ui.editor).mockResolvedValue(edited);
    vi.mocked(harness.context.ui.confirm).mockImplementation(async () => {
      const saved = JSON.parse(await readFile(join(harness.agentDir, "prompt-refine.json"), "utf8"));
      expect(saved.systemPrompt).toBe(original);
      return choice === true;
    });
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    harness.panelInput("\x1b[D");
    harness.panelInput(" ");
    harness.panelInput("\t");
    for (let i = 0; i < 2; i++) harness.panelInput("\x1b[B");
    expect(harness.panelLines().join("\n")).toContain("› Optimization prompt");
    expect(harness.panelLines().join("\n")).toContain("Enter Change");
    harness.panelInput("\r");
    await vi.waitFor(() => expect(harness.customCalls()).toBe(2));
    expect(harness.context.ui.editor).toHaveBeenCalledWith(expect.any(String), original);
    expect(harness.context.ui.confirm).toHaveBeenCalledTimes(typeof choice === "boolean" ? 1 : 0);
    expect(harness.panelLines().join("\n")).toContain("Unsaved settings changes");
    harness.panelInput("\x1b");
    harness.panelInput("q");
    await view;
    const expected = choice === true ? edited : original;
    const saved = JSON.parse(await readFile(join(harness.agentDir, "prompt-refine.json"), "utf8"));
    expect(saved.systemPrompt).toBe(expected);
    expect(harness.editorWrites).toEqual([]);
    await harness.reload();
    await harness.command("optimize", harness.context);
    await vi.waitFor(() => expect(harness.complete).toHaveBeenCalledOnce());
    expect((harness.complete.mock.calls[0]?.[1] as { systemPrompt: string }).systemPrompt).toContain(expected);
  });

  it.each(["main", "settings"])("returns to %s after confirming the optimizer model without starting refinement", async (origin) => {
    const harness = await makeHarness({ configureModel: false });
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    if (origin === "settings") {
      harness.panelInput("\x1b[D");
      harness.panelInput(" ");
      harness.panelInput("\t");
      harness.panelInput("\r");
    } else {
      harness.panelInput("m");
    }
    await vi.waitFor(() => expect(harness.panelLines().join("\n")).toContain("Choose optimizer model"));
    harness.panelInput("\r");
    await vi.waitFor(() => expect(harness.panelLines().join("\n")).not.toContain("Choose optimizer model"));
    expect(harness.customCalls()).toBe(1);
    const lines = harness.panelLines().join("\n");
    expect(lines).not.toContain("Choose optimizer model");
    expect(lines).toContain(origin === "settings" ? "Unsaved settings changes" : "m Model");
    const saved = JSON.parse(await readFile(join(harness.agentDir, "prompt-refine.json"), "utf8"));
    expect(saved.model).toEqual({ provider: "fake-provider", id: "fake-chat" });
    expect(harness.notifications.join(" ")).toContain("Optimizer model set to fake-provider/fake-chat");
    expect(harness.notifications.join(" ")).toContain("main session unchanged");
    expect(harness.complete).not.toHaveBeenCalled();
    expect(harness.editorWrites).toEqual([]);
    expect(harness.sent).toEqual([]);
    if (origin === "settings") harness.panelInput("\x1b");
    harness.panelInput("q");
    await view;
  });

  it("opens the model picker from Settings and restores unsaved context on cancel", async () => {
    const harness = await makeHarness({ reasoning: true, thinkingLevel: "medium" });
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    harness.panelInput("\x1b[D");
    harness.panelInput(" ");
    harness.panelInput(" ");
    harness.panelInput("\t");
    expect(harness.panelLines().join("\n")).toContain("Model:");
    harness.panelInput("\r");
    await vi.waitFor(() => expect(harness.panelLines().join("\n")).toContain("Choose optimizer model"));
    harness.panelInput("\x1b");
    await vi.waitFor(() => expect(harness.panelLines().join("\n")).toContain("Unsaved settings changes"));
    harness.panelInput("\x1b[D");
    expect(harness.panelLines().join("\n")).toMatch(/Project instructions +Always/);
    harness.panelInput("\t");
    harness.panelInput("\x1b[B");
    expect(harness.panelLines().join("\n")).toContain("Thinking: medium");
    harness.panelInput("\r");
    await vi.waitFor(() => expect(harness.panelLines().join("\n")).toContain("Thinking level saved"));
    expect(harness.panelLines().join("\n")).toContain("Thinking: high · Extension setting");
    expect(harness.context.thinkingLevel).toBe("medium");
    const saved = JSON.parse(await readFile(join(harness.agentDir, "prompt-refine.json"), "utf8"));
    expect(saved.thinkingLevel).toBe("high");
    expect(saved.modelThinkingLevels["fake-provider/fake-chat"]).toBe("high");
    expect(saved.projectContext.instructionsEnabled).toBe(false);
    harness.panelInput("\x1b");
    harness.panelInput("q");
    await view;
    expect(harness.editorWrites).toEqual([]);
  });

  it.each([
    { configureModel: false, reason: "select an available model first" },
    { noAvailableModels: true, reason: "select an available model first" },
    { reasoning: false, reason: "fixed for this model" },
  ])("disables unavailable or fixed thinking in Settings: $reason", async (options) => {
    const harness = await makeHarness(options);
    const before = await readFile(join(harness.agentDir, "prompt-refine.json"), "utf8");
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    harness.panelInput("\x1b[D");
    harness.panelInput("\t");
    for (let i = 0; i < 1; i++) harness.panelInput("\x1b[B");
    expect(harness.panelLines().join("\n")).toContain(`Unavailable — ${options.reason}`);
    for (const key of ["\r", " ", "\x1b[Z"]) harness.panelInput(key);
    await flushPromises();
    expect(await readFile(join(harness.agentDir, "prompt-refine.json"), "utf8")).toBe(before);
    expect(harness.panelLines().join("\n")).not.toContain("Thinking level saved");
    harness.panelInput("\x1b");
    harness.panelInput("q");
    await view;
  });

  it("saves pending Context from an Optimizer row without opening its action", async () => {
    const harness = await makeHarness();
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    harness.panelInput("\x1b[D");
    harness.panelInput("\r");
    expect(harness.panelLines().join("\n")).toContain("Unsaved settings changes");
    harness.panelInput("\t");
    harness.panelInput("\x13");
    await vi.waitFor(() => expect(harness.panelLines().join("\n")).toContain("Settings saved"));
    expect(harness.customCalls()).toBe(1);
    const saved = JSON.parse(await readFile(join(harness.agentDir, "prompt-refine.json"), "utf8"));
    expect(saved.projectContext.instructionsEnabled).toBe(true);
    harness.panelInput("q");
    await view;
  });

  it("bounds the model picker through resize without losing its selected model or starting a request", async () => {
    const harness = await makeHarness({ reasoning: true });
    const original = harness.context.modelRegistry.getAvailable()[0]!;
    const models = Array.from({ length: 30 }, (_, index) => ({ ...original,
      id: `model-${index}-中文😀`.repeat(8), name: `Model ${index} 中文😀`.repeat(8) }));
    vi.mocked(harness.context.modelRegistry.getAvailable).mockReturnValue([original, ...models]);
    harness.holdPanel();
    const picker = harness.command("model", harness.context);
    await vi.waitFor(() => expect(harness.panelLines().join("\n")).toContain("Choose optimizer model"));
    harness.panelInput("\x1b[B"); harness.panelInput("\x1b[Z");
    for (const rows of [8, 12, 24, 40, 80, 12, 40]) for (const width of [1, 20, 40, 100, 180]) {
      harness.resize(rows);
      const lines = harness.panelLines(width);
      expect(lines).toHaveLength(workspaceHeight(rows));
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      if (width >= 40 && rows >= 12) expect(lines.join("\n")).toContain("Model 0 中文😀");
      if (width >= 100 && rows >= 24) expect(lines.join("\n")).toContain("Thinking level:");
    }
    harness.panelInput("\x1b"); await picker;
    const saved = JSON.parse(await readFile(join(harness.agentDir, "prompt-refine.json"), "utf8"));
    expect(saved.model).toEqual({ provider: original.provider, id: original.id });
    expect(harness.complete).not.toHaveBeenCalled(); expect(harness.editorWrites).toEqual([]);
  });

  it("presents an overlay model picker without changing the model on cancel", async () => {
    const harness = await makeHarness();
    harness.setCustomAction("\x1b");
    await harness.command("model", harness.context);
    expect(harness.panelLines().join("\n")).toContain("Choose optimizer model");
    expect(harness.panelLines().join("\n")).toContain("Optimizer only · Main session unchanged");
    expect(harness.panelLines().join("\n")).toContain("Enter Confirm · ↑↓ Select");
    expect(harness.panelLines().join("\n")).toContain("Esc Cancel · Shift+Tab Thinking");
    for (const { width, lines } of harness.renderedWidths) {
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
    expect(harness.complete).not.toHaveBeenCalled();
    expect(harness.editorWrites).toEqual([]);
  });

  it("requires an explicit model choice and never silently falls back when it is absent or unavailable", async () => {
    const unconfigured = await makeHarness({ configureModel: false });
    await trigger(unconfigured);
    expect(unconfigured.complete).not.toHaveBeenCalled();
    expect(unconfigured.notifications.join(" ")).toContain("No optimizer model is configured");

    const unavailable = await makeHarness({ noAvailableModels: true });
    await trigger(unavailable);
    expect(unavailable.complete).not.toHaveBeenCalled();
    expect(unavailable.notifications.join(" ")).toContain("is missing or unavailable");
    await shortcut(unavailable, "alt+m")(unavailable.context);
    expect(unavailable.notifications.join(" ")).toContain("No authorized text-generation models are available");
  });
});
