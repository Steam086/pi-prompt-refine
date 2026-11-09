import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { stripVTControlCharacters } from "node:util";
import { workspaceHeight } from "../src/workspace-overlay.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { matchesKey, TuiAltScreen, TuiMainScreen, visibleWidth, type OverlayHandle, type OverlayOptions, type Terminal } from "@earendil-works/pi-tui";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import promptRefineExtension, { modelPickerItems } from "../src/extension.js";
import { DEFAULT_CONFIG, type RefineConfig } from "../src/config.js";
import { PreferenceStore } from "../src/preference-store.js";
import * as preferences from "../src/revision-preferences.js";
import { flushPromises } from "./helpers.js";
import { screenDraft } from "./fixtures/reference-preservation.js";

const agentDirs: string[] = [];
const activeHarnesses: Harness[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(async () => {
  for (const harness of activeHarnesses.splice(0)) {
    await harness.handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown" }, harness.context);
    harness.renderer?.tui.stop();
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
  reload(reason?: "reload" | "resume" | "fork"): Promise<void>;
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
  panelLines(width?: number): string[];
  resize(rows: number): void;
  customCalls(): number;
  customOptions: Array<{ overlay?: boolean; overlayOptions?: unknown }>;
  renderer?: { tui: RecordingMainScreen | RecordingAltScreen; writes: string[]; terminal: Terminal; input(key: string): void };
}

class RecordingMainScreen extends TuiMainScreen {
  readonly overlayFrames: boolean[] = [];
  protected override doRender(): void { this.overlayFrames.push(this.hasOverlay()); super.doRender(); }
}
class RecordingAltScreen extends TuiAltScreen {
  readonly overlayFrames: boolean[] = [];
  protected override doRender(): void { this.overlayFrames.push(this.hasOverlay()); super.doRender(); }
}

async function makeHarness(options: { renderer?: { mode: "regular" | "fullscreen"; theme: "dark" | "light" }; persistHistory?: boolean; freshInstall?: boolean; sessionName?: string; mode?: "tui" | "rpc" | "print"; busy?: boolean; configureModel?: boolean; noAvailableModels?: boolean; reasoning?: boolean; thinkingLevel?: ModelThinkingLevel; config?: Partial<RefineConfig>; useDefaultShortcuts?: boolean } = {}): Promise<Harness> {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-prompt-refine-agent-"));
  agentDirs.push(agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const config = { ...structuredClone(DEFAULT_CONFIG), ...options.config } as RefineConfig;
  // Existing workflow tests exercise the explicitly supported history-only mode.
  // Project context (including real asynchronous tree collection) has separate integration cases.
  if (!options.config?.projectContext) config.projectContext = { ...config.projectContext, enabled: false };
  if (options.config?.context) config.context = { ...DEFAULT_CONFIG.context, ...options.config.context };
  // Keep explicit secondary bindings in the older workflow tests; test defaults separately.
  if (!options.useDefaultShortcuts) config.shortcuts = { ...config.shortcuts, view: "alt+v", selectModel: "alt+m", restore: "alt+z" };
  if (options.config?.shortcuts) config.shortcuts = { ...DEFAULT_CONFIG.shortcuts, ...options.config.shortcuts };
  if (options.configureModel !== false) config.model = { provider: "fake-provider", id: "fake-chat" };
  if (!options.freshInstall) await writeFile(join(agentDir, "prompt-refine.json"), `${JSON.stringify(config)}\n`, "utf8");

  const model = { provider: "fake-provider", id: "fake-chat", name: "Fake Chat", contextWindow: 128_000, maxTokens: 16_384, reasoning: options.reasoning ?? false } as Model<Api>;
  const complete = vi.fn(async (_model?: Model<Api>, _context?: unknown, _options?: unknown) => ({
    content: [{ type: "text", text: JSON.stringify({ prompt: "Refined prompt", title: "Draft refinement workflow" }) }],
    stopReason: "stop",
  }));
  const modelRegistry = {
    isUsingOAuth: vi.fn(() => false),
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
    getSessionFile: () => options.persistHistory ? join(agentDir, "session.jsonl") : undefined,
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
  const customOptions: Harness["customOptions"] = [];
  const writes: string[] = [];
  let nativeInput = (_data: string) => {};
  const terminal = { rows: 40, columns: 100, kittyProtocolActive: true,
    start: (onInput) => { nativeInput = onInput; }, stop() {}, write: (data) => { writes.push(data); },
    async drainInput() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {},
    clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
  } satisfies Terminal;
  const renderer = !options.renderer ? undefined : options.renderer.mode === "regular"
    ? new RecordingMainScreen(terminal) : new RecordingAltScreen(terminal);
  if (renderer) {
    renderer.addChild({ render: () => ["Underlying Pi conversation"], invalidate() {} });
    renderer.start();
  }
  const theme = options.renderer ? getThemeByName(options.renderer.theme)! : {
    fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text,
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
      if (_title !== "Clear saved Refine history?") expect(message).toContain("Current draft:");
      if (shouldDeferConfirm) {
        return new Promise<boolean>((resolve) => { confirmResolve = resolve; });
      }
      if (confirmMutation !== undefined) editor = confirmMutation;
      return Promise.resolve(confirmResult);
    }),
    custom: async <T>(factory: (tui: any, theme: any, keybindings: any, done: (value: T) => void) => any,
      options: Harness["customOptions"][number] = {}): Promise<T> => {
      customCalls += 1;
      customOptions.push(options);
      return await new Promise<T>((resolve) => {
        let overlay: OverlayHandle | undefined;
        let closed = false;
        const component = factory(
          renderer ?? { requestRender: vi.fn(), terminal },
          theme,
          {
            getKeys: (action: string) => action === "app.thinking.cycle" ? ["shift+tab"] : [],
            getResolvedBindings: () => ({ "app.thinking.cycle": ["shift+tab"] }),
            matches: (data: string, action: string) => {
              const keys: Record<string, string> = {
                "tui.select.cancel": "escape", "tui.select.confirm": "return", "tui.input.submit": "return",
                "tui.select.up": "up", "tui.select.down": "down", "app.thinking.cycle": "shift+tab",
                "tui.editor.cursorUp": "up", "tui.editor.cursorDown": "down",
                "tui.editor.pageUp": "pageUp", "tui.editor.pageDown": "pageDown", "tui.editor.deleteCharBackward": "backspace",
              };
              return keys[action] ? matchesKey(data, keys[action] as any) : false;
            },
          },
          (value) => {
            if (closed) return;
            closed = true;
            overlay?.hide();
            resolve(value);
            component?.dispose?.();
          },
        );
        if (renderer) {
          // Match Pi's asynchronous custom-factory mounting and immediate input redraw.
          Promise.resolve(component).then((mounted) => {
            if (closed) return;
            panel = mounted;
            overlay = renderer.showOverlay(mounted, options.overlayOptions as OverlayOptions);
          });
          return;
        }
        panel = component;
        component.focused = true;
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
  await sessionStart?.({ type: "session_start", reason: "startup" }, context);

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
    reload: async (reason = "reload") => {
      await handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown" }, context);
      handlers.clear();
      shortcuts.clear();
      await promptRefineExtension(pi);
      harness.command = command;
      await handlers.get("session_start")?.[0]?.({ type: "session_start", reason }, context);
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
    customOptions,
    renderer: renderer ? { tui: renderer, writes, terminal, input: (key) => nativeInput(key) } : undefined,
    widgetLines: (width = 80) => widget?.render(width) ?? [],
    holdPanel: () => { holdPanel = true; },
    panelInput: (key) => panel?.handleInput?.(key),
    panelLines: (width = 80) => panel?.render(width) ?? [],
    resize: (rows) => { terminal.rows = rows; },
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
  config.instructionsEnabled = true;
  config.instructionsOnFollowUp = true;
  config.skillsEnabled = true;
  return config;
}

function resourcePrompt(skillDescription = "Extract PDF tables", instructions = "Use the project venv."): string {
  return `<tools>\nPRIVATE MAIN AGENT TOOLS\n</tools>\n<project_context>\nProject-specific instructions and guidelines:\n\n<project_instructions path="/repo/AGENTS.md">\n${instructions}\n</project_instructions>\n</project_context>\n<skills>\nUse bash to load skills.\n<available_skills>\n<skill><name>pdf</name><description>${skillDescription}</description><location>/skills/pdf/SKILL.md</location></skill>\n</available_skills>\n</skills>\n<cwd>\n/repo\n</cwd>`;
}

describe("startup hint", () => {
  it.each([
    ["ctrl+\\", "Ctrl + \\"],
    ["alt+r", "alt + r"],
    [null, "/refine optimize"],
  ] as const)("uses the configured optimize binding %s", async (optimize, label) => {
    const harness = await makeHarness({ config: { shortcuts: { ...DEFAULT_CONFIG.shortcuts, optimize } } });
    expect(harness.notifications).toEqual([`Prompt Refine: Use ${label} to refine your prompt.`]);
    for (const reason of ["new", "resume", "fork"]) {
      harness.handlers.get("session_start")?.[0]?.({ reason }, harness.context);
    }
    await harness.reload();
    expect(harness.notifications).toHaveLength(1);
    expect(harness.complete).not.toHaveBeenCalled();
    expect(harness.editorWrites).toEqual([]);
  });

  it.each(["rpc", "print"] as const)("stays silent in %s mode", async (mode) => {
    const harness = await makeHarness({ mode });
    expect(harness.notifications).toEqual([]);
  });
});

describe("first optimizer model setup", () => {
  it("guides a fresh install without borrowing the main model or starting a request", async () => {
    const harness = await makeHarness({ freshInstall: true });
    expect(harness.notifications).toEqual([expect.stringContaining("No optimizer model selected")]);
    expect(harness.notifications[0]).toContain("/refine model");
    harness.handlers.get("session_start")?.[0]?.({ reason: "new" }, harness.context);
    expect(harness.notifications).toHaveLength(1);
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    expect(harness.panelLines().join("\n")).toContain("Choose one with m or /refine model.");
    expect(harness.panelLines().join("\n")).not.toContain("No result yet.");
    expect(harness.complete).not.toHaveBeenCalled();
    harness.panelInput("q");
    await view;
    expect(harness.editorWrites).toEqual([]);
  });

  it("persists the first selection and gives a usable next step without auto-refining", async () => {
    const harness = await makeHarness({ freshInstall: true });
    harness.setCustomAction("\r");
    await harness.command("model", harness.context);
    const saved = JSON.parse(await readFile(join(harness.agentDir, "prompt-refine.json"), "utf8"));
    expect(saved.model).toEqual({ provider: "fake-provider", id: "fake-chat" });
    expect(harness.notifications.at(-1)).toContain("Use /refine <text> to start.");
    expect(harness.complete).not.toHaveBeenCalled();
    harness.notifications.length = 0;
    await harness.reload();
    expect(harness.notifications).toEqual([]);
  });

  it("keeps setup intact on cancel and reports when no authorized models exist", async () => {
    const harness = await makeHarness({ configureModel: false });
    harness.setCustomAction("\x1b");
    await harness.command("model", harness.context);
    expect(JSON.parse(await readFile(join(harness.agentDir, "prompt-refine.json"), "utf8"))).not.toHaveProperty("model");
    vi.mocked(harness.context.modelRegistry.getAvailable).mockReturnValue([]);
    await harness.command("model", harness.context);
    expect(harness.notifications.at(-1)).toContain("Configure a model and authentication in Pi first");
    expect(harness.complete).not.toHaveBeenCalled();
  });

  it("revalidates model availability when the picker closes", async () => {
    const harness = await makeHarness({ configureModel: false });
    harness.holdPanel();
    const picker = harness.command("model", harness.context);
    vi.mocked(harness.context.modelRegistry.getAvailable).mockReturnValue([]);
    harness.panelInput("\r");
    await picker;
    expect(harness.notifications.at(-1)).toContain("no longer available");
    const saved = JSON.parse(await readFile(join(harness.agentDir, "prompt-refine.json"), "utf8"));
    expect(saved).not.toHaveProperty("model");
    expect(saved.modelThinkingLevels).toEqual({});
  });

  it("does not claim a failed first selection save was persisted", async () => {
    const harness = await makeHarness({ configureModel: false });
    const path = join(harness.agentDir, "prompt-refine.json");
    await rm(path);
    await mkdir(path);
    harness.setCustomAction("\r");
    await harness.command("model", harness.context);
    expect(harness.notifications.at(-1)).toContain("current process only; not saved");
    expect(harness.complete).not.toHaveBeenCalled();
  });

  it("does not show TUI setup hints in non-interactive mode", async () => {
    const harness = await makeHarness({ configureModel: false, mode: "print" });
    expect(harness.notifications).toEqual([]);
    expect(harness.complete).not.toHaveBeenCalled();
  });
});

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

describe("persistent session-local Refine history", () => {
  const path = (h: Harness) => `${h.context.sessionManager.getSessionFile()}.prompt-refine.json`;

  it("resumes minimal records with request-time cost, without restoring actions or private background", async () => {
    const h = await makeHarness({ persistHistory: true });
    h.complete.mockResolvedValueOnce({ ...refinement("Saved result"), usage: { input: 100, cacheRead: 200, cacheWrite: 0, output: 20, cost: { total: 0.012 } } });
    await trigger(h);
    h.setCustomAction("a");
    await h.command("view", h.context);
    const writes = [...h.editorWrites];
    const leaf = h.context.sessionManager.getLeafId();
    await h.reload("resume");
    expect(h.editorWrites).toEqual(writes);
    expect(h.sent).toEqual([]);
    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(h.context.sessionManager.getLeafId()).toBe(leaf);
    expect(h.sessionWrites).toEqual([]);
    const saved = await readFile(path(h), "utf8");
    for (const secret of ["earlier requirement", "visible answer", "systemPrompt", "preparedInput", "sentInput", "branchLeafId", "Draft refinement workflow"]) expect(saved).not.toContain(secret);
    h.holdPanel();
    const view = h.command("history", h.context);
    h.panelInput("\x1b[B"); // Restored root -> saved run.
    expect(h.panelLines(100).join("\n")).toContain("Saved result");
    expect(h.panelLines(100).join("\n")).toContain("↑300 ↓20 · ≈$0.012");
    h.panelInput("\r");
    expect(h.panelLines(100).join("\n")).toContain("Copy to current");
    for (const key of ["f", "g", "m"]) {
      h.panelInput(key);
      expect(h.panelLines(100).join("\n")).toContain("Background not saved");
    }
    expect(h.complete).toHaveBeenCalledTimes(1);
    h.panelInput("a");
    await view;
    expect(h.getEditor()).toBe("Saved result");
    expect(h.sent).toEqual([]);
  });

  it("copies a restored original into a fresh round and captures current background only on explicit run", async () => {
    const h = await makeHarness({ persistHistory: true });
    await trigger(h);
    await h.reload("resume");
    vi.spyOn(h.context.sessionManager, "getBranch").mockReturnValue([{ type: "message", message: { role: "user", content: "New background" } }] as any);
    h.holdPanel();
    const view = h.command("history", h.context);
    h.panelInput("i");
    expect(h.panelLines(100).join("\n")).toContain("Draft A");
    h.panelInput("\r"); // Save a new unsent draft, no model call.
    expect(h.complete).toHaveBeenCalledTimes(1);
    h.panelInput("\r");
    await flushPromises();
    expect(h.complete).toHaveBeenCalledTimes(2);
    const packet = JSON.parse((h.complete.mock.calls[1] as any[])[1].messages[0].content[0].text);
    expect(JSON.stringify(packet.conversation)).toContain("New background");
    expect(JSON.stringify(packet.conversation)).not.toContain("earlier requirement");
    h.panelInput("q"); h.panelInput("q");
    await view;
    await h.reload();
    const records = JSON.parse(await readFile(path(h), "utf8")).records;
    expect(records.map((record: any) => record.id)).toEqual([1, 2]);
    expect(records.map((record: any) => record.roundId)).toEqual([1, 2]);
  });

  it("restores interrupted work without restarting it or accepting late completion from the old runtime", async () => {
    const h = await makeHarness({ persistHistory: true });
    let finish!: (value: any) => void;
    h.complete.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await trigger(h);
    await h.reload("resume");
    finish(refinement("Late result must not persist"));
    await flushPromises();
    h.holdPanel();
    const view = h.command("history", h.context);
    expect(h.panelLines(100).join("\n")).toContain("Interrupted");
    expect(h.panelLines(100).join("\n")).not.toContain("Late result");
    expect(h.complete).toHaveBeenCalledTimes(1);
    h.panelInput("q"); h.panelInput("q");
    await view;
    await h.reload();
    expect(await readFile(path(h), "utf8")).not.toContain("Late result");
  });

  it("keeps sessions/forks isolated and restores only the selected session", async () => {
    const h = await makeHarness({ persistHistory: true });
    await trigger(h);
    const originalFile = h.context.sessionManager.getSessionFile()!;
    await h.handlers.get("session_shutdown")?.[0]?.({}, h.context);
    const id = vi.spyOn(h.context.sessionManager, "getSessionId").mockReturnValue("session-two");
    const file = vi.spyOn(h.context.sessionManager, "getSessionFile").mockReturnValue(join(h.agentDir, "fork.jsonl"));
    await h.reload("fork");
    h.holdPanel();
    let view = h.command("history", h.context);
    expect(h.panelLines(100).join("\n")).toContain("No records yet");
    h.panelInput("q"); h.panelInput("q"); await view;
    id.mockReturnValue("session-one"); file.mockReturnValue(originalFile);
    await h.reload("resume");
    view = h.command("history", h.context);
    expect(h.panelLines(100).join("\n")).toContain("Draft A");
    expect(h.complete).toHaveBeenCalledTimes(1);
    h.panelInput("q"); h.panelInput("q"); await view;
  });

  it("rejects an old clear confirmation after runtime replacement", async () => {
    const h = await makeHarness({ persistHistory: true });
    await trigger(h); await h.reload();
    h.deferConfirm();
    const clear = h.command("history clear", h.context);
    await h.reload("resume");
    h.resolveConfirm(true);
    await clear;
    expect(await readFile(path(h), "utf8")).toContain("Draft A");
  });

  it.each([
    { persistHistory: false, enabled: true, label: "No session file · memory only" },
    { persistHistory: true, enabled: false, label: "Disabled by historyPersistence=false" },
    { persistHistory: true, enabled: true, label: "Enabled · no savable records yet" },
  ])("queries history storage without changing work ($label)", async ({ persistHistory, enabled, label }) => {
    const h = await makeHarness({ persistHistory, config: { historyPersistence: enabled } });
    h.holdPanel();
    const view = h.command("usage", h.context);
    expect(h.panelLines(40).join("\n")).toContain("b Storage");
    h.panelInput("b");
    expect(h.panelLines(100).join("\n")).toContain("History storage");
    expect(h.panelLines(100).join("\n")).toContain(label);
    for (const key of ["a", "s", "i", "m", "d", "\r", "\x1b[C", "\x1b[D"]) h.panelInput(key);
    expect(h.panelLines(100).join("\n")).toContain("History storage");
    expect(h.complete).not.toHaveBeenCalled(); expect(h.editorWrites).toEqual([]); expect(h.sent).toEqual([]);
    h.panelInput("q"); h.panelInput("q"); h.panelInput("q"); await view;
  });

  it("queries confirmed snapshots, file location and the paused-after-clear state", async () => {
    const h = await makeHarness({ persistHistory: true });
    await trigger(h); await h.reload();
    h.holdPanel();
    let view = h.command("usage", h.context);
    h.panelInput("b");
    expect(h.panelLines(100).join("\n")).toContain("Saved");
    expect(h.panelLines(100).join("\n")).toContain("Confirmed saved runs");
    expect(h.panelLines(100).join("\n")).toContain("#1");
    expect(h.panelLines(100).join("\n")).toContain("session.jsonl.prompt-refine.json");
    h.panelInput("q"); h.panelInput("q"); h.panelInput("q"); await view;
    h.setConfirm(true); await h.command("history clear", h.context);
    view = h.command("usage", h.context); h.panelInput("b");
    expect(h.panelLines(100).join("\n")).toContain("Cleared · saving paused until reload");
    expect(h.panelLines(100).join("\n")).toContain("Memory-only / pending runs");
    h.panelInput("q"); h.panelInput("q"); h.panelInput("q"); await view;
    expect(h.complete).toHaveBeenCalledTimes(1);
  });

  it("reports persistence failure without failing the model request", async () => {
    const h = await makeHarness({ persistHistory: true });
    await mkdir(path(h)); // A non-file destination must not be replaced.
    await trigger(h);
    await vi.waitFor(() => expect(h.notifications.join("\n")).toContain("history save failed"));
    expect(h.widgetLines().join("\n")).toContain("1 new");
    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(h.editorWrites).toEqual([]);
    h.notifications.length = 0;
    h.holdPanel(); const view = h.command("usage", h.context); h.panelInput("b");
    expect(h.panelLines(100).join("\n")).toContain("Save failed · saving paused until reload");
    expect(h.panelLines(100).join("\n")).toContain("Memory-only / pending runs");
    h.panelInput("q"); h.panelInput("q"); h.panelInput("q"); await view;
  });

  it("supports opt-out and confirmed deletion without old records recreating the file", async () => {
    const off = await makeHarness({ persistHistory: true, config: { historyPersistence: false } });
    await trigger(off); await off.reload();
    await expect(readFile(path(off))).rejects.toMatchObject({ code: "ENOENT" });
    const h = await makeHarness({ persistHistory: true });
    await trigger(h); await h.reload();
    h.setConfirm(false);
    await h.command("history clear", h.context);
    expect(await readFile(path(h), "utf8")).toContain("Draft A");
    h.setConfirm(true);
    await h.command("history clear", h.context);
    await h.command("optimize New input", h.context);
    await flushPromises();
    await expect(readFile(path(h))).rejects.toMatchObject({ code: "ENOENT" });
    await h.reload();
    h.holdPanel();
    const view = h.command("history", h.context);
    expect(h.panelLines(100).join("\n")).toContain("No records yet");
    h.panelInput("q"); h.panelInput("q"); await view;
  });
});

describe("native overlay workspace", () => {
  it("uses the same overlay shell for Refine and model selection without stacking", async () => {
    const h = await makeHarness(); h.holdPanel();
    const view = h.command("view", h.context);
    const expected = { overlay: true, overlayOptions: { anchor: "center", width: "98%", maxHeight: "96%", margin: 0 } };
    expect(h.customOptions).toEqual([expected]);
    const initial = h.panelLines();
    h.panelInput("m");
    expect(h.panelLines().join("\n")).toContain("Choose optimizer model");
    expect(h.customCalls()).toBe(1);
    expect(h.panelLines()).toHaveLength(initial.length);
    expect(h.panelLines()[0]).toBe(initial[0]);
    h.panelInput("\x1b");
    await vi.waitFor(() => expect(h.panelLines().join("\n")).not.toContain("Choose optimizer model"));
    expect(h.customOptions).toEqual([expected]);
    h.panelInput("q"); await view;
    expect(h.editorWrites).toEqual([]); expect(h.sent).toEqual([]);
  });

  describe.each(["regular", "fullscreen"] as const)("model transitions with the native %s renderer", (mode) => {
    it.each(["dark", "light"] as const)("keeps one overlay across open, cancel, resize and confirm (%s)", async (themeName) => {
      for (const origin of ["main", "settings", "original", "usage"] as const) {
        const h = await makeHarness({ renderer: { mode, theme: themeName }, reasoning: true,
          configureModel: origin === "original" || origin === "usage" });
        const original = h.context.modelRegistry.getAvailable()[0]!;
        const others = Array.from({ length: 24 }, (_, index) => ({ ...original,
          id: `other-model-${index}`, name: `Other ${index} 中文😀\x1b[31m` }));
        const models = [original, ...others];
        vi.mocked(h.context.modelRegistry.getAvailable).mockReturnValue(models);
        vi.mocked(h.context.modelRegistry.find).mockImplementation((provider, id) =>
          models.find((model) => model.provider === provider && model.id === id));
        if (origin === "original" || origin === "usage") await trigger(h);
        h.holdPanel();
        const view = h.command(origin === "usage" ? "history" : origin === "original" ? "" : "view", h.context);
        const r = h.renderer!;
        // Use an I/O turn, not just Promise microtasks: Pi redraws on nextTick
        // before an awaited custom() can mount a replacement overlay.
        const input = async (...keys: string[]) => {
          await new Promise<void>((resolve) => setImmediate(() => { keys.forEach(r.input); resolve(); }));
          await new Promise<void>((resolve) => setImmediate(resolve));
          r.tui.renderNow();
        };
        try {
          await vi.waitFor(() => expect(r.tui.hasOverlay()).toBe(true));
          if (origin === "settings") { await input("\x1b[D", " ", "\t"); }
          const before = await readFile(join(h.agentDir, "prompt-refine.json"), "utf8");
          const requests = h.complete.mock.calls.length;
          const focusOwner = r.tui.getFocusedComponent();
          r.tui.overlayFrames.length = 0;
          const open = origin === "settings" ? "\r" : "m";
          await input(open);
          const title = origin === "original" || origin === "usage" ? "Run original with another model" : "Choose optimizer model";
          const theme = getThemeByName(themeName)!;
          expect(h.panelLines(98).join("\n")).toContain(theme.fg("text", theme.bold(title)));
          expect(h.customCalls()).toBe(1);
          expect(r.tui.getFocusedComponent()).toBe(focusOwner);
          await input(...Array.from({ length: 12 }, () => "\x1b[B"));
          expect(h.panelLines(98).join("\n")).toContain("13/25");
          await input("\x1b[Z", "q"); // Thinking/search must not reach the retained workspace.
          expect(h.panelLines(98).join("\n")).toContain("No matching models");
          for (const [columns, rows] of [[28, 12], [160, 60], [100, 40]] as const) {
            Object.assign(r.terminal, { columns, rows });
            r.tui.renderNow();
            const width = Math.floor(columns * 0.98);
            const lines = h.panelLines(width);
            expect(lines).toHaveLength(workspaceHeight(rows));
            expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
            expect(lines.join("\n")).not.toContain("\x1b[31m");
          }
          const redraws = r.tui.fullRedraws;
          r.writes.length = 0;
          await input("\x1b");
          expect(h.panelLines(98).join("\n")).not.toContain(title);
          expect(h.complete).toHaveBeenCalledTimes(requests);
          expect(await readFile(join(h.agentDir, "prompt-refine.json"), "utf8")).toBe(before);
          if (origin === "settings") expect(h.panelLines(98).join("\n")).toContain("Unsaved context changes");
          if (origin === "usage") expect(h.panelLines(98).join("\n")).toContain("Usage · All rounds");
          await input(open);
          expect(h.panelLines(98).join("\n")).toContain(title);
          await input("\r", "\r"); // Confirm once; consume input while persistence is pending.
          await vi.waitFor(() => expect(h.panelLines(98).join("\n")).not.toContain(title));
          r.tui.renderNow();
          expect(h.customCalls()).toBe(1);
          expect(r.tui.overlayFrames.length).toBeGreaterThan(0);
          expect(r.tui.overlayFrames.every(Boolean)).toBe(true);
          expect(r.tui.getFocusedComponent()).toBe(focusOwner);
          expect(r.tui.fullRedraws).toBe(redraws);
          expect(r.writes.join("")).not.toMatch(/\x1b\[(?:2J|3J)/);
          expect(h.complete).toHaveBeenCalledTimes(requests + (origin === "original" || origin === "usage" ? 1 : 0));
          expect(h.editorWrites).toEqual([]);
          expect(h.sent).toEqual([]);
          if (origin === "settings") {
            expect(h.panelLines(98).join("\n")).toContain("Unsaved context changes");
            const saved = JSON.parse(await readFile(join(h.agentDir, "prompt-refine.json"), "utf8"));
            expect(saved.projectContext.instructionsEnabled).toBe(false);
          }
        } finally {
          await h.handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown" }, h.context);
          await view;
          r.tui.stop();
        }
      }
    });
  });

  it.each(["session_before_tree", "session_before_switch", "session_before_fork", "session_shutdown"])(
    "closes an embedded picker on %s without applying local edits or reopening", async (event) => {
      const h = await makeHarness({ configureModel: false, reasoning: true }); h.holdPanel();
      const before = await readFile(join(h.agentDir, "prompt-refine.json"), "utf8");
      const view = h.command("view", h.context);
      h.panelInput("m"); h.panelInput("\x1b[Z");
      expect(h.panelLines().join("\n")).toContain("Choose optimizer model");
      await h.handlers.get(event)?.[0]?.({ type: event }, h.context);
      await view;
      h.panelInput("\r"); h.panelInput("m");
      await flushPromises();
      expect(h.customCalls()).toBe(1);
      expect(await readFile(join(h.agentDir, "prompt-refine.json"), "utf8")).toBe(before);
      expect(h.complete).not.toHaveBeenCalled();
      expect(h.editorWrites).toEqual([]);
    });

  it("keeps Settings and its unsaved context when no models are available", async () => {
    const h = await makeHarness({ noAvailableModels: true }); h.holdPanel();
    const view = h.command("view", h.context);
    h.panelInput("\x1b[D"); h.panelInput(" "); h.panelInput("\t"); h.panelInput("\r");
    await flushPromises();
    expect(h.panelLines().join("\n")).toContain("Unsaved context changes");
    expect(h.notifications.at(-1)).toContain("No authorized text-generation models");
    expect(h.customCalls()).toBe(1);
    h.panelInput("\x1b"); h.panelInput("q"); await view;
    expect(h.complete).not.toHaveBeenCalled();
  });

  it("restores an unsubmitted revision after leaving for the main session", async () => {
    const h = await makeHarness(); await trigger(h); h.holdPanel();
    const view = h.command("view", h.context);
    h.panelInput("f"); h.panelInput("Keep 中文😀 commands");
    h.panelInput("\x1b"); h.panelInput("q"); await view;
    const reopened = h.command("view", h.context); h.panelInput("f");
    expect(h.panelLines().join("\n")).toContain("Keep 中文😀 commands");
    expect(h.complete).toHaveBeenCalledOnce();
    h.panelInput("\x1b"); h.panelInput("q"); await reopened;
    expect(h.editorWrites).toEqual([]); expect(h.sent).toEqual([]);
  });
});

describe("explicit candidate revision", () => {
  it("shows completed revision details with original task, instruction and before-revision text", async () => {
    const harness = await makeHarness();
    harness.complete.mockResolvedValueOnce(refinement("BEFORE_REVISION_TEXT")); await trigger(harness);
    harness.holdPanel(); const view = harness.command("view", harness.context);
    harness.panelInput("f"); harness.panelInput("Keep literal commands.");
    harness.complete.mockResolvedValueOnce(refinement("AFTER_REVISION_TEXT"));
    harness.panelInput("\x13"); await flushPromises();
    expect(harness.panelLines(100).join("\n")).toContain("Revised prompt");
    let all = "";
    for (let i = 0; i < 5; i++) { all += harness.panelLines(100).join("\n"); harness.panelInput("\x1b[6~"); }
    for (const expected of ["AFTER_REVISION_TEXT", "Original draft", "Draft A", "Revision instruction", "Keep literal commands.", "Before revision", "BEFORE_REVISION_TEXT"]) expect(all).toContain(expected);
    harness.panelInput("o"); expect(harness.panelLines(100).join("\n")).toContain("Draft A");
    harness.panelInput("q"); await view;
    const usage = harness.command("usage", harness.context);
    harness.panelInput("\r");
    expect(harness.panelLines(100).join("\n")).toContain("Revision of run #1");
    all = "";
    for (let i = 0; i < 6; i++) { all += harness.panelLines(100).join("\n"); harness.panelInput("\x1b[6~"); }
    for (const expected of ["Original prompt", "Draft A", "Keep literal commands.", "BEFORE_REVISION_TEXT"]) expect(all).toContain(expected);
    harness.panelInput("\x1b"); harness.panelInput("\x1b"); harness.panelInput("q"); await usage;
    expect(harness.complete).toHaveBeenCalledTimes(2); expect(harness.sent).toEqual([]); expect(harness.editorWrites).toEqual([]);
  });

  it("does not attach a failed revision's instructions to the retained result", async () => {
    const harness = await makeHarness(); await trigger(harness);
    harness.holdPanel(); const view = harness.command("view", harness.context);
    harness.panelInput("f"); harness.panelInput("FAILED_REVISION_INSTRUCTION");
    harness.complete.mockRejectedValueOnce(new Error("offline"));
    harness.panelInput("\x13"); await flushPromises();
    let all = "";
    for (let i = 0; i < 5; i++) { all += harness.panelLines(100).join("\n"); harness.panelInput("\x1b[6~"); }
    expect(all).toContain("previous result kept"); expect(all).toContain("Refined prompt");
    expect(all).not.toContain("Revised prompt"); expect(all).not.toContain("FAILED_REVISION_INSTRUCTION");
    harness.panelInput("q"); await view;
  });
  it("opens list Revise for the selected run and returns through its details without sending", async () => {
    const harness = await makeHarness(); await trigger(harness);
    harness.holdPanel(); const view = harness.command("", harness.context);
    // Select the run rather than the original root.
    if (harness.panelLines(100).join("\n").includes("› ▾")) harness.panelInput("\x1b[B");
    harness.panelInput("f");
    expect(harness.panelLines(100).join("\n")).toContain("Run #1");
    harness.panelInput("Retain this feedback"); harness.panelInput("\x1b");
    expect(harness.panelLines(100).join("\n")).toContain("Prompt details");
    harness.panelInput("f"); expect(harness.panelLines(100).join("\n")).toContain("Retain this feedback");
    harness.panelInput("\x1b"); harness.panelInput("\x1b");
    expect(harness.panelLines(100).join("\n")).toContain("Prompt refine · Tasks");
    expect(harness.complete).toHaveBeenCalledTimes(1);
    expect(harness.editorWrites).toEqual([]); expect(harness.sent).toEqual([]);
    harness.panelInput("q"); await view;
  });

  it("opens an empty editor/workspace to browse and Add/Edit/Delete Preferences without a request", async () => {
    const h = await makeHarness({ config: { preferencesKey: null } });
    const store = new PreferenceStore(h.agentDir, h.context.cwd);
    h.setEditorText(""); h.holdPanel(); const view = shortcut(h, "ctrl+\\")(h.context);
    expect(h.panelLines(100).join("\n")).toContain("p Preferences");
    h.panelInput("p");
    await vi.waitFor(() => {
      expect(h.panelLines().join("\n")).toContain("Library is empty");
      expect(h.panelLines().join("\n")).not.toContain("Working…");
    });
    h.panelInput("n"); h.panelInput("First 中文😀"); h.panelInput("\t"); h.panelInput("Keep literal commands.");
    for (let i = 0; i < 4; i++) h.panelInput("\t");
    h.panelInput("\r");
    await vi.waitFor(() => expect(h.panelLines().join("\n")).toContain("Saved; not selected"));
    h.panelInput(" "); h.panelInput("\x1b[13;3u"); h.panelInput("\x13");
    expect(h.panelLines().join("\n")).toContain("Library management only");
    h.panelInput("e"); h.panelInput("Renamed "); h.panelInput("\x1b[Z"); h.panelInput("\r");
    await vi.waitFor(() => expect(h.panelLines().join("\n")).toContain("Saved to library"));
    expect((await store.load()).entries).toEqual([expect.objectContaining({ name: "Renamed First 中文😀", body: "Keep literal commands." })]);
    h.panelInput("d"); h.panelInput("n"); expect((await store.load()).entries).toHaveLength(1);
    h.panelInput("d"); h.panelInput("y");
    await vi.waitFor(() => expect(h.panelLines().join("\n")).toContain("Deleted from library"));
    expect((await store.load()).entries).toEqual([]);
    h.panelInput("\x1b"); h.panelInput("q"); await view;
    expect(h.getEditor()).toBe(""); expect(h.complete).not.toHaveBeenCalled();
    expect(h.editorWrites).toEqual([]); expect(h.sent).toEqual([]);
  });

  it("manages running/queued originals and children equally in list and Inspect without changing frozen requirements", async () => {
    const h = await makeHarness(); const store = new PreferenceStore(h.agentDir, h.context.cwd);
    const entry = await store.save("project", { name: "Frozen 中文😀", body: "Original frozen body.",
      metadata: { kind: "rewrite", description: "Manually selected", activation: "manual" } });
    await h.reload();
    const finishes: ((value: any) => void)[] = [];
    h.complete.mockImplementation(() => new Promise((resolve) => { finishes.push(resolve); }));
    h.setEditorText(""); h.holdPanel(); const view = h.command("", h.context);
    const output = () => h.panelLines(100).join("\n");
    for (let i = 0; i < 5; i++) {
      h.panelInput("n"); h.panelInput(`Draft ${i}`); h.panelInput("\r");
      expect(output()).toContain("Preferences · 0 selected");
      h.panelInput("p"); await vi.waitFor(() => expect(output()).not.toContain("Working…"));
      h.panelInput(" "); h.panelInput("\x1b[13;3u"); h.panelInput("\r"); await flushPromises();
    }
    expect(h.complete).toHaveBeenCalledTimes(4);
    // Latest group is queued; the next group is running. Both have original/run rows.
    for (const row of [0, 1, 2, 3]) {
      h.panelInput("\x1b[H");
      for (let i = 0; i < row; i++) h.panelInput("\x1b[B");
      for (const inspect of [false, true]) {
        if (inspect) h.panelInput("\r");
        h.panelInput("p"); await vi.waitFor(() => expect(output()).toContain("1 frozen snapshots"));
        expect(output()).not.toContain("Bring back"); expect(output()).not.toContain("Space Select");
        h.panelInput(" "); h.panelInput("\x1b[13;3u"); h.panelInput("\x13");
        expect(output()).toContain("Library management only");
        h.panelInput("\x1b"); if (inspect) h.panelInput("\x1b");
      }
    }
    // Library writes in the child's management page never rewrite adopted snapshots.
    h.panelInput("p"); await vi.waitFor(() => expect(output()).toContain("1 frozen snapshots"));
    h.panelInput("e"); h.panelInput("Changed "); h.panelInput("\x1b[Z"); h.panelInput("\r");
    await vi.waitFor(() => expect(output()).toContain("Saved to library"));
    h.panelInput("s"); h.panelInput("\r");
    expect(output()).toContain("Selected snapshot"); expect(output()).toContain("Current library entry");
    expect(output()).toContain("Frozen 中文😀"); expect(output()).toContain("Changed Frozen 中文😀");
    h.panelInput("\x1b"); h.panelInput("d"); h.panelInput("y");
    await vi.waitFor(() => expect(output()).toContain("Deleted from library"));
    expect((await store.load()).entries).toEqual([]);
    finishes[0]!(refinement("Done")); await flushPromises();
    expect(h.complete).toHaveBeenCalledTimes(5);
    expect(output()).toContain("Preferences"); expect(output()).not.toContain("Bring back");
    h.panelInput("\r"); expect(output()).toContain("Source deleted"); expect(output()).toContain(entry.body);
    h.panelInput("\x1b"); h.panelInput("\x1b");
    // The refresh affects only future drafts, not the five frozen requests.
    h.panelInput("n"); h.panelInput("New after delete"); h.panelInput("\r");
    expect(output()).toContain("Preferences · 0 selected");
    for (const call of h.complete.mock.calls) {
      const packet = JSON.parse((call as any[])[1].messages[0].content[0].text);
      expect(packet.editing_instruction).toBe(`Prompt rewriting instructions (manually selected):\n${entry.body}`);
    }
    for (const finish of finishes.slice(1)) finish(refinement("Done")); await flushPromises();
    expect(h.complete).toHaveBeenCalledTimes(5); expect(h.editorWrites).toEqual([]); expect(h.sent).toEqual([]);
    h.panelInput("q"); await view;
  });

  it("browses legacy/restored records without fabricating adopted snapshots or enabling selection", async () => {
    const h = await makeHarness({ persistHistory: true });
    const store = new PreferenceStore(h.agentDir, h.context.cwd);
    await store.save("project", { name: "Library only", body: "Current library body." });
    await trigger(h); await h.reload();
    h.holdPanel(); const view = h.command("usage", h.context);
    h.panelInput("p");
    await vi.waitFor(() => expect(h.panelLines().join("\n")).toContain("0 frozen snapshots"));
    expect(h.panelLines().join("\n")).toContain("Library only");
    h.panelInput(" "); h.panelInput("\x1b[13;3u"); h.panelInput("s");
    expect(h.panelLines().join("\n")).toContain("No selections");
    expect(h.panelLines().join("\n")).not.toContain("Bring back");
    h.panelInput("\x1b"); h.panelInput("q"); h.panelInput("q"); await view;
    expect(h.complete).toHaveBeenCalledTimes(1); expect(h.sent).toEqual([]); expect(h.editorWrites).toEqual([]);
  });

  it("still permits management while send is pending, and closes Preferences on session invalidation", async () => {
    const h = await makeHarness(); await trigger(h); h.holdPanel();
    let view = h.command("view", h.context); h.panelInput("s"); await view;
    view = h.command("", h.context); h.panelInput("p");
    await vi.waitFor(() => expect(h.panelLines().join("\n")).toContain("0 frozen snapshots"));
    expect(h.panelLines().join("\n")).not.toContain("Bring back");
    h.panelInput("n"); h.panelInput("Unsaved form");
    h.handlers.get("session_before_switch")?.[0]?.({}, h.context); await view;
    h.panelInput("\x1b[Z"); h.panelInput("\r"); h.panelInput("\x1b[13;3u");
    expect((await new PreferenceStore(h.agentDir, h.context.cwd).load()).entries).toEqual([]);
    expect(h.complete).toHaveBeenCalledTimes(1); expect(h.sent).toHaveLength(1);
  });

  it("selects inline on Unsent, reads without submission, and freezes the chosen body across reopening", async () => {
    const h = await makeHarness({ config: { preferencesKey: null } });
    const store = new PreferenceStore(h.agentDir, h.context.cwd);
    const entry = await store.save("project", { name: "Inline 中文😀", body: "Only the main agent should use brief sections." });
    const original = "  Explain this literal task; do not run commands.\n";
    h.setEditorText(original); h.holdPanel(); let view = shortcut(h, "ctrl+\\")(h.context);
    const output = () => h.panelLines(100).join("\n");
    h.panelInput("\t");
    await vi.waitFor(() => expect(output()).toContain("[ ] Inline 中文😀"));
    h.panelInput(" ");
    expect(output()).toContain("[x] Inline 中文😀");
    expect(output()).not.toContain("Bring back");
    h.panelInput("o"); expect(output()).toContain(entry.body);
    for (const key of ["\x13", "\r", "p", "i", "f"]) h.panelInput(key);
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.editorWrites).toEqual([]); expect(h.sent).toEqual([]);
    h.panelInput("\x1b"); h.panelInput("\x1b"); h.panelInput("q"); await view;
    await store.save("project", { name: "Changed", body: "Do not replace the captured body." }, entry);
    view = h.command("", h.context);
    expect(output()).toContain("Preferences · 1 selected");
    h.panelInput("\t"); h.panelInput("\r"); await flushPromises();
    expect(h.complete).toHaveBeenCalledTimes(1);
    const packet = JSON.parse((h.complete.mock.calls[0] as any[])[1].messages[0].content[0].text);
    expect(packet).toMatchObject({ draft: original, editing_instruction: `Saved editing requirements (manually selected):\n${entry.body}` });
    expect(h.getEditor()).toBe(original);
    expect(h.editorWrites).toEqual([]); expect(h.sent).toEqual([]);
    h.panelInput("q"); await view;
  });

  it("keeps nonempty inline search cached through the production controller adapter", async () => {
    const h = await makeHarness();
    await new PreferenceStore(h.agentDir, h.context.cwd).save("project", { name: "Needle 中文😀", body: "Keep literals." });
    h.setEditorText("Unsent task"); h.holdPanel(); const view = shortcut(h, "ctrl+\\")(h.context);
    const output = () => h.panelLines(100).join("\n");
    h.panelInput("\x1b[Z");
    await vi.waitFor(() => expect(output()).toContain("[ ] Needle 中文😀"));
    h.panelInput(" "); h.panelInput("/"); h.panelInput("Needle"); h.panelInput("\r");
    const search = vi.spyOn(preferences, "searchPreferences");
    try {
      expect(output()).toContain("[x] Needle 中文😀");
      for (let index = 0; index < 30; index++) {
        h.resize(index % 2 ? 12 : 40);
        h.panelInput("\t"); h.panelLines(index % 2 ? 24 : 100);
      }
      expect(search).toHaveBeenCalledTimes(1);
      expect(h.complete).not.toHaveBeenCalled();
      expect(h.editorWrites).toEqual([]); expect(h.sent).toEqual([]);
      h.panelInput("\x1b"); h.panelInput("q"); await view;
    } finally { search.mockRestore(); }
  });

  it.each([
    ["add", "cancel"], ["add", "bring-back"], ["edit", "cancel"], ["edit", "bring-back"],
    ["delete", "cancel"], ["delete", "bring-back"],
  ] as const)("refreshes cached Unsent preferences after Revise library %s / %s", async (change, close) => {
    const h = await makeHarness();
    const store = new PreferenceStore(h.agentDir, h.context.cwd);
    const entry = await store.save("project", { name: "Cached 中文😀", body: "Original requirement." });
    await trigger(h);
    h.holdPanel(); const view = h.command("", h.context);
    const output = () => h.panelLines(100).join("\n");
    h.panelInput("n"); h.panelInput("Unsent task"); h.panelInput("\r");
    h.panelInput("\x1b[Z");
    await vi.waitFor(() => expect(output()).toContain("[ ] Cached 中文😀"));
    if (change !== "add") h.panelInput(" ");
    h.panelInput("\x1b"); // Leave inline selection, retaining the same workspace/cache.
    h.panelInput("\x1b[B"); h.panelInput("\x1b[B"); h.panelInput("f");
    expect(output()).toContain("Revise current result");
    h.panelInput("\x1bp");
    await vi.waitFor(() => expect(output()).toContain("0 selected ·"));
    await vi.waitFor(() => expect(output()).not.toContain("Working…"));
    if (change === "delete") {
      h.panelInput("d"); h.panelInput("y");
      await vi.waitFor(() => expect(output()).toContain("Deleted from library"));
    } else {
      h.panelInput(change === "add" ? "n" : "e");
      if (change === "add") h.panelInput("Added 中文😀");
      h.panelInput("\t"); h.panelInput("Updated body. ");
      for (let i = 0; i < 4; i++) h.panelInput("\t");
      h.panelInput("\r");
      await vi.waitFor(() => expect(output()).toContain(change === "add" ? "Saved; not selected" : "Saved to library"));
    }
    h.panelInput(close === "cancel" ? "\x1b" : "\x1b[13;3u"); // Library writes survive either selection boundary.
    h.panelInput("\x1b"); h.panelInput("\x1b"); // Revise -> details -> tasks.
    h.panelInput("\x1b[A"); h.panelInput("\x1b[A"); h.panelInput("\x1b[Z");
    await vi.waitFor(() => {
      if (change === "add") expect(output()).toContain("[ ] Added 中文😀");
      else expect(output()).toContain("! Cached 中文😀");
    });
    if (change !== "add") {
      h.panelInput("o");
      expect(output()).toContain(change === "edit" ? "Source changed" : "Source deleted");
      expect(output()).toContain(entry.body); // Adopted snapshot was not silently replaced.
      if (change === "edit") {
        h.panelInput("\x1b[6~");
        expect(output()).toContain("Original requirement.Updated body.");
      }
      h.panelInput("\x1b"); h.panelInput(" "); // Explicitly deselect the old snapshot.
      if (change === "delete") expect(output()).not.toContain("Cached 中文😀");
      else h.panelInput(" "); // Reselect now captures the edited library body.
    } else {
      h.panelInput("/"); h.panelInput("Added"); h.panelInput("\r"); h.panelInput(" ");
    }
    expect(h.complete).toHaveBeenCalledTimes(1); // Management/selection never submits.
    if (change !== "delete") {
      h.panelInput("\x1b"); h.panelInput("\r"); await flushPromises();
      const packet = JSON.parse((h.complete.mock.calls[1] as any[])[1].messages[0].content[0].text);
      expect(packet.editing_instruction).toContain(change === "edit" ? "Original requirement.Updated body." : "Updated body.");
    }
    expect(h.editorWrites).toEqual([]); expect(h.sent).toEqual([]);
    h.panelInput("\x1b"); h.panelInput("q"); await view;
  });

  it("selects Preferences before first refine without a modifier, preserves literal task and snapshots across reopening", async () => {
    const h = await makeHarness({ config: { preferencesKey: null }, persistHistory: true });
    const store = new PreferenceStore(h.agentDir, h.context.cwd);
    const entry = await store.save("project", { name: "Bullet Points", body: "Ask the main agent to use bullets only where useful." });
    const original = "  Explain this command; do not run it.\n```sh\nnpm test -- --run\n```\n";
    const configBefore = await readFile(join(h.agentDir, "prompt-refine.json"), "utf8");
    h.setEditorText(original);
    h.holdPanel(); let view = shortcut(h, "ctrl+\\")(h.context);
    expect(h.panelLines(100).join("\n")).toContain("› ○ Unsent");
    expect(h.complete).not.toHaveBeenCalled();
    h.panelInput("p");
    await vi.waitFor(() => expect(h.panelLines().join("\n")).toContain("Bullet Points"));
    h.panelInput(" "); h.panelInput("\x13");
    expect(h.complete).not.toHaveBeenCalled();
    h.panelInput("\r"); h.panelInput("\x1b"); h.panelInput("\x1b[13;3u");
    expect(h.panelLines().join("\n")).toContain("Preferences · 1 selected");
    expect(h.panelLines().join("\n")).toContain("[x] Bullet Points");
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.editorWrites).toEqual([]); expect(h.sent).toEqual([]);
    h.panelInput("q"); await view;
    await store.save("project", { name: "Renamed", body: "Changed library body" }, entry);
    view = h.command("", h.context);
    expect(h.panelLines().join("\n")).toContain("Preferences · 1 selected");
    expect(h.panelLines().join("\n")).toContain("[x] Bullet Points");
    h.panelInput("\r"); await flushPromises();
    expect(h.complete).toHaveBeenCalledTimes(1);
    const context = (h.complete.mock.calls[0] as any[])[1];
    const packet = JSON.parse(context.messages[0].content[0].text);
    expect(packet).toMatchObject({ operation: "refine", draft: original, editing_instruction: `Saved editing requirements (manually selected):\n${entry.body}` });
    expect(packet).not.toHaveProperty("revision_instruction");
    expect(packet).not.toHaveProperty("previous_candidate");
    expect(context.systemPrompt).not.toContain(entry.body);
    expect(h.getEditor()).toBe(original);
    expect(h.editorWrites).toEqual([]); expect(h.sent).toEqual([]);
    expect(await readFile(join(h.agentDir, "prompt-refine.json"), "utf8")).toBe(configBefore);
    h.panelInput("q"); await view;
    await h.handlers.get("session_shutdown")![0]!({ type: "session_shutdown" }, h.context);
    const history = JSON.parse(await readFile(`${h.context.sessionManager.getSessionFile()}.prompt-refine.json`, "utf8"));
    expect(history.records[0]).toMatchObject({ draft: original, editingInstruction: `Saved editing requirements (manually selected):\n${entry.body}` });
    expect(history.records[0]).not.toHaveProperty("preferences");
  });

  it("uses typed rewrites only after explicit selection and never inherits them on a new original", async () => {
    const h = await makeHarness();
    const store = new PreferenceStore(h.agentDir, h.context.cwd);
    const metadata = { kind: "rewrite", description: "Metadata never injected 中文", activation: "manual" } as const;
    const body = "Keep existing parallel questions as separate items.";
    await store.save("project", { name: "Structure", body, metadata });
    await store.save("global", { name: "Same structure", body, metadata });
    await store.save("global", { name: "English response", body: "Answer in English.",
      metadata: { kind: "task", description: "Response language", activation: "manual" } });
    await h.reload();
    h.holdPanel(); const view = h.command("", h.context);
    h.panelInput("n"); h.panelInput("Why? How?"); h.panelInput("\r");
    expect(h.panelLines().join("\n")).toContain("Preferences · 0 selected");
    expect(h.complete).not.toHaveBeenCalled();
    h.panelInput("p");
    await vi.waitFor(() => expect(h.panelLines().join("\n")).not.toContain("Working…"));
    expect(h.panelLines().join("\n")).not.toContain("Automatically selected");
    h.panelInput("/"); h.panelInput("Structure"); h.panelInput("\r");
    h.panelInput(" "); h.panelInput("\x1b[13;3u");
    expect(h.panelLines().join("\n")).toContain("Preferences · 1 selected");
    expect(h.panelLines().join("\n")).toContain("[x] Structure");
    expect(h.complete).not.toHaveBeenCalled();
    h.panelInput("\r"); await flushPromises();
    const first = JSON.parse((h.complete.mock.calls[0] as any[])[1].messages[0].content[0].text);
    expect(first).toMatchObject({ draft: "Why? How?", editing_instruction: `Prompt rewriting instructions (manually selected):\n${body}` });
    expect(JSON.stringify(first)).not.toContain(metadata.description);
    expect(JSON.stringify(first)).not.toContain("Answer in English.");
    h.panelInput("n"); h.panelInput("先检查，再解释。 What? Why?"); h.panelInput("\r");
    expect(h.panelLines().join("\n")).toContain("Preferences · 0 selected");
    h.panelInput("\r"); await flushPromises();
    const second = JSON.parse((h.complete.mock.calls[1] as any[])[1].messages[0].content[0].text);
    expect(second).not.toHaveProperty("editing_instruction");
    expect(h.sent).toEqual([]); expect(h.editorWrites).toEqual([]);
    h.panelInput("q"); await view;
  });

  it.each(["always", "parallel", "sequence"])("never auto-selects legacy %s preferences in shortcut or command requests, but keeps manual selection available", async (match) => {
    const h = await makeHarness();
    const path = join(h.agentDir, "prompt-refine-preferences.json");
    const body = "LEGACY BODY: only send after explicit selection.";
    const content = JSON.stringify({ version: 2, entries: [{ id: "legacy", version: 1, name: "Legacy structure", body,
      metadata: { kind: "rewrite", description: "Old configuration", activation: "auto", match } }] });
    await writeFile(path, content); await h.reload();
    h.setEditorText("先检查，再解释。 Why? How?"); await trigger(h);
    await h.command("optimize First inspect, then explain. 为什么？怎么办？", h.context); await flushPromises();
    for (const call of h.complete.mock.calls) {
      const packet = JSON.parse((call as any[])[1].messages[0].content[0].text);
      expect(packet).not.toHaveProperty("editing_instruction");
      expect(JSON.stringify(packet)).not.toContain(body);
    }
    expect(h.complete).toHaveBeenCalledTimes(2);
    h.holdPanel(); const view = h.command("", h.context);
    h.panelInput("n"); h.panelInput("Manual original"); h.panelInput("\r"); h.panelInput("p");
    await vi.waitFor(() => expect(h.panelLines().join("\n")).not.toContain("Working…"));
    expect(h.panelLines().join("\n")).toContain("0 selected");
    h.panelInput(" "); h.panelInput("\x1b[13;3u");
    expect(h.complete).toHaveBeenCalledTimes(2);
    h.panelInput("\r"); await flushPromises();
    const packet = JSON.parse((h.complete.mock.calls[2] as any[])[1].messages[0].content[0].text);
    expect(packet.editing_instruction).toBe(`Prompt rewriting instructions (manually selected):\n${body}`);
    expect(await readFile(path, "utf8")).toBe(content);
    expect(h.sent).toEqual([]); expect(h.editorWrites).toEqual([]);
    h.panelInput("q"); await view;
  });

  it("carries only selected frozen manual edit evidence across revisions without growing an edit conversation", async () => {
    const h = await makeHarness();
    const store = new PreferenceStore(h.agentDir, h.context.cwd);
    const translation = await store.save("project", { name: "Translation", body: "Translate the prompt to English.",
      metadata: { kind: "rewrite", activation: "manual", description: "Private description" } });
    await store.save("global", { name: "Unselected", body: "UNSELECTED BODY", metadata: {
      kind: "rewrite", activation: "manual", description: "Unselected metadata" } });
    await h.reload();
    h.holdPanel(); const view = h.command("", h.context);
    h.panelInput("n"); h.panelInput("解释缓存。"); h.panelInput("\r"); h.panelInput("p");
    await vi.waitFor(() => expect(h.panelLines().join("\n")).not.toContain("Working…"));
    h.panelInput("/"); h.panelInput("Translation"); h.panelInput("\r");
    h.panelInput(" "); h.panelInput("\x1b[13;3u");
    h.complete.mockResolvedValueOnce(refinement("Explain caching."));
    h.panelInput("\r"); await flushPromises();
    await store.save("project", { name: "Changed", body: "NEW LIBRARY BODY" }, translation);
    const packet = (index: number) => JSON.parse((h.complete.mock.calls[index] as any[])[1].messages[0].content[0].text);
    expect(packet(0).editing_instruction).not.toContain("UNSELECTED BODY");
    expect(packet(0).editing_instruction).toContain(translation.body);
    for (const [instruction, result] of [["再短一点。", "Explain caching briefly."], ["改回中文。", "简述缓存。"],
      ["保留字面量。", "简述缓存。"], ["保留命令原样。", "简述缓存。"]]) {
      h.panelInput("f"); h.panelInput(instruction!);
      h.complete.mockResolvedValueOnce(refinement(result!));
      h.panelInput("\x13"); await flushPromises();
    }
    expect(h.complete).toHaveBeenCalledTimes(5);
    for (const index of [1, 2, 3, 4]) {
      const sent = packet(index);
      expect(sent.historical_editing_context.initial_instruction).toBe(`Prompt rewriting instructions (manually selected):\n${translation.body}`);
      expect(sent).not.toHaveProperty("editing_instruction");
      for (const absent of ["UNSELECTED BODY", "NEW LIBRARY BODY", "Private description"]) expect(JSON.stringify(sent)).not.toContain(absent);
    }
    expect(packet(1).historical_editing_context).not.toHaveProperty("previous_revision_instruction");
    expect(packet(2).historical_editing_context.previous_revision_instruction).toBe("再短一点。");
    expect(packet(3).historical_editing_context.previous_revision_instruction).toBe("改回中文。");
    expect(JSON.stringify(packet(3))).not.toContain("再短一点。");
    expect(packet(3).previous_candidate).toBe("简述缓存。");
    // Structural coverage only: the explicit correction has now left the window.
    // Real model compliance is measured separately by revision-semantics.live.test.ts.
    expect(packet(4).previous_candidate).toBe("简述缓存。");
    expect(packet(4).historical_editing_context.previous_revision_instruction).toBe("保留字面量。");
    expect(JSON.stringify(packet(4))).not.toContain("改回中文。");
    expect(h.editorWrites).toEqual([]); expect(h.sent).toEqual([]);
    h.panelInput("q"); await view;
  });

  it("uses selected initial requirements on the one-off model path without changing defaults", async () => {
    const h = await makeHarness({ configureModel: false });
    const entry = await new PreferenceStore(h.agentDir, h.context.cwd).save("global", { name: "Steps", body: "Ask for ordered steps when sequence matters." });
    h.holdPanel(); const view = h.command("", h.context);
    h.panelInput("n"); h.panelInput("Explain setup, do not implement."); h.panelInput("\r");
    h.panelInput("\x1bp"); await vi.waitFor(() => expect(h.panelLines().join("\n")).toContain("Steps"));
    h.panelInput(" "); h.panelInput("\x1b[13;3u");
    expect(h.complete).not.toHaveBeenCalled();
    h.panelInput("m"); await flushPromises(); h.panelInput("\r");
    await vi.waitFor(() => expect(h.panelLines().join("\n")).not.toContain("Run original with another model"));
    expect(h.complete).toHaveBeenCalledTimes(1);
    const packet = JSON.parse((h.complete.mock.calls[0] as any[])[1].messages[0].content[0].text);
    expect(packet).toMatchObject({ draft: "Explain setup, do not implement.", editing_instruction: `Saved editing requirements (manually selected):\n${entry.body}` });
    expect(JSON.parse(await readFile(join(h.agentDir, "prompt-refine.json"), "utf8"))).not.toHaveProperty("model");
    expect(h.editorWrites).toEqual([]); expect(h.sent).toEqual([]);
    h.panelInput("q"); await view;
  });

  it("copies an already-run original without inheriting its preferences into the new task", async () => {
    const h = await makeHarness();
    await new PreferenceStore(h.agentDir, h.context.cwd).save("global", { name: "Sections", body: "Ask for useful topic headings." });
    h.holdPanel(); const view = h.command("", h.context);
    h.panelInput("n"); h.panelInput("Original"); h.panelInput("\r"); h.panelInput("p");
    await vi.waitFor(() => expect(h.panelLines().join("\n")).toContain("Sections"));
    h.panelInput(" "); h.panelInput("\x1b[13;3u"); h.panelInput("\r"); await flushPromises();
    h.panelInput("i"); h.panelInput(" copied"); h.panelInput("\r");
    expect(h.panelLines().join("\n")).toContain("Preferences · 0 selected");
    h.panelInput("\r"); await flushPromises();
    expect(h.complete).toHaveBeenCalledTimes(2);
    const packets = h.complete.mock.calls.map((call: any[]) => JSON.parse(call[1].messages[0].content[0].text));
    expect(packets[0]).toHaveProperty("editing_instruction", "Saved editing requirements (manually selected):\nAsk for useful topic headings.");
    expect(packets[1]).not.toHaveProperty("editing_instruction");
    expect(packets[1].draft).toBe("Original copied");
    h.panelInput("q"); await view;
  });

  it("composes saved preference snapshots into the existing request, only after returning and Ctrl+S", async () => {
    const harness = await makeHarness();
    const store = new PreferenceStore(harness.agentDir, harness.context.cwd);
    const entry = await store.save("global", { name: "Keep literal", body: "Keep all commands unchanged." });
    await trigger(harness);
    harness.holdPanel(); const view = harness.command("view", harness.context);
    harness.panelInput("f"); harness.panelInput("\x1bp");
    await vi.waitFor(() => expect(harness.panelLines(100).join("\n")).toContain("Keep literal"));
    harness.panelInput(" ");
    harness.panelInput("\x13");
    expect(harness.complete).toHaveBeenCalledTimes(1);
    harness.panelInput("\x1b[13;3u"); // Alt+Enter brings back; it does not request a revision.
    await store.save("global", { name: "Changed", body: "New library body" }, entry);
    harness.panelInput("Shorten examples."); harness.panelInput("\x13");
    await flushPromises();
    const packet = JSON.parse((harness.complete.mock.calls[1] as any[])[1].messages[0].content[0].text);
    expect(packet).toMatchObject({ operation: "revise", original_draft: "Draft A", previous_candidate: "Refined prompt",
      revision_instruction: "Saved editing requirements (manually selected):\nKeep all commands unchanged.\n\nCurrent user instructions:\nShorten examples." });
    expect(harness.editorWrites).toEqual([]); expect(harness.sent).toEqual([]);
    harness.panelInput("q"); await view;
  });

  it("checks total composed length and retains preferences when a candidate becomes stale", async () => {
    const harness = await makeHarness({ config: { maxDraftChars: 30 } });
    await new PreferenceStore(harness.agentDir, harness.context.cwd).save("global", { name: "Long", body: "1234567890123456789012345" });
    await trigger(harness); harness.holdPanel(); const view = harness.command("view", harness.context);
    harness.panelInput("f"); harness.panelInput("Extra"); harness.panelInput("\x1bp");
    await vi.waitFor(() => expect(harness.panelLines(100).join("\n")).toContain("Long"));
    harness.panelInput(" "); harness.panelInput("\x1b[13;3u");
    harness.panelInput("\x13");
    expect(harness.panelLines(100).join("\n")).toContain("exceed 30");
    expect(harness.complete).toHaveBeenCalledTimes(1);
    harness.complete.mockResolvedValueOnce(refinement("New background candidate"));
    harness.setEditorText("New original"); await trigger(harness);
    harness.panelInput("\x13");
    expect(harness.panelLines(100).join("\n")).toContain("result changed");
    expect(harness.panelLines(100).join("\n")).toContain("Preferences: 1");
    expect(harness.panelLines(100).join("\n")).not.toContain("New background candidate");
    expect(harness.panelLines(60).join("\n")).not.toContain("New background candidate");
    expect(harness.complete).toHaveBeenCalledTimes(2);
    harness.panelInput("\x1b"); harness.panelInput("q"); await view;
  });
  it("revises inline in Usage inspection, preserving the source viewport and explicit submit", async () => {
    const harness = await makeHarness();
    harness.complete.mockResolvedValueOnce(refinement("Source result\n" + Array.from({ length: 80 }, (_, i) => `Source line ${i}`).join("\n")));
    await trigger(harness);
    harness.holdPanel();
    const view = harness.command("usage", harness.context);
    harness.panelInput("\r");
    harness.panelInput("\x1b[6~");
    const before = harness.panelLines(100);
    harness.panelInput("f");
    // Reference content keeps its viewport; only suspended navigation chrome changes.
    expect(harness.panelLines(100).slice(9, 13)).toEqual(before.slice(9, 13));
    const referenceHeader = harness.panelLines(100).slice(0, 9).join("\n");
    expect(referenceHeader).toContain("Read-only reference");
    for (const hint of ["↑↓ scroll", "a Accept", "s Send to Pi", "p Preferences", "i Edit original", "f Revise"]) {
      expect(referenceHeader).not.toContain(hint);
    }
    expect(harness.panelLines(100).join("\n")).toContain("Run #1");
    harness.panelInput("Shorter");
    harness.panelInput("\r");
    harness.panelInput("Keep constraints");
    expect(harness.complete).toHaveBeenCalledTimes(1);
    harness.panelInput("\x05"); // Expand, preserving the draft.
    expect(harness.panelLines(100).join("\n")).toContain("Shorter");
    harness.panelInput("\x05");
    harness.panelInput("\x1b");
    expect(harness.panelLines(100)).toEqual(before);
    harness.panelInput("f");
    expect(harness.panelLines(100).join("\n")).toContain("Keep constraints");
    harness.panelInput("\x13");
    await flushPromises();
    const packet = JSON.parse((harness.complete.mock.calls[1] as any[])[1].messages[0].content[0].text);
    expect(packet.revision_instruction).toBe("Shorter\nKeep constraints");
    expect(harness.sent).toEqual([]);
    expect(harness.editorWrites).toEqual([]);
    harness.panelInput("q");
    await view;
  });

  it("revises the latest candidate while preserving the original task and keeping Input independent", async () => {
    const harness = await makeHarness();
    await trigger(harness);
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    expect(harness.panelLines(100).join("\n")).toContain("f Revise");
    harness.panelInput("i");
    harness.panelInput("Separate new draft");
    harness.panelInput("\x1b");
    harness.panelInput("f");
    expect(harness.panelLines().join("\n")).toContain("Revise current result");
    expect(harness.panelLines().join("\n")).not.toContain("Separate new draft");
    harness.panelInput("再短一点，命令原样保留。");
    harness.setEditorText("Unrelated main editor changes");
    harness.complete.mockResolvedValueOnce({ content: [{ type: "text", text: JSON.stringify({ prompt: "Second result" }) }], stopReason: "stop" });
    harness.panelInput("\x13");
    await flushPromises();
    const packet = JSON.parse((harness.complete.mock.calls[1] as any[])[1].messages[0].content[0].text);
    expect(packet).toMatchObject({ operation: "revise", original_draft: "Draft A", previous_candidate: "Refined prompt", revision_instruction: "再短一点，命令原样保留。" });
    expect(packet).not.toHaveProperty("draft");
    expect(packet.conversation.items).toHaveLength(2);
    expect(harness.editorWrites).toEqual([]);
    expect(harness.sent).toEqual([]);
    expect(harness.panelLines().join("\n")).toContain("Second result");
    harness.panelInput("f");
    expect(harness.panelLines().join("\n")).not.toContain("再短一点");
    harness.panelInput("Use bullet points");
    harness.complete.mockResolvedValueOnce({ content: [{ type: "text", text: JSON.stringify({ prompt: "Third result" }) }], stopReason: "stop" });
    harness.panelInput("\x13");
    await flushPromises();
    const next = JSON.parse((harness.complete.mock.calls[2] as any[])[1].messages[0].content[0].text);
    expect(next).toMatchObject({ operation: "revise", original_draft: "Draft A", previous_candidate: "Second result", revision_instruction: "Use bullet points",
      historical_editing_context: { previous_revision_instruction: "再短一点，命令原样保留。" } });
    expect(JSON.stringify(next)).not.toContain("Refined prompt");
    harness.panelInput("i");
    expect(harness.panelLines().join("\n")).toContain("Separate new draft");
    harness.panelInput("\x1b");
    harness.panelInput("a");
    await view;
    await flushPromises();
    expect(harness.context.ui.confirm).toHaveBeenCalled();
    expect(harness.getEditor()).toBe("Third result");
  });

  it("retains empty/oversized feedback and rejects a source changed during editing", async () => {
    const harness = await makeHarness({ config: { maxDraftChars: 30 } });
    await trigger(harness);
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    harness.panelInput("f");
    harness.panelInput("\x13");
    expect(harness.panelLines().join("\n")).toContain("Select preferences or enter additional requirements");
    harness.panelInput("x".repeat(31));
    harness.panelInput("\x13");
    expect(harness.panelLines().join("\n")).toContain("exceed");
    expect(harness.complete).toHaveBeenCalledTimes(1);
    harness.panelInput("\x1b");
    harness.panelInput("f");
    expect(harness.panelLines().join("\n")).toContain("x".repeat(31));
    await harness.command("optimize New task", harness.context);
    await flushPromises();
    harness.panelInput("\x13");
    expect(harness.panelLines().join("\n")).toContain("result changed");
    expect(harness.complete).toHaveBeenCalledTimes(2);
    expect(harness.editorWrites).toEqual([]);
    harness.panelInput("\x1b");
    harness.panelInput("q");
    await view;
  });

  it("keeps the previous result on failure and permits an explicit revision retry", async () => {
    const harness = await makeHarness();
    await trigger(harness);
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    harness.panelInput("f");
    harness.panelInput("Shorter");
    harness.complete.mockRejectedValueOnce(new Error("offline"));
    harness.panelInput("\x13");
    await flushPromises();
    expect(harness.panelLines().join("\n")).toContain("previous result kept");
    expect(harness.panelLines().join("\n")).toContain("Refined prompt");
    harness.panelInput("f");
    expect(harness.panelLines().join("\n")).toContain("Shorter");
    harness.panelInput("\x13");
    await flushPromises();
    expect(harness.complete).toHaveBeenCalledTimes(3);
    expect(JSON.parse((harness.complete.mock.calls[2] as any[])[1].messages[0].content[0].text).revision_instruction).toBe("Shorter");
    expect(harness.editorWrites).toEqual([]);
    harness.panelInput("q");
    await view;
  });

  it("keeps round Context frozen across settings changes and revisions", async () => {
    const harness = await makeHarness({ config: { projectContext: projectConfig(false) } });
    vi.spyOn(harness.context, "getSystemPrompt").mockReturnValue(resourcePrompt());
    await trigger(harness);
    await vi.waitFor(() => expect(harness.widgetLines().join("\n")).toContain("1 new"));
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    harness.panelInput("\x1b[D");
    harness.panelInput(" "); // Disable project instructions for the next round.
    harness.panelInput("\x13");
    await vi.waitFor(() => expect(harness.panelLines().join("\n")).toContain("Context saved"));
    harness.panelInput("\r"); // Inspect the selected result before revising.
    harness.panelInput("f");
    harness.panelInput("Shorter");
    harness.panelInput("\x13");
    await vi.waitFor(() => expect(harness.complete).toHaveBeenCalledTimes(2));
    const first = JSON.parse((harness.complete.mock.calls[0] as any[])[1].messages[0].content[0].text);
    const revision = JSON.parse((harness.complete.mock.calls[1] as any[])[1].messages[0].content[0].text);
    expect(first.project_context).toContain("Use the project venv.");
    expect(revision.project_context).toContain("Use the project venv.");
    expect(revision.conversation).toEqual(first.conversation);
    harness.panelInput("q");
    harness.panelInput("q");
    await view;
  });

  it("blocks revision while delivery is pending", async () => {
    const harness = await makeHarness();
    await trigger(harness);
    harness.holdPanel();
    let view = harness.command("view", harness.context);
    harness.panelInput("s");
    await view;
    expect(harness.sent).toHaveLength(1);
    view = harness.command("view", harness.context);
    harness.panelInput("f");
    expect(harness.panelLines().join("\n")).not.toContain("Revise current result");
    expect(harness.panelLines(100).slice(-2).join("\n")).not.toContain("f Revise");
    harness.panelInput("q");
    await view;
    expect(harness.complete).toHaveBeenCalledTimes(1);
  });

  it("does not offer revision for an empty workflow or accepted read-only snapshot", async () => {
    const harness = await makeHarness();
    harness.holdPanel();
    let view = harness.command("view", harness.context);
    harness.panelInput("f");
    expect(harness.panelLines().join("\n")).not.toContain("Revise current result");
    harness.panelInput("q");
    await view;
    await trigger(harness);
    view = harness.command("view", harness.context);
    harness.panelInput("a");
    await view;
    view = harness.command("view", harness.context);
    harness.panelInput("f");
    expect(harness.panelLines().join("\n")).not.toContain("Revise current result");
    expect(harness.panelLines(100).slice(-2).join("\n")).not.toContain("f Revise");
    harness.panelInput("q");
    await view;
    expect(harness.complete).toHaveBeenCalledTimes(1);
  });
});

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
      await vi.waitFor(() => expect(harness.panelLines().join("\n")).toContain("Context saved · Applies to next round"));
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
  if (action === "e") {
    vi.mocked(harness.context.ui.editor).mockImplementationOnce(async () => {
      harness.setCustomAction("q"); // Close the result page reopened after editing.
      return "Edited candidate";
    });
  }
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
    harness.handlers.get("message_start")?.[0]?.({ message: { role: "user", content: "Sent" } }, harness.context);
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
      expect(harness.widgetLines().join("\n")).toContain("1 failed");
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
      // Neither queue preflight nor before_agent_start is a successful send boundary.
      if (ack !== "message_start") harness.handlers.get("message_start")?.[0]?.({ message: { role: "user", content: "Refined prompt" } }, harness.context);
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
      if (boundary === "other-input") harness.handlers.get("message_start")?.[0]?.({ message: { role: "user", content: "Unrelated" } }, harness.context);
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

  it("shows one line above the editor without a result card, editor changes or automatic dialogs", async () => {
    const harness = await makeHarness({ useDefaultShortcuts: true });
    let resolve!: (value: any) => void;
    harness.complete.mockImplementation(() => new Promise((res) => { resolve = res; }));
    await harness.command("optimize", harness.context);
    expect(harness.widgetLines().join("\n")).toContain("1 running");
    expect(harness.widgetLines()).toHaveLength(1);
    expect(harness.context.ui.setWidget).toHaveBeenLastCalledWith(expect.any(String), expect.any(Function), { placement: "aboveEditor" });
    expect(harness.customCalls()).toBe(0);
    harness.setEditorText("Draft B");
    resolve({ content: [{ type: "text", text: JSON.stringify({ prompt: "Automatic visible result", title: "Background refinement" }) }], stopReason: "stop" });
    await flushPromises();
    expect(harness.widgetLines().join("\n")).toContain("1 new");
    expect(harness.widgetLines()).toHaveLength(1);
    expect(harness.customCalls()).toBe(0);
    expect(harness.getEditor()).toBe("Draft B");
    expect(harness.editorWrites).toEqual([]);
    expect(harness.sent).toEqual([]);
  });

  it("uses the same shortcut to open a live generating panel and automatically updates its candidate", async () => {
    const harness = await makeHarness({ useDefaultShortcuts: true });
    let resolve!: (value: any) => void;
    harness.complete.mockImplementation(() => new Promise((res) => { resolve = res; }));
    harness.holdPanel();
    let view = shortcut(harness, "ctrl+\\")(harness.context);
    expect(harness.complete).not.toHaveBeenCalled();
    harness.panelInput("\r"); // Explicit start selects the running model beneath its original.
    harness.panelInput("q"); await view;
    view = shortcut(harness, "ctrl+\\")(harness.context);
    expect(harness.panelLines().join("\n")).toContain("Running");
    expect(harness.panelLines().join("\n")).toContain("Original prompt");
    expect(harness.panelLines().join("\n")).toContain("Draft A");
    expect(harness.complete).toHaveBeenCalledTimes(1);
    resolve({ content: [{ type: "text", text: JSON.stringify({ prompt: "Fresh completed result", title: "Live preview" }) }], stopReason: "stop" });
    await flushPromises();
    expect(harness.panelLines().join("\n")).toContain("Fresh completed result");
    expect(harness.panelLines().join("\n")).toContain("Draft A"); // Task label remains stable.
    expect(harness.customCalls()).toBe(2);
    harness.panelInput("a");
    await view;
    expect(harness.getEditor()).toBe("Fresh completed result");
    expect(harness.widgetLines()).toEqual([]);
    expect(harness.sent).toEqual([]);
  });

  it("shows live and final duration in the banner and clears the result reminder after viewing", async () => {
    const harness = await makeHarness();
    vi.useFakeTimers();
    let resolve!: (value: any) => void;
    harness.complete.mockImplementationOnce(() => new Promise((res) => { resolve = res; }));
    await trigger(harness);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(harness.widgetLines().join("\n")).toContain("1 running 12s");
    resolve(refinement("Timed result"));
    await flushPromises();
    expect(harness.widgetLines()).toHaveLength(1);
    expect(harness.widgetLines().join("\n")).toContain("1 new 12s");
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.widgetLines().join("\n")).toContain("1 new 12s");
    await panelAction(harness, "q");
    expect(harness.panelLines().join("\n")).toContain("Done · 12s");
    expect(harness.widgetLines()).toEqual([]);
    await panelAction(harness, "a");
    expect(harness.widgetLines()).toEqual([]);
    await vi.advanceTimersByTimeAsync(30_000);
    await panelAction(harness, "q");
    expect(harness.panelLines().join("\n")).toContain("Accepted · 12s");
    expect(harness.complete).toHaveBeenCalledTimes(1);

    await trigger(harness);
    expect(harness.widgetLines().join("\n")).toContain("1 new");
  });

  it("times the longest background run, excluding queue wait and already completed results", async () => {
    const harness = await makeHarness();
    vi.useFakeTimers();
    const finish: Array<(value: any) => void> = [];
    harness.complete.mockImplementation(() => new Promise((resolve) => { finish.push(resolve); }));
    await harness.command("optimize First", harness.context);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(5_000);
    for (const draft of ["Second", "Third", "Fourth", "Fifth"]) {
      await harness.command(`optimize ${draft}`, harness.context);
      await flushPromises();
    }
    await vi.advanceTimersByTimeAsync(3_000);
    expect(harness.widgetLines(100).join("\n")).toContain("4 running 8s · 1 queued");
    const narrow = harness.widgetLines(40).join("\n");
    expect(narrow).toContain("4 running · 1 queued");
    expect(narrow).toContain("alt+v Open");
    expect(narrow).not.toContain("8s");

    finish[0]!(refinement("First result"));
    await flushPromises();
    expect(finish).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(harness.widgetLines(100).join("\n")).toContain("4 running 5s · 1 new");
    for (const resolve of finish.slice(1, 4)) resolve(refinement("Another result"));
    await flushPromises();
    // Fifth began only when First finished; its five-second queue wait is not elapsed time.
    expect(harness.widgetLines(100).join("\n")).toContain("1 running 2s · 4 new");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(harness.widgetLines(100).join("\n")).toContain("1 running 4s · 4 new");
    finish[4]!(refinement("Last result"));
    await flushPromises();
    expect(harness.widgetLines(100).join("\n")).toContain("5 new");
    expect(harness.widgetLines(100).join("\n")).not.toMatch(/\d+s/);
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.customCalls()).toBe(0);
    expect(harness.editorWrites).toEqual([]);
  });

  it("captures request-time subscription and SDK cost without repricing from later settings", async () => {
    const harness = await makeHarness();
    vi.mocked(harness.context.modelRegistry.isUsingOAuth).mockReturnValue(true);
    let finish!: (value: any) => void;
    harness.complete.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await trigger(harness);
    vi.mocked(harness.context.modelRegistry.isUsingOAuth).mockReturnValue(false);
    finish({
      ...refinement("Priced result"),
      usage: { input: 200, output: 300, cacheRead: 1000, cacheWrite: 0, totalTokens: 1500, cost: { total: 0.012, input: 0.005, output: 0.006, cacheRead: 0.001, cacheWrite: 0 } },
    });
    await flushPromises();
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    expect(harness.panelLines().join("\n")).toContain("↑1.2k ↓300 · ≈$0.012 (sub)");
    harness.panelInput("q");
    await view;
    expect(harness.complete).toHaveBeenCalledTimes(1);
  });

  it("shows reported usage in the workspace and accepted snapshot without extra requests", async () => {
    const harness = await makeHarness();
    harness.complete.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify({ prompt: "Usage result" }) }], stopReason: "stop",
      usage: { input: 120, output: 30, cacheRead: 40, cacheWrite: 0, reasoning: 10, totalTokens: 190 },
    });
    await trigger(harness);
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    expect(harness.panelLines().join("\n")).toContain("↑160 ↓30 · Cost —");
    expect(harness.panelLines().join("\n")).not.toContain("think(out)");
    harness.panelInput("\x1b[C"); // Unified Usage shows full details beside the list.
    harness.panelInput("\r");
    let usageDetail = "";
    for (let i = 0; i < 4; i++) { usageDetail += harness.panelLines(100).join("").replace(/\s/g, ""); harness.panelInput("\x1b[6~"); }
    for (const count of ["Cacheread40", "Cachewrite0", "Reasoning10"]) expect(usageDetail).toContain(count);
    harness.panelInput("a");
    await view;
    const acceptedView = harness.command("view", harness.context);
    expect(harness.panelLines().join("\n")).toContain("↑160 ↓30 · Cost —");
    harness.panelInput("q");
    await acceptedView;
    expect(harness.complete).toHaveBeenCalledTimes(1);
    expect(harness.sent).toEqual([]);

    // A subsequent response without usage must not inherit the previous counts.
    await trigger(harness);
    const nextView = harness.command("view", harness.context);
    expect(harness.panelLines().join("\n")).not.toContain("↑160 ↓30");
    harness.panelInput("q");
    await nextView;
  });

  it("acknowledges a failed response and shows running status on retry", async () => {
    const harness = await makeHarness();
    harness.complete.mockResolvedValueOnce({
      content: [{ type: "text", text: "Partial result" }], stopReason: "length",
      usage: { totalTokens: 25 },
    });
    await trigger(harness);
    expect(harness.widgetLines().join("\n")).toContain("1 failed");
    await panelAction(harness, "q");
    expect(harness.widgetLines()).toEqual([]);
    harness.complete.mockImplementationOnce(() => new Promise(() => {}));
    await trigger(harness);
    expect(harness.widgetLines().join("\n")).toContain("1 running");
    expect(harness.widgetLines().join("\n")).not.toContain("failed");
  });

  it.each(["\x1b", "\x1c"])("closes the preview with %j without changing the candidate or draft", async (key) => {
    const harness = await makeHarness();
    await trigger(harness);
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    harness.panelInput(key);
    await view;
    expect(harness.widgetLines()).toEqual([]);
    expect(harness.editorWrites).toEqual([]);
    expect(harness.sent).toEqual([]);
    expect(harness.complete).toHaveBeenCalledTimes(1);
  });

  it("shows a single result surface and toggles reading options without writing or sending", async () => {
    const harness = await makeHarness();
    await trigger(harness);
    expect(harness.widgetLines().join("\n")).toContain("1 new");
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    expect(harness.widgetLines()).toEqual([]);
    expect(harness.panelLines().join("\n")).not.toContain("Draft A");
    harness.panelInput("o");
    expect(harness.panelLines().join("\n")).toContain("Draft A");
    harness.panelInput("?");
    const helpHeight = harness.panelLines().length;
    let help = harness.panelLines().join("\n");
    for (let page = 0; page < 3; page++) {
      harness.panelInput("\x1b[6~");
      expect(harness.panelLines()).toHaveLength(helpHeight);
      help += harness.panelLines().join("\n");
    }
    expect(help).toContain("Cycle task models + favorites");
    harness.panelInput("?");
    harness.panelInput("v");
    expect(harness.panelLines().join("\n")).toContain("source");
    harness.panelInput("\r");
    expect(harness.sent).toEqual([]);
    expect(harness.editorWrites).toEqual([]);
    harness.panelInput("\x1b");
    await view;
    expect(harness.widgetLines()).toEqual([]);
    expect(harness.getEditor()).toBe("Draft A");
    expect(harness.customCalls()).toBe(1);
  });

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
    const settingsHints = settings.findIndex((line) => line.includes("Ctrl+S Save context"));
    expect(settingsHints).toBeGreaterThan(settings.findIndex((line) => line.includes("←")));
    expect(settings[settingsHints + 2]).toBe(main.at(-4));
    expect(settings.findIndex((line) => line.includes("Directory tree"))).toBeGreaterThan(settingsHints + 2);
    expect(settings[1]?.startsWith("│  ")).toBe(true);
    harness.panelInput(" ");
    const edited = harness.panelLines();
    harness.panelInput("\t");
    expect(harness.panelLines().join("\n")).toContain("Model");
    harness.panelInput("\t");
    expect(harness.panelLines()).toEqual(edited);
    harness.panelInput(back);
    await flushPromises();
    expect(harness.complete).not.toHaveBeenCalled();
    expect(harness.customCalls()).toBe(1);
    expect(harness.panelLines().join("\n")).not.toContain("Unsaved context changes");
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
    await vi.waitFor(() => expect(harness.panelLines().join("\n")).toContain("Context saved"));
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
    await vi.waitFor(() => expect(harness.panelLines().join("\n")).toContain("Context saved"));
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
    expect(harness.panelLines().join("\n")).not.toContain("Context saved");
    expect(harness.panelLines().join("\n")).toContain("Settings");
    harness.panelInput("q"); // Failed persistence stays in Settings for retry.
    harness.panelInput("q");
    await view;
  });

  it("x Stop aborts the provider request and ignores late output", async () => {
    const harness = await makeHarness();
    let resolve!: (value: any) => void;
    harness.complete.mockImplementation(() => new Promise((res) => { resolve = res; }));
    await trigger(harness);
    const signal = (harness.complete.mock.calls[0] as any[])[2].signal as AbortSignal;
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    expect(harness.panelLines().join("\n")).toContain("x Stop");
    harness.panelInput("x");
    expect(harness.panelLines().join("\n")).toContain("Same input");
    harness.panelInput("q");
    await view;
    expect(signal.aborted).toBe(true);
    resolve({ content: [{ type: "text", text: JSON.stringify({ prompt: "Late output" }) }], stopReason: "stop" });
    await flushPromises();
    expect(harness.widgetLines()).toEqual([]);
    expect(harness.sent).toEqual([]);
    expect(harness.getEditor()).toBe("Draft A");
  });

  it.each(["q", "\x1b", "\x1c"])("closing a live panel with %j restores the running line without reopening on completion", async (key) => {
    const harness = await makeHarness();
    let resolve!: (value: any) => void;
    harness.complete.mockImplementation(() => new Promise((res) => { resolve = res; }));
    await trigger(harness);
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    expect(harness.widgetLines()).toEqual([]);
    harness.panelInput(key);
    await view;
    expect(harness.widgetLines().join("\n")).toContain("1 running");
    resolve({ content: [{ type: "text", text: JSON.stringify({ prompt: "Background result" }) }], stopReason: "stop" });
    await flushPromises();
    expect(harness.widgetLines().join("\n")).toContain("1 new");
    expect(harness.customCalls()).toBe(1);
  });

  it.each(["session_before_tree", "session_shutdown"])("clears widget and live panel on %s and ignores late output", async (event) => {
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
    expect(harness.widgetLines().join("\n")).toContain("1 new");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("opens the action panel instead of issuing a request when no model is configured", async () => {
    const harness = await makeHarness({ useDefaultShortcuts: true, configureModel: false });
    await shortcut(harness, "ctrl+\\")(harness.context);
    expect(harness.customCalls()).toBe(1);
    expect(harness.panelLines().join("\n")).toContain("m Model");
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
    expect(harness.panelLines().join("\n")).toContain("Unsaved context changes");
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
    expect(lines).toContain(origin === "settings" ? "Unsaved context changes" : "m Model");
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
    await vi.waitFor(() => expect(harness.panelLines().join("\n")).toContain("Unsaved context changes"));
    harness.panelInput("\t");
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
    expect(harness.panelLines().join("\n")).toContain("Unsaved context changes");
    harness.panelInput("\t");
    harness.panelInput("\x13");
    await vi.waitFor(() => expect(harness.panelLines().join("\n")).toContain("Context saved"));
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

  it("accepts only explicitly, preserves an intervening draft behind default-No overwrite confirmation, and safely restores", async () => {
    const harness = await makeHarness();
    await trigger(harness);
    harness.setCustomAction("a");
    await shortcut(harness, "alt+v")(harness.context);
    expect(harness.getEditor()).toBe("Refined prompt");
    expect(harness.sent).toEqual([]);
    expect(harness.internalMessages).toEqual([]);
    expect(harness.sessionWrites).toEqual([]);
    expect(harness.editorWrites).toEqual(["Refined prompt"]);

    await shortcut(harness, "alt+z")(harness.context);
    expect(harness.getEditor()).toBe("Draft A");
    expect(harness.sent).toEqual([]);

    await trigger(harness);
    harness.setEditorText("Draft B");
    harness.setConfirm(false);
    harness.setCustomAction("a");
    await shortcut(harness, "alt+v")(harness.context);
    await flushPromises();
    expect(harness.getEditor()).toBe("Draft B");
    expect(harness.editorWrites).toEqual(["Refined prompt", "Draft A"]);
    expect(harness.context.ui.confirm).toHaveBeenCalledTimes(1);
  });

  it.each(["Refined prompt", "Draft A", ""])("shortcut views an accepted result without calling the model when the editor contains %j", async (draft) => {
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
    expect(panel).toContain("Accepted");
    expect(panel).not.toContain("Applied");
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

  it("captures an edited accepted prompt without automatically requesting", async () => {
    const harness = await makeHarness({ useDefaultShortcuts: true });
    await trigger(harness);
    harness.setCustomAction("a");
    await shortcut(harness, "ctrl+\\")(harness.context);
    harness.setEditorText("my edited accepted prompt");
    harness.setCustomAction("q");
    const panelsBefore = harness.customCalls();
    await shortcut(harness, "ctrl+\\")(harness.context);
    await flushPromises();
    expect(harness.customCalls()).toBe(panelsBefore + 1);
    expect(harness.complete).toHaveBeenCalledTimes(1);
    expect(harness.panelLines().join("\n")).toContain("Unsent");
    expect(harness.getEditor()).toBe("my edited accepted prompt");
    harness.setCustomAction("q");
    await shortcut(harness, "ctrl+\\")(harness.context);
    expect(harness.complete).toHaveBeenCalledTimes(1);
    expect(harness.panelLines().join("\n")).toContain("2 prompts");
  });

  it("explicit view opens an edited candidate without regenerating and labels a changed main draft", async () => {
    const harness = await makeHarness({ useDefaultShortcuts: true });
    await trigger(harness);
    await panelAction(harness, "e");
    harness.setEditorText("another main draft");
    harness.setCustomAction("q");
    await harness.command("view", harness.context);
    expect(harness.panelLines().join("\n")).toContain("Edited candidate");
    expect(harness.panelLines().join("\n")).toContain("candidate uses the original draft");
    expect(harness.complete).toHaveBeenCalledTimes(1);
    expect(harness.getEditor()).toBe("another main draft");
  });

  it.each(["generating", "ready", "error"] as const)("captures B without replacing or cancelling A when A is %s", async (phase) => {
    const harness = await makeHarness({ useDefaultShortcuts: true });
    let finishA!: (value: any) => void;
    if (phase === "generating") harness.complete.mockImplementationOnce(() => new Promise((resolve) => { finishA = resolve; }));
    else if (phase === "error") harness.complete.mockRejectedValueOnce(new Error("offline"));
    await trigger(harness);
    harness.setEditorText("Draft B");
    // Viewing is still passive, and always describes the submitted A, not editor B.
    await harness.command("view", harness.context);
    let text = harness.panelLines().join("\n");
    if (phase === "ready") {
      harness.setCustomAction("o");
      await harness.command("view", harness.context);
      text = harness.panelLines().join("\n");
    }
    expect(text).toContain("Draft A");
    expect(text).not.toContain("Draft B");
    expect(text.toLowerCase()).toMatch(/editor (changed|differs)/);
    expect(harness.complete).toHaveBeenCalledTimes(1);
    let finishB!: (value: any) => void;
    harness.complete.mockImplementationOnce(() => new Promise((resolve) => { finishB = resolve; }));
    harness.holdPanel();
    const view = shortcut(harness, "ctrl+\\")(harness.context);
    expect(harness.complete).toHaveBeenCalledTimes(1);
    expect(harness.panelLines().join("\n")).toContain("Draft B");
    expect(harness.panelLines().join("\n")).toContain("Draft A");
    expect(harness.panelLines().join("\n")).toContain("Unsent");
    expect(harness.panelLines(100).join("\n")).toContain("› ○ Unsent · Draft B");
    harness.panelInput("\r"); // Explicitly start B and automatically follow its model child.
    expect(harness.panelLines(100).join("\n")).toMatch(/›\s+└ fake-chat/);
    const request = (harness.complete.mock.calls[1] as any[])[1];
    expect(JSON.parse(request.messages[0].content[0].text).draft).toBe("Draft B");
    if (phase === "generating") {
      expect((harness.complete.mock.calls[0] as any[])[2].signal.aborted).toBe(false);
      finishA(refinement("Late A result"));
      await flushPromises();
      expect(harness.panelLines().join("\n")).not.toContain("Late A result"); // Still viewing B.
    }
    finishB(refinement("Result B"));
    await flushPromises();
    expect(harness.panelLines().join("\n")).toContain("Result B");
    expect(harness.panelLines().join("\n")).toContain("Draft B");
    expect(harness.complete).toHaveBeenCalledTimes(2);
    expect(harness.getEditor()).toBe("Draft B");
    expect(harness.editorWrites).toEqual([]);
    expect(harness.sent).toEqual([]);
    harness.panelInput("q");
    await view;
  });

  it.each(["too-long", "unavailable"])("does not relabel A as B when B is rejected: %s", async (reason) => {
    const harness = await makeHarness({ config: { maxDraftChars: 100 } });
    await trigger(harness);
    harness.setEditorText(reason === "too-long" ? "B".repeat(101) : "Draft B");
    if (reason === "unavailable") vi.mocked(harness.context.modelRegistry.getAvailable).mockReturnValue([]);
    await shortcut(harness, "ctrl+\\")(harness.context);
    expect(harness.complete).toHaveBeenCalledTimes(1);
    expect(harness.notifications.at(-1)).toContain("no request was sent");
    harness.setCustomAction("o");
    await harness.command("view", harness.context);
    expect(harness.panelLines().join("\n")).toContain("Draft A");
    expect(harness.panelLines().join("\n")).not.toContain("Draft B");
  });

  it("uses the shortcut to inspect failures and blocks the legacy r retry",  async () => {
    const harness = await makeHarness({ useDefaultShortcuts: true });
    harness.complete.mockRejectedValueOnce(new Error("offline"));
    await trigger(harness);
    harness.setCustomAction("q");
    await shortcut(harness, "ctrl+\\")(harness.context);
    expect(harness.panelLines().join("\n")).toContain("Failed");
    expect(harness.complete).toHaveBeenCalledTimes(1);
    harness.setCustomAction("r");
    await shortcut(harness, "ctrl+\\")(harness.context);
    await flushPromises();
    expect(harness.complete).toHaveBeenCalledTimes(1);
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
    expect(harness.widgetLines()).toEqual([]);
    await panelAction(harness, "q");
    expect(harness.panelLines().join("\n")).toContain("Refined prompt");
    expect(harness.getEditor()).toBe(draft);
  });

  it("retains archived work after submission so new shortcut input is unsent", async () => {
    const harness = await makeHarness({ useDefaultShortcuts: true });
    await trigger(harness);
    harness.setCustomAction("a");
    await shortcut(harness, "ctrl+\\")(harness.context);
    await harness.command("cancel", harness.context);
    harness.setCustomAction("q");
    await shortcut(harness, "ctrl+\\")(harness.context);
    expect(harness.complete).toHaveBeenCalledTimes(1);
    harness.handlers.get("message_start")?.[0]?.({ message: { role: "user", content: "Refined prompt" } }, harness.context);
    harness.setEditorText("brand new task");
    await shortcut(harness, "ctrl+\\")(harness.context);
    await flushPromises();
    expect(harness.complete).toHaveBeenCalledTimes(1);
    expect(harness.panelLines().join("\n")).toContain("Unsent");
  });

  it("rejects a confirmation that returns after the session branch changed", async () => {
    const harness = await makeHarness();
    await trigger(harness);
    harness.setEditorText("Draft B");
    harness.deferConfirm();
    harness.setCustomAction("a");
    await shortcut(harness, "alt+v")(harness.context);
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
    await shortcut(harness, "alt+v")(harness.context);
    await flushPromises();
    expect(harness.getEditor()).toBe("Draft C");
    expect(harness.editorWrites).toEqual([]);
  });

  it("keeps a running request across raw input without writing Pi until explicit acceptance", async () => {
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
    await shortcut(harness, "alt+v")(harness.context);
    expect(harness.editorWrites).toEqual(["stale result"]);
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


  it("waits past Pi preflight until message start before archiving an explicitly sent candidate", async () => {
    const harness = await makeHarness();
    await trigger(harness);
    harness.setCustomAction("s");
    await shortcut(harness, "alt+v")(harness.context);
    expect(harness.sent).toEqual([{ text: "Refined prompt", options: undefined }]);

    harness.handlers.get("input")?.[0]?.({ type: "input", text: "Refined prompt", source: "extension" }, harness.context);
    expect(harness.widgetLines()).toEqual([]);
    harness.setCustomAction("s");
    await shortcut(harness, "alt+v")(harness.context);
    expect(harness.sent).toHaveLength(1);

    harness.handlers.get("before_agent_start")?.[0]?.({ type: "before_agent_start", messageType: "user", prompt: "Refined prompt" }, harness.context);
    expect(harness.widgetLines()).toEqual([]);
    harness.setCustomAction("q");
    await shortcut(harness, "alt+v")(harness.context);
    expect(harness.panelLines().join("\n")).toContain("Send pending");
    harness.handlers.get("message_start")?.[0]?.({ message: { role: "user", content: "Refined prompt" } }, harness.context);
    await shortcut(harness, "alt+v")(harness.context);
    expect(harness.panelLines().join("\n")).toContain("Accepted prompt");
    expect(harness.getEditor()).toBe("Draft A");
  });

  it("sends the current candidate exactly once as Pi follow-up when busy without replacing another draft", async () => {
    const harness = await makeHarness({ busy: true });
    await trigger(harness);
    harness.setEditorText("unrelated main draft");
    harness.setCustomAction("s");
    await shortcut(harness, "alt+v")(harness.context);
    expect(harness.sent).toEqual([{ text: "Refined prompt", options: { deliverAs: "followUp" } }]);
    expect(harness.getEditor()).toBe("unrelated main draft");
    expect(harness.editorWrites).toEqual([]);

    harness.handlers.get("input")?.[0]?.({ type: "input", text: "Refined prompt", source: "extension", streamingBehavior: "followUp" }, harness.context);
    harness.setCustomAction("s");
    await shortcut(harness, "alt+v")(harness.context);
    expect(harness.sent).toHaveLength(1);
  });

  it.each([undefined, "Edited candidate", ""])("returns from candidate editing to the result page before Esc exits (edit: %s)", async (edited) => {
    const harness = await makeHarness();
    await trigger(harness);
    vi.mocked(harness.context.ui.editor).mockResolvedValueOnce(edited);
    harness.holdPanel();
    let closed = false;
    const view = harness.command("view", harness.context);
    void Promise.resolve(view).then(() => { closed = true; });
    harness.panelInput("e");
    await flushPromises();
    expect(harness.context.ui.editor).toHaveBeenCalledWith("Edit candidate (cancel keeps original)", "Refined prompt");
    expect(harness.customCalls()).toBe(2);
    expect(harness.panelLines().join("\n")).toContain(edited || "Refined prompt");
    expect(harness.panelLines().join("\n")).toContain("Settings");
    expect(harness.widgetLines()).toEqual([]);
    expect(closed).toBe(false);
    harness.panelInput("\x1b");
    await view;
    expect(closed).toBe(true);
    expect(harness.complete).toHaveBeenCalledTimes(1);
    expect(harness.getEditor()).toBe("Draft A");
    expect(harness.editorWrites).toEqual([]);
    expect(harness.sent).toEqual([]);
  });

  it("returns from Revise to the result page before a second Esc exits", async () => {
    const harness = await makeHarness();
    await trigger(harness);
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    harness.panelInput("f");
    harness.panelInput("Make it shorter");
    harness.panelInput("\x1b");
    expect(harness.panelLines().join("\n")).toContain("Refined prompt");
    expect(harness.widgetLines()).toEqual([]);
    harness.panelInput("f");
    expect(harness.panelLines().join("\n")).toContain("Make it shorter");
    harness.panelInput("\x1b");
    harness.panelInput("\x1b");
    await view;
    expect(harness.widgetLines()).toEqual([]);
    expect(harness.complete).toHaveBeenCalledTimes(1);
    expect(harness.editorWrites).toEqual([]);
  });

  it.each(["session_before_switch", "session_before_tree", "session_shutdown"])("does not reopen the result page after %s during editing", async (event) => {
    const harness = await makeHarness();
    await trigger(harness);
    let finishEdit!: (value: string | undefined) => void;
    vi.mocked(harness.context.ui.editor).mockImplementationOnce(() => new Promise((resolve) => { finishEdit = resolve; }));
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    harness.panelInput("e");
    await flushPromises();
    harness.handlers.get(event)?.[0]?.({ type: event }, harness.context);
    finishEdit(undefined);
    await view;
    expect(harness.customCalls()).toBe(1);
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
    await shortcut(harness, "alt+v")(harness.context);
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

describe("main request deletion shortcut", () => {
  it("uses d with confirmation, stops a running request and ignores late output", async () => {
    const harness = await makeHarness({ useDefaultShortcuts: true });
    let resolve!: (value: any) => void;
    harness.complete.mockImplementationOnce(() => new Promise((res) => { resolve = res; }));
    harness.holdPanel();
    const view = shortcut(harness, "ctrl+\\")(harness.context);
    harness.panelInput("\r");
    expect(harness.panelLines(100).join("\n")).toContain("d Delete");
    harness.panelInput("d");
    expect(harness.panelLines().join("\n")).toContain("Confirmation required");
    harness.panelInput("n");
    expect(harness.panelLines().join("\n")).toContain("Running");
    harness.panelInput("d");
    harness.panelInput("y");
    await view;
    resolve(refinement("Deleted result must not return"));
    await flushPromises();
    expect(harness.widgetLines()).toEqual([]);
    expect(harness.widgetLines()).toEqual([]);
    expect(harness.editorWrites).toEqual([]);
    expect(harness.sent).toEqual([]);
  });
});
