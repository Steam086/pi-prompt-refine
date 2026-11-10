import type { Api, Model } from "@earendil-works/pi-ai";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { extensionHarnessEnvironment, projectConfig, refinement, shortcut, trigger } from "../support/extension-harness.js";
import { flushPromises } from "../support/helpers.js";

const { makeHarness } = extensionHarnessEnvironment();

describe("multi-model preview and unified Usage", () => {
  it("runs another model from the selected original in two keys without changing defaults", async () => {
    const harness = await makeHarness();
    const registry = harness.context.modelRegistry;
    const a = registry.getAvailable()[0]!;
    const b = { ...a, provider: "other-provider", id: "second-model", name: "Second Model" } as Model<Api>;
    vi.mocked(registry.getAvailable).mockReturnValue([a, b]);
    vi.mocked(registry.find).mockImplementation((provider, id) => [a, b].find((model) => model.provider === provider && model.id === id));
    await trigger(harness);
    const firstInput = (harness.complete.mock.calls[0] as any[])[1];
    const savedBefore = await readFile(join(harness.agentDir, "prompt-refine.json"), "utf8");
    harness.setEditorText("New editor draft");
    vi.spyOn(harness.context.sessionManager, "getBranch").mockReturnValue([]);
    harness.complete.mockResolvedValueOnce(refinement("B result"));
    harness.holdPanel();
    const view = harness.command("", harness.context);
    harness.panelInput("m");
    await flushPromises();
    expect(harness.panelLines().join("\n")).toContain("Run original with another model");
    harness.panelInput("\r");
    await flushPromises();
    expect(harness.complete).toHaveBeenCalledTimes(2);
    const call = harness.complete.mock.calls[1] as any[];
    expect(call[0]).toBe(b);
    expect(call[1].systemPrompt).toBe(firstInput.systemPrompt);
    expect(call[1].messages[0].content).toEqual(firstInput.messages[0].content);
    await vi.waitFor(() => expect(harness.panelLines().join("\n")).toContain("Run: fake-provider/fake-chat"));
    const savedAfter = JSON.parse(await readFile(join(harness.agentDir, "prompt-refine.json"), "utf8"));
    expect(savedAfter).toEqual({ ...JSON.parse(savedBefore), modelThinkingLevels: { "other-provider/second-model": "off" } });
    expect(harness.panelLines().join("\n")).toContain("Refined prompt");
    harness.panelInput("\x1b[A");
    expect(harness.panelLines().join("\n")).toContain("B result");
    harness.panelInput("\r"); harness.panelInput("c");
    expect(harness.panelLines().join("\n")).toContain("Compare results");
    expect(harness.getEditor()).toBe("New editor draft");
    expect(harness.sent).toEqual([]);
    harness.panelInput("q"); harness.panelInput("q");
    await view;
  });
  it("inspects sibling outputs without Apply and accepts the selected result directly", async () => {
    const harness = await makeHarness();
    await trigger(harness);
    harness.complete.mockResolvedValueOnce(refinement("Second candidate"));
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    harness.panelInput("g");
    await flushPromises();
    expect(harness.panelLines().join("\n")).toContain("2 runs");
    expect(harness.panelLines().join("\n")).toContain("Refined prompt");
    harness.panelInput("\x1b[A"); harness.panelInput("\r");
    expect(harness.panelLines().join("\n")).toContain("Second candidate");
    expect(harness.panelLines().join("\n")).toContain("Prompt details");
    expect(harness.editorWrites).toEqual([]);
    expect(harness.sent).toEqual([]);
    harness.panelInput("a");
    await view;
    expect(harness.getEditor()).toBe("Second candidate");
    expect(harness.complete).toHaveBeenCalledTimes(2);
  });
  it("opens history/usage commands without calls, and retains records after submission", async () => {
    const harness = await makeHarness();
    await trigger(harness);
    harness.handlers.get("message_start")?.[0]?.({ message: { role: "user", content: "Another task" } }, harness.context);
    harness.holdPanel();
    const view = harness.command("history", harness.context);
    expect(harness.panelLines().join("\n")).toContain("Draft A");
    expect(harness.panelLines()[1]).toContain("Usage");
    expect(harness.panelLines().join("\n")).toContain("Earlier ·");
    expect(harness.panelLines().join("\n")).not.toContain("0 tokens");
    harness.panelInput("q");
    harness.panelInput("q");
    harness.panelInput("q");
    await view;
    expect(harness.complete).toHaveBeenCalledTimes(1);
    expect(harness.editorWrites).toEqual([]);
    expect(harness.internalMessages).toEqual([]);
    expect(harness.sessionWrites).toEqual([]);
  });
});

