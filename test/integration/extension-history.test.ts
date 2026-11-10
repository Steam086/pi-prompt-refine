import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { extensionHarnessEnvironment, refinement, shortcut, trigger, type Harness } from "../support/extension-harness.js";
import { flushPromises } from "../support/helpers.js";

const { makeHarness } = extensionHarnessEnvironment();

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
