import { describe, expect, it, vi } from "vitest";
import type { Hello, RunDetail } from "../../src/app/api.js";
import { requireValue, wireMutation, wireRequest } from "../support/application-wire.js";
import { extensionHarnessEnvironment, refinement, type Harness } from "../support/extension-harness.js";
import { deferred, flushPromises } from "../support/helpers.js";

const { makeHarness } = extensionHarnessEnvironment();
const receiptText = {
  started: "Refine started a background rewrite.",
  queued: "Refine queued a background rewrite.",
  duplicate: "Refine already has a rewrite run for this draft.",
};

async function admit(h: Harness, args: string, outcome: keyof typeof receiptText = "started"): Promise<string> {
  await h.command(args, h.context);
  const notice = h.notifications.at(-1)!;
  const prefix = `${receiptText[outcome]} The result opens automatically. To reopen, use /refine result `;
  expect(notice.startsWith(prefix)).toBe(true);
  const id = notice.slice(prefix.length);
  expect(id).toMatch(/^run-\d+@[a-f0-9-]{36}\.\d+$/);
  return id;
}

const show = (h: Harness, id: string) => h.command(`result ${id}`, h.context);
const nextPreview = () => vi.advanceTimersByTimeAsync(250);
const rawId = (id: string) => id.split("@")[0]!;
const hello = async (h: Harness) => requireValue(await wireRequest<Hello>(h.events, { action: "hello", clientId: "rpc-check" }));

function expectNoWrites(h: Harness) {
  expect(h.editorWrites).toEqual([]);
  expect(h.sent).toEqual([]);
  expect(h.internalMessages).toEqual([]);
  expect(h.sessionWrites).toEqual([]);
  expect(h.customCalls()).toBe(0);
}

