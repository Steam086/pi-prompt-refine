import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { extensionHarnessEnvironment, projectConfig, resourcePrompt, shortcut, trigger } from "../support/extension-harness.js";
import { flushPromises } from "../support/helpers.js";

const { makeHarness } = extensionHarnessEnvironment();

describe("project context injection", () => {
  it.each([
    { history: true, tree: true }, { history: true, tree: false },
    { history: false, tree: true }, { history: false, tree: false },
  ])("injects explicit directories independently of history=$history and default tree=$tree", async ({ history, tree }) => {
    const settings = projectConfig(tree);
    settings.tree.timeoutMs = 2000;
    const harness = await makeHarness({ config: { projectContext: settings }, sessionName: "Existing title" });
    await mkdir(join(harness.agentDir, "src"));
    await writeFile(join(harness.agentDir, "src", "target.ts"), "PRIVATE SOURCE BODY");
    await writeFile(join(harness.agentDir, "unrelated-root.txt"), "");
    if (!history) vi.spyOn(harness.context.sessionManager, "getBranch").mockReturnValue([]);
    vi.spyOn(harness.context, "getSystemPrompt").mockReturnValue(resourcePrompt());
    harness.setEditorText("Explain @src without edits");
    await trigger(harness);
    await vi.waitFor(() => expect(harness.complete).toHaveBeenCalledTimes(1));
    const request = (harness.complete.mock.calls[0] as any[])[1];
    const input = request.messages[0].content[0].text;
    expect(JSON.parse(input).project_context).toContain('REFERENCED DIRECTORY: "src"');
    // Default tree and explicit references are independently frozen scopes.
    expect(input.match(/target\.ts/g)).toHaveLength(!history && tree ? 2 : 1);
    expect(input).toContain("Use the project venv.");
    expect(input).toContain("Extract PDF tables");
    expect(input).toContain("Explain @src without edits");
    expect(input).not.toContain("PRIVATE SOURCE BODY");
    expect(input.includes("visible answer")).toBe(history);
    expect(input.includes("unrelated-root.txt")).toBe(!history && tree);
    expect(request.systemPrompt).toContain("Do not generate a title");
    expect(request.tools).toEqual([]);
    expect(harness.sent).toEqual([]);
    expect(harness.editorWrites).toEqual([]);
  });

  it("reuses the final directory-enriched input for g without rescanning files or rules", async () => {
    const harness = await makeHarness({ config: { projectContext: projectConfig(false) } });
    await mkdir(join(harness.agentDir, "src"));
    await writeFile(join(harness.agentDir, "src", "original.ts"), "");
    vi.spyOn(harness.context, "getSystemPrompt").mockReturnValue(resourcePrompt());
    harness.setEditorText("Explain @src");
    await trigger(harness);
    await vi.waitFor(() => expect(harness.complete).toHaveBeenCalledTimes(1));
    await flushPromises();
    const first = (harness.complete.mock.calls[0] as any[])[1];
    expect(first.messages[0].content[0].text).toContain("original.ts");
    await writeFile(join(harness.agentDir, "src", "new.ts"), "");
    vi.mocked(harness.context.getSystemPrompt).mockReturnValue("Different rules");
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    harness.panelInput("g");
    await flushPromises();
    expect(harness.complete).toHaveBeenCalledTimes(2);
    const second = (harness.complete.mock.calls[1] as any[])[1];
    expect(second.messages[0].content).toEqual(first.messages[0].content);
    expect(second.systemPrompt).toBe(first.systemPrompt);
    expect(second.messages[0].content[0].text).not.toContain("new.ts");
    harness.panelInput("q");
    await view;
  });

  it.each(["references", "project"])("respects the %s opt-out with explicit directories", async (disabled) => {
    const settings = projectConfig(false);
    if (disabled === "references") settings.referencedDirectories.enabled = false;
    else settings.enabled = false;
    const harness = await makeHarness({ config: { projectContext: settings } });
    await mkdir(join(harness.agentDir, "src"));
    await writeFile(join(harness.agentDir, "src", "target.ts"), "");
    harness.setEditorText("Explain @src");
    await trigger(harness);
    const input = (harness.complete.mock.calls[0] as any[])[1].messages[0].content[0].text;
    expect(input).toContain("Explain @src");
    expect(input).not.toContain("REFERENCED DIRECTORY:");
    expect(input).not.toContain("target.ts");
  });

  it.each(["references", "project"])("applies the Settings %s switch independently on the next round", async (disabled) => {
    const harness = await makeHarness({ config: { projectContext: projectConfig(false) } });
    await mkdir(join(harness.agentDir, "src"));
    await writeFile(join(harness.agentDir, "src", "target.ts"), "");
    vi.spyOn(harness.context, "getSystemPrompt").mockReturnValue(resourcePrompt());
    harness.setEditorText("Explain @src"); await trigger(harness);
    await vi.waitFor(() => expect(harness.complete).toHaveBeenCalledOnce());
    const packet = (index: number) => JSON.parse((harness.complete.mock.calls[index] as any[])[1].messages[0].content[0].text);
    expect(packet(0).project_context).toContain("target.ts");
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    harness.panelInput("\x1b[D");
    for (let i = 0; i < (disabled === "project" ? 3 : 4); i++) harness.panelInput("\x1b[B");
    harness.panelInput(" "); harness.panelInput("\x13");
    await vi.waitFor(() => expect(harness.panelLines().join("\n")).toContain("Settings saved"));
    harness.panelInput("q"); await view;
    harness.handlers.get("message_start")?.[0]?.({ message: { role: "user", content: "Sent" } }, harness.context);
    harness.setEditorText("Explain @src again"); await trigger(harness);
    await vi.waitFor(() => expect(harness.complete).toHaveBeenCalledTimes(2));
    const second = packet(1);
    expect(second.project_context ?? "").not.toContain("target.ts");
    expect(second.conversation.items).toHaveLength(2);
    if (disabled === "project") expect(second.project_context).toBeNull();
    else {
      expect(second.project_context).toContain("Use the project venv.");
      expect(second.project_context).toContain("Extract PDF tables");
    }
  });

  it("does not collect directories mentioned only in visible history", async () => {
    const harness = await makeHarness({ config: { projectContext: projectConfig(true) } });
    await mkdir(join(harness.agentDir, "src"));
    await writeFile(join(harness.agentDir, "src", "history-only.ts"), "");
    vi.spyOn(harness.context.sessionManager, "getBranch").mockReturnValue([
      { type: "message", message: { role: "user", content: "Previously inspect @src" } },
    ] as any);
    harness.setEditorText("Explain the previous decision");
    await trigger(harness);
    const input = (harness.complete.mock.calls[0] as any[])[1].messages[0].content[0].text;
    expect(input).toContain("Previously inspect @src");
    expect(input).not.toContain("REFERENCED DIRECTORY:");
    expect(input).not.toContain("history-only.ts");
    expect(input).not.toContain("PROJECT TREE");
  });

  it("warns on unavailable directory references without blocking refinement or expanding file contents", async () => {
    const harness = await makeHarness({ config: { projectContext: projectConfig(false) } });
    await writeFile(join(harness.agentDir, "file.ts"), "PRIVATE FILE BODY");
    harness.setEditorText("Explain @missing/ and @file.ts");
    await trigger(harness);
    await vi.waitFor(() => expect(harness.complete).toHaveBeenCalledTimes(1));
    const input = (harness.complete.mock.calls[0] as any[])[1].messages[0].content[0].text;
    expect(input).toContain("Directory reference");
    expect(input).toContain("missing or unreadable");
    expect(input).not.toContain("PRIVATE FILE BODY");
    expect(harness.notifications.join(" ")).toContain("missing or unreadable");
  });

  it("uses only the captured draft's directory references despite subsequent editor changes", async () => {
    const harness = await makeHarness({ config: { projectContext: projectConfig(false) } });
    await mkdir(join(harness.agentDir, "src"));
    await writeFile(join(harness.agentDir, "src", "captured.ts"), "");
    harness.setEditorText("Inspect @src");
    await harness.command("optimize", harness.context);
    harness.setEditorText("Inspect @missing instead");
    await vi.waitFor(() => expect(harness.complete).toHaveBeenCalledTimes(1));
    const input = (harness.complete.mock.calls[0] as any[])[1].messages[0].content[0].text;
    expect(input).toContain("captured.ts");
    expect(input).not.toContain("@missing");
    expect(harness.getEditor()).toBe("Inspect @missing instead");
  });

  it("cancels explicit directory collection with visible history and default tree disabled", async () => {
    const harness = await makeHarness({ config: { projectContext: projectConfig(false) } });
    harness.setEditorText("Inspect @missing");
    await harness.command("optimize", harness.context);
    await harness.command("cancel", harness.context);
    await flushPromises();
    expect(harness.complete).not.toHaveBeenCalled();
    expect(harness.widgetLines()).toEqual([]);
    expect(harness.notifications).toEqual([
      "Prompt Refine: Use Ctrl + \\ to refine your prompt.",
      "Refinement cancelled. Editor unchanged.",
    ]);
  });

  it.each([false, true])("includes opted-in per-request instructions with followUp=%s, independent of history budget", async (followUp) => {
    const config = structuredClone(DEFAULT_CONFIG.projectContext);
    config.instructionsEnabled = true;
    expect(config.instructionsOnFollowUp).toBe(true);
    const harness = await makeHarness({ config: { projectContext: config, context: { maxMessages: 0, maxChars: 0 } } });
    vi.spyOn(harness.context.sessionManager, "getBranch").mockReturnValue(followUp
      ? [{ type: "message", message: { role: "user", content: "Earlier prompt" } }] as any : []);
    vi.spyOn(harness.context, "getSystemPrompt").mockReturnValue(resourcePrompt());
    await trigger(harness);
    const input = (harness.complete.mock.calls[0] as any[])[1].messages[0].content[0].text;
    expect(input).toContain("Use the project venv.");
    expect(input).toContain("/repo/AGENTS.md");
    expect(input).not.toContain("Extract PDF tables");
  });

  it.each([false, true].flatMap((hasHistory) =>
    ([["Always", 0], ["Off", 1], ["First request only", 2]] as const).map(([mode, presses]) => ({ hasHistory, mode, presses }))))
    ("persists $mode for new tasks and Revise independently of main history (history: $hasHistory)", async ({ hasHistory, mode, presses }) => {
      const config = projectConfig(false);
      const harness = await makeHarness({ config: { projectContext: config } });
      if (!hasHistory) vi.spyOn(harness.context.sessionManager, "getBranch").mockReturnValue([]);
      vi.spyOn(harness.context, "getSystemPrompt").mockReturnValue(resourcePrompt());
      harness.holdPanel();
      const settings = harness.command("view", harness.context);
      harness.panelInput("\x1b[D");
      for (let i = 0; i < presses; i++) harness.panelInput(" ");
      expect(harness.panelLines().join("\n")).toMatch(new RegExp(`Project instructions +${mode}`));
      harness.panelInput("\x13");
      await vi.waitFor(() => expect(harness.panelLines().join("\n")).toContain("Settings saved · Context applies to next round"));
      harness.panelInput("q");
      await settings;
      const saved = JSON.parse(await readFile(join(harness.agentDir, "prompt-refine.json"), "utf8"));
      expect(saved.projectContext.instructionsEnabled).toBe(mode !== "Off");
      expect(saved.projectContext.instructionsOnFollowUp).toBe(mode !== "First request only");
      await harness.reload();
      await trigger(harness);
      const inputAt = (index: number) => (harness.complete.mock.calls[index] as any[])[1].messages[0].content[0].text as string;
      expect(inputAt(0).includes("Use the project venv.")).toBe(mode !== "Off");
      const view = harness.command("view", harness.context);
      for (let i = 1; i <= 2; i++) {
        harness.panelInput("f");
        harness.panelInput("Make it shorter");
        harness.panelInput("\x13");
        await flushPromises();
        expect(harness.complete).toHaveBeenCalledTimes(i + 1);
        expect(inputAt(i).includes("Use the project venv.")).toBe(mode === "Always");
        expect(inputAt(i)).toContain("Extract PDF tables");
      }
      harness.panelInput("q");
      await view;
      await harness.command("optimize A new task", harness.context);
      await flushPromises();
      expect(inputAt(3).includes("Use the project venv.")).toBe(mode !== "Off");
      expect(harness.editorWrites).toEqual([]);
    });

  it("injects frozen resources only after explicitly starting the first shortcut draft", async () => {
    const harness = await makeHarness({ config: { projectContext: projectConfig(true) } });
    vi.spyOn(harness.context.sessionManager, "getBranch").mockReturnValue([]);
    const systemPrompt = vi.spyOn(harness.context, "getSystemPrompt").mockReturnValue(resourcePrompt());
    harness.holdPanel();
    const view = shortcut(harness, "ctrl+\\")(harness.context);
    expect(harness.complete).not.toHaveBeenCalled();
    expect(harness.panelLines().join("\n")).toContain("Unsent");
    systemPrompt.mockReturnValue("Resources changed after capture");
    harness.panelInput("\r");
    await vi.waitFor(() => expect(harness.complete).toHaveBeenCalledTimes(1));
    const request = (harness.complete.mock.calls[0] as any[])[1];
    const input = request.messages[0].content[0].text;
    expect(input).toContain("Use the project venv.");
    expect(input).toContain("Extract PDF tables");
    expect(input).toContain("PROJECT TREE");
    expect(input).toContain("prompt-refine.json");
    expect(input).not.toContain("PRIVATE MAIN AGENT TOOLS");
    expect(input).not.toContain("Use bash to load skills");
    expect(request.tools).toEqual([]);
    expect(harness.notifications).toEqual(["Prompt Refine: Use Ctrl + \\ to refine your prompt."]);
    expect(harness.getEditor()).toBe("Draft A");
    expect(harness.sent).toEqual([]);
    expect(harness.sessionWrites).toEqual([]);
    harness.panelInput("q"); await view;
  });

  it.each(["user", "assistant"] as const)("omits tree with selected %s history, including on the first optimization", async (role) => {
    const harness = await makeHarness({ config: { projectContext: projectConfig(true) } });
    const branch = vi.spyOn(harness.context.sessionManager, "getBranch").mockReturnValue([
      { type: "message", message: { role, content: "Selected visible history" } },
    ] as any);
    vi.spyOn(harness.context, "getSystemPrompt").mockReturnValue(resourcePrompt());
    await trigger(harness);
    const input = (harness.complete.mock.calls[0] as any[])[1].messages[0].content[0].text;
    expect(JSON.parse(input).conversation.items).toEqual([
      expect.objectContaining({ role, text: "Selected visible history", status: "complete" }),
    ]);
    expect(input).toContain("/repo/AGENTS.md");
    expect(input).toContain("Use the project venv.");
    expect(input).toContain("Extract PDF tables");
    expect(input).not.toContain("PROJECT TREE");
    expect(input).not.toContain("prompt-refine.json");

    // After send, the next round captures the latest available history.
    harness.handlers.get("message_start")?.[0]?.({ message: { role: "user", content: "Sent" } }, harness.context);
    branch.mockReturnValue([]);
    await trigger(harness);
    await vi.waitFor(() => expect(harness.complete).toHaveBeenCalledTimes(2));
    const nextInput = (harness.complete.mock.calls[1] as any[])[1].messages[0].content[0].text;
    expect(nextInput).toContain("PROJECT TREE");
    expect(nextInput).toContain("Use the project venv.");
  });

  it.each([
    { reason: "zero message budget", context: { maxMessages: 0, maxChars: 100 } },
    { reason: "zero character budget", context: { maxMessages: 12, maxChars: 0 } },
    { reason: "insufficient character budget", context: { maxMessages: 12, maxChars: 1 } },
    { reason: "only invisible records", context: { maxMessages: 12, maxChars: 100 } },
  ])("keeps tree when a nonempty branch yields no selected history: $reason", async ({ reason, context }) => {
    const harness = await makeHarness({ config: { projectContext: projectConfig(true), context } });
    if (reason === "only invisible records") {
      vi.spyOn(harness.context.sessionManager, "getBranch").mockReturnValue([
        { type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }] } },
        { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "tool output" }] } },
        { type: "message", message: { role: "user", content: "   " } },
      ] as any);
    }
    vi.spyOn(harness.context, "getSystemPrompt").mockReturnValue(resourcePrompt());
    expect(harness.context.sessionManager.getBranch().length).toBeGreaterThan(0);
    await trigger(harness);
    await vi.waitFor(() => expect(harness.complete).toHaveBeenCalledTimes(1));
    const input = (harness.complete.mock.calls[0] as any[])[1].messages[0].content[0].text;
    expect(JSON.parse(input).conversation.items).toEqual([]);
    expect(input).toContain("Use the project venv.");
    expect(input).toContain("Extract PDF tables");
    expect(input).toContain("PROJECT TREE");
    expect(input).toContain("prompt-refine.json");
  });

  it("respects disabled tree even with no selected history", async () => {
    const harness = await makeHarness({ config: { projectContext: projectConfig(false) } });
    vi.spyOn(harness.context.sessionManager, "getBranch").mockReturnValue([]);
    vi.spyOn(harness.context, "getSystemPrompt").mockReturnValue(resourcePrompt());
    await trigger(harness);
    const input = (harness.complete.mock.calls[0] as any[])[1].messages[0].content[0].text;
    expect(input).toContain("Use the project venv.");
    expect(input).toContain("Extract PDF tables");
    expect(input).not.toContain("PROJECT TREE");
  });

  it("captures fresh structured metadata on the next round", async () => {
    const harness = await makeHarness({ config: { projectContext: projectConfig() } });
    const source = { contextFiles: [{ path: "/repo/AGENTS.md", content: "Use npm" }], skills: [{ name: "pdf", description: "Read PDFs" }] };
    Object.assign(harness.context, { getSystemPromptOptions: () => source });
    await trigger(harness);
    source.contextFiles[0]!.content = "Use pnpm";
    source.skills[0]!.description = "Read updated PDFs";
    harness.handlers.get("message_start")?.[0]?.({ message: { role: "user", content: "Sent" } }, harness.context);
    await trigger(harness);
    const first = (harness.complete.mock.calls[0] as any[])[1].messages[0].content[0].text;
    const second = (harness.complete.mock.calls[1] as any[])[1].messages[0].content[0].text;
    expect(first).toContain("Use npm");
    expect(first).toContain("Read PDFs");
    expect(second).toContain("Use pnpm");
    expect(second).toContain("Read updated PDFs");
    expect(second).not.toContain("Use npm");
  });

  it("warns both the model and user when instructions and skill descriptions exceed their budgets", async () => {
    const config = projectConfig();
    config.instructionsMaxChars = 512;
    config.skillsMaxChars = 512;
    const harness = await makeHarness({ config: { projectContext: config } });
    vi.spyOn(harness.context, "getSystemPrompt").mockReturnValue(resourcePrompt("d".repeat(2000), "# Long\n" + "x".repeat(2000)));
    await trigger(harness);
    const text = (harness.complete.mock.calls[0] as any[])[1].messages[0].content[0].text;
    expect(text).toContain("CONTEXT WARNINGS");
    expect(JSON.parse(text).project_context).toContain('"complete":false');
    expect(harness.notifications.join(" ")).toContain("Project instructions are incomplete");
    expect(harness.notifications.join(" ")).toContain("skills catalog is incomplete");
    expect(harness.customCalls()).toBe(0);
  });

  it("does not send a model request or late warnings when cancelled during tree collection", async () => {
    const harness = await makeHarness({ config: { projectContext: projectConfig(true) } });
    vi.spyOn(harness.context.sessionManager, "getBranch").mockReturnValue([]);
    vi.spyOn(harness.context, "getSystemPrompt").mockReturnValue(resourcePrompt());
    await harness.command("optimize", harness.context);
    await harness.command("cancel", harness.context);
    await flushPromises();
    expect(harness.complete).not.toHaveBeenCalled();
    expect(harness.widgetLines()).toEqual([]);
    expect(harness.notifications).toHaveLength(2); // Startup hint and explicit cancellation only.
  });

  it("freezes host resources before asynchronous tree collection and allows draft edits", async () => {
    const harness = await makeHarness({ config: { projectContext: projectConfig(true) } });
    vi.spyOn(harness.context.sessionManager, "getBranch").mockReturnValue([]);
    const source = { skills: [{ name: "pdf", description: "Original description" }], contextFiles: [] };
    Object.assign(harness.context, { getSystemPromptOptions: () => source });
    await harness.command("optimize", harness.context);
    source.skills[0]!.description = "Changed after trigger";
    harness.setEditorText("Draft B");
    await vi.waitFor(() => expect(harness.complete).toHaveBeenCalledTimes(1));
    const text = (harness.complete.mock.calls[0] as any[])[1].messages[0].content[0].text;
    expect(text).toContain("Original description");
    expect(text).not.toContain("Changed after trigger");
    expect(text).toContain("Draft A");
    expect(harness.getEditor()).toBe("Draft B");
  });
});
