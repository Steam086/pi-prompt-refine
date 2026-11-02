import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import promptRefineExtension, { modelPickerItems } from "../src/extension.js";
import { DEFAULT_CONFIG, type RefineConfig } from "../src/config.js";
import { flushPromises } from "./helpers.js";

const agentDirs: string[] = [];
const activeHarnesses: Harness[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(async () => {
  for (const harness of activeHarnesses.splice(0)) {
    harness.handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown" }, harness.context);
  }
  vi.useRealTimers();
  await Promise.all(agentDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

interface Harness {
  context: ExtensionContext;
  handlers: Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>;
  shortcuts: Map<string, (ctx: ExtensionContext) => unknown>;
  command: (args: string, ctx: ExtensionContext) => unknown;
  complete: ReturnType<typeof vi.fn>;
  notifications: string[];
  statuses: Array<string | undefined>;
  sent: Array<{ text: string; options?: { deliverAs?: "steer" | "followUp" } }>;
  internalMessages: unknown[];
  sessionWrites: unknown[];
  setSessionName: ReturnType<typeof vi.fn>;
  getSessionName(): string | undefined;
  manualName(name: string): void;
  sendUserMessage: ReturnType<typeof vi.fn>;
  reload(): Promise<void>;
  editorWrites: string[];
  getEditor(): string;
  setEditorText(text: string): void;
  setCustomAction(action: string | string[] | undefined): void;
  setConfirm(confirmed: boolean, mutateEditor?: string): void;
  deferConfirm(): void;
  resolveConfirm(confirmed: boolean): void;
  agentDir: string;
  renderedWidths: Array<{ width: number; lines: string[] }>;
  widgetLines(width?: number): string[];
  holdPanel(): void;
  panelInput(key: string): void;
  panelLines(): string[];
  customCalls(): number;
}

async function makeHarness(options: { sessionName?: string; mode?: "tui" | "print"; busy?: boolean; configureModel?: boolean; noAvailableModels?: boolean; reasoning?: boolean; thinkingLevel?: ModelThinkingLevel; config?: Partial<RefineConfig>; useDefaultShortcuts?: boolean } = {}): Promise<Harness> {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-prompt-refine-agent-"));
  agentDirs.push(agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const config = { ...structuredClone(DEFAULT_CONFIG), ...options.config } as RefineConfig;
  // Existing workflow tests exercise the explicitly supported history-only mode.
  // Project context (including real asynchronous tree collection) has separate integration cases.
  if (!options.config?.projectContext) config.projectContext = { ...config.projectContext, enabled: false };
  if (options.config?.context) config.context = { ...DEFAULT_CONFIG.context, ...options.config.context };
  // Keep explicit secondary bindings in the older workflow tests; test defaults separately.
  if (!options.useDefaultShortcuts) config.shortcuts = { ...config.shortcuts, view: "f3", selectModel: "f5", restore: "f7" };
  if (options.config?.shortcuts) config.shortcuts = { ...DEFAULT_CONFIG.shortcuts, ...options.config.shortcuts };
  if (options.configureModel !== false) config.model = { provider: "fake-provider", id: "fake-chat" };
  await writeFile(join(agentDir, "prompt-refine.json"), `${JSON.stringify(config)}\n`, "utf8");

  const model = { provider: "fake-provider", id: "fake-chat", name: "Fake Chat", maxTokens: 4096, reasoning: options.reasoning ?? false } as Model<Api>;
  const complete = vi.fn(async (_model?: Model<Api>, _context?: unknown, _options?: unknown) => ({
    content: [{ type: "text", text: JSON.stringify({ prompt: "Refined prompt", title: "Draft refinement workflow" }) }],
    stopReason: "stop",
  }));
  const modelRegistry = {
    find: vi.fn((provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined),
    getAvailable: vi.fn(() => options.noAvailableModels ? [] : [model]),
    streamSimple: vi.fn((selectedModel: Model<Api>, context: unknown, requestOptions: unknown) => ({
      result: () => complete(selectedModel, context, requestOptions),
    })),
    complete,
  };
  let editor = "Draft A";
  let customAction: string | string[] | undefined;
  let confirmResult = true;
  let confirmMutation: string | undefined;
  let shouldDeferConfirm = false;
  let confirmResolve: ((confirmed: boolean) => void) | undefined;
  const notifications: string[] = [];
  const statuses: Array<string | undefined> = [];
  const sent: Array<{ text: string; options?: { deliverAs?: "steer" | "followUp" } }> = [];
  const internalMessages: unknown[] = [];
  const sessionWrites: unknown[] = [];
  const editorWrites: string[] = [];
  let sessionName = options.sessionName;
  const sessionEntries: any[] = options.sessionName ? [{ type: "session_info", name: options.sessionName }] : [];
  const manualName = (name: string) => {
    sessionName = name;
    sessionEntries.push({ type: "session_info", name });
  };
  const setSessionName = vi.fn(manualName);
  const sendUserMessage = vi.fn((text: string, sendOptions?: { deliverAs?: "steer" | "followUp" }) => {
    sent.push({ text, options: sendOptions });
  });
  const renderedWidths: Array<{ width: number; lines: string[] }> = [];
  const sessionManager = {
    getSessionId: () => "session-one",
    getLeafId: () => "leaf-one",
    getEntries: () => sessionEntries,
    getBranch: () => [
      { type: "message", message: { role: "user", content: "earlier requirement" } },
      { type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "secret" }, { type: "text", text: "visible answer" }] } },
      { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "not context" }] } },
    ],
  };
  let widget: { render(width: number): string[] } | undefined;
  let panel: { render(width: number): string[]; handleInput?(data: string): void } | undefined;
  let holdPanel = false;
  let customCalls = 0;
  const theme = {
    fg: (_color: string, text: string) => text, bold: (text: string) => text,
    italic: (text: string) => text, underline: (text: string) => text, strikethrough: (text: string) => text,
  };
  const ui = {
    setWidget: vi.fn((_key: string, factory: any) => {
      widget = typeof factory === "function" ? factory({ requestRender: vi.fn() }, theme) : undefined;
    }),
    notify: vi.fn((message: string) => notifications.push(message)),
    setStatus: vi.fn((_key: string, text: string | undefined) => statuses.push(text)),
    setFooter: vi.fn(),
    input: vi.fn(async () => undefined as string | undefined),
    getEditorText: () => editor,
    setEditorText: (text: string) => {
      editor = text;
      editorWrites.push(text);
    },
    editor: vi.fn(async () => "Edited candidate"),
    confirm: vi.fn((_title: string, message: string) => {
      expect(message).toContain("Current draft:");
      if (shouldDeferConfirm) {
        return new Promise<boolean>((resolve) => { confirmResolve = resolve; });
      }
      if (confirmMutation !== undefined) editor = confirmMutation;
      return Promise.resolve(confirmResult);
    }),
    custom: async <T>(factory: (tui: any, theme: any, keybindings: any, done: (value: T) => void) => any): Promise<T> => {
      customCalls += 1;
      return await new Promise<T>((resolve) => {
        const component = factory(
          { requestRender: vi.fn(), terminal: { rows: 40 } },
          theme,
          {
            getKeys: (action: string) => action === "app.thinking.cycle" ? ["shift+tab"] : [],
            matches: (data: string, action: string) => {
              const keys: Record<string, string> = {
                "tui.select.cancel": "escape", "tui.select.confirm": "return", "tui.input.submit": "return",
                "tui.select.up": "up", "tui.select.down": "down", "app.thinking.cycle": "shift+tab",
                "tui.editor.cursorUp": "up", "tui.editor.cursorDown": "down",
                "tui.editor.pageUp": "pageUp", "tui.editor.pageDown": "pageDown",
              };
              return keys[action] ? matchesKey(data, keys[action] as any) : false;
            },
          },
          resolve,
        );
        panel = component;
        for (const width of [20, 40, 80]) {
          const lines = component.render?.(width) ?? [];
          renderedWidths.push({ width, lines });
        }
        if (!holdPanel) {
          if (Array.isArray(customAction)) {
            for (const key of customAction) component.handleInput?.(key);
          } else {
            if (customAction) component.handleInput?.(customAction);
            component.handleInput?.("q"); // Close when an action is disabled (e.g. no candidate).
          }
        }
      });
    },
  };
  const context = {
    ui,
    mode: options.mode ?? "tui",
    hasUI: options.mode !== "print",
    cwd: agentDir,
    sessionManager,
    modelRegistry,
    model,
    scopedModels: [],
    thinkingLevel: options.thinkingLevel,
    isIdle: () => !options.busy,
    getSystemPrompt: () => `<cwd>\n${agentDir}\n</cwd>`,
  } as unknown as ExtensionContext;

  const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
  const shortcuts = new Map<string, (ctx: ExtensionContext) => unknown>();
  let command: (args: string, ctx: ExtensionContext) => unknown = (_args, _ctx) => undefined;
  const pi = {
    on: (name: string, handler: (event: any, ctx: ExtensionContext) => unknown) => {
      const registered = handlers.get(name) ?? [];
      registered.push(handler);
      handlers.set(name, registered);
      return () => undefined;
    },
    registerShortcut: (shortcut: string, definition: { handler: (ctx: ExtensionContext) => unknown }) => {
      shortcuts.set(shortcut, definition.handler);
    },
    registerCommand: (_name: string, definition: { handler: (args: string, ctx: ExtensionContext) => unknown }) => {
      command = definition.handler;
    },
    sendUserMessage,
    getSessionName: () => sessionName,
    setSessionName,
    sendMessage: (...args: unknown[]) => internalMessages.push(args),
    appendEntry: (...args: unknown[]) => sessionWrites.push(args),
  } as unknown as ExtensionAPI;

  await promptRefineExtension(pi);
  const sessionStart = handlers.get("session_start")?.[0];
  sessionStart?.({ type: "session_start", reason: "startup" }, context);

  const harness: Harness = {
    context,
    handlers,
    shortcuts,
    command,
    complete,
    notifications,
    statuses,
    sent,
    internalMessages,
    sessionWrites,
    setSessionName,
    getSessionName: () => sessionName,
    manualName,
    sendUserMessage,
    reload: async () => {
      handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown" }, context);
      handlers.clear();
      shortcuts.clear();
      await promptRefineExtension(pi);
      harness.command = command;
      handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "reload" }, context);
    },
    editorWrites,
    getEditor: () => editor,
    setEditorText: (text) => { editor = text; },
    setCustomAction: (action) => { customAction = action; },
    setConfirm: (confirmed, mutateEditor) => {
      confirmResult = confirmed;
      confirmMutation = mutateEditor;
    },
    deferConfirm: () => { shouldDeferConfirm = true; },
    resolveConfirm: (confirmed) => {
      confirmResult = confirmed;
      confirmResolve?.(confirmed);
    },
    agentDir,
    renderedWidths,
    widgetLines: (width = 80) => widget?.render(width) ?? [],
    holdPanel: () => { holdPanel = true; },
    panelInput: (key) => panel?.handleInput?.(key),
    panelLines: () => panel?.render(80) ?? [],
    customCalls: () => customCalls,
  };
  activeHarnesses.push(harness);
  return harness;
}

