import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function makeHarness(options: { mode?: "tui" | "print"; busy?: boolean; configureModel?: boolean; noAvailableModels?: boolean; reasoning?: boolean; thinkingLevel?: ModelThinkingLevel; config?: Partial<RefineConfig>; useDefaultShortcuts?: boolean } = {}): Promise<Harness> {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-prompt-refine-agent-"));
  agentDirs.push(agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const config = { ...structuredClone(DEFAULT_CONFIG), ...options.config } as RefineConfig;
  if (options.config?.context) config.context = { ...DEFAULT_CONFIG.context, ...options.config.context };
  // Keep explicit secondary bindings in the older workflow tests; test defaults separately.
  if (!options.useDefaultShortcuts) config.shortcuts = { ...config.shortcuts, view: "f3", selectModel: "f5", restore: "f7" };
  if (options.config?.shortcuts) config.shortcuts = { ...DEFAULT_CONFIG.shortcuts, ...options.config.shortcuts };
  if (options.configureModel !== false) config.model = { provider: "fake-provider", id: "fake-chat" };
  await writeFile(join(agentDir, "prompt-refine.json"), `${JSON.stringify(config)}\n`, "utf8");

  const model = { provider: "fake-provider", id: "fake-chat", name: "Fake Chat", maxTokens: 4096, reasoning: options.reasoning ?? false } as Model<Api>;
  const complete = vi.fn(async (_model?: Model<Api>, _context?: unknown, _options?: unknown) => ({
    content: [{ type: "text", text: "Refined prompt" }],
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
  const renderedWidths: Array<{ width: number; lines: string[] }> = [];
  const sessionManager = {
    getSessionId: () => "session-one",
    getLeafId: () => "leaf-one",
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
    getEditorText: () => editor,
    setEditorText: (text: string) => {
      editor = text;
      editorWrites.push(text);
    },
    editor: vi.fn(async () => "Edited candidate"),
    confirm: vi.fn((_title: string, message: string) => {
      expect(message).toContain("以下是确认时实际将被替换的草稿");
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
    sendUserMessage: (text: string, sendOptions?: { deliverAs?: "steer" | "followUp" }) => sent.push({ text, options: sendOptions }),
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

describe("optimizer model picker", () => {
  const thinking = { provider: "fake-provider", id: "reasoner", name: "Reasoner", reasoning: true } as Model<Api>;
  const plain = { provider: "other", id: "plain", name: "Plain Chat", reasoning: false } as Model<Api>;

  it("keeps both reasoning and ordinary models when no search is entered", () => {
    const items = modelPickerItems([thinking, plain], "", thinking);
    expect(items.map((item) => item.value)).toEqual(["fake-provider/reasoner", "other/plain"]);
    expect(items[0]?.label).toBe("fake-provider/reasoner [thinking] (当前)");
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
    expect(harness.widgetLines().join("\n")).toContain("正在优化");
    expect(harness.widgetLines().join("\n")).toContain("含最近 assistant 回复");
    expect(harness.customCalls()).toBe(0);
    harness.setEditorText("Draft B");
    resolve({ content: [{ type: "text", text: "Automatic visible result" }], stopReason: "stop" });
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
    expect(harness.panelLines().join("\n")).toContain("正在优化");
    expect(harness.complete).toHaveBeenCalledTimes(1);
    resolve({ content: [{ type: "text", text: "Fresh completed result" }], stopReason: "stop" });
    await flushPromises();
    expect(harness.panelLines().join("\n")).toContain("Fresh completed result");
    expect(harness.customCalls()).toBe(1);
    harness.panelInput("a");
    await view;
    expect(harness.getEditor()).toBe("Fresh completed result");
    expect(harness.widgetLines()).toEqual([]);
    expect(harness.sent).toEqual([]);
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
    expect(harness.panelLines().join("\n")).toContain("收藏循环");
    harness.panelInput("v");
    expect(harness.panelLines().join("\n")).toContain("纯文本");
    harness.panelInput("\r");
    expect(harness.sent).toEqual([]);
    expect(harness.editorWrites).toEqual([]);
    harness.panelInput("\x1b");
    await view;
    expect(harness.widgetLines().join("\n")).toContain("Refined prompt");
    expect(harness.getEditor()).toBe("Draft A");
    expect(harness.customCalls()).toBe(1);
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
    expect(harness.widgetLines().join("\n")).toContain("正在优化");
    resolve({ content: [{ type: "text", text: "Background result" }], stopReason: "stop" });
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
    resolve({ content: [{ type: "text", text: "must not reappear" }], stopReason: "stop" });
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
    expect(harness.panelLines().join("\n")).toContain("超时");
    expect(vi.getTimerCount()).toBe(0);
    harness.complete.mockImplementation(async () => ({ content: [{ type: "text", text: "retry succeeded" }], stopReason: "stop" }));
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
    expect(harness.panelLines().join("\n")).toContain("m 选择模型");
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
    expect(harness.notifications.join(" ")).toContain("思考强度 high（扩展设置）");

    await trigger(harness);
    expect((harness.complete.mock.calls[0] as any[])[2]).toMatchObject({ reasoning: "high" });
  });

  it("presents a compact model picker without changing the model on cancel", async () => {
    const harness = await makeHarness();
    harness.setCustomAction("\x1b");
    await harness.command("model", harness.context);
    expect(harness.panelLines().join("\n")).toContain("选择优化模型");
    expect(harness.panelLines().join("\n")).toContain("不改变主会话模型");
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
    expect(unconfigured.notifications.join(" ")).toContain("尚未配置优化模型");

    const unavailable = await makeHarness({ noAvailableModels: true });
    await trigger(unavailable);
    expect(unavailable.complete).not.toHaveBeenCalled();
    expect(unavailable.notifications.join(" ")).toContain("当前不存在或不可用");
    await shortcut(unavailable, "f5")(unavailable.context);
    expect(unavailable.notifications.join(" ")).toContain("当前没有可用于文本生成的已授权模型");
  });

  it("runs the optimizer in the background without writing the editor or session", async () => {
    const harness = await makeHarness();
    await trigger(harness);

    expect(harness.complete).toHaveBeenCalledTimes(1);
    const [_model, completionContext, completionOptions] = harness.complete.mock.calls[0] as any[];
    expect(completionContext.tools).toEqual([]);
    expect(completionContext.systemPrompt).toContain("output only the final prompt text");
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
    expect(harness.widgetLines().join("\n")).toContain("含最近 assistant 回复");
  });

  it("respects explicit zero history budgets and makes draft-only mode visible", async () => {
    const harness = await makeHarness({ config: { context: { maxMessages: 0, maxChars: 100 } } });
    await trigger(harness);
    const context = (harness.complete.mock.calls[0] as any[])[1];
    expect(context.messages[0].content[0].text).not.toContain("visible answer");
    expect(harness.widgetLines().join("\n")).toContain("仅草稿");
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
    expect(panel).toContain("上次接受的 Prompt");
    expect(panel).toContain("只读快照");
    if (draft !== "Refined prompt") expect(panel).toContain("不包含后续微调");
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
    expect(harness.panelLines().join("\n")).toContain("此候选仍基于触发时草稿");
    expect(harness.complete).toHaveBeenCalledTimes(1);
    expect(harness.getEditor()).toBe("another main draft");
  });

  it("uses the shortcut to inspect failures and requires r for retry", async () => {
    const harness = await makeHarness({ useDefaultShortcuts: true });
    harness.complete.mockRejectedValueOnce(new Error("offline"));
    await trigger(harness);
    harness.setCustomAction("q");
    await shortcut(harness, "ctrl+\\")(harness.context);
    expect(harness.panelLines().join("\n")).toContain("请求失败");
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
    resolve({ content: [{ type: "text", text: "stale result" }], stopReason: "stop" });
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
    resolve({ content: [{ type: "text", text: "late" }], stopReason: "stop" });
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
    expect(harness.statuses.at(-1)).toBe("Refine · 发送待 Pi 确认 · 主草稿保留");
    harness.setCustomAction("s");
    await shortcut(harness, "f3")(harness.context);
    expect(harness.sent).toHaveLength(1);

    harness.handlers.get("before_agent_start")?.[0]?.({ type: "before_agent_start", messageType: "user", prompt: "Refined prompt" }, harness.context);
    expect(harness.statuses.at(-1)).toBeUndefined();
    harness.setCustomAction("q");
    await shortcut(harness, "f3")(harness.context);
    expect(harness.panelLines().join("\n")).toContain("没有可预览");
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
    expect(harness.context.ui.editor).toHaveBeenCalledWith("微调优化结果（取消不修改候选）", "Refined prompt");
    expect(harness.getEditor()).toBe("Draft A");
    expect(harness.editorWrites).toEqual([]);
  });

  it("keeps a long multibyte preview within narrow and wide terminal widths", async () => {
    const harness = await makeHarness();
    harness.complete.mockImplementation(async () => ({
      content: [{ type: "text", text: "优化后的 Prompt：" + " 保留用户目标与约束。".repeat(30) }],
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
