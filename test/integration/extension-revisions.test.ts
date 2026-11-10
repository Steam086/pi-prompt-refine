import { describe, expect, it, vi } from "vitest";
import { extensionHarnessEnvironment, projectConfig, refinement, resourcePrompt, trigger } from "../support/extension-harness.js";
import { flushPromises } from "../support/helpers.js";

const { makeHarness } = extensionHarnessEnvironment();

describe("explicit candidate revision", () => {

  it("shows completed revision details with original task, instruction and before-revision text", async () => {
    const harness = await makeHarness();
    harness.complete.mockResolvedValueOnce(refinement("BEFORE_REVISION_TEXT")); await trigger(harness);
    harness.holdPanel(); const view = harness.command("view", harness.context);
    harness.panelInput("f"); harness.panelInput("Keep literal commands.");
    harness.complete.mockResolvedValueOnce(refinement("AFTER_REVISION_TEXT"));
    harness.panelInput("\x13"); await flushPromises();
    expect(harness.panelLines(100).join("\n")).toContain("Revised prompt");
    let all = "";
    for (let i = 0; i < 5; i++) { all += harness.panelLines(100).join("\n"); harness.panelInput("\x1b[6~"); }
    for (const expected of ["AFTER_REVISION_TEXT", "Original draft", "Draft A", "Revision instruction", "Keep literal commands.", "Before revision", "BEFORE_REVISION_TEXT"]) expect(all).toContain(expected);
    harness.panelInput("o"); expect(harness.panelLines(100).join("\n")).toContain("Draft A");
    harness.panelInput("q"); await view;
    const usage = harness.command("usage", harness.context);
    harness.panelInput("\r");
    expect(harness.panelLines(100).join("\n")).toContain("Revision of run #1");
    all = "";
    for (let i = 0; i < 6; i++) { all += harness.panelLines(100).join("\n"); harness.panelInput("\x1b[6~"); }
    for (const expected of ["Original prompt", "Draft A", "Keep literal commands.", "BEFORE_REVISION_TEXT"]) expect(all).toContain(expected);
    harness.panelInput("\x1b"); harness.panelInput("\x1b"); harness.panelInput("q"); await usage;
    expect(harness.complete).toHaveBeenCalledTimes(2); expect(harness.sent).toEqual([]); expect(harness.editorWrites).toEqual([]);
  });

  it("does not attach a failed revision's instructions to the retained result", async () => {
    const harness = await makeHarness(); await trigger(harness);
    harness.holdPanel(); const view = harness.command("view", harness.context);
    harness.panelInput("f"); harness.panelInput("FAILED_REVISION_INSTRUCTION");
    harness.complete.mockRejectedValueOnce(new Error("offline"));
    harness.panelInput("\x13"); await flushPromises();
    let all = "";
    for (let i = 0; i < 5; i++) { all += harness.panelLines(100).join("\n"); harness.panelInput("\x1b[6~"); }
    expect(all).toContain("previous result kept"); expect(all).toContain("Refined prompt");
    expect(all).not.toContain("Revised prompt"); expect(all).not.toContain("FAILED_REVISION_INSTRUCTION");
    harness.panelInput("q"); await view;
  });
  it("opens list Revise for the selected run and returns through its details without sending", async () => {
    const harness = await makeHarness(); await trigger(harness);
    harness.holdPanel(); const view = harness.command("", harness.context);
    // Select the run rather than the original root.
    if (harness.panelLines(100).join("\n").includes("› ▾")) harness.panelInput("\x1b[B");
    harness.panelInput("f");
    expect(harness.panelLines(100).join("\n")).toContain("Run #1");
    harness.panelInput("Retain this feedback"); harness.panelInput("\x1b");
    expect(harness.panelLines(100).join("\n")).toContain("Prompt details");
    harness.panelInput("f"); expect(harness.panelLines(100).join("\n")).toContain("Retain this feedback");
    harness.panelInput("\x1b"); harness.panelInput("\x1b");
    expect(harness.panelLines(100).join("\n")).toContain("Prompt refine · Tasks");
    expect(harness.complete).toHaveBeenCalledTimes(1);
    expect(harness.editorWrites).toEqual([]); expect(harness.sent).toEqual([]);
    harness.panelInput("q"); await view;
  });
  it("revises inline in Usage inspection, preserving the source viewport and explicit submit", async () => {
    const harness = await makeHarness();
    harness.complete.mockResolvedValueOnce(refinement("Source result\n" + Array.from({ length: 80 }, (_, i) => `Source line ${i}`).join("\n")));
    await trigger(harness);
    harness.holdPanel();
    const view = harness.command("usage", harness.context);
    harness.panelInput("\r");
    harness.panelInput("\x1b[6~");
    const before = harness.panelLines(100);
    harness.panelInput("f");
    // Reference content keeps its viewport; only suspended navigation chrome changes.
    expect(harness.panelLines(100).slice(9, 13)).toEqual(before.slice(9, 13));
    const referenceHeader = harness.panelLines(100).slice(0, 9).join("\n");
    expect(referenceHeader).toContain("Read-only reference");
    for (const hint of ["↑↓ scroll", "a Accept", "s Send to Pi", "p Preferences", "i Edit original", "f Revise"]) {
      expect(referenceHeader).not.toContain(hint);
    }
    expect(harness.panelLines(100).join("\n")).toContain("Run #1");
    harness.panelInput("Shorter");
    harness.panelInput("\r");
    harness.panelInput("Keep constraints");
    expect(harness.complete).toHaveBeenCalledTimes(1);
    harness.panelInput("\x05"); // Expand, preserving the draft.
    expect(harness.panelLines(100).join("\n")).toContain("Shorter");
    harness.panelInput("\x05");
    harness.panelInput("\x1b");
    expect(harness.panelLines(100)).toEqual(before);
    harness.panelInput("f");
    expect(harness.panelLines(100).join("\n")).toContain("Keep constraints");
    harness.panelInput("\x13");
    await flushPromises();
    const packet = JSON.parse((harness.complete.mock.calls[1] as any[])[1].messages[0].content[0].text);
    expect(packet.revision_instruction).toBe("Shorter\nKeep constraints");
    expect(harness.sent).toEqual([]);
    expect(harness.editorWrites).toEqual([]);
    harness.panelInput("q");
    await view;
  });

  it("revises the latest candidate while preserving the original task and keeping Input independent", async () => {
    const harness = await makeHarness();
    await trigger(harness);
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    expect(harness.panelLines(100).join("\n")).toContain("f Revise");
    harness.panelInput("i");
    harness.panelInput("Separate new draft");
    harness.panelInput("\x1b");
    harness.panelInput("f");
    expect(harness.panelLines().join("\n")).toContain("Revise current result");
    expect(harness.panelLines().join("\n")).not.toContain("Separate new draft");
    harness.panelInput("再短一点，命令原样保留。");
    harness.setEditorText("Unrelated main editor changes");
    harness.complete.mockResolvedValueOnce({ content: [{ type: "text", text: JSON.stringify({ prompt: "Second result" }) }], stopReason: "stop" });
    harness.panelInput("\x13");
    await flushPromises();
    const packet = JSON.parse((harness.complete.mock.calls[1] as any[])[1].messages[0].content[0].text);
    expect(packet).toMatchObject({ operation: "revise", original_draft: "Draft A", previous_candidate: "Refined prompt", revision_instruction: "再短一点，命令原样保留。" });
    expect(packet).not.toHaveProperty("draft");
    expect(packet.conversation.items).toHaveLength(2);
    expect(harness.editorWrites).toEqual([]);
    expect(harness.sent).toEqual([]);
    expect(harness.panelLines().join("\n")).toContain("Second result");
    harness.panelInput("f");
    expect(harness.panelLines().join("\n")).not.toContain("再短一点");
    harness.panelInput("Use bullet points");
    harness.complete.mockResolvedValueOnce({ content: [{ type: "text", text: JSON.stringify({ prompt: "Third result" }) }], stopReason: "stop" });
    harness.panelInput("\x13");
    await flushPromises();
    const next = JSON.parse((harness.complete.mock.calls[2] as any[])[1].messages[0].content[0].text);
    expect(next).toMatchObject({ operation: "revise", original_draft: "Draft A", previous_candidate: "Second result", revision_instruction: "Use bullet points",
      historical_editing_context: { previous_revision_instruction: "再短一点，命令原样保留。" } });
    expect(JSON.stringify(next)).not.toContain("Refined prompt");
    harness.panelInput("i");
    expect(harness.panelLines().join("\n")).toContain("Separate new draft");
    harness.panelInput("\x1b");
    harness.panelInput("a");
    await view;
    await flushPromises();
    expect(harness.context.ui.confirm).toHaveBeenCalled();
    expect(harness.getEditor()).toBe("Third result");
  });

  it("retains empty/oversized feedback and rejects a source changed during editing", async () => {
    const harness = await makeHarness({ config: { maxDraftChars: 30 } });
    await trigger(harness);
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    harness.panelInput("f");
    harness.panelInput("\x13");
    expect(harness.panelLines().join("\n")).toContain("Select preferences or enter additional requirements");
    harness.panelInput("x".repeat(31));
    harness.panelInput("\x13");
    expect(harness.panelLines().join("\n")).toContain("exceed");
    expect(harness.complete).toHaveBeenCalledTimes(1);
    harness.panelInput("\x1b");
    harness.panelInput("f");
    expect(harness.panelLines().join("\n")).toContain("x".repeat(31));
    await harness.command("optimize New task", harness.context);
    await flushPromises();
    harness.panelInput("\x13");
    expect(harness.panelLines().join("\n")).toContain("result changed");
    expect(harness.complete).toHaveBeenCalledTimes(2);
    expect(harness.editorWrites).toEqual([]);
    harness.panelInput("\x1b");
    harness.panelInput("q");
    await view;
  });

  it("keeps the previous result on failure and permits an explicit revision retry", async () => {
    const harness = await makeHarness();
    await trigger(harness);
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    harness.panelInput("f");
    harness.panelInput("Shorter");
    harness.complete.mockRejectedValueOnce(new Error("offline"));
    harness.panelInput("\x13");
    await flushPromises();
    expect(harness.panelLines().join("\n")).toContain("previous result kept");
    expect(harness.panelLines().join("\n")).toContain("Refined prompt");
    harness.panelInput("f");
    expect(harness.panelLines().join("\n")).toContain("Shorter");
    harness.panelInput("\x13");
    await flushPromises();
    expect(harness.complete).toHaveBeenCalledTimes(3);
    expect(JSON.parse((harness.complete.mock.calls[2] as any[])[1].messages[0].content[0].text).revision_instruction).toBe("Shorter");
    expect(harness.editorWrites).toEqual([]);
    harness.panelInput("q");
    await view;
  });

  it("keeps round Context frozen across settings changes and revisions", async () => {
    const harness = await makeHarness({ config: { projectContext: projectConfig(false) } });
    vi.spyOn(harness.context, "getSystemPrompt").mockReturnValue(resourcePrompt());
    await trigger(harness);
    await vi.waitFor(() => expect(harness.widgetLines().join("\n")).toContain("1 new"));
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    harness.panelInput("\x1b[D");
    harness.panelInput(" "); // Disable project instructions for the next round.
    harness.panelInput("\x13");
    await vi.waitFor(() => expect(harness.panelLines().join("\n")).toContain("Settings saved"));
    harness.panelInput("\r"); // Inspect the selected result before revising.
    harness.panelInput("f");
    harness.panelInput("Shorter");
    harness.panelInput("\x13");
    await vi.waitFor(() => expect(harness.complete).toHaveBeenCalledTimes(2));
    const first = JSON.parse((harness.complete.mock.calls[0] as any[])[1].messages[0].content[0].text);
    const revision = JSON.parse((harness.complete.mock.calls[1] as any[])[1].messages[0].content[0].text);
    expect(first.project_context).toContain("Use the project venv.");
    expect(revision.project_context).toContain("Use the project venv.");
    expect(revision.conversation).toEqual(first.conversation);
    harness.panelInput("q");
    harness.panelInput("q");
    await view;
  });

  it("blocks revision while delivery is pending", async () => {
    const harness = await makeHarness();
    await trigger(harness);
    harness.holdPanel();
    let view = harness.command("view", harness.context);
    harness.panelInput("s");
    await view;
    expect(harness.sent).toHaveLength(1);
    view = harness.command("view", harness.context);
    harness.panelInput("f");
    expect(harness.panelLines().join("\n")).not.toContain("Revise current result");
    expect(harness.panelLines(100).slice(-2).join("\n")).not.toContain("f Revise");
    harness.panelInput("q");
    await view;
    expect(harness.complete).toHaveBeenCalledTimes(1);
  });

  it("does not offer revision for an empty workflow or accepted read-only snapshot", async () => {
    const harness = await makeHarness();
    harness.holdPanel();
    let view = harness.command("view", harness.context);
    harness.panelInput("f");
    expect(harness.panelLines().join("\n")).not.toContain("Revise current result");
    harness.panelInput("q");
    await view;
    await trigger(harness);
    view = harness.command("view", harness.context);
    harness.panelInput("a");
    await view;
    view = harness.command("view", harness.context);
    harness.panelInput("f");
    expect(harness.panelLines().join("\n")).not.toContain("Revise current result");
    expect(harness.panelLines(100).slice(-2).join("\n")).not.toContain("f Revise");
    harness.panelInput("q");
    await view;
    expect(harness.complete).toHaveBeenCalledTimes(1);
  });
});