describe("/refine RPC", () => {
  it.each(["", "optimize", "optimize \t\n", "result", "result run-1", "view", "arbitrary text", "optimizer select"])(
    "shows usage for %j without reading the draft or requesting a model", async (args) => {
      const h = await makeHarness({ mode: "rpc" });
      const readDraft = vi.spyOn(h.context.ui, "getEditorText");
      await h.command(args, h.context);
      expect(h.notifications.at(-1)).toMatch(/^Usage:/);
      expect(h.context.ui.editor).not.toHaveBeenCalled();
      expect(h.complete).not.toHaveBeenCalled();
      expect(readDraft).not.toHaveBeenCalled();
      expectNoWrites(h);
    },
  );

  it("consumes RPC slash forms that Pi's space-only command splitter misses, without matching /refine-api", async () => {
    const h = await makeHarness({ mode: "rpc" });
    const input = (text: string) => h.handlers.get("input")![0]!({ type: "input", source: "rpc", text }, h.context);
    expect(await input("/refine\tinvalid")).toEqual({ action: "handled" });
    expect(h.notifications.at(-1)).toMatch(/^Usage:/);
    expect(await input("/refine-api status")).toBeUndefined();
    expect(await input("/refinement")).toBeUndefined();
    h.setEditorText("Not the draft to optimize");
    const draft = "\n  中文\r\n\n````md\n```\n```\n````  \n";
    expect(await input(`/refine\noptimize\r\n${draft}`)).toEqual({ action: "handled" });
    await vi.waitFor(() => expect(h.complete).toHaveBeenCalledTimes(1));
    expect(JSON.parse(h.complete.mock.calls[0]![1].messages[0].content[0].text).draft).toBe(draft);
    expectNoWrites(h);
  });

  it.each([
    { options: { configureModel: false }, code: "no-model" },
    { options: { noAvailableModels: true }, code: "model-unavailable" },
    { options: { config: { maxDraftChars: 4 } }, code: "too-long" },
  ])("reports $code without launching or opening a view", async ({ options, code }) => {
    const h = await makeHarness({ mode: "rpc", ...options });
    await h.command("optimize Example", h.context);
    expect(h.notifications.at(-1)).toContain(`rejected: ${code}`);
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.context.ui.editor).not.toHaveBeenCalled();
    expectNoWrites(h);
  });

  it("announces automatic preview, opens only the candidate text, and reopens without adopting edits or cancellation", async () => {
    const h = await makeHarness({ mode: "rpc", config: { maxOutputTokens: 65_536 } });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = deferred<ReturnType<typeof refinement>>();
    h.complete.mockReturnValueOnce(pending.promise);
    const editor = vi.mocked(h.context.ui.editor);
    const draft = "  Explain this literally.\n\n  ";
    const id = await admit(h, `optimize ${draft}`);
    expect(h.statuses.at(-1)).toBe("Refine · Rewriting in background · Results open automatically");
    await show(h, id);
    expect(h.notifications.at(-1)).toContain("Background rewrite still running.");
    expect(editor).not.toHaveBeenCalled();

    const start = "  中文 😀\n\n````markdown\n```ts\nlet x = 1;\n```\n````\nhttps://example.invalid/";
    const tail = "\n最后一行  \n";
    const result = `${start}${"字".repeat(65_536 * 32 - start.length - tail.length)}${tail}`;
    h.setEditorText("A later composer draft");
    editor.mockResolvedValueOnce("Host-edited text").mockResolvedValueOnce(undefined);
    pending.resolve(refinement(result));
    await flushPromises();
    const ready = h.statuses.at(-1)!;
    expect(ready).toBe(`Refine · Ready: /refine result ${id}`);
    await nextPreview();
    expect(editor).toHaveBeenCalledTimes(1);
    expect(h.getEditor()).toBe("A later composer draft");
    await h.command(ready.split("/refine ")[1]!, h.context);
    expect(editor).toHaveBeenCalledTimes(2);
    for (const [title, text] of editor.mock.calls) {
      expect(title).toBe(`Rewrite result · ${rawId(id)} · Select all to copy · Submit closes without sending`);
      expect(text === result).toBe(true);
    }
    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(JSON.parse(h.complete.mock.calls[0]![1].messages[0].content[0].text).draft).toBe(draft);
    expect(h.getEditor()).toBe("A later composer draft");
    expectNoWrites(h);
  });

  it("reports queued and duplicate receipts and previews out-of-order completions one at a time", async () => {
    const h = await makeHarness({ mode: "rpc" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = Array.from({ length: 5 }, () => deferred<ReturnType<typeof refinement>>());
    for (const result of pending) h.complete.mockReturnValueOnce(result.promise);
    const editor = vi.mocked(h.context.ui.editor);
    const open = deferred<string | undefined>();
    editor.mockReturnValueOnce(open.promise);
    const first = await admit(h, "optimize 1st original");
    const second = await admit(h, "optimize 2nd original");
    await admit(h, "optimize 3rd original");
    await admit(h, "optimize 4th original");
    const fifth = await admit(h, "optimize 5th original", "queued");
    expect(await admit(h, "optimize 5th original", "duplicate")).toBe(fifth);
    expect(await admit(h, "optimize 1st original", "duplicate")).toBe(first);
    await show(h, fifth);
    expect(h.notifications.at(-1)).toContain("Background rewrite still queued.");
    expect(h.complete).toHaveBeenCalledTimes(4);
    expect(h.statuses.at(-1)).toBe("Refine · 4 rewrites in progress · 1 queued · Results open automatically");

    pending[1]!.resolve(refinement("Second result"));
    await vi.waitFor(() => expect(h.complete).toHaveBeenCalledTimes(5));
    await nextPreview();
    expect(h.statuses.at(-1)).toContain(`/refine result ${second}`);
    expect(editor).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(rawId(second)), "Second result");
    pending[0]!.resolve(refinement("First result"));
    pending[4]!.resolve(refinement("Fifth result"));
    await flushPromises();
    await nextPreview();
    expect(editor).toHaveBeenCalledTimes(1);
    open.resolve(undefined);
    await flushPromises();
    await nextPreview();
    await nextPreview();
    expect(editor.mock.calls.map(([, text]) => text)).toEqual(["Second result", "First result", "Fifth result"]);
    expect(h.complete).toHaveBeenCalledTimes(5);
  });

  it("does not stack result editors or replace a pending Pi dialog", async () => {
    const h = await makeHarness({ mode: "rpc" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const id = await admit(h, "optimize Test");
    await flushPromises();
    const ui = vi.mocked(h.context.ui.editor);
    const deferredEditor = deferred<string | undefined>();
    ui.mockReturnValueOnce(deferredEditor.promise);
    await h.handlers.get("ui_prompt_start")![0]!({}, h.context);
    await show(h, id);
    expect(h.notifications.at(-1)).toContain("after the current turn or dialog closes");
    expect(ui).not.toHaveBeenCalled();
    await h.handlers.get("ui_prompt_end")![0]!({}, h.context);
    const open = show(h, id);
    await show(h, id);
    expect(ui).toHaveBeenCalledTimes(1);
    expect(h.notifications.at(-1)).toContain("after the current turn or dialog closes");
    deferredEditor.resolve(undefined);
    await open;
    ui.mockRejectedValueOnce(new Error("private host diagnostic"));
    await show(h, id);
    expect(h.notifications.at(-1)).toBe("Refine: the host could not open the result editor.");
    await show(h, id);
    expect(ui).toHaveBeenCalledTimes(3);
    await nextPreview();
    expect(ui).toHaveBeenCalledTimes(3);
    expect(h.complete).toHaveBeenCalledTimes(1);
    expectNoWrites(h);
  });

  it("keeps the ready command visible and defers opening until Pi and nested dialogs become idle", async () => {
    const h = await makeHarness({ mode: "rpc" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const idle = vi.spyOn(h.context, "isIdle").mockReturnValue(false);
    const id = await admit(h, "optimize Wait for the host");
    await flushPromises();
    expect(h.statuses.at(-1)).toBe(`Refine · Ready: /refine result ${id}`);
    await nextPreview();
    expect(h.context.ui.editor).not.toHaveBeenCalled();

    const event = (name: string) => h.handlers.get(name)![0]!({}, h.context);
    idle.mockReturnValue(true);
    await event("agent_settled");
    await event("ui_prompt_start");
    await event("ui_prompt_start");
    await show(h, id);
    await event("ui_prompt_end");
    await nextPreview();
    expect(h.context.ui.editor).not.toHaveBeenCalled();
    await event("ui_prompt_end");
    await nextPreview();
    expect(h.context.ui.editor).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(rawId(id)), "Refined prompt");
  });

  it("does not reopen a cancelled preview when the host settles again", async () => {
    const h = await makeHarness({ mode: "rpc" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await admit(h, "optimize Existing candidate");
    await nextPreview();
    expect(h.context.ui.editor).toHaveBeenCalledTimes(1);
    for (const handler of h.handlers.get("agent_settled") ?? []) await handler({}, h.context);
    await nextPreview();
    expect(h.context.ui.editor).toHaveBeenCalledTimes(1);
    expect(h.complete).toHaveBeenCalledTimes(1);
  });

  it("reports failure and cancellation once, ignores late completions, and never opens an empty result", async () => {
    const h = await makeHarness({ mode: "rpc" });
    const failed = deferred<ReturnType<typeof refinement>>();
    const cancelled = deferred<ReturnType<typeof refinement>>();
    h.complete.mockReturnValueOnce(failed.promise).mockReturnValueOnce(cancelled.promise);
    const badId = await admit(h, "optimize Fail");
    const stoppedId = await admit(h, "optimize Stop");
    failed.reject(new Error("private provider error"));
    await wireMutation(h.events, await hello(h), { method: "stopRun", runId: rawId(stoppedId) });
    cancelled.resolve(refinement("Do not resurrect"));
    await flushPromises();
    const failures = h.notifications.filter((text) => text.includes(`${badId}: Run error`));
    expect(failures).toHaveLength(1);
    expect(h.notifications.filter((text) => text.includes(`${stoppedId}: Cancelled`))).toHaveLength(1);
    await show(h, badId);
    expect(h.notifications.at(-1)).toBe(failures[0]);
    await show(h, stoppedId);
    expect(h.notifications.at(-1)).toContain("Cancelled.");
    expect(h.notifications.join(" ")).not.toMatch(/private provider error|Do not resurrect/);
    expect(h.context.ui.editor).not.toHaveBeenCalled();
    expect(h.complete).toHaveBeenCalledTimes(2);
  });

  it("reports timeout without retrying, displaying or restoring an expired candidate", async () => {
    const h = await makeHarness({ mode: "rpc", config: { timeoutMs: 1_000 } });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = deferred<ReturnType<typeof refinement>>();
    h.complete.mockReturnValueOnce(pending.promise);
    const id = await admit(h, "optimize Time out");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.notifications.at(-1)).toContain("Run timed out.");
    pending.resolve(refinement("Too late"));
    await flushPromises();
    await show(h, id);
    expect(h.notifications.at(-1)).toContain("Run timed out.");
    expect(h.context.ui.editor).not.toHaveBeenCalled();
    expect(h.complete).toHaveBeenCalledTimes(1);
  });

  it("rejects an unknown or expired receipt even when the same domain run ID is still present", async () => {
    const h = await makeHarness({ mode: "rpc", persistHistory: true });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const id = await admit(h, "optimize First binding");
    await flushPromises();
    await show(h, id.replace(/^run-\d+/, "run-999999"));
    expect(h.notifications.at(-1)).toContain("Unknown Refine result");
    await h.handlers.get("session_tree")![0]!({}, h.context);
    await nextPreview();
    expect(h.statuses.at(-1)).toBeUndefined();
    await show(h, id);
    expect(h.notifications.at(-1)).toContain("expired");
    await h.reload();
    const binding = (await hello(h)).binding;
    expect(requireValue(await wireRequest<RunDetail>(h.events,
      { action: "query", binding, query: { method: "run", runId: rawId(id) } })).text).toBe("Refined prompt");
    await show(h, id);
    expect(h.notifications.at(-1)).toContain("expired");
    expect(h.context.ui.editor).not.toHaveBeenCalled();
    expect(h.complete).toHaveBeenCalledTimes(1);
  });

  it.each(["session_before_switch", "session_shutdown"])("drops pending completion feedback on %s", async (event) => {
    const h = await makeHarness({ mode: "rpc" });
    const pending = deferred<ReturnType<typeof refinement>>();
    h.complete.mockReturnValueOnce(pending.promise);
    await admit(h, "optimize Old session");
    const before = h.notifications.slice();
    await h.handlers.get(event)![0]!({}, h.context);
    pending.reject(new Error("old run"));
    await flushPromises();
    expect(h.notifications).toEqual(before);
    expect(h.statuses.at(-1)).toBeUndefined();
    expect(h.context.ui.editor).not.toHaveBeenCalled();
  });
});