describe("round workspace integration", () => {
  it("captures the first shortcut input as Unsent, permits editing, and never submits on reopen", async () => {
    const h = await makeHarness();
    h.holdPanel();
    let view = shortcut(h, "ctrl+\\")(h.context);
    expect(h.panelLines(100).join("\n")).toContain("› ○ Unsent · Draft A");
    expect(h.complete).not.toHaveBeenCalled();
    h.panelInput("q"); await view;
    view = shortcut(h, "ctrl+\\")(h.context);
    expect(h.panelLines().join("\n")).toContain("1 prompts");
    expect(h.complete).not.toHaveBeenCalled();
    h.panelInput("i"); h.panelInput(" edited 中文😀"); h.panelInput("\r");
    expect(h.panelLines(100).join("\n")).toContain("› ○ Unsent · Draft A edited");
    expect(h.panelLines(100).join("\n")).toContain("Draft A edited 中文😀");
    expect(h.complete).not.toHaveBeenCalled();
    h.panelInput("\r");
    expect(h.panelLines(100).join("\n")).toMatch(/›\s+└ fake-chat/);
    await flushPromises();
    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(JSON.parse((h.complete.mock.calls[0] as any[])[1].messages[0].content[0].text).draft).toBe("Draft A edited 中文😀");
    expect(h.panelLines().join("\n")).toContain("Refined prompt");
    expect(h.getEditor()).toBe("Draft A");
    expect(h.editorWrites).toEqual([]); expect(h.sent).toEqual([]);
    h.panelInput("d"); h.panelInput("y"); // Empty the workspace again.
    h.panelInput("q"); await view;
    view = shortcut(h, "ctrl+\\")(h.context);
    expect(h.panelLines(100).join("\n")).toContain("› ○ Unsent · Draft A");
    expect(h.complete).toHaveBeenCalledTimes(1);
    h.panelInput("q"); await view;
  });

  it("focuses a new shortcut draft over a remembered result from an earlier round", async () => {
    const harness = await makeHarness();
    await trigger(harness);
    harness.setCustomAction("q");
    await harness.command("", harness.context); // Remember the model result selection.
    harness.handlers.get("message_start")?.[0]?.({ message: { role: "user", content: "Sent A" } }, harness.context);
    harness.setEditorText("Current draft");
    harness.holdPanel();
    const view = shortcut(harness, "ctrl+\\")(harness.context);
    const lines = harness.panelLines(100).join("\n");
    expect(lines).toContain("› ○ Unsent · Current draft");
    expect(lines).toContain("Original prompt");
    expect(harness.complete).toHaveBeenCalledTimes(1);
    harness.panelInput("\r"); // No navigation is needed before starting the current draft.
    await flushPromises();
    expect(harness.complete).toHaveBeenCalledTimes(2);
    expect(JSON.parse((harness.complete.mock.calls[1] as any[])[1].messages[0].content[0].text).draft).toBe("Current draft");
    expect(harness.editorWrites).toEqual([]);
    expect(harness.sent).toEqual([]);
    harness.panelInput("q"); await view;
  });

  it("locates an existing shortcut draft instead of retaining another task or duplicating it", async () => {
    const harness = await makeHarness();
    await trigger(harness);
    harness.setEditorText("Draft B");
    harness.holdPanel();
    let view = shortcut(harness, "ctrl+\\")(harness.context);
    expect(harness.panelLines(100).join("\n")).toContain("› ○ Unsent · Draft B");
    harness.panelInput("\x1b[B"); harness.panelInput("\x1b[B"); // Browse A's model result.
    expect(harness.panelLines().join("\n")).toContain("Refined prompt");
    harness.panelInput("q"); await view;

    harness.setEditorText("");
    view = shortcut(harness, "ctrl+\\")(harness.context);
    expect(harness.panelLines().join("\n")).toContain("Refined prompt"); // Empty input restores selection.
    harness.panelInput("q"); await view;

    harness.setEditorText("Draft B");
    view = shortcut(harness, "ctrl+\\")(harness.context);
    const lines = harness.panelLines(100).join("\n");
    expect(lines).toContain("› ○ Unsent · Draft B");
    expect(lines).toContain("2 prompts");
    expect(harness.complete).toHaveBeenCalledTimes(1);
    harness.panelInput("i");
    expect(harness.panelLines().join("\n")).toContain("Draft B");
    harness.panelInput("\x1b");
    harness.panelInput("q"); await view;
  });

  it("locates the accepted result matching the editor after browsing a different task", async () => {
    const harness = await makeHarness();
    await trigger(harness);
    harness.complete.mockResolvedValueOnce(refinement("Accepted B result"));
    await harness.command("optimize Draft B", harness.context);
    await flushPromises();
    harness.setCustomAction("a");
    await harness.command("view", harness.context);
    expect(harness.getEditor()).toBe("Accepted B result");
    harness.holdPanel();
    let view = harness.command("", harness.context);
    harness.panelInput("\x1b[B"); harness.panelInput("\x1b[B");
    expect(harness.panelLines().join("\n")).toContain("Refined prompt");
    harness.panelInput("q"); await view;

    view = shortcut(harness, "ctrl+\\")(harness.context);
    expect(harness.panelLines().join("\n")).toContain("Accepted B result");
    expect(harness.panelLines().join("\n")).toContain("a Accept");
    expect(harness.panelLines().join("\n")).toContain("2 prompts");
    expect(harness.complete).toHaveBeenCalledTimes(2);
    harness.panelInput("q"); await view;
  });

  it("saves a blank/new original without a default model and runs a one-off model choice", async () => {
    const harness = await makeHarness({ configureModel: false });
    harness.holdPanel();
    const view = harness.command("", harness.context);
    harness.panelInput("n"); harness.panelInput("\r");
    expect(harness.panelLines().join("\n")).toContain("Empty prompt");
    harness.panelInput("\r");
    expect(harness.complete).not.toHaveBeenCalled();
    harness.panelInput("i"); harness.panelInput("Independent original"); harness.panelInput("\r");
    expect(harness.panelLines().join("\n")).toContain("1 prompts");
    harness.panelInput("m"); await flushPromises(); harness.panelInput("\r");
    await vi.waitFor(() => expect(harness.panelLines().join("\n")).not.toContain("Run original with another model"));
    expect(harness.complete).toHaveBeenCalledTimes(1);
    const payload = JSON.parse((harness.complete.mock.calls[0] as any[])[1].messages[0].content[0].text);
    expect(payload.draft).toBe("Independent original");
    expect(JSON.parse(await readFile(join(harness.agentDir, "prompt-refine.json"), "utf8"))).not.toHaveProperty("model");
    expect(harness.editorWrites).toEqual([]);
    harness.panelInput("q"); await view;
  });

  it("cancels a comparison picker and locates an already-running model without launching twice", async () => {
    const harness = await makeHarness();
    harness.complete.mockImplementationOnce(() => new Promise(() => {}));
    await trigger(harness);
    harness.holdPanel();
    const view = harness.command("", harness.context);
    harness.panelInput("m"); await flushPromises(); harness.panelInput("\x1b"); await flushPromises();
    expect(harness.complete).toHaveBeenCalledTimes(1);
    harness.panelInput("m"); await flushPromises();
    expect(harness.panelLines().join("\n")).toContain("Running");
    harness.panelInput("\r"); await flushPromises();
    expect(harness.complete).toHaveBeenCalledTimes(1);
    expect(harness.notifications.at(-1)).toContain("already running");
    await vi.waitFor(() => expect(harness.panelLines().join("\n")).toContain("x Stop"));
    harness.panelInput("x");
    expect((harness.complete.mock.calls[0] as any[])[2].signal.aborted).toBe(true);
    harness.panelInput("q"); await view;
  });

  it("forks an inspected result into an unsent original and returns to a runnable list", async () => {
    const harness = await makeHarness();
    await trigger(harness);
    harness.holdPanel();
    const view = harness.command("", harness.context);
    harness.panelInput("\r"); harness.panelInput("i");
    expect(harness.panelLines().join("\n")).toContain("Draft A");
    harness.panelInput(" adjusted"); harness.panelInput("\r");
    expect(harness.panelLines().join("\n")).toContain("Prompt refine · Tasks");
    expect(harness.complete).toHaveBeenCalledTimes(1);
    harness.panelInput("\r"); await flushPromises();
    expect(JSON.parse((harness.complete.mock.calls[1] as any[])[1].messages[0].content[0].text).draft).toBe("Draft A adjusted");
    expect(JSON.parse((harness.complete.mock.calls[0] as any[])[1].messages[0].content[0].text).draft).toBe("Draft A");
    harness.panelInput("q"); await view;
  });

  it("keeps an open result stable on archival but opens only current work in a fresh Preview", async () => {
    const harness = await makeHarness();
    await trigger(harness);
    harness.holdPanel();
    const view = harness.command("", harness.context);
    expect(harness.panelLines().join("\n")).toContain("Refined prompt");
    harness.panelInput("\r");
    harness.handlers.get("message_start")?.[0]?.({ message: { role: "user", content: "Sent prompt" } }, harness.context);
    expect(harness.panelLines().join("\n")).toContain("Earlier · kept open");
    expect(harness.panelLines().join("\n")).toContain("Refined prompt");
    harness.panelInput("\x1b");
    expect(harness.panelLines().join("\n")).not.toContain("Refined prompt");
    harness.panelInput("q"); await view;
    harness.holdPanel();
    const reopened = harness.command("", harness.context);
    expect(harness.panelLines().join("\n")).not.toContain("Refined prompt");
    harness.panelInput("\x1b[C");
    expect(harness.panelLines().join("\n")).toContain("Earlier ·");
    expect(harness.panelLines().join("\n")).toContain("Refined prompt");
    harness.panelInput("q"); harness.panelInput("q"); await reopened;
    expect(harness.complete).toHaveBeenCalledTimes(1);
    expect(harness.editorWrites).toEqual([]);
    expect(harness.sent).toEqual([]);
  });

  it("archives on committed Pi send, preserves background work, and captures the next context lazily", async () => {
    const harness = await makeHarness();
    let finish!: (value: any) => void;
    harness.complete.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await trigger(harness);
    const signal = (harness.complete.mock.calls[0] as any[])[2].signal as AbortSignal;
    harness.handlers.get("input")?.[0]?.({ text: "Sent prompt", source: "interactive" }, harness.context);
    harness.handlers.get("before_agent_start")?.[0]?.({ messageType: "user", prompt: "Sent prompt" }, harness.context);
    expect(signal.aborted).toBe(false);
    harness.handlers.get("message_start")?.[0]?.({ message: { role: "user", content: "Sent prompt" } }, harness.context);
    expect(signal.aborted).toBe(false);
    vi.spyOn(harness.context.sessionManager, "getBranch").mockReturnValue([
      { type: "message", message: { role: "assistant", content: "Latest available response" } },
    ] as any);
    harness.setEditorText("Next round draft");
    harness.holdPanel();
    const view = shortcut(harness, "ctrl+\\")(harness.context);
    expect(harness.complete).toHaveBeenCalledTimes(1);
    expect(harness.panelLines().join("\n")).toContain("Unsent");
    harness.panelInput("\r");
    await flushPromises();
    expect(harness.complete).toHaveBeenCalledTimes(2);
    const second = JSON.parse((harness.complete.mock.calls[1] as any[])[1].messages[0].content[0].text);
    expect(second.draft).toBe("Next round draft");
    expect(second.conversation.items[0].text).toBe("Latest available response");
    harness.panelInput("\r"); // The submitted run is already selected; inspect it.
    expect(harness.panelLines().join("\n")).toContain("Refined prompt");
    finish(refinement("Earlier round result"));
    await flushPromises();
    expect(harness.panelLines().join("\n")).not.toContain("Earlier round result");
    harness.panelInput("\x1b[C"); // Usage includes old rounds below current work.
    for (let i = 0; i < 4; i++) harness.panelInput("\x1b[B");
    expect(harness.panelLines().join("\n")).toContain("Earlier ·");
    expect(harness.panelLines().join("\n")).toContain("Earlier round result");
    harness.panelInput("\r");
    expect(harness.panelLines().join("\n")).toContain("Earlier round result");
    expect(harness.editorWrites).toEqual([]);
    expect(harness.sent).toEqual([]);
    expect(harness.setSessionName).not.toHaveBeenCalled();
    harness.panelInput("q");
    harness.panelInput("q");
    harness.panelInput("q");
    harness.panelInput("q");
    await view;
  });

  it("validates the applied result's model for revision, independently of the next launch model", async () => {
    const harness = await makeHarness();
    const registry = harness.context.modelRegistry;
    const a = registry.getAvailable()[0]!;
    const b = { ...a, id: "second" } as Model<Api>;
    vi.mocked(registry.getAvailable).mockReturnValue([a, b]);
    vi.mocked(registry.find).mockImplementation((provider, id) => [a, b].find((model) => model.provider === provider && model.id === id));
    await trigger(harness);
    harness.setCustomAction(["\x1b[B", "\r"]);
    await harness.command("model", harness.context);
    vi.mocked(registry.getAvailable).mockReturnValue([b]);
    vi.mocked(registry.find).mockImplementation((provider, id) => provider === b.provider && id === b.id ? b : undefined);
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    harness.panelInput("f");
    harness.panelInput("Shorter");
    harness.panelInput("\x13");
    expect(harness.panelLines().join("\n")).toContain("missing or unavailable");
    expect(harness.complete).toHaveBeenCalledTimes(1);
    expect(harness.editorWrites).toEqual([]);
    harness.panelInput("\x1b");
    harness.panelInput("q");
    await view;
  });

  it("edits an archived unsent prompt as a new draft without changing the original snapshot", async () => {
    const harness = await makeHarness();
    await trigger(harness);
    harness.setEditorText("Pending B");
    harness.setCustomAction("q");
    await shortcut(harness, "ctrl+\\")(harness.context);
    harness.handlers.get("message_start")?.[0]?.({ message: { role: "user", content: "Sent A" } }, harness.context);
    vi.spyOn(harness.context.sessionManager, "getBranch").mockReturnValue([]);
    harness.holdPanel();
    const view = harness.command("usage", harness.context);
    harness.panelInput("\x1b[A"); harness.panelInput("\x1b[A");
    expect(harness.panelLines().join("\n")).toContain("Earlier context");
    harness.panelInput("i");
    expect(harness.panelLines().join("\n")).toContain("Edit original prompt");
    expect(harness.panelLines().join("\n")).toContain("Pending B");
    harness.panelInput("\r");
    expect(harness.complete).toHaveBeenCalledTimes(1);
    harness.panelInput("\r");
    await flushPromises();
    const payload = JSON.parse((harness.complete.mock.calls[1] as any[])[1].messages[0].content[0].text);
    expect(payload.draft).toBe("Pending B");
    expect(payload.conversation.items).toEqual([]);
    expect(harness.getEditor()).toBe("Pending B");
    expect(harness.editorWrites).toEqual([]);
    harness.panelInput("q"); harness.panelInput("q");
    await view;
  });
  it("shares directory-enriched packets across overlapping model runs without cancellation or rescan", async () => {
    const harness = await makeHarness({ config: { projectContext: projectConfig(true) } });
    vi.spyOn(harness.context.sessionManager, "getBranch").mockReturnValue([]);
    await mkdir(join(harness.agentDir, "src"));
    await writeFile(join(harness.agentDir, "src", "frozen.ts"), "not read");
    const registry = harness.context.modelRegistry;
    const a = registry.getAvailable()[0]!;
    const b = { ...a, id: "second" } as Model<Api>;
    vi.mocked(registry.getAvailable).mockReturnValue([a, b]);
    vi.mocked(registry.find).mockImplementation((provider, id) => [a, b].find((model) => model.provider === provider && model.id === id));
    const pending = new Map<string, (value: any) => void>();
    harness.complete.mockImplementation((model: Model<Api>) => new Promise((resolve) => { pending.set(model.id, resolve); }));
    harness.setEditorText("Explain @src");
    await trigger(harness);
    await vi.waitFor(() => expect(harness.complete).toHaveBeenCalledTimes(1));
    harness.holdPanel();
    const view = shortcut(harness, "ctrl+\\")(harness.context);
    harness.panelInput("\x1b[B"); // Inspect/select the running child.
    harness.panelInput("m");
    await flushPromises();
    await writeFile(join(harness.agentDir, "src", "later.ts"), "not read");
    harness.panelInput("\r");
    await vi.waitFor(() => expect(harness.complete).toHaveBeenCalledTimes(2));
    expect((harness.complete.mock.calls[0] as any[])[2].signal.aborted).toBe(false);
    const first = (harness.complete.mock.calls[0] as any[])[1];
    const second = (harness.complete.mock.calls[1] as any[])[1];
    expect(second.systemPrompt).toBe(first.systemPrompt);
    expect(second.messages[0].content).toEqual(first.messages[0].content);
    harness.panelInput("x"); // Stops only the selected first model.
    pending.get(a.id)!(refinement("Cancelled late result"));
    pending.get(b.id)!(refinement("Second result"));
    await flushPromises();
    expect(harness.panelLines().join("\n")).not.toContain("Cancelled late result");
    harness.panelInput("\x1b[A");
    expect(harness.panelLines().join("\n")).toContain("Second result");
    harness.panelInput("q");
    await view;
  });
});
