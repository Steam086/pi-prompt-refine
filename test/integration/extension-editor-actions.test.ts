import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { extensionHarnessEnvironment, panelAction, refinement, shortcut, trigger } from "../support/extension-harness.js";
import { flushPromises } from "../support/helpers.js";

const { makeHarness } = extensionHarnessEnvironment();

describe("Pi extension integration (mocked TUI and provider)", () => {

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
