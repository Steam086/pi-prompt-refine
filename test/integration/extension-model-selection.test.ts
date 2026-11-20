import { frameHeader } from "../support/panel-chrome.js";
import type { Api, Model } from "@earendil-works/pi-ai";
import { visibleWidth } from "@earendil-works/pi-tui";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { type RefineConfig } from "../../src/config.js";
import { REFINE_SYSTEM_PROMPT } from "../../src/context.js";
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
    expect(frame).toContain("No current prompts.");
    expect(frame).not.toContain("Refine model:");
    expect(frame).toContain("n: New");
    expect(frame).not.toContain("m Model");
    expect(harness.complete).not.toHaveBeenCalled();
  });

  it.each([
    { reasoning: true, thinkingLevel: "high" as const, expected: "high" },
    { reasoning: true, expected: "medium" },
    { reasoning: false, thinkingLevel: "high" as const, expected: "off" },
    { reasoning: true, thinkingLevel: "high" as const, config: { thinkingLevel: "low" as const }, expected: "low" },
  ])("shows effective idle thinking in the header: $expected", async (options) => {
    const harness = await makeHarness(options);
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    const lines = harness.panelLines();
    expect(stripVTControlCharacters(frameHeader(lines).join("\n"))).toContain(`fake-provider/fake-chat · ${options.expected}`);
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
    expect(frameHeader(lines).join("\n")).toContain("fake-provider/fake-chat · high");
    expect(frameHeader(lines).join("\n")).not.toContain("low");
    if (phase === "accepted") expect(frameHeader(lines).join("\n")).toContain("Accepted");
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
    const { panelInput: input } = harness;
    const path = join(harness.agentDir, "prompt-refine.json");
    const before = await readFile(path, "utf8");
    const frame = () => stripVTControlCharacters(harness.panelLines(120).join("\n"));
    const edited = "Custom optimization instructions\nKeep 中文😀";
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    input("\x1b[D"); input(" "); // Stage a change to project instructions.
    input("\t"); input("\x1b[B"); input("\x1b[B");
    expect(frame()).toContain("› Optimization prompt");
    expect(frame()).toContain("Enter: Edit");
    input("\r");
    expect(frame()).toContain(original);
    expect(frame()).toContain("Refine only · Applies next round");
    if (choice !== "unchanged") {
      input("\x15"); // Clear the prefilled line.
      if (choice === "empty") { input(" "); input("\r"); input(" "); }
      else { input("Custom optimization instructions"); input("\r"); input("Keep 中文😀"); }
    }
    if (choice === undefined) input("\x1b");
    else input("\x13");
    if (choice === "empty") {
      expect(frame()).toContain("Prompt cannot be empty.");
      expect(frame()).not.toContain("Save optimization prompt?");
      input("\x1b");
    } else if (typeof choice === "boolean") {
      expect(frame()).toContain("Save optimization prompt?");
      expect(await readFile(path, "utf8")).toBe(before);
      input("\r"); input("q"); input("\t"); input("\x1b[D");
      expect(frame()).toContain("Save optimization prompt?");
      if (choice) {
        input("y"); input("y"); input("\x1b"); // A pending write consumes further keys.
        await vi.waitFor(() => expect(frame()).toContain("Optimization prompt saved"));
      } else {
        input("\x1b");
        expect(frame()).toContain("Custom optimization instructions");
        expect(frame()).toContain("Keep 中文😀");
        expect(frame()).not.toContain("Save optimization prompt?");
        input("\x1b");
      }
    }
    expect(frame()).toContain("› Optimization prompt");
    expect(frame()).toContain("Unsaved settings changes");
    input("\x1b[D");
    expect(frame()).toMatch(/› Project instructions +First only · inactive/);
    input("\t");
    expect(frame()).toContain("› Optimization prompt");
    expect(harness.customCalls()).toBe(1);
    expect(harness.context.ui.editor).not.toHaveBeenCalled();
    expect(harness.context.ui.confirm).not.toHaveBeenCalled();
    expect(harness.complete).not.toHaveBeenCalled();
    expect(harness.getEditor()).toBe("Draft A");
    expect(harness.editorWrites).toEqual([]);
    expect(harness.sent).toEqual([]);
    const after = await readFile(path, "utf8");
    const expected = choice === true ? edited : original;
    expect(JSON.parse(after).systemPrompt).toBe(expected);
    expect(JSON.parse(after).projectContext).toEqual(JSON.parse(before).projectContext);
    if (choice !== true) expect(after).toBe(before);
    input("\x1b"); input("q"); await view;
    await harness.reload();
    await harness.command("optimize", harness.context);
    await vi.waitFor(() => expect(harness.complete).toHaveBeenCalledOnce());
    expect((harness.complete.mock.calls[0]?.[1] as { systemPrompt: string }).systemPrompt).toContain(expected);
  });

  it("prefills the built-in policy and applies edits only to the next round, with the fixed protocol", async () => {
    const harness = await makeHarness();
    await trigger(harness);
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    const { panelInput: input } = harness;
    input("\x1b[D"); input("\t"); input("\x1b[B"); input("\x1b[B"); input("\r");
    const frame = () => harness.panelLines(120).join("\n");
    expect(frame()).toContain(REFINE_SYSTEM_PROMPT.split("\n").at(-1)!.slice(-37));
    input("\r"); input("Prefer direct phrasing."); input("\x13"); input("y");
    await vi.waitFor(() => expect(frame()).toContain("Optimization prompt saved"));
    expect(harness.complete).toHaveBeenCalledOnce();
    expect(harness.getEditor()).toBe("Draft A");
    input("\x1b"); input("q"); await view;
    const policy = (index: number) => (harness.complete.mock.calls[index]?.[1] as { systemPrompt: string }).systemPrompt;
    await harness.command("optimize Same-round draft", harness.context);
    await vi.waitFor(() => expect(harness.complete).toHaveBeenCalledTimes(2));
    expect(policy(1)).toBe(policy(0));
    harness.handlers.get("message_start")?.[0]?.({ message: { role: "user", content: "New round" } }, harness.context);
    await harness.command("optimize Next-round draft", harness.context);
    await vi.waitFor(() => expect(harness.complete).toHaveBeenCalledTimes(3));
    expect(policy(2)).toBe(policy(0).replace(REFINE_SYSTEM_PROMPT, () => `${REFINE_SYSTEM_PROMPT}\nPrefer direct phrasing.`));
  });

  it.each(["write failure", "stale generation"])("reports a policy that was not persisted after %s", async (scenario) => {
    const original = "Original rewrite policy";
    const harness = await makeHarness({ config: { systemPrompt: original } });
    const path = join(harness.agentDir, "prompt-refine.json");
    const before = await readFile(path, "utf8");
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    const { panelInput: input } = harness;
    input("\x1b[D"); input("\t"); input("\x1b[B"); input("\x1b[B"); input("\r");
    input(" Updated"); input("\x13");
    const frame = () => harness.panelLines(120).join("\n");
    expect(frame()).toContain("Save optimization prompt?");
    if (scenario === "write failure") { await rm(path); await mkdir(path); }
    else harness.handlers.get("session_tree")?.[0]?.({ type: "session_tree" }, harness.context);
    input("y");
    await vi.waitFor(() => expect(frame()).toContain("Not persisted"));
    expect(frame()).not.toContain("Optimization prompt saved");
    expect(frame()).toContain("› Optimization prompt");
    expect(harness.customCalls()).toBe(1);
    if (scenario === "stale generation") expect(await readFile(path, "utf8")).toBe(before);
    input("\r");
    expect(frame()).toContain(scenario === "write failure" ? `${original} Updated` : original);
    if (scenario === "stale generation") expect(frame()).not.toContain("Updated");
    input("\x1b"); input("\x1b"); input("q"); await view;
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
    expect(harness.panelLines().join("\n")).toMatch(/Default model +fake-provider\/fake-chat/);
    harness.panelInput("\r");
    await vi.waitFor(() => expect(harness.panelLines().join("\n")).toContain("Choose optimizer model"));
    const picker = () => stripVTControlCharacters(harness.panelLines(120).join("\n"));
    expect(picker()).toMatch(/Preview +Usage +Settings.*Esc Cancel.*Enter Save/);
    expect(picker()).toContain("Thinking: medium");
    harness.panelInput("\x1b[Z");
    expect(picker()).toContain("Thinking: high");
    harness.panelInput("q");
    expect(picker()).toContain("Search: q");
    expect(picker()).toContain("No matching models");
    expect(picker()).not.toContain("Enter Save");
    harness.panelInput("\x1b");
    await vi.waitFor(() => expect(harness.panelLines().join("\n")).toContain("Unsaved settings changes"));
    harness.panelInput("\x1b[D");
    expect(harness.panelLines().join("\n")).toMatch(/Project instructions +Always/);
    harness.panelInput("\t");
    harness.panelInput("\x1b[B");
    expect(harness.panelLines().join("\n")).toMatch(/Thinking +medium/);
    expect(picker()).toContain("Enter: Cycle");
    harness.panelInput("\r");
    await vi.waitFor(() => expect(harness.panelLines().join("\n")).toContain("Thinking level saved"));
    expect(harness.panelLines().join("\n")).toMatch(/Thinking +high/);
    expect(harness.panelLines().join("\n")).toContain("Extension setting. Changes save immediately.");
    expect(harness.context.thinkingLevel).toBe("medium");
    const saved = JSON.parse(await readFile(join(harness.agentDir, "prompt-refine.json"), "utf8"));
    expect(saved.thinkingLevel).toBe("high");
    expect(saved.modelThinkingLevels["fake-provider/fake-chat"]).toBe("high");
    expect(saved.projectContext.instructionsEnabled).toBe(false);
    expect(harness.customCalls()).toBe(1);
    expect(harness.complete).not.toHaveBeenCalled();
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
    const status = options.reason === "fixed for this model" ? "Fixed" : "Unavailable";
    expect(harness.panelLines().join("\n")).toMatch(new RegExp(`Thinking +${status}`));
    expect(harness.panelLines().join("\n")).toContain(options.reason);
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
    const frame = () => stripVTControlCharacters(harness.panelLines().join("\n"));
    expect(frame()).toContain("› Default model");
    expect(frame()).toContain("Esc: Back");
    expect(frame()).not.toContain("Unsaved settings changes");
    expect(harness.customCalls()).toBe(1);
    const saved = JSON.parse(await readFile(join(harness.agentDir, "prompt-refine.json"), "utf8"));
    expect(saved.projectContext.instructionsEnabled).toBe(true);
    harness.panelInput("\x1b");
    expect(frame()).not.toContain("Settings saved");
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
