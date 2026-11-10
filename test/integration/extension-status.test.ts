import { describe, expect, it, vi } from "vitest";
import { extensionHarnessEnvironment, panelAction, refinement, shortcut, trigger } from "../support/extension-harness.js";
import { flushPromises } from "../support/helpers.js";

const { makeHarness } = extensionHarnessEnvironment();

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
});
