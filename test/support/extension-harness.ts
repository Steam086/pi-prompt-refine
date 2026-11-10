import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, TuiAltScreen, TuiMainScreen, type OverlayHandle, type OverlayOptions, type Terminal } from "@earendil-works/pi-tui";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { DEFAULT_CONFIG, type RefineConfig } from "../../src/config.js";
import promptRefineExtension from "../../src/extension.js";
import { flushPromises } from "./helpers.js";
import { getThemeByName } from "./pi-theme.js";
import { createRecordingTerminal } from "./recording-terminal.js";

export interface Harness {
  dispose(): Promise<void>;
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

// Call once per test file. Vitest isolates the module environment; no agent directory is shared.
export function extensionHarnessEnvironment() {
  const agentDirs: string[] = [];
  const activeHarnesses: Harness[] = [];
  let originalAgentDir: string | undefined;
  beforeEach(() => { originalAgentDir = process.env.PI_CODING_AGENT_DIR; });
  const dispose = async () => {
    try {
      const failures: unknown[] = [];
      for (const harness of activeHarnesses.splice(0).reverse()) {
        try { await harness.dispose(); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, "Extension harness shutdown failed");
    } finally {
      if (vi.isFakeTimers()) vi.clearAllTimers();
      vi.useRealTimers();
      vi.restoreAllMocks();
      try {
        await Promise.all(agentDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
      } finally {
        if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
      }
    }
  };
  afterEach(dispose);

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
    const { terminal, writes, input: nativeInput } = createRecordingTerminal({ rows: 40, columns: 100 });
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

    let disposed = false;
    const harness: Harness = {
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        try {
          for (const handler of handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" }, context);
        } finally {
          renderer?.stop();
        }
      },
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
    // Track resources before startup so a failed initialization is still cleaned up.
    activeHarnesses.push(harness);
    await promptRefineExtension(pi);
    harness.command = command;
    const sessionStart = handlers.get("session_start")?.[0];
    await sessionStart?.({ type: "session_start", reason: "startup" }, context);
    return harness;
  }
  return { makeHarness, dispose };
}

export function shortcut(harness: Harness, action: string): (ctx: ExtensionContext) => unknown {
  const handler = harness.shortcuts.get(action);
  if (!handler) throw new Error(`Missing shortcut ${action}`);
  return handler;
}

export async function trigger(harness: Harness): Promise<void> {
  await harness.command("optimize", harness.context);
  await flushPromises();
}

export function projectConfig(tree = false): RefineConfig["projectContext"] {
  const config = structuredClone(DEFAULT_CONFIG.projectContext);
  config.tree.enabled = tree;
  // Existing resource/budget tests explicitly exercise repeat injection.
  config.instructionsEnabled = true;
  config.instructionsOnFollowUp = true;
  config.skillsEnabled = true;
  return config;
}

export function resourcePrompt(skillDescription = "Extract PDF tables", instructions = "Use the project venv."): string {
  return `<tools>\nPRIVATE MAIN AGENT TOOLS\n</tools>\n<project_context>\nProject-specific instructions and guidelines:\n\n<project_instructions path="/repo/AGENTS.md">\n${instructions}\n</project_instructions>\n</project_context>\n<skills>\nUse bash to load skills.\n<available_skills>\n<skill><name>pdf</name><description>${skillDescription}</description><location>/skills/pdf/SKILL.md</location></skill>\n</available_skills>\n</skills>\n<cwd>\n/repo\n</cwd>`;
}

export function refinement(prompt: string, title?: unknown) {
  return { content: [{ type: "text", text: JSON.stringify({ prompt, title }) }], stopReason: "stop" };
}

export async function panelAction(harness: Harness, action: string): Promise<void> {
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
