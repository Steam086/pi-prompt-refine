import { describe, expect, it } from "vitest";
import { extensionHarnessEnvironment, refinement, shortcut, type Harness } from "../support/extension-harness.js";
import { flushPromises } from "../support/helpers.js";

const { makeHarness } = extensionHarnessEnvironment();
const open = (h: Harness) => shortcut(h, "ctrl+\\")(h.context);
const screen = (h: Harness) => h.panelLines(100).join("\n");

describe("quick preview transactions", () => {
  it("keeps the changed editor by default and rechecks it before replacing or clearing", async () => {
    const h = await makeHarness();
    h.holdPanel();
    const view = open(h);
    await flushPromises();
    expect(screen(h)).toContain("Ready");
    h.setEditorText("Uncaptured B");
    h.panelInput("a");
    expect(screen(h)).toContain("Replace editor?");
    h.panelInput("\r");
    expect(h.getEditor()).toBe("Uncaptured B");
    h.panelInput("a");
    h.setEditorText("Newer C");
    h.panelInput("y");
    expect(h.editorWrites).toEqual([]);
    h.panelInput("n"); expect(screen(h)).toContain("unsaved text");
    h.panelInput("\x1b"); expect(h.getEditor()).toBe("Newer C");
    h.panelInput("n"); h.panelInput("y"); await view;
    expect(h.getEditor()).toBe("");
    h.setEditorText("Newer C"); const recovered = open(h);
    expect(screen(h)).toContain("Unsent"); expect(screen(h)).toContain("Newer C");
    expect(h.complete).toHaveBeenCalledTimes(1);
    h.panelInput("n"); await recovered;
    expect(h.getEditor()).toBe(""); expect(h.sent).toEqual([]);
  });

  it("accepts the entire multiline result while only its first page is visible", async () => {
    const h = await makeHarness();
    const candidate = Array.from({length: 100}, (_, i) => `Line ${i} 中文 🧑‍💻`).join("\n");
    h.complete.mockResolvedValueOnce(refinement(candidate));
    h.holdPanel();
    const view = open(h);
    await flushPromises();
    expect(screen(h)).toContain("Line 0");
    expect(screen(h)).not.toContain("Line 99");
    h.panelInput("a"); await view;
    expect(h.editorWrites).toEqual([candidate]);
    expect(h.sent).toEqual([]);
  });

  it("retains the replaced text for restore and ignores repeated Enter in Ready", async () => {
    const h = await makeHarness();
    h.holdPanel();
    const view = open(h);
    await flushPromises();
    expect(screen(h)).toContain("Ready");
    h.panelInput("\r"); h.panelInput("\r");
    expect(h.editorWrites).toEqual([]); expect(h.sent).toEqual([]);
    h.setEditorText("Other text");
    h.panelInput("a"); h.panelInput("y"); await view;
    expect(h.getEditor()).toBe("Refined prompt");
    await h.command("restore", h.context);
    expect(h.getEditor()).toBe("Other text"); expect(h.sent).toEqual([]);
  });

  it("keeps uncaptured text when the protected copy exceeds the draft limit", async () => {
    const h = await makeHarness({config:{maxDraftChars:100}});
    h.holdPanel(); const view = open(h); await flushPromises();
    h.setEditorText("B".repeat(101));
    h.panelInput("n"); h.panelInput("y");
    expect(h.getEditor()).toBe("B".repeat(101));
    expect(h.notifications.at(-1)).toContain("Could not protect");
    expect(h.complete).toHaveBeenCalledTimes(1);
    h.panelInput("q"); await view;
  });

  it("stops only the selected request and retries its frozen input after the editor changes", async () => {
    const h = await makeHarness();
    h.complete.mockImplementation(() => new Promise(() => {}));
    h.holdPanel(); const a = open(h); await flushPromises();
    h.panelInput("q"); await a;
    h.setEditorText("B"); const b = open(h); await flushPromises();
    const [first, second] = h.complete.mock.calls;
    h.panelInput("x"); expect(screen(h)).toContain("Cancelled");
    expect(first![2].signal.aborted).toBe(false);
    expect(second![2].signal.aborted).toBe(true);
    h.setEditorText("C"); h.panelInput("r"); h.panelInput("r"); await flushPromises();
    expect(h.complete).toHaveBeenCalledTimes(3);
    expect(h.complete.mock.calls[2]![1]).toEqual({ ...second![1],
      messages: [{ ...second![1].messages[0], timestamp: expect.any(Number) }] });
    expect(screen(h)).toContain("Generating");
    expect(h.editorWrites).toEqual([]); expect(h.sent).toEqual([]);
    h.panelInput("q"); await b;
  });

  it("carries a revision through Preferences and dismissal and follows exactly one new run", async () => {
    const h = await makeHarness(); h.holdPanel();
    let view = open(h);
    await flushPromises();
    h.panelInput("v"); expect(screen(h)).toContain("Full preview");
    h.panelInput("f");
    h.panelInput("afmvw"); h.panelInput("\r"); h.panelInput("second");
    h.panelInput("\x1bp"); await flushPromises(); expect(screen(h)).toContain("Preferences");
    h.panelInput("\x1b"); expect(screen(h)).toContain("afmvw");
    h.panelInput("\x1b"); expect(screen(h)).toContain("Full preview");
    h.panelInput("f"); h.panelInput("\x1c"); await view;
    view = open(h); h.panelInput("f"); expect(screen(h)).toContain("second");
    h.complete.mockResolvedValueOnce(refinement("Revised candidate"));
    h.panelInput("\x13"); h.panelInput("\x13"); await flushPromises();
    expect(h.complete).toHaveBeenCalledTimes(2);
    expect(screen(h)).toContain("Revised candidate");
    expect(screen(h)).toContain("2/2");
    h.panelInput("\x1b[D"); expect(screen(h)).toContain("Refined prompt");
    h.panelInput("v"); h.panelInput("w"); expect(screen(h)).toContain("Usage");
    h.panelInput("\x1b"); expect(screen(h)).toContain("Full preview");
    h.panelInput("a"); await view;
    expect(h.getEditor()).toBe("Refined prompt"); expect(h.sent).toEqual([]);
    view = open(h); expect(screen(h)).toContain("1/2"); h.panelInput("q"); await view;
  });

  it("drops an open confirmation at the committed round boundary and recaptures the exact same draft", async () => {
    const h = await makeHarness(); h.holdPanel();
    let view = open(h); await flushPromises(); expect(screen(h)).toContain("Ready");
    h.setEditorText("B"); h.panelInput("a");
    expect(screen(h)).toContain("Replace editor?");
    h.handlers.get("message_start")?.[0]?.({message: {role:"user",content:"A"}}, h.context);
    h.panelInput("y"); await view; expect(h.editorWrites).toEqual([]);
    h.setEditorText("Draft A"); view = open(h); await flushPromises();
    expect(h.complete).toHaveBeenCalledTimes(2);
    expect(screen(h)).toContain("Ready");
    h.panelInput("a"); await view;
  });

  it("keeps unrelated results unread and never reopens for late output", async () => {
    const h = await makeHarness();
    let finish!: (v: ReturnType<typeof refinement>) => void;
    h.complete.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
    h.holdPanel(); const a = open(h);
    await flushPromises(); h.panelInput("\x1b"); await a;
    h.setEditorText("New B"); const b = open(h); await flushPromises();
    expect(screen(h)).toContain("Ready");
    finish(refinement("Late A")); await flushPromises();
    expect(screen(h)).not.toContain("Late A");
    h.panelInput("q"); await b;
    expect(h.widgetLines().join("")).toContain("1 new");
    expect(h.editorWrites).toEqual([]);
    expect(h.customCalls()).toBe(2);
  });

  it.each(["session_before_tree","session_before_fork","session_before_switch","session_shutdown"])(
    "disposes the focused quick view on %s", async event => {
      const h = await makeHarness(); h.holdPanel();
      let finish!: (v: ReturnType<typeof refinement>) => void;
      h.complete.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      const view = open(h); await flushPromises();
      await h.handlers.get(event)?.[0]?.({}, h.context);
      await view; finish(refinement("Old session")); await flushPromises();
      expect(h.editorWrites).toEqual([]); expect(h.widgetLines()).toEqual([]);
      expect(h.customCalls()).toBe(1); expect(h.sent).toEqual([]);
    });
});
