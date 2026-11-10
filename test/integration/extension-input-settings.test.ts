import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { extensionHarnessEnvironment, projectConfig, refinement, resourcePrompt, trigger } from "../support/extension-harness.js";
import { flushPromises } from "../support/helpers.js";

const { makeHarness } = extensionHarnessEnvironment();

describe("slash command drafts", () => {
  it.each([
    ["请改进 API\n保留 Case 和  两个空格", "请改进 API\n保留 Case 和  两个空格"],
    ["optimize 请改进 API\n保留 Case", "请改进 API\n保留 Case"],
    ["OPTIMIZE view", "view"],
    ["constructor", "constructor"],
  ])("refines command text: %s", async (args, draft) => {
    const harness = await makeHarness({ config: { shortcuts: { optimize: null, view: null, dismiss: null, selectModel: null, cycleModel: null, restore: null } } });
    harness.setEditorText(""); // Real Pi clears the submitted slash command.
    await harness.command(args, harness.context);
    await flushPromises();
    expect(harness.shortcuts.size).toBe(0);
    expect(harness.complete).toHaveBeenCalledTimes(1);
    const request = harness.complete.mock.calls[0]?.[1] as any;
    expect(JSON.parse(request.messages[0].content[0].text).draft).toBe(draft);
    expect(harness.getEditor()).toBe(draft);
    expect(harness.sent).toEqual([]);
    harness.setCustomAction("a");
    await harness.command("view", harness.context);
    expect(harness.getEditor()).toBe("Refined prompt");
    expect(harness.context.ui.confirm).not.toHaveBeenCalled();
    await harness.command("restore", harness.context);
    expect(harness.getEditor()).toBe(draft);
  });

  it("keeps a different editor draft and requires confirmation before acceptance", async () => {
    const harness = await makeHarness();
    await harness.command("optimize Command source", harness.context);
    await flushPromises();
    expect(harness.getEditor()).toBe("Draft A");
    harness.setConfirm(false);
    harness.setCustomAction("a");
    await harness.command("view", harness.context);
    await flushPromises();
    expect(harness.context.ui.confirm).toHaveBeenCalled();
    expect(harness.getEditor()).toBe("Draft A");
  });

  it.each([
    { configureModel: false },
    { noAvailableModels: true },
    { config: { maxDraftChars: 3 } },
    { mode: "print" as const },
  ])("keeps existing guards for supplied text: %j", async (options) => {
    const harness = await makeHarness(options);
    harness.setEditorText("");
    await harness.command("optimize Source draft", harness.context);
    await flushPromises();
    expect(harness.complete).not.toHaveBeenCalled();
    expect(harness.sent).toEqual([]);
  });

  it("still opens the panel for empty arguments and view", async () => {
    const harness = await makeHarness();
    await harness.command("  ", harness.context);
    await harness.command("VIEW", harness.context);
    expect(harness.customCalls()).toBe(2);
    expect(harness.complete).not.toHaveBeenCalled();
    expect(harness.getEditor()).toBe("Draft A");
  });
});

