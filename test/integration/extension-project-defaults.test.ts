import { describe, expect, it, vi } from "vitest";
import { PreferenceStore } from "../../src/preference-store.js";
import { preferenceKey } from "../../src/revision-preferences.js";
import { extensionHarnessEnvironment, refinement, shortcut } from "../support/extension-harness.js";
import { flushPromises } from "../support/helpers.js";

const { makeHarness } = extensionHarnessEnvironment();

describe("project defaults through the extension", () => {
  it("keeps changed defaults out of revisions and same-input retries, but uses them for an explicit copy", async () => {
    const h = await makeHarness(); const store = new PreferenceStore(h.agentDir, h.context.cwd);
    const initial = await store.save("project", { name: "Initial", body: "Initial requirement." });
    const future = await store.save("global", { name: "Future", body: "Future drafts only." });
    await store.setProjectDefault(initial, true); await h.reload();
    h.setEditorText("Original task"); await h.command("optimize", h.context); await flushPromises();
    h.holdPanel(); let view = h.command("", h.context);
    const output = () => h.panelLines(100).join("\n");
    const packet = (index: number) => JSON.parse((h.complete.mock.calls[index] as any[])[1].messages[0].content[0].text);
    h.panelInput("p"); await vi.waitFor(() => expect(output()).not.toContain("Working…"));
    h.panelInput("g"); await vi.waitFor(() => expect(output()).toContain("Project default disabled"));
    h.panelInput("\x1b[B"); h.panelInput("g"); await vi.waitFor(() => expect(output()).toContain("Project default enabled"));
    h.panelInput("\x1b");
    h.panelInput("f"); h.panelInput("Remove the initial requirement.");
    h.complete.mockResolvedValueOnce(refinement("Task without initial requirement."));
    h.panelInput("\x13"); await flushPromises();
    expect(h.complete).toHaveBeenCalledTimes(2);
    expect(packet(1).revision_instruction).toBe("Remove the initial requirement.");
    expect(packet(1).editing_instruction).toBeUndefined();
    expect(packet(1).historical_editing_context.initial_instruction).toBe(`Saved editing requirements (project default):\n${initial.body}`);
    expect(JSON.stringify(packet(1))).not.toContain(future.body);
    h.panelInput("q"); await view; view = h.command("", h.context);
    // m runs the original with a model and retains its adopted snapshot.
    h.panelInput("m"); await flushPromises();
    expect(output()).toContain("Run original with another model");
    h.panelInput("\r"); await vi.waitFor(() => expect(h.complete).toHaveBeenCalledTimes(3));
    expect(packet(2).editing_instruction).toBe(`Saved editing requirements (project default):\n${initial.body}`);
    expect(JSON.stringify(packet(2))).not.toContain(future.body);
    h.panelInput("i"); h.panelInput("\r");
    expect(output()).toContain("Preferences · 1 selected");
    h.panelInput("\r"); await flushPromises();
    expect(h.complete).toHaveBeenCalledTimes(4);
    expect(packet(3).editing_instruction).toBe(`Saved editing requirements (project default):\n${future.body}`);
    h.panelInput("q"); await view;
  });

  it.each(["project", "global"] as const)("toggles a %s item for future drafts, clears one request, and restores defaults for the next", async (scope) => {
    const h = await makeHarness();
    const store = new PreferenceStore(h.agentDir, h.context.cwd);
    const entry = await store.save(scope, { name: "Default 中文😀", body: "Keep commands literal." });
    h.holdPanel(); let view = h.command("", h.context);
    h.panelInput("n"); h.panelInput("Existing draft"); h.panelInput("\r");
    const output = () => h.panelLines(100).join("\n");
    h.panelInput("p"); await vi.waitFor(() => expect(output()).not.toContain("Working…"));
    expect(output()).toContain("Space Toggle · g Project default");
    h.panelInput("g"); await vi.waitFor(() => expect(output()).toContain("Project default enabled"));
    expect(output()).toContain("[ ] * Default 中文😀");
    expect((await store.load()).projectDefaults).toEqual([preferenceKey(entry)]);
    h.panelInput("\x1b"); expect(output()).toContain("Preferences · 0 selected");
    expect(h.complete).not.toHaveBeenCalled(); expect(h.editorWrites).toEqual([]); expect(h.sent).toEqual([]);
    h.panelInput("q"); await view;

    view = h.command("", h.context);
    h.panelInput("n"); h.panelInput("One request without defaults"); h.panelInput("\r");
    expect(output()).toContain("Preferences · 1 selected");
    h.panelInput("\t"); await vi.waitFor(() => expect(output()).not.toContain("Loading preferences…"));
    h.panelInput("c"); expect(output()).toContain("Selected · 0");
    h.panelInput("\r"); await flushPromises();
    expect(h.complete).toHaveBeenCalledTimes(1);
    const first = JSON.parse((h.complete.mock.calls[0] as any[])[1].messages[0].content[0].text);
    expect(first.draft).toBe("One request without defaults");
    expect(first.editing_instruction).toBeUndefined();
    h.panelInput("q"); await view;

    h.setEditorText("Following request"); view = shortcut(h, "ctrl+\\")(h.context);
    expect(output()).toContain("Preferences · 1 selected");
    h.panelInput("\r"); await flushPromises();
    expect(h.complete).toHaveBeenCalledTimes(2);
    const next = JSON.parse((h.complete.mock.calls[1] as any[])[1].messages[0].content[0].text);
    expect(next.editing_instruction).toBe(`Saved editing requirements (project default):\n${entry.body}`);
    expect((await store.load()).projectDefaults).toEqual([preferenceKey(entry)]);
    expect(h.editorWrites).toEqual([]); expect(h.sent).toEqual([]);
    h.panelInput("q"); await view;
  });

  it("keeps session and project choices separate, applies them to new prompts, and isolates other sessions", async () => {
    const h = await makeHarness(); const store = new PreferenceStore(h.agentDir, h.context.cwd);
    const inherited = await store.save("project", { name: "Inherited item", body: "Project requirement." });
    const manual = await store.save("global", { name: "Session item", body: "Session requirement." });
    await store.setProjectDefault(inherited, true);
    h.holdPanel(); let view = h.command("", h.context);
    const output = (width = 100) => h.panelLines(width).join("\n");
    const find = (name: string) => { for (const key of ["/", "\x15", name, "\r"]) h.panelInput(key); };
    h.panelInput("p"); await vi.waitFor(() => expect(output()).toContain("[x] * Inherited item"));
    find(inherited.name); h.panelInput(" ");
    expect(output()).toContain("[ ] * Inherited item"); expect(output()).toContain("0 selected");
    h.panelInput("g"); await vi.waitFor(() => expect(output()).toContain("Project default disabled"));
    h.panelInput("g"); await vi.waitFor(() => expect(output()).toContain("Project default enabled"));
    expect(output()).toContain("[ ] * Inherited item"); expect(output()).toContain("This session: Off");
    h.panelInput("r"); expect(output()).toContain("[x] * Inherited item");
    h.panelInput(" "); find(manual.name);
    h.resize(10);
    expect(output(24)).toMatch(/Esc[\s\S]*Space.*g/);
    h.panelInput(" ");
    expect(output(24)).toContain("1 selected"); expect(output(24)).toContain("[x]");
    h.resize(40);
    expect(output()).toContain("[x] Session item");
    h.panelInput("\x1b"); h.panelInput("q"); await view;
    expect(h.complete).not.toHaveBeenCalled(); expect(h.sent).toEqual([]); expect(h.editorWrites).toEqual([]);
    expect((await store.load()).projectDefaults).toEqual([preferenceKey(inherited)]);

    const messageStarted = h.handlers.get("message_start")![0]!;
    messageStarted({ message: { role: "user", content: "Another round" } }, h.context);
    view = h.command("", h.context);
    h.panelInput("p"); await vi.waitFor(() => expect(output()).toContain("[x] Session item"));
    h.panelInput("\x1b"); h.panelInput("n"); h.panelInput("Draft captured earlier"); h.panelInput("\r");
    expect(output()).toContain("Preferences · 1 selected");
    h.panelInput("q"); await view;
    await h.command("optimize New explicit request", h.context); await flushPromises();
    const packet = (index: number) => JSON.parse((h.complete.mock.calls[index] as any[])[1].messages[0].content[0].text);
    expect(packet(0).editing_instruction).toBe(`Saved editing requirements (manually selected):\n${manual.body}`);

    view = h.command("view", h.context);
    h.panelInput("p"); await vi.waitFor(() => expect(output()).toContain("[x] Session item"));
    find(manual.name); h.panelInput(" "); expect(output()).toContain("0 selected");
    h.panelInput("\x1b"); h.panelInput("q"); await view;
    await h.command("optimize Changed session selection", h.context); await flushPromises();
    expect(packet(1).editing_instruction).toBeUndefined();
    view = h.command("", h.context);
    const draftVisible = () => output().includes("› ○ Unsent");
    for (let i = 0; i < 5 && !draftVisible(); i++) h.panelInput("\x1b[B");
    expect(draftVisible()).toBe(true);
    h.panelInput("\r"); await flushPromises(); expect(packet(2).editing_instruction).toContain(manual.body);
    h.panelInput("q"); await view;

    const sessionId = vi.spyOn(h.context.sessionManager, "getSessionId");
    for (const [id, marker] of [["session-two", "[x]"], ["session-one", "[ ]"]]) {
      h.handlers.get("session_before_switch")![0]!({}, h.context);
      sessionId.mockReturnValue(id!);
      await h.handlers.get("session_start")![0]!({ reason: "resume" }, h.context);
      view = h.command("", h.context);
      h.panelInput("p"); await vi.waitFor(() => expect(output()).toContain(`${marker} * Inherited item`));
      h.panelInput("\x1b"); h.panelInput("q"); await view;
    }
  });

  it("changes future session choices after a send without changing the adopted audit", async () => {
    const h = await makeHarness(); const store = new PreferenceStore(h.agentDir, h.context.cwd);
    const old = await store.save("project", { name: "Adopted item", body: "Original adopted requirement." });
    await store.setProjectDefault(old, true); await h.reload();
    await h.command("optimize Previous prompt", h.context); await flushPromises();
    h.holdPanel(); let view = h.command("view", h.context);
    h.panelInput("s"); await view;
    expect(h.sent).toHaveLength(1);
    h.handlers.get("message_start")![0]!({ message: { role: "user", content: h.sent[0]!.text } }, h.context);

    view = h.command("", h.context);
    const output = () => h.panelLines(100).join("\n");
    h.panelInput("p"); await vi.waitFor(() => expect(output()).toContain("[x] * Adopted item"));
    expect(output()).toContain("Preferences · This session");
    h.panelInput(" "); expect(output()).toContain("[ ] * Adopted item");
    h.panelInput("\x1b"); h.panelInput("\x1b[C"); h.panelInput("p");
    await vi.waitFor(() => expect(output()).toContain("[x] * Adopted item"));
    expect(output()).toContain("Adopted preferences");
    h.panelInput(" "); expect(output()).toContain("[x] * Adopted item");
    h.panelInput("\r"); expect(output()).toContain(old.body);
    expect(h.complete).toHaveBeenCalledTimes(1); expect(h.sent).toHaveLength(1);
    h.panelInput("\x1b"); h.panelInput("\x1b"); h.panelInput("q"); await view;
  });

  it("loads defaults after resume and clears them for the draft without a separate confirmation", async () => {
    const h = await makeHarness(); const store = new PreferenceStore(h.agentDir, h.context.cwd);
    const entry = await store.save("global", { name: "Resumed default", body: "Keep task scope." });
    await store.setProjectDefault(entry, true); await h.reload("resume");
    h.holdPanel(); const view = h.command("", h.context);
    h.panelInput("n"); h.panelInput("Resumed draft"); h.panelInput("\r");
    const output = () => h.panelLines(100).join("\n");
    expect(output()).toContain("Preferences · 1 selected");
    h.panelInput("p"); await vi.waitFor(() => expect(output()).not.toContain("Working…"));
    h.panelInput("c"); expect(output()).toContain("0 selected");
    h.panelInput("\x1b");
    expect(output()).toContain("Preferences · 0 selected");
    // Reopening and library refresh cannot reapply defaults to this existing draft.
    h.panelInput("p"); await vi.waitFor(() => expect(output()).not.toContain("Working…"));
    expect(output()).toContain("0 selected"); h.panelInput("\x1b");
    expect(h.complete).not.toHaveBeenCalled();
    h.panelInput("\r"); await flushPromises();
    const packet = JSON.parse((h.complete.mock.calls[0] as any[])[1].messages[0].content[0].text);
    expect(packet.editing_instruction).toBeUndefined();
    expect((await store.load()).projectDefaults).toEqual([preferenceKey(entry)]);
    h.panelInput("q"); await view;
  });

  it("uses configured project defaults on the first shortcut run", async () => {
    const h = await makeHarness();
    const store = new PreferenceStore(h.agentDir, h.context.cwd);
    const entry = await store.save("global", { name: "Shortcut default", body: "Keep commands literal." });
    await store.setProjectDefault(entry, true); await h.reload();
    h.setCustomAction("q");
    await shortcut(h, "ctrl+\\")(h.context);
    await flushPromises();
    expect(h.complete).toHaveBeenCalledTimes(1);
    const packet = JSON.parse((h.complete.mock.calls[0] as any[])[1].messages[0].content[0].text);
    expect(packet).toMatchObject({ draft: "Draft A", editing_instruction: `Saved editing requirements (project default):\n${entry.body}` });
    expect(h.editorWrites).toEqual([]); expect(h.sent).toEqual([]);
  });

  it("can clear over-limit inherited requirements before any request is sent", async () => {
    const h = await makeHarness({ config: { maxDraftChars: 100 } });
    const store = new PreferenceStore(h.agentDir, h.context.cwd);
    const entry = await store.save("project", { name: "Long default", body: "Long instructions. ".repeat(20) });
    await store.setProjectDefault(entry, true); await h.reload();
    h.setEditorText("Short task"); h.holdPanel(); const view = shortcut(h, "ctrl+\\")(h.context);
    const output = () => h.panelLines(100).join("\n");
    expect(output()).toContain("Preferences · 1 selected");
    expect(h.notifications.some((notice) => notice.includes("Project defaults exceed"))).toBe(true);
    h.panelInput("\r"); await flushPromises(); expect(h.complete).not.toHaveBeenCalled();
    h.panelInput("p"); await vi.waitFor(() => expect(output()).toContain("Too long"));
    h.panelInput("c"); h.panelInput("\x1b");
    h.panelInput("\r"); await flushPromises(); expect(h.complete).toHaveBeenCalledTimes(1);
    h.panelInput("q"); await view;
  });

  it("keeps an existing snapshot after disabling its default, while new explicit requests use the new setting", async () => {
    const h = await makeHarness(); const store = new PreferenceStore(h.agentDir, h.context.cwd);
    const entry = await store.save("project", { name: "Toggle off", body: "Keep literal input." });
    await store.setProjectDefault(entry, true); await h.reload();
    h.holdPanel(); const view = h.command("", h.context);
    h.panelInput("n"); h.panelInput("Captured with default"); h.panelInput("\r");
    const output = () => h.panelLines(100).join("\n");
    h.panelInput("p"); await vi.waitFor(() => expect(output()).not.toContain("Working…"));
    h.panelInput("l"); h.panelInput("g"); await vi.waitFor(() => expect(output()).toContain("Project default disabled"));
    h.panelInput("\x1b"); h.panelInput("\x1b"); expect(output()).toContain("Preferences · 1 selected");
    h.panelInput("\r"); await flushPromises();
    const frozen = JSON.parse((h.complete.mock.calls[0] as any[])[1].messages[0].content[0].text);
    expect(frozen.editing_instruction).toContain(entry.body);
    h.panelInput("q"); await view;
    h.setEditorText("New explicit request"); await h.command("optimize", h.context); await flushPromises();
    const next = JSON.parse((h.complete.mock.calls[1] as any[])[1].messages[0].content[0].text);
    expect(next.editing_instruction).toBeUndefined();
  });
});
