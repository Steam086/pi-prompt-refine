import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { extensionHarnessEnvironment, panelAction, refinement, trigger } from "../support/extension-harness.js";
import { flushPromises } from "../support/helpers.js";

const { makeHarness } = extensionHarnessEnvironment();

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
