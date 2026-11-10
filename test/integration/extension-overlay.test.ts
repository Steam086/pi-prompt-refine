import { visibleWidth } from "@earendil-works/pi-tui";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { workspaceHeight } from "../../src/workspace-overlay.js";
import { extensionHarnessEnvironment, trigger } from "../support/extension-harness.js";
import { flushPromises } from "../support/helpers.js";
import { getThemeByName } from "../support/pi-theme.js";

const { makeHarness } = extensionHarnessEnvironment();

describe("native overlay workspace", () => {
  it("uses the same overlay shell for Refine and model selection without stacking", async () => {
    const h = await makeHarness(); h.holdPanel();
    const view = h.command("view", h.context);
    const expected = { overlay: true, overlayOptions: { anchor: "center", width: "98%", maxHeight: "96%", margin: 0 } };
    expect(h.customOptions).toEqual([expected]);
    const initial = h.panelLines();
    h.panelInput("m");
    expect(h.panelLines().join("\n")).toContain("Choose optimizer model");
    expect(h.customCalls()).toBe(1);
    expect(h.panelLines()).toHaveLength(initial.length);
    expect(h.panelLines()[0]).toBe(initial[0]);
    h.panelInput("\x1b");
    await vi.waitFor(() => expect(h.panelLines().join("\n")).not.toContain("Choose optimizer model"));
    expect(h.customOptions).toEqual([expected]);
    h.panelInput("q"); await view;
    expect(h.editorWrites).toEqual([]); expect(h.sent).toEqual([]);
  });

  describe.each(["regular", "fullscreen"] as const)("model transitions with the native %s renderer", (mode) => {
    it.each(["dark", "light"] as const)("keeps one overlay across open, cancel, resize and confirm (%s)", async (themeName) => {
      for (const origin of ["main", "settings", "original", "usage"] as const) {
        const h = await makeHarness({ renderer: { mode, theme: themeName }, reasoning: true,
          configureModel: origin === "original" || origin === "usage" });
        const original = h.context.modelRegistry.getAvailable()[0]!;
        const others = Array.from({ length: 24 }, (_, index) => ({ ...original,
          id: `other-model-${index}`, name: `Other ${index} 中文😀\x1b[31m` }));
        const models = [original, ...others];
        vi.mocked(h.context.modelRegistry.getAvailable).mockReturnValue(models);
        vi.mocked(h.context.modelRegistry.find).mockImplementation((provider, id) =>
          models.find((model) => model.provider === provider && model.id === id));
        if (origin === "original" || origin === "usage") await trigger(h);
        h.holdPanel();
        const view = h.command(origin === "usage" ? "history" : origin === "original" ? "" : "view", h.context);
        const r = h.renderer!;
        // Use an I/O turn, not just Promise microtasks: Pi redraws on nextTick
        // before an awaited custom() can mount a replacement overlay.
        const input = async (...keys: string[]) => {
          await new Promise<void>((resolve) => setImmediate(() => { keys.forEach(r.input); resolve(); }));
          await new Promise<void>((resolve) => setImmediate(resolve));
          r.tui.renderNow();
        };
        try {
          await vi.waitFor(() => expect(r.tui.hasOverlay()).toBe(true));
          if (origin === "settings") { await input("\x1b[D", " ", "\t"); }
          const before = await readFile(join(h.agentDir, "prompt-refine.json"), "utf8");
          const requests = h.complete.mock.calls.length;
          const focusOwner = r.tui.getFocusedComponent();
          r.tui.overlayFrames.length = 0;
          const open = origin === "settings" ? "\r" : "m";
          await input(open);
          const title = origin === "original" || origin === "usage" ? "Run original with another model" : "Choose optimizer model";
          const theme = getThemeByName(themeName)!;
          expect(h.panelLines(98).join("\n")).toContain(theme.fg("text", theme.bold(title)));
          expect(h.customCalls()).toBe(1);
          expect(r.tui.getFocusedComponent()).toBe(focusOwner);
          await input(...Array.from({ length: 12 }, () => "\x1b[B"));
          expect(h.panelLines(98).join("\n")).toContain("13/25");
          await input("\x1b[Z", "q"); // Thinking/search must not reach the retained workspace.
          expect(h.panelLines(98).join("\n")).toContain("No matching models");
          for (const [columns, rows] of [[28, 12], [160, 60], [100, 40]] as const) {
            Object.assign(r.terminal, { columns, rows });
            r.tui.renderNow();
            const width = Math.floor(columns * 0.98);
            const lines = h.panelLines(width);
            expect(lines).toHaveLength(workspaceHeight(rows));
            expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
            expect(lines.join("\n")).not.toContain("\x1b[31m");
          }
          const redraws = r.tui.fullRedraws;
          r.writes.length = 0;
          await input("\x1b");
          expect(h.panelLines(98).join("\n")).not.toContain(title);
          expect(h.complete).toHaveBeenCalledTimes(requests);
          expect(await readFile(join(h.agentDir, "prompt-refine.json"), "utf8")).toBe(before);
          if (origin === "settings") expect(h.panelLines(98).join("\n")).toContain("Unsaved settings changes");
          if (origin === "usage") expect(h.panelLines(98).join("\n")).toContain("Usage · All rounds");
          await input(open);
          expect(h.panelLines(98).join("\n")).toContain(title);
          await input("\r", "\r"); // Confirm once; consume input while persistence is pending.
          await vi.waitFor(() => expect(h.panelLines(98).join("\n")).not.toContain(title));
          r.tui.renderNow();
          expect(h.customCalls()).toBe(1);
          expect(r.tui.overlayFrames.length).toBeGreaterThan(0);
          expect(r.tui.overlayFrames.every(Boolean)).toBe(true);
          expect(r.tui.getFocusedComponent()).toBe(focusOwner);
          expect(r.tui.fullRedraws).toBe(redraws);
          expect(r.writes.join("")).not.toMatch(/\x1b\[(?:2J|3J)/);
          expect(h.complete).toHaveBeenCalledTimes(requests + (origin === "original" || origin === "usage" ? 1 : 0));
          expect(h.editorWrites).toEqual([]);
          expect(h.sent).toEqual([]);
          if (origin === "settings") {
            expect(h.panelLines(98).join("\n")).toContain("Unsaved settings changes");
            const saved = JSON.parse(await readFile(join(h.agentDir, "prompt-refine.json"), "utf8"));
            expect(saved.projectContext.instructionsEnabled).toBe(false);
          }
        } finally {
          await h.handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown" }, h.context);
          await view;
          r.tui.stop();
        }
      }
    });
  });

  it.each(["session_before_tree", "session_before_switch", "session_before_fork", "session_shutdown"])(
    "closes an embedded picker on %s without applying local edits or reopening", async (event) => {
      const h = await makeHarness({ configureModel: false, reasoning: true }); h.holdPanel();
      const before = await readFile(join(h.agentDir, "prompt-refine.json"), "utf8");
      const view = h.command("view", h.context);
      h.panelInput("m"); h.panelInput("\x1b[Z");
      expect(h.panelLines().join("\n")).toContain("Choose optimizer model");
      await h.handlers.get(event)?.[0]?.({ type: event }, h.context);
      await view;
      h.panelInput("\r"); h.panelInput("m");
      await flushPromises();
      expect(h.customCalls()).toBe(1);
      expect(await readFile(join(h.agentDir, "prompt-refine.json"), "utf8")).toBe(before);
      expect(h.complete).not.toHaveBeenCalled();
      expect(h.editorWrites).toEqual([]);
    });

  it("keeps Settings and its unsaved context when no models are available", async () => {
    const h = await makeHarness({ noAvailableModels: true }); h.holdPanel();
    const view = h.command("view", h.context);
    h.panelInput("\x1b[D"); h.panelInput(" "); h.panelInput("\t"); h.panelInput("\r");
    await flushPromises();
    expect(h.panelLines().join("\n")).toContain("Unsaved settings changes");
    expect(h.notifications.at(-1)).toContain("No authorized text-generation models");
    expect(h.customCalls()).toBe(1);
    h.panelInput("\x1b"); h.panelInput("q"); await view;
    expect(h.complete).not.toHaveBeenCalled();
  });

  it("restores an unsubmitted revision after leaving for the main session", async () => {
    const h = await makeHarness(); await trigger(h); h.holdPanel();
    const view = h.command("view", h.context);
    h.panelInput("f"); h.panelInput("Keep 中文😀 commands");
    h.panelInput("\x1b"); h.panelInput("q"); await view;
    const reopened = h.command("view", h.context); h.panelInput("f");
    expect(h.panelLines().join("\n")).toContain("Keep 中文😀 commands");
    expect(h.complete).toHaveBeenCalledOnce();
    h.panelInput("\x1b"); h.panelInput("q"); await reopened;
    expect(h.editorWrites).toEqual([]); expect(h.sent).toEqual([]);
  });
});
