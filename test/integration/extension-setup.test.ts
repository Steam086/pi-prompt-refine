import type { Api, Model } from "@earendil-works/pi-ai";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { modelPickerItems } from "../../src/extension.js";
import { extensionHarnessEnvironment } from "../support/extension-harness.js";

const { makeHarness } = extensionHarnessEnvironment();

describe("startup hint", () => {
  it.each([
    ["ctrl+\\", "Ctrl + \\"],
    ["alt+r", "alt + r"],
    [null, "/refine optimize"],
  ] as const)("uses the configured optimize binding %s", async (optimize, label) => {
    const harness = await makeHarness({ config: { shortcuts: { ...DEFAULT_CONFIG.shortcuts, optimize } } });
    expect(harness.notifications).toEqual([`Prompt Refine: Use ${label} to refine your prompt.`]);
    for (const reason of ["new", "resume", "fork"]) {
      harness.handlers.get("session_start")?.[0]?.({ reason }, harness.context);
    }
    await harness.reload();
    expect(harness.notifications).toHaveLength(1);
    expect(harness.complete).not.toHaveBeenCalled();
    expect(harness.editorWrites).toEqual([]);
  });

  it.each(["rpc", "print"] as const)("stays silent in %s mode", async (mode) => {
    const harness = await makeHarness({ mode });
    expect(harness.notifications).toEqual([]);
  });
});

describe("first optimizer model setup", () => {
  it("guides a fresh install without borrowing the main model or starting a request", async () => {
    const harness = await makeHarness({ freshInstall: true });
    expect(harness.notifications).toEqual([expect.stringContaining("No optimizer model selected")]);
    expect(harness.notifications[0]).toContain("/refine model");
    harness.handlers.get("session_start")?.[0]?.({ reason: "new" }, harness.context);
    expect(harness.notifications).toHaveLength(1);
    harness.holdPanel();
    const view = harness.command("view", harness.context);
    expect(harness.panelLines().join("\n")).toContain("Choose one with m or /refine model.");
    expect(harness.panelLines().join("\n")).not.toContain("No result yet.");
    expect(harness.complete).not.toHaveBeenCalled();
    harness.panelInput("q");
    await view;
    expect(harness.editorWrites).toEqual([]);
  });

  it("persists the first selection and gives a usable next step without auto-refining", async () => {
    const harness = await makeHarness({ freshInstall: true });
    harness.setCustomAction("\r");
    await harness.command("model", harness.context);
    const saved = JSON.parse(await readFile(join(harness.agentDir, "prompt-refine.json"), "utf8"));
    expect(saved.model).toEqual({ provider: "fake-provider", id: "fake-chat" });
    expect(harness.notifications.at(-1)).toContain("Use /refine <text> to start.");
    expect(harness.complete).not.toHaveBeenCalled();
    harness.notifications.length = 0;
    await harness.reload();
    expect(harness.notifications).toEqual([]);
  });

  it("keeps setup intact on cancel and reports when no authorized models exist", async () => {
    const harness = await makeHarness({ configureModel: false });
    harness.setCustomAction("\x1b");
    await harness.command("model", harness.context);
    expect(JSON.parse(await readFile(join(harness.agentDir, "prompt-refine.json"), "utf8"))).not.toHaveProperty("model");
    vi.mocked(harness.context.modelRegistry.getAvailable).mockReturnValue([]);
    await harness.command("model", harness.context);
    expect(harness.notifications.at(-1)).toContain("Configure a model and authentication in Pi first");
    expect(harness.complete).not.toHaveBeenCalled();
  });

  it("revalidates model availability when the picker closes", async () => {
    const harness = await makeHarness({ configureModel: false });
    harness.holdPanel();
    const picker = harness.command("model", harness.context);
    vi.mocked(harness.context.modelRegistry.getAvailable).mockReturnValue([]);
    harness.panelInput("\r");
    await picker;
    expect(harness.notifications.at(-1)).toContain("no longer available");
    const saved = JSON.parse(await readFile(join(harness.agentDir, "prompt-refine.json"), "utf8"));
    expect(saved).not.toHaveProperty("model");
    expect(saved.modelThinkingLevels).toEqual({});
  });

  it("does not claim a failed first selection save was persisted", async () => {
    const harness = await makeHarness({ configureModel: false });
    const path = join(harness.agentDir, "prompt-refine.json");
    await rm(path);
    await mkdir(path);
    harness.setCustomAction("\r");
    await harness.command("model", harness.context);
    expect(harness.notifications.at(-1)).toContain("current process only; not saved");
    expect(harness.complete).not.toHaveBeenCalled();
  });

  it("does not show TUI setup hints in non-interactive mode", async () => {
    const harness = await makeHarness({ configureModel: false, mode: "print" });
    expect(harness.notifications).toEqual([]);
    expect(harness.complete).not.toHaveBeenCalled();
  });
});

describe("optimizer model picker", () => {
  const thinking = { provider: "fake-provider", id: "reasoner", name: "Reasoner", reasoning: true } as Model<Api>;
  const plain = { provider: "other", id: "plain", name: "Plain Chat", reasoning: false } as Model<Api>;

  it("keeps both reasoning and ordinary models when no search is entered", () => {
    const items = modelPickerItems([thinking, plain], "", thinking);
    expect(items.map((item) => item.value)).toEqual(["fake-provider/reasoner", "other/plain"]);
    expect(items[0]?.label).toBe("fake-provider/reasoner [thinking] (current)");
    expect(items[1]?.label).toBe("other/plain");
  });

  it.each(["thinking", "THINKING", "reasoning", "思考", "推理"])("searches reasoning capability using %s", (query) => {
    expect(modelPickerItems([thinking, plain], query).map((item) => item.value)).toEqual(["fake-provider/reasoner"]);
  });

  it("preserves provider, ID, and display-name searches", () => {
    expect(modelPickerItems([thinking, plain], "FAKE-PROVIDER")).toHaveLength(1);
    expect(modelPickerItems([thinking, plain], "reasoner")[0]?.value).toBe("fake-provider/reasoner");
    expect(modelPickerItems([thinking, plain], "plain chat")[0]?.value).toBe("other/plain");
    expect(modelPickerItems([thinking, plain], "missing")).toEqual([]);
  });
});
