import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Hello, Snapshot } from "../../src/app/api.js";
import { extensionHarnessEnvironment } from "../support/extension-harness.js";
import { requireValue, wireRequest } from "../support/application-wire.js";
import { flushPromises } from "../support/helpers.js";
import { getThemeByName } from "../support/pi-theme.js";
import { formatKeyHint } from "../../src/key-hints.js";

const { makeHarness } = extensionHarnessEnvironment();
describe("native slash output and retry boundary", () => {
  it.each((["regular", "fullscreen"] as const).flatMap((mode) => (["dark", "light"] as const).map((theme) => ({ mode, theme }))))(
    "renders read-only output in $mode/$theme with bounded geometry, styling, scroll and back", async ({ mode, theme }) => {
    const h = await makeHarness({ renderer: { mode, theme } });
    h.holdPanel();
    const command = h.commands.get("refine-api")!("status", h.context);
    await flushPromises();
    for (const rows of [16, 40]) {
      h.resize(rows);
      for (const width of [40, 140]) {
        const lines = h.panelLines(width);
        expect(lines.length).toBeLessThanOrEqual(rows);
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
        expect(lines.join("\n")).toContain("Refine API");
        const styled = getThemeByName(theme)!;
        expect(lines.join("\n")).toContain(styled.fg("text", styled.bold("Refine API")));
        expect(lines.join("\n")).toContain(formatKeyHint(["Esc", "Back"], styled));
      }
    }
    h.resize(16);
    const before = h.panelLines(40).join("\n");
    h.panelInput("\u001b[6~");
    expect(h.panelLines(40).join("\n")).not.toBe(before);
    h.panelInput("\u001b");
    await command;
    expect(h.internalMessages).toEqual([]);
    expect(h.sessionWrites).toEqual([]);
    expect(h.complete).not.toHaveBeenCalled();
  });

  it("fails visibly when the host resolves a duplicate command to suffixed aliases", async () => {
    const h = await makeHarness({ mode: "rpc" });
    const command = h.commands.get("refine-api")!;
    h.commands.delete("refine-api");
    h.commands.set("refine-api:1", command);
    h.commands.set("refine-api:2", () => undefined);
    await h.handlers.get("session_start")![0]!({ type: "session_start", reason: "reload" }, h.context);
    await command("drafts create -- not committed", h.context);
    expect(h.notifications.at(-1)).toContain("registered more than once");
    const hello = requireValue(await wireRequest<Hello>(h.events, { action: "hello", clientId: "reader" }));
    const snapshot = requireValue(await wireRequest<Snapshot>(h.events, { action: "query", binding: hello.binding, query: { method: "snapshot", scope: "all" } }));
    expect(snapshot.tasks).toEqual([]);
    expect(h.complete).not.toHaveBeenCalled();
  });

  it("only retries issued operation ids in their original lifecycle scope", async () => {
    const h = await makeHarness({ mode: "rpc" });
    const command = h.commands.get("refine-api")!;
    await command("drafts create -- source", h.context);
    const operationId = /operation ([\w-]+)/.exec(h.notifications.at(-1)!)![1]!;
    await command(`drafts create --operation-id ${operationId} -- source`, h.context);
    const hello = requireValue(await wireRequest<Hello>(h.events, { action: "hello", clientId: "reader" }));
    const snapshot = () => wireRequest<Snapshot>(h.events, { action: "query", binding: hello.binding, query: { method: "snapshot", scope: "all" } });
    expect(requireValue(await snapshot()).tasks).toHaveLength(1);
    await command(`drafts create --operation-id ${operationId} -- changed`, h.context);
    expect(h.notifications.at(-1)).toContain("operation-id-reused");
    await command("drafts create --operation-id unknown -- source", h.context);
    expect(h.notifications.at(-1)).toContain("lease-expired");
    await h.reload();
    await h.commands.get("refine-api")!(`drafts create --operation-id ${operationId} -- source`, h.context);
    expect(h.notifications.at(-1)).toContain("lease-expired");
    expect(h.complete).not.toHaveBeenCalled();
  });
});