describe("Pi extension integration (mocked TUI and provider)", () => {

  it("opens input without refining and starts only after submission", async () => {
    const harness = await makeHarness();
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    const height = harness.panelLines().length;
    harness.panelInput("i");
    expect(harness.panelLines()).toHaveLength(height);
    expect(harness.panelLines()[1]).toContain("Input");
    expect(harness.context.ui.input).not.toHaveBeenCalled();
    expect(harness.complete).not.toHaveBeenCalled();
    harness.panelInput("New input prompt");
    harness.panelInput("\r");
    await flushPromises();
    expect(harness.complete).toHaveBeenCalledTimes(1);
    expect((harness.complete.mock.calls[0] as any[])[1].messages[0].content[0].text).toContain("New input prompt");
    expect(harness.sent).toEqual([]);
    expect(harness.editorWrites).toEqual([]);
    expect(harness.customCalls()).toBe(1);
    expect(harness.panelLines()).toHaveLength(height);
    harness.panelInput("q");
    await view;
    const footer = vi.mocked(harness.context.ui.setFooter);
    expect((footer.mock.calls[0]![0] as any)().render(80)).toEqual([]);
    expect(footer).toHaveBeenLastCalledWith(undefined);
  });

  it.each(["", "Main editor stays independent"])("retains exact Input text across close/reopen with main editor %j", async (mainDraft) => {
    const harness = await makeHarness();
    harness.setEditorText(mainDraft);
    harness.holdPanel();
    const text = "  Original 中文 😀\n\n" + "Long pasted line\n".repeat(30);
    let view = harness.command("view", harness.context);
    harness.panelInput("i");
    harness.panelInput(`\x1b[200~${text}\x1b[201~`);
    harness.panelInput("\x1b");
    harness.panelInput("q");
    await view;
    expect(harness.complete).not.toHaveBeenCalled();

    view = harness.command("view", harness.context);
    expect(harness.panelLines()[1]).toContain("Prompt refine");
    harness.panelInput("i");
    harness.panelInput("\r");
    await flushPromises();
    const payload = JSON.parse((harness.complete.mock.calls[0] as any[])[1].messages[0].content[0].text);
    expect(payload.draft).toBe(text);
    harness.panelInput("q");
    await view;
    view = harness.command("view", harness.context);
    harness.panelInput("i");
    harness.panelInput("\r");
    await flushPromises();
    expect(harness.complete).toHaveBeenCalledTimes(1); // Same captured input is not a new request.
    expect(harness.panelLines().join("\n")).toContain("Original 中文");
    harness.panelInput("q");
    await view;
    expect(harness.getEditor()).toBe(mainDraft);
    expect(harness.editorWrites).toEqual([]);
    expect(harness.sent).toEqual([]);
    expect(harness.sessionWrites).toEqual([]);
  });

  it("isolates Input by session, remembers clearing, and drops runtime memory on reload", async () => {
    const harness = await makeHarness();
    harness.holdPanel();
    const session = vi.spyOn(harness.context.sessionManager, "getSessionId");
    let view = harness.command("view", harness.context);
    harness.panelInput("i");
    harness.panelInput("Session one input");
    harness.handlers.get("session_before_switch")?.[0]?.({ type: "session_before_switch" }, harness.context);
    await view;
    session.mockReturnValue("session-two");
    view = harness.command("view", harness.context);
    harness.panelInput("i");
    expect(harness.panelLines().join("\n")).not.toContain("Session one input");
    harness.panelInput("Session two input");
    harness.panelInput("\x1b");
    harness.panelInput("q");
    await view;

    session.mockReturnValue("session-one");
    view = harness.command("view", harness.context);
    harness.panelInput("i");
    expect(harness.panelLines().join("\n")).toContain("Session one input");
    expect(harness.panelLines().join("\n")).not.toContain("Session two input");
    harness.panelInput("\x15");
    harness.panelInput("\x1b");
    harness.panelInput("q");
    await view;
    view = harness.command("view", harness.context);
    harness.panelInput("i");
    expect(harness.panelLines().join("\n")).not.toContain("Session one input");
    harness.panelInput("Not persisted");
    harness.panelInput("\x1b");
    harness.panelInput("q");
    await view;
    await harness.reload();
    view = harness.command("view", harness.context);
    harness.panelInput("i");
    expect(harness.panelLines().join("\n")).not.toContain("Not persisted");
    harness.panelInput("\x1b");
    harness.panelInput("q");
    await view;
    expect(harness.complete).not.toHaveBeenCalled();
    expect(harness.sessionWrites).toEqual([]);
    expect(harness.editorWrites).toEqual([]);
  });

  it("edits originals in place before running and forks submitted originals without losing work", async () => {
    const harness = await makeHarness();
    let finish!: (value: any) => void;
    harness.complete.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    harness.holdPanel();
    const view = harness.command("", harness.context);
    harness.panelInput("n");
    expect(harness.panelLines().join("\n")).toContain("Edit original prompt");
    harness.panelInput("Original input"); harness.panelInput("\r");
    expect(harness.complete).not.toHaveBeenCalled();
    expect(harness.panelLines().join("\n")).toContain("1 prompts");
    harness.panelInput("i"); harness.panelInput(" + edit"); harness.panelInput("\r");
    expect(harness.panelLines().join("\n")).toContain("1 prompts");
    harness.panelInput("\r");
    await flushPromises();
    expect(JSON.parse((harness.complete.mock.calls[0] as any[])[1].messages[0].content[0].text).draft).toBe("Original input + edit");
    harness.panelInput("i");
    harness.panelInput(" + next version");
    const editing = harness.panelLines();
    finish(refinement("First result"));
    await flushPromises();
    expect(harness.panelLines()).toEqual(editing);
    harness.panelInput("\r");
    expect(harness.complete).toHaveBeenCalledTimes(1);
    expect(harness.panelLines().join("\n")).toContain("2 prompts");
    harness.panelInput("\r");
    await flushPromises();
    expect(JSON.parse((harness.complete.mock.calls[1] as any[])[1].messages[0].content[0].text).draft).toBe("Original input + edit + next version");
    harness.panelInput("n"); harness.panelInput("Cancel this draft"); harness.panelInput("\x1b");
    expect(harness.panelLines().join("\n")).toContain("2 prompts");
    expect(harness.panelLines().join("\n")).not.toContain("Cancel this draft");
    harness.panelInput("q"); await view;
    expect(harness.editorWrites).toEqual([]);
    expect(harness.sent).toEqual([]);
  });
  it("retains canceled input and rejects blank submissions in place", async () => {
    const harness = await makeHarness();
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    harness.panelInput("i");
    harness.panelInput("   ");
    harness.panelInput("\r");
    expect(harness.panelLines()[1]).toContain("Input");
    expect(harness.panelLines().join("\n")).toContain("empty");
    harness.panelInput("irq"); // Letters are text, never main-page actions.
    harness.panelInput("\x1b");
    expect(harness.panelLines()[1]).toContain("Prompt refine");
    harness.panelInput("i");
    expect(harness.panelLines().join("\n")).toContain("irq");
    expect(harness.complete).not.toHaveBeenCalled();
    harness.panelInput("\x1b");
    harness.panelInput("q");
    await view;
  });

  it.each(["\x1c", "q", "\x1b"])("cancels unsaved context edits with %j and keeps default context opt-outs", async (back) => {
    const harness = await makeHarness({ config: { projectContext: structuredClone(DEFAULT_CONFIG.projectContext) } });
    vi.spyOn(harness.context.sessionManager, "getBranch").mockReturnValue([]);
    vi.spyOn(harness.context, "getSystemPrompt").mockReturnValue(resourcePrompt());
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    const main = harness.panelLines();
    expect(main[0]).toMatch(/^╭─+╮$/);
    expect(main[1]).toContain("Prompt refine");
    harness.panelInput("t");
    expect(harness.panelLines()).toEqual(main);
    harness.panelInput("\x1b[D");
    await flushPromises();
    const settings = harness.panelLines();
    expect(settings[1]).toContain("Settings");
    expect(settings).toHaveLength(main.length);
    expect(settings[0]).toBe(main[0]);
    const settingsHints = settings.findIndex((line) => line.includes("Ctrl+S Save settings"));
    expect(settingsHints).toBeGreaterThan(settings.findIndex((line) => line.includes("←")));
    expect(settings[settingsHints + 2]).toBe(main.at(-4));
    expect(settings.findIndex((line) => line.includes("Directory tree"))).toBeGreaterThan(settingsHints + 2);
    expect(settings[1]?.startsWith("│  ")).toBe(true);
    harness.panelInput(" ");
    const edited = harness.panelLines();
    harness.panelInput("\t");
    expect(harness.panelLines().join("\n")).toContain("Model");
    harness.panelInput("\t");
    harness.panelInput("\t");
    expect(harness.panelLines()).toEqual(edited);
    harness.panelInput(back);
    await flushPromises();
    expect(harness.complete).not.toHaveBeenCalled();
    expect(harness.customCalls()).toBe(1);
    expect(harness.panelLines().join("\n")).not.toContain("Unsaved settings changes");
    expect(harness.panelLines().join("\n")).toContain("Prompt refine");
    harness.panelInput("q");
    await view;
    await trigger(harness);
    await vi.waitFor(() => expect(harness.complete).toHaveBeenCalledTimes(1));
    const input = (harness.complete.mock.calls[0] as any[])[1].messages[0].content[0].text;
    expect(input).not.toContain("Use the project venv.");
    expect(input).not.toContain("PROJECT TREE");
    expect(input).not.toContain("Extract PDF tables");
  });

  it("saves all seven Settings additions and applies runtime limits without reload", async () => {
    const harness = await makeHarness({ config: { projectContext: projectConfig(false) } });
    vi.spyOn(harness.context, "getSystemPrompt").mockReturnValue(resourcePrompt());
    const file = join(harness.agentDir, "prompt-refine.json");
    const before = await readFile(file, "utf8");
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    const down = (count: number) => { for (let i = 0; i < count; i++) harness.panelInput("\x1b[B"); };
    const number = (text: string) => { harness.panelInput("\r"); harness.panelInput("\x15"); harness.panelInput(text); harness.panelInput("\r"); };
    harness.panelInput("\x1b[D");
    down(3); harness.panelInput(" "); // Project context off.
    down(1); harness.panelInput(" "); // Explicit directory references off.
    down(1); number("0");
    down(1); number("9000");
    harness.panelInput("\t"); down(3); number("4096");
    down(1); number("120");
    harness.panelInput("\t"); number("32");
    expect(await readFile(file, "utf8")).toBe(before);
    expect(harness.complete).not.toHaveBeenCalled();
    expect(harness.customCalls()).toBe(1); // Numeric editors stay inside the same shell.
    harness.panelInput("\x13");
    await vi.waitFor(() => expect(harness.panelLines().join("\n")).toContain("Settings saved"));
    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(saved).toMatchObject({ maxOutputTokens: 4096, timeoutMs: 120000, maxDraftChars: 32,
      context: { maxMessages: 0, maxChars: 9000 }, projectContext: { enabled: false, referencedDirectories: { enabled: false, maxReferences: 8 } } });
    harness.panelInput("q"); await view;
    harness.setEditorText("x".repeat(33));
    await trigger(harness);
    expect(harness.complete).not.toHaveBeenCalled();
    expect(harness.getEditor()).toBe("x".repeat(33));
    expect(harness.notifications.join(" ")).toContain("exceeds 32 characters");
    const timer = vi.spyOn(globalThis, "setTimeout");
    try {
      harness.setEditorText("x".repeat(32));
      await trigger(harness);
      expect(harness.complete).toHaveBeenCalledOnce();
      expect(timer).toHaveBeenCalledWith(expect.any(Function), 120000);
      const call = harness.complete.mock.calls[0] as any[];
      expect(call[2].maxTokens).toBe(4096);
      expect(JSON.parse(call[1].messages[0].content[0].text)).toMatchObject({ project_context: null, conversation: { items: [] } });
    } finally { timer.mockRestore(); }
    await harness.reload();
    harness.setEditorText("Reloaded prompt");
    await trigger(harness);
    expect((harness.complete.mock.calls[1] as any[])[2].maxTokens).toBe(4096);
    expect(harness.editorWrites).toEqual([]);
    expect(harness.sent).toEqual([]);
  });

  it.each([5, 6])("freezes history settings until the next round (Context row %i)", async (row) => {
    const harness = await makeHarness();
    await trigger(harness);
    const packet = (index: number) => JSON.parse((harness.complete.mock.calls[index] as any[])[1].messages[0].content[0].text);
    const first = packet(0).conversation;
    expect(first.items).toHaveLength(2);
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    harness.panelInput("\x1b[D");
    for (let i = 0; i < row; i++) harness.panelInput("\x1b[B");
    harness.panelInput("\r"); harness.panelInput("\x15"); harness.panelInput("0"); harness.panelInput("\r");
    harness.panelInput("\x13");
    await vi.waitFor(() => expect(harness.panelLines().join("\n")).toContain("Settings saved"));
    harness.panelInput("q"); await view;
    harness.setEditorText("Second draft in frozen round"); await trigger(harness);
    expect(packet(1).conversation).toEqual(first);
    harness.handlers.get("message_start")?.[0]?.({ message: { role: "user", content: "Sent" } }, harness.context);
    harness.setEditorText("Third draft in a new round"); await trigger(harness);
    expect(packet(2).conversation.items).toEqual([]);
  });

  it("keeps running output limits unchanged when saving a smaller limit", async () => {
    const harness = await makeHarness();
    let resolve!: (response: any) => void;
    harness.complete.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await trigger(harness);
    expect((harness.complete.mock.calls[0] as any[])[2].maxTokens).toBe(8192);
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    harness.panelInput("\x1b[D"); harness.panelInput("\t");
    for (let i = 0; i < 3; i++) harness.panelInput("\x1b[B");
    harness.panelInput("\r"); harness.panelInput("\x15"); harness.panelInput("16"); harness.panelInput("\r");
    harness.panelInput("\x13");
    await vi.waitFor(() => expect(harness.panelLines().join("\n")).toContain("Settings saved"));
    const result = "x".repeat(20000); // Above the new character guard, within the old one.
    resolve({ content: [{ type: "text", text: JSON.stringify({ prompt: result }) }], stopReason: "stop" });
    await flushPromises();
    harness.panelInput("\x1b[B"); // Original root -> completed run.
    harness.panelInput("a");
    await vi.waitFor(() => expect(harness.getEditor(), harness.panelLines(100).join("\n")).toBe(result));
    await view;
    harness.setEditorText("Next draft"); await trigger(harness);
    expect((harness.complete.mock.calls[1] as any[])[2].maxTokens).toBe(16);
  });

  it("saves vertical context selections and applies them after reload", async () => {
    const harness = await makeHarness({ config: { projectContext: structuredClone(DEFAULT_CONFIG.projectContext) } });
    vi.spyOn(harness.context.sessionManager, "getBranch").mockReturnValue([]);
    vi.spyOn(harness.context, "getSystemPrompt").mockReturnValue(resourcePrompt());
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    harness.panelInput("\x1b[D");
    await flushPromises();
    const lines = harness.panelLines();
    expect(lines.find((line) => line.includes("Directory tree"))).toMatch(/Directory tree +\[ \] Off/);
    expect(lines.find((line) => line.includes("Skill metadata"))).toMatch(/Skill metadata +\[ \] Off/);
    harness.panelInput(" ");
    harness.panelInput("\x1b[B");
    harness.panelInput(" ");
    harness.panelInput("\x1b[B");
    harness.panelInput(" ");
    harness.panelInput("\x13");
    await vi.waitFor(() => expect(harness.panelLines().join("\n")).toContain("Settings saved"));
    harness.panelInput("q");
    await view;
    const saved = JSON.parse(await readFile(join(harness.agentDir, "prompt-refine.json"), "utf8"));
    expect(saved.projectContext).toMatchObject({ instructionsEnabled: true, skillsEnabled: true, tree: { enabled: true } });
    await harness.reload();
    await trigger(harness);
    await vi.waitFor(() => expect(harness.complete).toHaveBeenCalledTimes(1));
    const input = (harness.complete.mock.calls[0] as any[])[1].messages[0].content[0].text;
    expect(input).toContain("Use the project venv.");
    expect(input).toContain("PROJECT TREE");
    expect(input).toContain("Extract PDF tables");
  });

  it.each([
    [true, true, "Always"], [true, false, "First request only"],
    [false, true, "Off"], [false, false, "Off"],
  ] as const)("loads existing instruction flags (%s, %s) as %s and preserves them on save", async (enabled, followUp, label) => {
    const config = structuredClone(DEFAULT_CONFIG.projectContext);
    config.instructionsEnabled = enabled;
    config.instructionsOnFollowUp = followUp;
    const harness = await makeHarness({ config: { projectContext: config } });
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    harness.panelInput("\x1b[D");
    expect(harness.panelLines().join("\n")).toMatch(new RegExp(`Project instructions +${label}`));
    harness.panelInput("\x13");
    await vi.waitFor(() => expect(harness.panelLines().join("\n")).toContain("Settings saved"));
    const saved = JSON.parse(await readFile(join(harness.agentDir, "prompt-refine.json"), "utf8"));
    expect(saved.projectContext.instructionsEnabled).toBe(enabled);
    expect(saved.projectContext.instructionsOnFollowUp).toBe(followUp);
    harness.panelInput("q");
    await view;
  });

  it.each([
    { configureModel: false, error: "No optimizer model" },
    { noAvailableModels: true, error: "missing or unavailable" },
    { config: { maxDraftChars: 100 }, error: "exceeds" },
  ])("retains input on validation failure: $error", async (options) => {
    const harness = await makeHarness(options);
    harness.setEditorText("");
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    harness.panelInput("i");
    const text = "retained prompt ".repeat(10);
    harness.panelInput(text);
    harness.panelInput("\r");
    expect(harness.panelLines()[1]).toContain("Input");
    expect(harness.panelLines().join("\n")).toContain(options.error);
    expect(harness.panelLines().join("\n")).toContain("retained prompt");
    expect(harness.editorWrites).toEqual([]);
    expect(harness.complete).not.toHaveBeenCalled();
    harness.panelInput("\x1b");
    harness.panelInput("q");
    await view;
  });

  it("submits input without filling even an empty main editor", async () => {
    const harness = await makeHarness();
    harness.setEditorText("");
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    harness.panelInput("i");
    harness.panelInput("Independent prompt");
    harness.panelInput("\r");
    await flushPromises();
    expect(harness.complete).toHaveBeenCalledTimes(1);
    expect(harness.getEditor()).toBe("");
    expect(harness.editorWrites).toEqual([]);
    expect(harness.sent).toEqual([]);
    harness.panelInput("q");
    await view;
  });

  it.each(["i", "\x1b[C", "\x1b[D"])("closes secondary state %j on lifecycle invalidation and rejects stale input", async (key) => {
    const harness = await makeHarness();
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    harness.panelInput(key);
    harness.handlers.get("session_before_tree")?.[0]?.({ type: "session_before_tree" }, harness.context);
    await view;
    harness.panelInput("stale prompt");
    harness.panelInput("\r");
    expect(harness.complete).not.toHaveBeenCalled();
    expect(harness.customCalls()).toBe(1);
    expect(harness.context.ui.setFooter).toHaveBeenLastCalledWith(undefined);
  });

  it("reports settings persistence failure without claiming a successful save", async () => {
    const harness = await makeHarness();
    await rm(join(harness.agentDir, "prompt-refine.json"));
    await mkdir(join(harness.agentDir, "prompt-refine.json"));
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    harness.panelInput("\x1b[D");
    harness.panelInput(" ");
    harness.panelInput("\x13");
    await vi.waitFor(() => expect(harness.panelLines().join("\n")).toContain("Not persisted"));
    expect(harness.panelLines().join("\n")).not.toContain("Settings saved");
    expect(harness.panelLines().join("\n")).toContain("Settings");
    harness.panelInput("q"); // Failed persistence stays in Settings for retry.
    harness.panelInput("q");
    await view;
  });
});
