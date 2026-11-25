import { describe, expect, it, vi } from "vitest";
import { PreferenceStore } from "../../src/preference-store.js";
import { preferenceKey } from "../../src/revision-preferences.js";
import { extensionHarnessEnvironment, refinement, shortcut } from "../support/extension-harness.js";
import { advanceMicrotaskTurns } from "../support/helpers.js";

const { makeHarness } = extensionHarnessEnvironment();

describe("project defaults through the extension", () => {
  it("keeps changed defaults out of revisions and same-input retries, but uses them for an explicit copy", async () => {
    const h = await makeHarness(); const store = new PreferenceStore(h.agentDir, h.context.cwd);
    const initial = await store.save("project", { name: "Initial", body: "Initial requirement." });
    const future = await store.save("global", { name: "Future", body: "Future drafts only." });
    await store.setProjectDefault(initial, true); await h.reload();
    h.setEditorText("Original task"); await h.command("optimize", h.context); await advanceMicrotaskTurns();
    h.holdPanel(); let view = h.command("", h.context);
    const output = () => h.panelLines(100).join("\n");
    const packet = (index: number) => JSON.parse((h.complete.mock.calls[index] as any[])[1].messages[0].content[0].text);
    h.panelInput("p"); await vi.waitFor(() => expect(output()).not.toContain("Working…"));
    h.panelInput("l"); h.panelInput("g"); await vi.waitFor(() => expect(output()).toContain("Project default disabled"));
    h.panelInput("\x1b[B"); h.panelInput("g"); await vi.waitFor(() => expect(output()).toContain("Project default enabled"));
    h.panelInput("\x1b");
    h.panelInput("f"); h.panelInput("Remove the initial requirement.");
    h.complete.mockResolvedValueOnce(refinement("Task without initial requirement."));
    h.panelInput("\x13"); await advanceMicrotaskTurns();
    expect(h.complete).toHaveBeenCalledTimes(2);
    expect(packet(1).revision_instruction).toBe("Remove the initial requirement.");
    expect(packet(1).editing_instruction).toBeUndefined();
    expect(packet(1).historical_editing_context.initial_instruction).toBe(`Saved editing requirements (project default):\n${initial.body}`);
    expect(JSON.stringify(packet(1))).not.toContain(future.body);
    h.panelInput("q"); await view; view = h.command("", h.context);
    h.panelInput("m"); await advanceMicrotaskTurns();
    expect(output()).toContain("Run original with another model");
    h.panelInput("\r"); await vi.waitFor(() => expect(h.complete).toHaveBeenCalledTimes(3));
    expect(packet(2).editing_instruction).toBe(`Saved editing requirements (project default):\n${initial.body}`);
    expect(JSON.stringify(packet(2))).not.toContain(future.body);
    h.panelInput("i"); h.panelInput("\r");
    expect(output()).toContain("Preferences · 1 selected");
    h.panelInput("\r"); await advanceMicrotaskTurns();
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
    h.panelInput("l"); h.panelInput("g"); await vi.waitFor(() => expect(output()).toContain("Project default enabled"));
    expect((await store.load()).projectDefaults).toEqual([preferenceKey(entry)]);
    h.panelInput("\x1b"); h.panelInput("\x1b"); expect(output()).toContain("Preferences · 0 selected");
    expect(h.complete).not.toHaveBeenCalled(); expect(h.editorWrites).toEqual([]); expect(h.sent).toEqual([]);
    h.panelInput("q"); await view;

    view = h.command("", h.context);
    h.panelInput("n"); h.panelInput("One request without defaults"); h.panelInput("\r");
    expect(output()).toContain("Preferences · 1 selected");
    h.panelInput("\t"); await vi.waitFor(() => expect(output()).not.toContain("Loading preferences…"));
    h.panelInput("c"); expect(output()).toContain("Selected · 0");
    h.panelInput("\r"); await advanceMicrotaskTurns();
    expect(h.complete).toHaveBeenCalledTimes(1);
    const first = JSON.parse((h.complete.mock.calls[0] as any[])[1].messages[0].content[0].text);
    expect(first.draft).toBe("One request without defaults");
    expect(first.editing_instruction).toBeUndefined();
    h.panelInput("q"); await view;

    h.setEditorText("Following request"); view = shortcut(h, "ctrl+\\")(h.context);
    expect(output()).toContain("Preferences · 1 selected");
    h.panelInput("\r"); await advanceMicrotaskTurns();
    expect(h.complete).toHaveBeenCalledTimes(2);
    const next = JSON.parse((h.complete.mock.calls[1] as any[])[1].messages[0].content[0].text);
    expect(next.editing_instruction).toBe(`Saved editing requirements (project default):\n${entry.body}`);
    expect((await store.load()).projectDefaults).toEqual([preferenceKey(entry)]);
    expect(h.editorWrites).toEqual([]); expect(h.sent).toEqual([]);
    h.panelInput("q"); await view;
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
    h.panelInput("p"); await vi.waitFor(() => expect(output()).not.toContain("Working…"));
    expect(output()).toContain("0 selected"); h.panelInput("\x1b");
    expect(h.complete).not.toHaveBeenCalled();
    h.panelInput("\r"); await advanceMicrotaskTurns();
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
    await advanceMicrotaskTurns();
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
    h.panelInput("\r"); await advanceMicrotaskTurns(); expect(h.complete).not.toHaveBeenCalled();
    h.panelInput("p"); await vi.waitFor(() => expect(output()).toContain("Too long"));
    h.panelInput("c"); h.panelInput("\x1b");
    h.panelInput("\r"); await advanceMicrotaskTurns(); expect(h.complete).toHaveBeenCalledTimes(1);
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
    h.panelInput("\r"); await advanceMicrotaskTurns();
    const frozen = JSON.parse((h.complete.mock.calls[0] as any[])[1].messages[0].content[0].text);
    expect(frozen.editing_instruction).toContain(entry.body);
    h.panelInput("q"); await view;
    h.setEditorText("New explicit request"); await h.command("optimize", h.context); await advanceMicrotaskTurns();
    const next = JSON.parse((h.complete.mock.calls[1] as any[])[1].messages[0].content[0].text);
    expect(next.editing_instruction).toBeUndefined();
  });
});