function shortcut(harness: Harness, action: string): (ctx: ExtensionContext) => unknown {
  const handler = harness.shortcuts.get(action);
  if (!handler) throw new Error(`Missing shortcut ${action}`);
  return handler;
}

async function trigger(harness: Harness): Promise<void> {
  await harness.command("optimize", harness.context);
  await flushPromises();
}

function projectConfig(tree = false): RefineConfig["projectContext"] {
  const config = structuredClone(DEFAULT_CONFIG.projectContext);
  config.tree.enabled = tree;
  // Existing resource/budget tests explicitly exercise repeat injection.
  config.instructionsOnFollowUp = true;
  config.skillsEnabled = true;
  return config;
}

function resourcePrompt(skillDescription = "Extract PDF tables", instructions = "Use the project venv."): string {
  return `<tools>\nPRIVATE MAIN AGENT TOOLS\n</tools>\n<project_context>\nProject-specific instructions and guidelines:\n\n<project_instructions path="/repo/AGENTS.md">\n${instructions}\n</project_instructions>\n</project_context>\n<skills>\nUse bash to load skills.\n<available_skills>\n<skill><name>pdf</name><description>${skillDescription}</description><location>/skills/pdf/SKILL.md</location></skill>\n</available_skills>\n</skills>\n<cwd>\n/repo\n</cwd>`;
}

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
    expect(harness.complete.mock.calls[0]?.[1]).toMatchObject({
      messages: [{ content: [{ text: expect.stringContaining(draft) }] }],
    });
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
    expect(input).toContain('REFERENCED DIRECTORY: "src"');
    expect(input.match(/target\.ts/g)).toHaveLength(1);
    expect(input).toContain("Use the project venv.");
    expect(input).toContain("Extract PDF tables");
    expect(input).toContain("Explain @src without edits");
    expect(input).not.toContain("PRIVATE SOURCE BODY");
    expect(input.includes("visible answer")).toBe(history);
    expect(input.includes("unrelated-root.txt")).toBe(!history && tree);
    expect(harness.widgetLines(200).join("\n")).toContain("@dirs 1");
    expect(request.systemPrompt).toContain("Do not generate a title");
    expect(request.tools).toEqual([]);
    expect(harness.sent).toEqual([]);
    expect(harness.editorWrites).toEqual([]);
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
    expect(harness.widgetLines().join("\n")).toContain("⚠1");
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
    expect(harness.notifications).toEqual(["Refinement cancelled. Editor unchanged."]);
  });

  it.each([false, true])("defaults to first-prompt-only instructions with followUp=%s, independent of history budget", async (followUp) => {
    const config = structuredClone(DEFAULT_CONFIG.projectContext);
    config.tree.enabled = false;
    expect(config.instructionsOnFollowUp).toBe(false);
    const harness = await makeHarness({ config: { projectContext: config, context: { maxMessages: 0, maxChars: 0 } } });
    vi.spyOn(harness.context.sessionManager, "getBranch").mockReturnValue(followUp
      ? [{ type: "message", message: { role: "user", content: "Earlier prompt" } }] as any : []);
    vi.spyOn(harness.context, "getSystemPrompt").mockReturnValue(resourcePrompt());
    await trigger(harness);
    const input = (harness.complete.mock.calls[0] as any[])[1].messages[0].content[0].text;
    expect(input.includes("Use the project venv.")).toBe(!followUp);
    expect(input.includes("/repo/AGENTS.md")).toBe(!followUp);
    expect(input).not.toContain("Extract PDF tables");
  });

  it("injects skills, applicable instructions and a real bounded tree on the first shortcut in an empty session", async () => {
    const harness = await makeHarness({ config: { projectContext: projectConfig(true) } });
    vi.spyOn(harness.context.sessionManager, "getBranch").mockReturnValue([]);
    vi.spyOn(harness.context, "getSystemPrompt").mockReturnValue(resourcePrompt());
    await shortcut(harness, "ctrl+\\")(harness.context);
    await vi.waitFor(() => expect(harness.complete).toHaveBeenCalledTimes(1));
    const request = (harness.complete.mock.calls[0] as any[])[1];
    const input = request.messages[0].content[0].text;
    expect(input).toContain("Use the project venv.");
    expect(input).toContain("Extract PDF tables");
    expect(input).toContain("PROJECT TREE");
    expect(input).toContain("prompt-refine.json");
    expect(harness.widgetLines().join("\n")).toContain("1 rules   ·   1 skills");
    expect(input).not.toContain("PRIVATE MAIN AGENT TOOLS");
    expect(input).not.toContain("Use bash to load skills");
    expect(request.tools).toEqual([]);
    expect(harness.notifications).toEqual([]);
    expect(harness.getEditor()).toBe("Draft A");
    expect(harness.sent).toEqual([]);
    expect(harness.sessionWrites).toEqual([]);
  });

  it.each(["user", "assistant"] as const)("omits tree with selected %s history, including on the first optimization", async (role) => {
    const harness = await makeHarness({ config: { projectContext: projectConfig(true) } });
    const branch = vi.spyOn(harness.context.sessionManager, "getBranch").mockReturnValue([
      { type: "message", message: { role, content: "Selected visible history" } },
    ] as any);
    vi.spyOn(harness.context, "getSystemPrompt").mockReturnValue(resourcePrompt());
    await trigger(harness);
    const input = (harness.complete.mock.calls[0] as any[])[1].messages[0].content[0].text;
    expect(input).toContain(`[${role}]\nSelected visible history`);
    expect(input).toContain("/repo/AGENTS.md");
    expect(input).toContain("Use the project venv.");
    expect(input).toContain("Extract PDF tables");
    expect(input).not.toContain("PROJECT TREE");
    expect(input).not.toContain("prompt-refine.json");
    expect(harness.widgetLines(200).join("\n")).not.toContain(" · tree");

    // A later request with no selected history must include tree again.
    branch.mockReturnValue([]);
    await trigger(harness);
    await vi.waitFor(() => expect(harness.complete).toHaveBeenCalledTimes(2));
    const nextInput = (harness.complete.mock.calls[1] as any[])[1].messages[0].content[0].text;
    expect(nextInput).toContain("PROJECT TREE");
    expect(nextInput).toContain("Use the project venv.");
    expect(harness.widgetLines(200).join("\n")).toContain(" · tree");
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
    expect(input).toContain("(no visible conversation context selected)");
    expect(input).toContain("Use the project venv.");
    expect(input).toContain("Extract PDF tables");
    expect(input).toContain("PROJECT TREE");
    expect(input).toContain("prompt-refine.json");
    expect(harness.widgetLines(200).join("\n")).toContain(" · tree");
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
    expect(harness.widgetLines(200).join("\n")).not.toContain(" · tree");
  });

  it("injects fresh metadata on every independent optimization and uses structured command resources when available", async () => {
    const harness = await makeHarness({ config: { projectContext: projectConfig() } });
    const source = { contextFiles: [{ path: "/repo/AGENTS.md", content: "Use npm" }], skills: [{ name: "pdf", description: "Read PDFs" }] };
    Object.assign(harness.context, { getSystemPromptOptions: () => source });
    await trigger(harness);
    source.contextFiles[0]!.content = "Use pnpm";
    source.skills[0]!.description = "Read updated PDFs";
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
    expect(text).toContain('"complete":false');
    expect(harness.notifications.join(" ")).toContain("Project instructions are incomplete");
    expect(harness.notifications.join(" ")).toContain("skills catalog is incomplete");
    expect(harness.widgetLines().join("\n")).toContain("⚠2");
    expect(harness.customCalls()).toBe(0);
  });

  it("does not send a model request or late warnings when cancelled during tree collection", async () => {
    const harness = await makeHarness({ config: { projectContext: projectConfig(true) } });
    vi.spyOn(harness.context.sessionManager, "getBranch").mockReturnValue([]);
    vi.spyOn(harness.context, "getSystemPrompt").mockReturnValue(resourcePrompt());
    await shortcut(harness, "ctrl+\\")(harness.context);
    await harness.command("cancel", harness.context);
    await flushPromises();
    expect(harness.complete).not.toHaveBeenCalled();
    expect(harness.widgetLines()).toEqual([]);
    expect(harness.notifications).toHaveLength(1); // Explicit cancellation notice only.
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

describe("optimizer model picker", () => {
  const thinking = { provider: "fake-provider", id: "reasoner", name: "Reasoner", reasoning: true } as Model<Api>;
  const plain = { provider: "other", id: "plain", name: "Plain Chat", reasoning: false } as Model<Api>;

  it("keeps both reasoning and ordinary models when no search is entered", () => {
    const items = modelPickerItems([thinking, plain], "", thinking);
    expect(items.map((item) => item.value)).toEqual(["fake-provider/reasoner", "other/plain"]);
    expect(items[0]?.label).toBe("fake-provider/reasoner [thinking] (current)");
    expect(items[1]?.label).toBe("other/plain");
  });

  it.each(["thinking", "THINKING", "reasoning", "思考", "推理"])("searches reasoning capability using %s", (query) => {
    expect(modelPickerItems([thinking, plain], query).map((item) => item.value)).toEqual(["fake-provider/reasoner"]);
  });

  it("preserves provider, ID, and display-name searches", () => {
    expect(modelPickerItems([thinking, plain], "FAKE-PROVIDER")).toHaveLength(1);
    expect(modelPickerItems([thinking, plain], "reasoner")[0]?.value).toBe("fake-provider/reasoner");
    expect(modelPickerItems([thinking, plain], "plain chat")[0]?.value).toBe("other/plain");
    expect(modelPickerItems([thinking, plain], "missing")).toEqual([]);
  });
});

function refinement(prompt: string, title?: unknown) {
  return { content: [{ type: "text", text: JSON.stringify({ prompt, title }) }], stopReason: "stop" };
}

async function panelAction(harness: Harness, action: string): Promise<void> {
  harness.setCustomAction(action);
  await harness.command("view", harness.context);
  await flushPromises();
}

describe("session naming", () => {
  it("generates a name in the same call, previews it separately, and applies it only on acceptance", async () => {
    const harness = await makeHarness();
    harness.complete.mockResolvedValueOnce(refinement("请修复路径解析。", "路径解析修复"));
    await trigger(harness);
    expect(harness.complete).toHaveBeenCalledTimes(1);
    const request = (harness.complete.mock.calls[0] as any[])[1];
    expect(request.systemPrompt).toContain('Also include a "title"');
    expect(harness.setSessionName).not.toHaveBeenCalled();
    expect(harness.editorWrites).toEqual([]);
    await panelAction(harness, "q");
    expect(harness.panelLines().join("\n")).toContain("Title on accept: 路径解析修复");
    expect(harness.panelLines().join("\n")).not.toContain('"prompt":');
    expect(harness.setSessionName).not.toHaveBeenCalled();
    await panelAction(harness, "a");
    expect(harness.editorWrites).toEqual(["请修复路径解析。"]);
    expect(harness.setSessionName).toHaveBeenCalledExactlyOnceWith("路径解析修复");
    expect(harness.sent).toEqual([]);
    expect(harness.internalMessages).toEqual([]);
    expect(harness.sessionWrites).toEqual([]); // No appendEntry; Pi owns name persistence.
    await panelAction(harness, "q");
    expect(harness.panelLines().join("\n")).not.toContain("Title on accept:");
    expect(harness.complete).toHaveBeenCalledTimes(1);
  });

  it("does not request or apply a title for an already named session, even if the model returns one", async () => {
    const harness = await makeHarness({ sessionName: "My chosen project" });
    await trigger(harness);
    expect((harness.complete.mock.calls[0] as any[])[1].systemPrompt).toContain("Do not generate a title");
    await panelAction(harness, "q");
    expect(harness.panelLines().join("\n")).not.toContain("Title on accept:");
    await panelAction(harness, "a");
    expect(harness.getEditor()).toBe("Refined prompt");
    expect(harness.getSessionName()).toBe("My chosen project");
    expect(harness.setSessionName).not.toHaveBeenCalled();
  });

  it.each(["generation", "confirmation", "send"])("preserves a manual name set during %s", async (boundary) => {
    const harness = await makeHarness();
    if (boundary === "generation") {
      let resolve!: (value: any) => void;
      harness.complete.mockImplementationOnce(() => new Promise((res) => { resolve = res; }));
      await trigger(harness);
      harness.manualName("Manual project name");
      resolve(refinement("Refined prompt", "Generated name"));
      await flushPromises();
      await panelAction(harness, "a");
    } else {
      await trigger(harness);
      if (boundary === "confirmation") {
        harness.setEditorText("Changed draft");
        harness.deferConfirm();
        await panelAction(harness, "a");
        harness.manualName("Manual project name");
        harness.resolveConfirm(true);
        await flushPromises();
        expect(harness.getEditor()).toBe("Refined prompt");
      } else {
        await panelAction(harness, "s");
        harness.manualName("Manual project name");
        harness.handlers.get("message_start")?.[0]?.({ message: { role: "user", content: "Refined prompt" } }, harness.context);
      }
    }
    expect(harness.getSessionName()).toBe("Manual project name");
    expect(harness.setSessionName).not.toHaveBeenCalled();
  });

  it("keeps naming disabled across restore, re-optimization, navigation and reload, even after an explicit clear", async () => {
    const harness = await makeHarness();
    await trigger(harness);
    await panelAction(harness, "a");
    await harness.command("restore", harness.context);
    expect(harness.getEditor()).toBe("Draft A");
    harness.manualName("");
    await trigger(harness);
    expect((harness.complete.mock.calls.at(-1) as any[])[1].systemPrompt).toContain("Do not generate a title");
    await panelAction(harness, "a");
    harness.handlers.get("session_tree")?.[0]?.({ type: "session_tree" }, harness.context);
    await harness.reload();
    await trigger(harness);
    expect((harness.complete.mock.calls.at(-1) as any[])[1].systemPrompt).toContain("Do not generate a title");
    await panelAction(harness, "a");
    expect(harness.setSessionName).toHaveBeenCalledTimes(1);
    expect(harness.getSessionName()).toBe("");
  });

  it("does not carry a discarded candidate's title into a different task", async () => {
    const harness = await makeHarness();
    harness.complete.mockResolvedValueOnce(refinement("Old prompt", "Old task"));
    await trigger(harness);
    await panelAction(harness, "x");
    expect(harness.setSessionName).not.toHaveBeenCalled();
    harness.setEditorText("New task draft");
    harness.complete.mockResolvedValueOnce(refinement("New prompt", "New task"));
    await trigger(harness);
    expect((harness.complete.mock.calls.at(-1) as any[])[1].systemPrompt).toContain('Also include a "title"');
    await panelAction(harness, "a");
    expect(harness.getEditor()).toBe("New prompt");
    expect(harness.setSessionName).toHaveBeenCalledExactlyOnceWith("New task");
  });

  it.each([undefined, null, 42, "", "bad\nname", "x".repeat(81)])("accepts prompt with an invalid title %j, then allows a new naming attempt", async (title) => {
    const harness = await makeHarness();
    harness.complete.mockResolvedValueOnce(refinement("Valid prompt", title));
    await trigger(harness);
    await panelAction(harness, "a");
    expect(harness.getEditor()).toBe("Valid prompt");
    expect(harness.setSessionName).not.toHaveBeenCalled();
    await trigger(harness);
    expect((harness.complete.mock.calls.at(-1) as any[])[1].systemPrompt).toContain('Also include a "title"');
    await panelAction(harness, "a");
    expect(harness.setSessionName).toHaveBeenCalledTimes(1);
  });

  it.each(['{"prompt":"unfinished', '{"title":"No prompt"}', '{"prompt":42}', 'raw text', '```json\n{"prompt":"wrapped"}\n```'])
    ("rejects malformed responses without exposing JSON as prompt: %s", async (text) => {
      const harness = await makeHarness();
      harness.complete.mockResolvedValueOnce({ content: [{ type: "text", text }], stopReason: "stop", usage: { totalTokens: 12 } });
      await trigger(harness);
      expect(harness.widgetLines().join("\n")).toContain("invalid output");
      expect(harness.widgetLines().join("\n")).toContain("total 12");
      await panelAction(harness, "a");
      await panelAction(harness, "s");
      expect(harness.editorWrites).toEqual([]);
      expect(harness.sent).toEqual([]);
      expect(harness.setSessionName).not.toHaveBeenCalled();
    });

  it.each(["stop-error", "length", "toolUse", "cancel", "confirmation-no", "confirmation-stale", "editor-failure"])
    ("does not name the session on %s", async (failure) => {
      const harness = await makeHarness();
      if (failure === "stop-error") harness.complete.mockRejectedValueOnce(new Error("offline"));
      if (failure === "length" || failure === "toolUse") harness.complete.mockResolvedValueOnce({ ...refinement("Partial prompt", "Task name"), stopReason: failure });
      await trigger(harness);
      if (failure === "cancel") await harness.command("cancel", harness.context);
      if (failure.startsWith("confirmation")) {
        harness.setEditorText("Changed draft");
        harness.deferConfirm();
      }
      if (failure === "editor-failure") vi.spyOn(harness.context.ui, "setEditorText").mockImplementation(() => { throw new Error("editor unavailable"); });
      await panelAction(harness, "a");
      if (failure === "confirmation-stale") harness.handlers.get("session_before_tree")?.[0]?.({}, harness.context);
      harness.resolveConfirm(failure !== "confirmation-no");
      await flushPromises();
      expect(harness.setSessionName).not.toHaveBeenCalled();
      expect(harness.editorWrites).toEqual([]);
    });

  it.each(["before_agent_start", "message_start", "followUp"])("names once only after successful %s send acknowledgement", async (ack) => {
    const harness = await makeHarness({ busy: ack === "followUp" });
    await trigger(harness);
    await panelAction(harness, "s");
    expect(harness.setSessionName).not.toHaveBeenCalled();
    expect(harness.sent[0]?.text).toBe("Refined prompt");
    harness.handlers.get("input")?.[0]?.({ text: "Refined prompt", source: "extension" }, harness.context);
    expect(harness.setSessionName).not.toHaveBeenCalled();
    const acknowledge = () => {
      if (ack === "followUp") harness.handlers.get("input")?.[0]?.({ text: "Refined prompt", source: "extension", streamingBehavior: "followUp" }, harness.context);
      else if (ack === "message_start") harness.handlers.get(ack)?.[0]?.({ message: { role: "user", content: [{ type: "text", text: "Refined prompt" }] } }, harness.context);
      else harness.handlers.get(ack)?.[0]?.({ messageType: "user", prompt: "Refined prompt" }, harness.context);
    };
    acknowledge();
    acknowledge();
    expect(harness.setSessionName).toHaveBeenCalledExactlyOnceWith("Draft refinement workflow");
    expect(harness.editorWrites).toEqual([]);
  });

  it.each(["throw", "timeout", "cancel", "session", "branch", "other-input", "edit"])
    ("does not apply a pending send title after %s", async (boundary) => {
      const harness = await makeHarness();
      vi.useFakeTimers();
      await trigger(harness);
      if (boundary === "throw") harness.sendUserMessage.mockImplementationOnce(() => { throw new Error("send failed"); });
      await panelAction(harness, "s");
      if (boundary === "timeout") await vi.advanceTimersByTimeAsync(DEFAULT_CONFIG.timeoutMs);
      if (boundary === "cancel") await harness.command("cancel", harness.context);
      if (boundary === "session") {
        harness.handlers.get("session_before_switch")?.[0]?.({}, harness.context);
        vi.spyOn(harness.context.sessionManager, "getSessionId").mockReturnValue("session-two");
        harness.handlers.get("session_start")?.[0]?.({}, harness.context);
      }
      if (boundary === "branch") harness.handlers.get("session_before_tree")?.[0]?.({}, harness.context);
      if (boundary === "other-input") harness.handlers.get("input")?.[0]?.({ text: "Unrelated", source: "interactive" }, harness.context);
      if (boundary === "edit") await panelAction(harness, "e");
      harness.handlers.get("message_start")?.[0]?.({ message: { role: "user", content: "Refined prompt" } }, harness.context);
      expect(harness.setSessionName).not.toHaveBeenCalled();
    });

  it("does not undo prompt acceptance when the naming API fails", async () => {
    const harness = await makeHarness();
    harness.setSessionName.mockImplementationOnce(() => { throw new Error("name write failed"); });
    await trigger(harness);
    await panelAction(harness, "a");
    expect(harness.getEditor()).toBe("Refined prompt");
    expect(harness.notifications.join("\n")).toContain("session naming failed");
    await trigger(harness);
    await panelAction(harness, "a");
    expect(harness.getSessionName()).toBe("Draft refinement workflow");
  });
});

describe("Pi extension integration (mocked TUI and provider)", () => {
  it("registers only Control+backslash by default, without Alt, Fn or occupied Ctrl letters", async () => {
    const harness = await makeHarness({ useDefaultShortcuts: true });
    expect([...harness.shortcuts.keys()]).toEqual(["ctrl+\\"]);
  });

  it("automatically shows generation progress and the result above the editor without opening a dialog", async () => {
    const harness = await makeHarness({ useDefaultShortcuts: true });
    let resolve!: (value: any) => void;
    harness.complete.mockImplementation(() => new Promise((res) => { resolve = res; }));
    await shortcut(harness, "ctrl+\\")(harness.context);
    expect(harness.widgetLines().join("\n")).toContain("Refining");
    expect(harness.widgetLines().join("\n")).toContain(" · asst");
    expect(harness.customCalls()).toBe(0);
    harness.setEditorText("Draft B");
    resolve({ content: [{ type: "text", text: JSON.stringify({ prompt: "Automatic visible result", title: "Background refinement" }) }], stopReason: "stop" });
    await flushPromises();
    expect(harness.widgetLines().join("\n")).toContain("Automatic visible result");
    expect(harness.customCalls()).toBe(0);
    expect(harness.getEditor()).toBe("Draft B");
    expect(harness.editorWrites).toEqual([]);
    expect(harness.sent).toEqual([]);
  });

  it("uses the same shortcut to open a live generating panel and automatically updates its candidate", async () => {
    const harness = await makeHarness({ useDefaultShortcuts: true });
    let resolve!: (value: any) => void;
    harness.complete.mockImplementation(() => new Promise((res) => { resolve = res; }));
    await shortcut(harness, "ctrl+\\")(harness.context);
    harness.holdPanel();
    const view = shortcut(harness, "ctrl+\\")(harness.context);
    expect(harness.panelLines().join("\n")).toContain("Refining");
    expect(harness.complete).toHaveBeenCalledTimes(1);
    resolve({ content: [{ type: "text", text: JSON.stringify({ prompt: "Fresh completed result", title: "Live preview" }) }], stopReason: "stop" });
    await flushPromises();
    expect(harness.panelLines().join("\n")).toContain("Fresh completed result");
    expect(harness.customCalls()).toBe(1);
    harness.panelInput("a");
    await view;
    expect(harness.getEditor()).toBe("Fresh completed result");
    expect(harness.widgetLines()).toEqual([]);
    expect(harness.sent).toEqual([]);
  });

  it("keeps the completed duration in the summary, status and reopened accepted panel", async () => {
    const harness = await makeHarness();
    vi.useFakeTimers();
    let resolve!: (value: any) => void;
    harness.complete.mockImplementationOnce(() => new Promise((res) => { resolve = res; }));
    await trigger(harness);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(harness.widgetLines().join("\n")).toContain("Refining · 12s");
    resolve(refinement("Timed result"));
    await flushPromises();
    expect(harness.widgetLines().join("\n")).toContain("Done · 12s");
    expect(harness.statuses.at(-1)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(30_000);
    await panelAction(harness, "q");
    expect(harness.panelLines().join("\n")).toContain("Done · 12s");
    expect(harness.widgetLines().join("\n")).toContain("Done · 12s");
    await panelAction(harness, "a");
    expect(harness.statuses.at(-1)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(30_000);
    await panelAction(harness, "q");
    expect(harness.panelLines().join("\n")).toContain("Accepted · 12s");
    expect(harness.complete).toHaveBeenCalledTimes(1);

    await trigger(harness);
    expect(harness.widgetLines().join("\n")).toContain("Done · 0s");
  });

  it("shows reported usage in the summary and accepted snapshot without extra requests", async () => {
    const harness = await makeHarness();
    harness.complete.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify({ prompt: "Usage result" }) }], stopReason: "stop",
      usage: { input: 120, output: 30, cacheRead: 40, cacheWrite: 0, reasoning: 10, totalTokens: 190 },
    });
    await trigger(harness);
    expect(harness.widgetLines(100).join("\n")).toContain("Tokens: total 190 · in 120 · out 30");
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    expect(harness.panelLines().join("").replace(/\s/g, "")).toContain("think(out)10");
    harness.panelInput("a");
    await view;
    const acceptedView = harness.command("view", harness.context);
    expect(harness.panelLines().join("\n")).toContain("Tokens: total 190");
    harness.panelInput("q");
    await acceptedView;
    expect(harness.complete).toHaveBeenCalledTimes(1);
    expect(harness.sent).toEqual([]);

    // A subsequent response without usage must not inherit the previous counts.
    await trigger(harness);
    expect(harness.widgetLines().join("\n")).not.toContain("Tokens:");
  });

  it("shows reported usage for an unusable response and clears it on retry", async () => {
    const harness = await makeHarness();
    harness.complete.mockResolvedValueOnce({
      content: [{ type: "text", text: "Partial result" }], stopReason: "length",
      usage: { totalTokens: 25 },
    });
    await trigger(harness);
    expect(harness.widgetLines().join("\n")).toContain("Tokens: total 25");
    harness.complete.mockImplementationOnce(() => new Promise(() => {}));
    await trigger(harness);
    expect(harness.widgetLines().join("\n")).not.toContain("Tokens:");
  });

  it.each(["\x1b", "\x1c"])("closes the preview with %j without changing the candidate or draft", async (key) => {
    const harness = await makeHarness();
    await trigger(harness);
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    harness.panelInput(key);
    await view;
    expect(harness.widgetLines().join("\n")).toContain("Refined prompt");
    expect(harness.editorWrites).toEqual([]);
    expect(harness.sent).toEqual([]);
    expect(harness.complete).toHaveBeenCalledTimes(1);
  });

  it("shows a single result surface and toggles reading options without writing or sending", async () => {
    const harness = await makeHarness();
    await trigger(harness);
    expect(harness.widgetLines().join("\n")).toContain("Refined prompt");
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    expect(harness.widgetLines()).toEqual([]);
    expect(harness.panelLines().join("\n")).not.toContain("Draft A");
    harness.panelInput("o");
    expect(harness.panelLines().join("\n")).toContain("Draft A");
    harness.panelInput("?");
    expect(harness.panelLines().join("\n")).toContain("Cycle favorites");
    harness.panelInput("v");
    expect(harness.panelLines().join("\n")).toContain("source");
    harness.panelInput("\r");
    expect(harness.sent).toEqual([]);
    expect(harness.editorWrites).toEqual([]);
    harness.panelInput("\x1b");
    await view;
    expect(harness.widgetLines().join("\n")).toContain("Refined prompt");
    expect(harness.getEditor()).toBe("Draft A");
    expect(harness.customCalls()).toBe(1);
  });

  it("opens input without refining and starts only after submission", async () => {
    const harness = await makeHarness();
    let submit!: (value: string | undefined) => void;
    vi.mocked(harness.context.ui.input).mockImplementation(() => new Promise((resolve) => { submit = resolve; }));
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    harness.panelInput("i");
    await flushPromises();
    expect(harness.context.ui.input).toHaveBeenCalledTimes(1);
    expect(harness.complete).not.toHaveBeenCalled();
    submit("New input prompt");
    await flushPromises();
    expect(harness.complete).toHaveBeenCalledTimes(1);
    expect((harness.complete.mock.calls[0] as any[])[1].messages[0].content[0].text).toContain("New input prompt");
    expect(harness.sent).toEqual([]);
    harness.panelInput("q");
    await view;
    const footer = vi.mocked(harness.context.ui.setFooter);
    expect((footer.mock.calls[0]![0] as any)().render(80)).toEqual([]);
    expect(footer).toHaveBeenLastCalledWith(undefined);
  });

  it.each([undefined, "   "])("does not refine canceled or blank input %j", async (value) => {
    const harness = await makeHarness();
    vi.mocked(harness.context.ui.input).mockResolvedValue(value);
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    harness.panelInput("i");
    await flushPromises();
    expect(harness.complete).not.toHaveBeenCalled();
    harness.panelInput("q");
    await view;
  });

  it.each(["\x1b[D", "q", "\x1b"])("cancels unsaved context edits with %j and keeps default injection", async (back) => {
    const harness = await makeHarness({ config: { projectContext: structuredClone(DEFAULT_CONFIG.projectContext) } });
    vi.spyOn(harness.context.sessionManager, "getBranch").mockReturnValue([]);
    vi.spyOn(harness.context, "getSystemPrompt").mockReturnValue(resourcePrompt());
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    const main = harness.panelLines();
    expect(main[0]).toContain("Main");
    harness.panelInput("t");
    harness.panelInput("\x1b[D");
    expect(harness.panelLines()).toEqual(main);
    harness.panelInput("\x1b[C");
    await flushPromises();
    const settings = harness.panelLines();
    expect(settings[0]).toContain("Context");
    expect(settings).toHaveLength(main.length);
    expect(settings.findIndex((line) => line.includes("──"))).toBe(main.findIndex((line) => line.includes("──")));
    expect(settings[0]?.startsWith("  ")).toBe(true);
    harness.panelInput(" ");
    const edited = harness.panelLines();
    harness.panelInput("\x1b[C");
    expect(harness.panelLines()).toEqual(edited);
    harness.panelInput(back);
    await flushPromises();
    expect(harness.complete).not.toHaveBeenCalled();
    harness.panelInput("q");
    await view;
    await trigger(harness);
    await vi.waitFor(() => expect(harness.complete).toHaveBeenCalledTimes(1));
    const input = (harness.complete.mock.calls[0] as any[])[1].messages[0].content[0].text;
    expect(input).toContain("Use the project venv.");
    expect(input).toContain("PROJECT TREE");
    expect(input).not.toContain("Extract PDF tables");
  });

  it("saves vertical context selections and applies them after reload", async () => {
    const harness = await makeHarness({ config: { projectContext: structuredClone(DEFAULT_CONFIG.projectContext) } });
    vi.spyOn(harness.context.sessionManager, "getBranch").mockReturnValue([]);
    vi.spyOn(harness.context, "getSystemPrompt").mockReturnValue(resourcePrompt());
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    harness.panelInput("\x1b[C");
    await flushPromises();
    const lines = harness.panelLines();
    expect(lines.filter((line) => /\[[x ]\]/.test(line))).toEqual(["  › [x] AGENTS.md", "    [x] tree", "    [ ] skills"]);
    harness.panelInput(" ");
    harness.panelInput("\x1b[B");
    harness.panelInput(" ");
    harness.panelInput("\x1b[B");
    harness.panelInput(" ");
    harness.panelInput("\r");
    await vi.waitFor(() => expect(harness.panelLines().join("\n")).toContain("Prompt Refine"));
    harness.panelInput("q");
    await view;
    const saved = JSON.parse(await readFile(join(harness.agentDir, "prompt-refine.json"), "utf8"));
    expect(saved.projectContext).toMatchObject({ instructionsEnabled: false, skillsEnabled: true, tree: { enabled: false } });
    await harness.reload();
    await trigger(harness);
    const input = (harness.complete.mock.calls[0] as any[])[1].messages[0].content[0].text;
    expect(input).not.toContain("Use the project venv.");
    expect(input).not.toContain("PROJECT TREE");
    expect(input).toContain("Extract PDF tables");
  });

  it("x Break aborts the provider request and ignores late output", async () => {
    const harness = await makeHarness();
    let resolve!: (value: any) => void;
    harness.complete.mockImplementation(() => new Promise((res) => { resolve = res; }));
    await trigger(harness);
    const signal = (harness.complete.mock.calls[0] as any[])[2].signal as AbortSignal;
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    expect(harness.panelLines().join("\n")).toContain("x Break");
    harness.panelInput("x");
    await view;
    expect(signal.aborted).toBe(true);
    resolve({ content: [{ type: "text", text: JSON.stringify({ prompt: "Late output" }) }], stopReason: "stop" });
    await flushPromises();
    expect(harness.widgetLines()).toEqual([]);
    expect(harness.sent).toEqual([]);
    expect(harness.getEditor()).toBe("Draft A");
  });

  it("closing a live panel keeps generating and does not reopen it on completion", async () => {
    const harness = await makeHarness();
    let resolve!: (value: any) => void;
    harness.complete.mockImplementation(() => new Promise((res) => { resolve = res; }));
    await trigger(harness);
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    harness.panelInput("q");
    await view;
    expect(harness.widgetLines().join("\n")).toContain("Refining");
    resolve({ content: [{ type: "text", text: JSON.stringify({ prompt: "Background result" }) }], stopReason: "stop" });
    await flushPromises();
    expect(harness.widgetLines().join("\n")).toContain("Background result");
    expect(harness.customCalls()).toBe(1);
  });

  it.each(["input", "session_before_tree", "session_shutdown"])("clears widget and live panel on %s and ignores late output", async (event) => {
    const harness = await makeHarness();
    let resolve!: (value: any) => void;
    harness.complete.mockImplementation(() => new Promise((res) => { resolve = res; }));
    await trigger(harness);
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    harness.handlers.get(event)?.[0]?.({ type: event, text: "Draft B", source: "interactive" }, harness.context);
    await view;
    expect(harness.widgetLines()).toEqual([]);
    resolve({ content: [{ type: "text", text: JSON.stringify({ prompt: "must not reappear", title: "Stale task" }) }], stopReason: "stop" });
    await flushPromises();
    expect(harness.widgetLines()).toEqual([]);
    expect(harness.editorWrites).toEqual([]);
    expect(harness.customCalls()).toBe(1);
  });

  it("refreshes elapsed time, permits retry from an open error panel, and cleans timers", async () => {
    const harness = await makeHarness();
    vi.useFakeTimers();
    harness.complete.mockImplementation(() => new Promise(() => {}));
    await trigger(harness);
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(harness.widgetLines()).toEqual([]);
    expect(harness.panelLines().join("\n")).toContain("2s");
    await vi.advanceTimersByTimeAsync(58_000);
    expect(harness.widgetLines()).toEqual([]);
    expect(harness.panelLines().join("\n")).toContain("timed out");
    expect(vi.getTimerCount()).toBe(0);
    harness.complete.mockImplementation(async () => ({ content: [{ type: "text", text: JSON.stringify({ prompt: "retry succeeded" }) }], stopReason: "stop" }));
    harness.panelInput("r");
    await view;
    await flushPromises();
    expect(harness.widgetLines().join("\n")).toContain("retry succeeded");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("opens the action panel instead of issuing a request when no model is configured", async () => {
    const harness = await makeHarness({ useDefaultShortcuts: true, configureModel: false });
    await shortcut(harness, "ctrl+\\")(harness.context);
    expect(harness.customCalls()).toBe(1);
    expect(harness.panelLines().join("\n")).toContain("m Model");
    expect(harness.complete).not.toHaveBeenCalled();
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

  it("presents a compact model picker without changing the model on cancel", async () => {
    const harness = await makeHarness();
    harness.setCustomAction("\x1b");
    await harness.command("model", harness.context);
    expect(harness.panelLines().join("\n")).toContain("Choose optimizer model");
    expect(harness.panelLines().join("\n")).toContain("does not change the main session model");
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
    await shortcut(unavailable, "f5")(unavailable.context);
    expect(unavailable.notifications.join(" ")).toContain("No authorized text-generation models are available");
  });

  it("runs the optimizer in the background without writing the editor or session", async () => {
    const harness = await makeHarness();
    await trigger(harness);

    expect(harness.complete).toHaveBeenCalledTimes(1);
    const [_model, completionContext, completionOptions] = harness.complete.mock.calls[0] as any[];
    expect(completionContext.tools).toEqual([]);
    expect(completionContext.systemPrompt).toContain("return a single JSON object");
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

  it("actually sends the last visible assistant to the optimizer even with a one-message budget", async () => {
    const harness = await makeHarness({ config: { context: { maxMessages: 1, maxChars: 100 } } });
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
    expect(harness.widgetLines().join("\n")).toContain(" · asst");
  });

  it("respects explicit zero history budgets and makes draft-only mode visible", async () => {
    const harness = await makeHarness({ config: { context: { maxMessages: 0, maxChars: 100 } } });
    await trigger(harness);
    const context = (harness.complete.mock.calls[0] as any[])[1];
    expect(context.messages[0].content[0].text).not.toContain("visible answer");
    expect(harness.widgetLines().join("\n")).toContain("Draft only");
  });

  it("accepts only explicitly, preserves an intervening draft behind default-No overwrite confirmation, and safely restores", async () => {
    const harness = await makeHarness();
    await trigger(harness);
    harness.setCustomAction("a");
    await shortcut(harness, "f3")(harness.context);
    expect(harness.getEditor()).toBe("Refined prompt");
    expect(harness.sent).toEqual([]);
    expect(harness.internalMessages).toEqual([]);
    expect(harness.sessionWrites).toEqual([]);
    expect(harness.editorWrites).toEqual(["Refined prompt"]);

    await shortcut(harness, "f7")(harness.context);
    expect(harness.getEditor()).toBe("Draft A");
    expect(harness.sent).toEqual([]);

    await trigger(harness);
    harness.setEditorText("Draft B");
    harness.setConfirm(false);
    harness.setCustomAction("a");
    await shortcut(harness, "f3")(harness.context);
    await flushPromises();
    expect(harness.getEditor()).toBe("Draft B");
    expect(harness.editorWrites).toEqual(["Refined prompt", "Draft A"]);
    expect(harness.context.ui.confirm).toHaveBeenCalledTimes(1);
  });

  it.each(["Refined prompt", "Refined prompt with my edits", "Entirely replaced draft", ""])("views an accepted result without calling the model when the editor contains %j", async (draft) => {
    const harness = await makeHarness({ useDefaultShortcuts: true });
    await trigger(harness);
    harness.setCustomAction("a");
    await shortcut(harness, "ctrl+\\")(harness.context);
    harness.setEditorText(draft);
    harness.setCustomAction("q");
    await shortcut(harness, "ctrl+\\")(harness.context);
    await shortcut(harness, "ctrl+\\")(harness.context);
    expect(harness.complete).toHaveBeenCalledTimes(1);
    const panel = harness.panelLines().join("\n");
    expect(panel).toContain("Accepted prompt");
    expect(panel).toContain("read-only");
    if (draft !== "Refined prompt") expect(panel).toContain("excludes later edits");
    expect(harness.getEditor()).toBe(draft);
    expect(harness.editorWrites).toEqual(["Refined prompt"]);
    expect(harness.sent).toEqual([]);
  });

  it("keeps archived a/e/s disabled so viewing cannot overwrite or send an old result", async () => {
    const harness = await makeHarness();
    await trigger(harness);
    harness.setCustomAction("a");
    await harness.command("view", harness.context);
    harness.setEditorText("my final edits");
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    for (const key of ["a", "e", "s", "\r"]) harness.panelInput(key);
    expect(harness.context.ui.editor).not.toHaveBeenCalled();
    expect(harness.editorWrites).toEqual(["Refined prompt"]);
    expect(harness.sent).toEqual([]);
    expect(harness.complete).toHaveBeenCalledTimes(1);
    harness.panelInput("q");
    await view;
    expect(harness.getEditor()).toBe("my final edits");
  });

  it("re-optimizes the actual edited main prompt only after explicit r", async () => {
    const harness = await makeHarness({ useDefaultShortcuts: true });
    await trigger(harness);
    harness.setCustomAction("a");
    await shortcut(harness, "ctrl+\\")(harness.context);
    harness.setEditorText("my edited accepted prompt");
    harness.setCustomAction("q");
    await shortcut(harness, "ctrl+\\")(harness.context);
    expect(harness.complete).toHaveBeenCalledTimes(1);
    harness.setCustomAction("r");
    await shortcut(harness, "ctrl+\\")(harness.context);
    await flushPromises();
    expect(harness.complete).toHaveBeenCalledTimes(2);
    const request = (harness.complete.mock.calls[1] as any[])[1];
    expect(request.messages[0].content[0].text).toContain("my edited accepted prompt");
    expect(harness.getEditor()).toBe("my edited accepted prompt");
    harness.setCustomAction("q");
    await shortcut(harness, "ctrl+\\")(harness.context);
    expect(harness.complete).toHaveBeenCalledTimes(2);
  });

  it("opens an edited candidate without regenerating and labels a changed main draft", async () => {
    const harness = await makeHarness({ useDefaultShortcuts: true });
    await trigger(harness);
    harness.setCustomAction("e");
    await shortcut(harness, "ctrl+\\")(harness.context);
    harness.setEditorText("another main draft");
    harness.setCustomAction("q");
    await shortcut(harness, "ctrl+\\")(harness.context);
    expect(harness.panelLines().join("\n")).toContain("Edited candidate");
    expect(harness.panelLines().join("\n")).toContain("candidate uses the original draft");
    expect(harness.complete).toHaveBeenCalledTimes(1);
    expect(harness.getEditor()).toBe("another main draft");
  });

  it("uses the shortcut to inspect failures and requires r for retry", async () => {
    const harness = await makeHarness({ useDefaultShortcuts: true });
    harness.complete.mockRejectedValueOnce(new Error("offline"));
    await trigger(harness);
    harness.setCustomAction("q");
    await shortcut(harness, "ctrl+\\")(harness.context);
    expect(harness.panelLines().join("\n")).toContain("request failed");
    expect(harness.complete).toHaveBeenCalledTimes(1);
    harness.setCustomAction("r");
    await shortcut(harness, "ctrl+\\")(harness.context);
    await flushPromises();
    expect(harness.complete).toHaveBeenCalledTimes(2);
  });

  it("honors an explicit optimize command even when a ready result has the same source draft", async () => {
    const harness = await makeHarness();
    await trigger(harness);
    await harness.command("optimize", harness.context);
    await flushPromises();
    expect(harness.complete).toHaveBeenCalledTimes(2);
    expect(harness.customCalls()).toBe(0);
  });

  it.each(["", "x".repeat(101)])("preserves the ready result when r is requested with an invalid draft", async (draft) => {
    const harness = await makeHarness({ config: { maxDraftChars: 100 } });
    await trigger(harness);
    harness.setEditorText(draft);
    harness.setCustomAction("r");
    await harness.command("view", harness.context);
    await flushPromises();
    expect(harness.complete).toHaveBeenCalledTimes(1);
    expect(harness.widgetLines().join("\n")).toContain("Refined prompt");
    expect(harness.getEditor()).toBe(draft);
  });

  it("does not forget accepted provenance on dismiss, but clears it after submission", async () => {
    const harness = await makeHarness({ useDefaultShortcuts: true });
    await trigger(harness);
    harness.setCustomAction("a");
    await shortcut(harness, "ctrl+\\")(harness.context);
    await harness.command("cancel", harness.context);
    harness.setCustomAction("q");
    await shortcut(harness, "ctrl+\\")(harness.context);
    expect(harness.complete).toHaveBeenCalledTimes(1);
    harness.handlers.get("input")?.[0]?.({ type: "input", text: "Refined prompt", source: "interactive" }, harness.context);
    harness.setEditorText("brand new task");
    await shortcut(harness, "ctrl+\\")(harness.context);
    await flushPromises();
    expect(harness.complete).toHaveBeenCalledTimes(2);
  });

  it("rejects a confirmation that returns after the session branch changed", async () => {
    const harness = await makeHarness();
    await trigger(harness);
    harness.setEditorText("Draft B");
    harness.deferConfirm();
    harness.setCustomAction("a");
    await shortcut(harness, "f3")(harness.context);
    expect(harness.context.ui.confirm).toHaveBeenCalledTimes(1);
    harness.handlers.get("session_before_tree")?.[0]?.({ type: "session_before_tree" }, harness.context);
    harness.resolveConfirm(true);
    await flushPromises();
    expect(harness.getEditor()).toBe("Draft B");
    expect(harness.editorWrites).toEqual([]);
  });

  it("rechecks text after a confirmation dialog returns before replacement", async () => {
    const harness = await makeHarness();
    await trigger(harness);
    harness.setEditorText("Draft B");
    harness.setConfirm(true, "Draft C");
    harness.setCustomAction("a");
    await shortcut(harness, "f3")(harness.context);
    await flushPromises();
    expect(harness.getEditor()).toBe("Draft C");
    expect(harness.editorWrites).toEqual([]);
  });

  it("invalidates a late result on submitted input even if the user retypes the same A", async () => {
    const harness = await makeHarness();
    let resolve!: (value: any) => void;
    harness.complete.mockImplementation(() => new Promise((res) => { resolve = res; }));
    await trigger(harness);
    harness.setEditorText("");
    const inputHandler = harness.handlers.get("input")?.[0];
    inputHandler?.({ type: "input", text: "Draft A", source: "interactive" }, harness.context);
    harness.setEditorText("Draft A");
    resolve({ content: [{ type: "text", text: JSON.stringify({ prompt: "stale result", title: "Stale task" }) }], stopReason: "stop" });
    await flushPromises();

    expect(harness.getEditor()).toBe("Draft A");
    expect(harness.editorWrites).toEqual([]);
    harness.setCustomAction("a");
    await shortcut(harness, "f3")(harness.context);
    expect(harness.editorWrites).toEqual([]);
  });

  it.each(["tree", "shutdown"] as const)("drops a late response after %s lifecycle invalidation", async (boundary) => {
    const harness = await makeHarness();
    let resolve!: (value: any) => void;
    harness.complete.mockImplementation(() => new Promise((res) => { resolve = res; }));
    await trigger(harness);
    const eventName = boundary === "tree" ? "session_before_tree" : "session_shutdown";
    harness.handlers.get(eventName)?.[0]?.({ type: eventName }, harness.context);
    resolve({ content: [{ type: "text", text: JSON.stringify({ prompt: "late", title: "Stale task" }) }], stopReason: "stop" });
    await flushPromises();
    expect(harness.editorWrites).toEqual([]);
    expect(harness.sent).toEqual([]);
  });


  it("waits for Pi's idle before-agent boundary before consuming an explicitly sent candidate", async () => {
    const harness = await makeHarness();
    await trigger(harness);
    harness.setCustomAction("s");
    await shortcut(harness, "f3")(harness.context);
    expect(harness.sent).toEqual([{ text: "Refined prompt", options: undefined }]);

    harness.handlers.get("input")?.[0]?.({ type: "input", text: "Refined prompt", source: "extension" }, harness.context);
    expect(harness.statuses.at(-1)).toBeUndefined();
    harness.setCustomAction("s");
    await shortcut(harness, "f3")(harness.context);
    expect(harness.sent).toHaveLength(1);

    harness.handlers.get("before_agent_start")?.[0]?.({ type: "before_agent_start", messageType: "user", prompt: "Refined prompt" }, harness.context);
    expect(harness.statuses.at(-1)).toBeUndefined();
    harness.setCustomAction("q");
    await shortcut(harness, "f3")(harness.context);
    expect(harness.panelLines().join("\n")).toContain("No result yet");
    expect(harness.getEditor()).toBe("Draft A");
  });

  it("sends the current candidate exactly once as Pi follow-up when busy without replacing another draft", async () => {
    const harness = await makeHarness({ busy: true });
    await trigger(harness);
    harness.setEditorText("unrelated main draft");
    harness.setCustomAction("s");
    await shortcut(harness, "f3")(harness.context);
    expect(harness.sent).toEqual([{ text: "Refined prompt", options: { deliverAs: "followUp" } }]);
    expect(harness.getEditor()).toBe("unrelated main draft");
    expect(harness.editorWrites).toEqual([]);

    harness.handlers.get("input")?.[0]?.({ type: "input", text: "Refined prompt", source: "extension", streamingBehavior: "followUp" }, harness.context);
    harness.setCustomAction("s");
    await shortcut(harness, "f3")(harness.context);
    expect(harness.sent).toHaveLength(1);
  });

  it("allows canceling independent edits and leaves the main editor untouched", async () => {
    const harness = await makeHarness();
    await trigger(harness);
    harness.setCustomAction("e");
    await shortcut(harness, "f3")(harness.context);
    expect(harness.context.ui.editor).toHaveBeenCalledWith("Edit candidate (cancel keeps original)", "Refined prompt");
    expect(harness.getEditor()).toBe("Draft A");
    expect(harness.editorWrites).toEqual([]);
  });

  it("keeps a long multibyte preview within narrow and wide terminal widths", async () => {
    const harness = await makeHarness();
    harness.complete.mockImplementation(async () => ({
      content: [{ type: "text", text: JSON.stringify({ prompt: "优化后的 Prompt：" + " 保留用户目标与约束。".repeat(30) }) }],
      stopReason: "stop",
    }));
    await trigger(harness);
    harness.setCustomAction("q");
    await shortcut(harness, "f3")(harness.context);
    expect(harness.renderedWidths).toHaveLength(3);
    for (const rendered of harness.renderedWidths) {
      for (const line of rendered.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(rendered.width);
    }
  });

  it("does not invoke interactive APIs or the model in non-TUI mode", async () => {
    const harness = await makeHarness({ mode: "print" });
    await harness.command("optimize", harness.context);
    expect(harness.complete).not.toHaveBeenCalled();
    expect(harness.context.ui.getEditorText()).toBe("Draft A");
    expect(harness.editorWrites).toEqual([]);
    expect(harness.sent).toEqual([]);
  });
});
