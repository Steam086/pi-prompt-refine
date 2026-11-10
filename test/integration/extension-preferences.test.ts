import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PreferenceStore } from "../../src/preference-store.js";
import * as preferences from "../../src/revision-preferences.js";
import { extensionHarnessEnvironment, refinement, shortcut, trigger } from "../support/extension-harness.js";
import { flushPromises } from "../support/helpers.js";

const { makeHarness } = extensionHarnessEnvironment();

describe("explicit candidate revision", () => {

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
});
