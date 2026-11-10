import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { PreferenceStore } from "../../src/preference-store.js";
import { screenDraft } from "../fixtures/reference-preservation.js";
import { extensionHarnessEnvironment, panelAction, refinement, shortcut, trigger } from "../support/extension-harness.js";
import { flushPromises } from "../support/helpers.js";

const { makeHarness } = extensionHarnessEnvironment();

describe("source preservation in the provider path", () => {
  it("retains the complete draft and warns when a model discards a pasted TUI reference", async () => {
    const h = await makeHarness({ persistHistory: true });
    h.setEditorText(screenDraft);
    h.complete.mockResolvedValueOnce(refinement("右侧的正文部分是不是太靠下了？讨论能否删掉一部分。", "Misleading generated title"));
    await trigger(h);
    expect(h.notifications.some((message) => message.includes("omitted most of a pasted TUI reference"))).toBe(true);
    expect(h.getEditor()).toBe(screenDraft); // Never auto-accept.
    expect(h.getSessionName()).toBeUndefined(); // Discard the unsafe result's title too.
    await vi.waitFor(async () => {
      const saved = JSON.parse(await readFile(`${h.context.sessionManager.getSessionFile()}.prompt-refine.json`, "utf8"));
      expect(saved.records[0].result).toBe(screenDraft);
    });
    expect(h.context.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Original draft kept"), "warning");
    await panelAction(h, "a");
    expect(h.getSessionName()).toBeUndefined(); // Also after explicit acceptance.
  });

  it.each(["rewrite", "task"] as const)("respects the scope of a selected %s removal preference", async (kind) => {
    const h = await makeHarness();
    const store = new PreferenceStore(h.agentDir, h.context.cwd);
    await store.save("project", { name: "Removal", body: "Remove the screenshot.",
      metadata: { kind, description: "Removal scope", activation: "manual" } });
    h.setEditorText(screenDraft);
    h.complete.mockResolvedValueOnce(refinement("Right side too low?", "Layout question"));
    h.holdPanel(); const view = shortcut(h, "ctrl+\\")(h.context);
    h.panelInput("p");
    await vi.waitFor(() => expect(h.panelLines().join("\n")).toContain("Removal"));
    h.panelInput(" "); h.panelInput("\x1b[13;3u");
    h.panelInput("\r"); await flushPromises();
    const packet = JSON.parse((h.complete.mock.calls[0] as any[])[1].messages[0].content[0].text);
    expect(packet.editing_instruction).toContain("Remove the screenshot.");
    expect(h.notifications.some((message) => message.includes("Original draft kept"))).toBe(kind === "task");
    h.panelInput("a"); await view; await flushPromises();
    expect(h.getEditor()).toBe(kind === "rewrite" ? "Right side too low?" : screenDraft);
    expect(h.getSessionName()).toBe(kind === "rewrite" ? "Layout question" : undefined);
  });

  it.each(["length", "toolUse", "error", "invalid-json"])("never turns %s into a successful original-draft fallback", async (failure) => {
    const h = await makeHarness();
    h.setEditorText(screenDraft);
    h.complete.mockResolvedValueOnce(failure === "invalid-json"
      ? { content: [{ type: "text", text: "Not JSON" }], stopReason: "stop" }
      : { ...refinement("Right side too low?", "Unsafe title"), stopReason: failure });
    await trigger(h);
    expect(h.widgetLines().join("\n")).toContain("1 failed");
    expect(h.notifications.join("\n")).not.toContain("Original draft kept");
    expect(h.editorWrites).toEqual([]);
  });

  it("does not warn for a canceled provider result arriving late", async () => {
    const h = await makeHarness();
    h.setEditorText(screenDraft);
    let resolve!: (value: ReturnType<typeof refinement>) => void;
    h.complete.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    await trigger(h);
    await h.command("cancel", h.context);
    resolve(refinement("Right side too low?", "Unsafe title"));
    await flushPromises();
    expect(h.notifications.join("\n")).not.toContain("Original draft kept");
    expect(h.editorWrites).toEqual([]);
  });

  it("does not restore the original reference during Revise", async () => {
    const h = await makeHarness();
    h.setEditorText(screenDraft);
    h.complete.mockResolvedValueOnce(refinement(screenDraft, "Layout"));
    await trigger(h);
    h.holdPanel(); const view = h.command("view", h.context);
    h.panelInput("f"); h.panelInput("Remove the screenshot.");
    h.complete.mockResolvedValueOnce(refinement("Right side too low?", "Layout question"));
    h.panelInput("\x13"); await flushPromises();
    expect(h.notifications.join("\n")).not.toContain("Original draft kept");
    h.panelInput("a"); await view; await flushPromises();
    expect(h.getEditor()).toBe("Right side too low?");
  });
});

describe("Pi extension integration (mocked TUI and provider)", () => {

  it("accepts an unchanged draft as a successful refinement without retrying or sending it", async () => {
    const harness = await makeHarness();
    const draft = "把标题改成“运行结果”，其他内容保持不变。";
    harness.setEditorText(draft);
    harness.complete.mockResolvedValueOnce({ content: [{ type: "text", text: JSON.stringify({ prompt: draft }) }], stopReason: "stop" });
    await trigger(harness);
    harness.setCustomAction("a");
    await harness.command("view", harness.context);
    expect(harness.getEditor()).toBe(draft);
    expect(harness.complete).toHaveBeenCalledTimes(1);
    expect(harness.sent).toEqual([]);
    expect(harness.notifications.join(" ")).not.toContain("failed");
  });

  it("sends the selected user correction and omission metadata to the optimizer, not just the UI", async () => {
    const harness = await makeHarness({ config: { context: { maxMessages: 1, maxChars: 100 } } });
    vi.spyOn(harness.context.sessionManager, "getBranch").mockReturnValue([
      { type: "message", id: "proposal", message: { role: "assistant", content: "Implement with a new dependency" } },
      { type: "message", id: "correction", message: { role: "user", content: "不要新增依赖，先只解释方案。" } },
    ] as any);
    harness.setEditorText("继续看这个方案");
    await trigger(harness);
    const packet = JSON.parse((harness.complete.mock.calls[0] as any[])[1].messages[0].content[0].text);
    expect(packet.conversation).toMatchObject({
      status: "partial", total_message_count: 2, omitted_message_count: 1, excerpted_message_count: 0,
      items: [{ id: "correction", role: "user", status: "complete", text: "不要新增依赖，先只解释方案。" }],
    });
    expect(packet.draft).toBe("继续看这个方案");
    expect(harness.complete).toHaveBeenCalledTimes(1);
  });

  it("budgets the actual request, warns on pruning and restores full frozen background for a larger model", async () => {
    const harness = await makeHarness();
    const registry = harness.context.modelRegistry;
    const small = registry.getAvailable()[0]!;
    small.contextWindow = 9000;
    const large = { ...small, id: "larger", name: "Larger", contextWindow: 128_000 };
    vi.mocked(registry.getAvailable).mockReturnValue([small, large]);
    vi.mocked(registry.find).mockImplementation((provider, id) => [small, large].find((model) => model.provider === provider && model.id === id));
    vi.spyOn(harness.context.sessionManager, "getBranch").mockReturnValue([
      { type: "message", id: "old", message: { role: "assistant", content: "OLD".repeat(3000) } },
      { type: "message", id: "latest", message: { role: "user", content: "Do not implement" } },
    ] as any);
    await trigger(harness);
    const first = harness.complete.mock.calls[0] as any[];
    expect(first).toBeDefined();
    const firstPacket = JSON.parse(first[1].messages[0].content[0].text);
    expect(firstPacket.draft).toBe("Draft A");
    expect(firstPacket.budget_omissions).toBeDefined();
    const tokens = Math.ceil(Buffer.byteLength(first[1].systemPrompt) / 3) + Math.ceil(Buffer.byteLength(first[1].messages[0].content[0].text) / 3);
    expect(tokens + first[2].maxTokens + 4096 + Math.ceil(small.contextWindow * 0.01)).toBeLessThanOrEqual(small.contextWindow);
    expect(harness.notifications.join(" ")).toContain("Budget trimmed background");
    harness.holdPanel();
    const view = harness.command("", harness.context);
    expect(harness.panelLines(60).join("\n")).toContain("⚠");
    harness.panelInput("m"); await flushPromises();
    harness.panelInput("\r"); await flushPromises();
    expect(harness.complete).toHaveBeenCalledTimes(2);
    const second = harness.complete.mock.calls[1] as any[];
    expect(second[0]).toBe(large);
    expect(JSON.parse(second[1].messages[0].content[0].text).conversation.items).toHaveLength(2);
    expect(second[1].messages[0].content[0].text).toContain("OLD".repeat(3000));
    expect(harness.editorWrites).toEqual([]);
    await vi.waitFor(() => expect(harness.panelLines().join("\n")).not.toContain("Run original with another model"));
    harness.panelInput("q"); harness.panelInput("q"); await view;
  });

  it.each(["context", "unknown"])("blocks before the provider on %s budget failure, preserving the editor and warning in the UI", async (kind) => {
    const harness = await makeHarness();
    const model = harness.context.modelRegistry.getAvailable()[0]!;
    if (kind === "context") model.contextWindow = 5000;
    if (kind === "unknown") model.contextWindow = NaN;
    await trigger(harness);
    expect(harness.context.modelRegistry.streamSimple).not.toHaveBeenCalled();
    expect(harness.notifications.join(" ")).toContain("Request not sent");
    expect(harness.notifications.join(" ")).toContain("Draft unchanged");
    expect(harness.getEditor()).toBe("Draft A");
    expect(harness.editorWrites).toEqual([]);
    harness.holdPanel();
    const view = harness.command("usage", harness.context);
    expect(harness.panelLines(60).join("\n")).toContain("⚠");
    harness.panelInput("q"); harness.panelInput("q"); await view;
  });

  it("sends a small request with legacy 2048 output and inherited high thinking", async () => {
    const harness = await makeHarness({ reasoning: true, thinkingLevel: "high", config: { maxOutputTokens: 2048 } });
    await trigger(harness);
    expect(harness.complete).toHaveBeenCalledTimes(1);
    const call = harness.complete.mock.calls[0] as any[];
    expect(call[2]).toMatchObject({ maxTokens: 2048, reasoning: "high" });
    expect(harness.notifications.join(" ")).not.toContain("Request not sent");
    expect(harness.editorWrites).toEqual([]);
  });

  it("reports DeepSeek reasoning exhaustion without accepting a partial result or retrying automatically", async () => {
    const harness = await makeHarness({ reasoning: true, thinkingLevel: "max", config: { maxOutputTokens: 2048 } });
    const model = harness.context.modelRegistry.getAvailable()[0]!;
    model.api = "openai-completions";
    model.compat = { thinkingFormat: "deepseek" };
    model.thinkingLevelMap = { max: "max" };
    harness.complete.mockResolvedValueOnce({
      content: [{ type: "thinking", thinking: "Synthetic reasoning" }], stopReason: "length",
      usage: { input: 1513, cacheRead: 256, cacheWrite: 0, output: 2048, reasoning: 2048, totalTokens: 3817 },
    });
    await trigger(harness);
    expect(harness.complete).toHaveBeenCalledTimes(1);
    const call = harness.complete.mock.calls[0] as any[];
    expect(call[2]).toMatchObject({ maxTokens: 2048, reasoning: "max" });
    expect(call[2]).not.toHaveProperty("thinkingBudgets");
    expect(harness.notifications.join(" ")).toContain("cannot reserve answer space");
    await panelAction(harness, "q");
    expect(harness.panelLines(100).join(" ")).toContain("All reported output tokens were reasoning");
    expect(harness.getEditor()).toBe("Draft A");
    expect(harness.editorWrites).toEqual([]);
    expect(harness.sessionWrites).toEqual([]);
  });

  it("keeps total output inside the configured and model ceiling when reasoning is enabled", async () => {
    const harness = await makeHarness({ reasoning: true, thinkingLevel: "high" });
    const model = harness.context.modelRegistry.getAvailable()[0]!;
    model.maxTokens = 6000;
    await trigger(harness);
    const call = harness.complete.mock.calls[0] as any[];
    expect(call[2].reasoning).toBe("high");
    expect(call[2].thinkingBudgets.high).toBeGreaterThanOrEqual(1024);
    expect(call[2].maxTokens).toBeLessThanOrEqual(model.maxTokens);
  });

  it("runs the optimizer in the background without writing the editor or session", async () => {
    const harness = await makeHarness();
    await trigger(harness);

    expect(harness.complete).toHaveBeenCalledTimes(1);
    const [_model, completionContext, completionOptions] = harness.complete.mock.calls[0] as any[];
    expect(completionContext.tools).toEqual([]);
    expect(completionContext.systemPrompt).toContain("Return exactly one JSON object");
    expect(completionContext.messages[0].content[0].text).toContain("Draft A");
    expect(completionContext.messages[0].content[0].text).toContain("visible answer");
    expect(completionContext.messages[0].content[0].text).not.toContain("secret");
    expect(completionOptions.maxTokens).toBe(DEFAULT_CONFIG.maxOutputTokens);
    expect(harness.getEditor()).toBe("Draft A");
    expect(harness.editorWrites).toEqual([]);
    expect(harness.sent).toEqual([]);
    expect(harness.internalMessages).toEqual([]);
    expect(harness.sessionWrites).toEqual([]);
    expect(harness.context.sessionManager.getBranch()).toHaveLength(3);
  });

  it("sends the last visible assistant alongside a newer user message when two slots are available", async () => {
    const harness = await makeHarness({ config: { context: { maxMessages: 2, maxChars: 100 } } });
    vi.spyOn(harness.context.sessionManager, "getBranch").mockReturnValue([
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Use the existing parser, not a new dependency." }, { type: "thinking", thinking: "hidden" }] } },
      { type: "message", message: { role: "user", content: "Follow up" } },
    ] as any);
    await trigger(harness);
    const context = (harness.complete.mock.calls[0] as any[])[1];
    const sent = context.messages[0].content[0].text;
    expect(sent).toContain("Use the existing parser, not a new dependency.");
    expect(sent).toContain("Draft A");
    expect(sent).not.toContain("hidden");
  });

  it("respects explicit zero history budgets and makes draft-only mode visible", async () => {
    const harness = await makeHarness({ config: { context: { maxMessages: 0, maxChars: 100 } } });
    await trigger(harness);
    const context = (harness.complete.mock.calls[0] as any[])[1];
    expect(context.messages[0].content[0].text).not.toContain("visible answer");
    expect(JSON.parse(context.messages[0].content[0].text).conversation).toMatchObject({
      status: "disabled_by_policy", omitted_message_count: 2, selected_message_count: 0,
    });
  });
});
