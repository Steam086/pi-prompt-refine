import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import type { ShortcutAction } from "./config.js";
import { createRefineApplication } from "./app/runtime.js";

export { modelPickerItems } from "./app/model-selection.js";

export default async function promptRefineExtension(pi: ExtensionAPI): Promise<void> {
  const app = await createRefineApplication(pi);
  for (const [action, shortcut] of Object.entries(app.shortcuts) as [ShortcutAction, KeyId | null][]) {
    if (shortcut === null) continue;
    pi.registerShortcut(shortcut, {
      description: `Prompt Refine: ${action}`,
      handler: (ctx) => app.actions[action](ctx),
    });
  }
  pi.registerCommand("refine", {
    description: "Prompt Refine: /refine <text> or optimize [text], view, history, history clear, usage, cancel, model, cycle, restore",
    handler: app.command,
  });
  pi.on("input", (event, ctx) => app.input(ctx, event.text, event.source, event.streamingBehavior));
  // Only user message_start commits a round boundary; input is preflight.
  pi.on("message_start", (event, ctx) => app.messageStarted(event.message, ctx));
  pi.on("session_start", (event, ctx) => app.lifecycle.start(event, ctx));
  pi.on("session_before_tree", (_event, ctx) => app.lifecycle.beforeTransition(ctx));
  pi.on("session_tree", (_event, ctx) => app.lifecycle.tree(ctx));
  pi.on("session_before_switch", (_event, ctx) => app.lifecycle.beforeTransition(ctx));
  pi.on("session_before_fork", (_event, ctx) => app.lifecycle.beforeTransition(ctx));
  pi.on("session_shutdown", (_event, ctx) => app.lifecycle.shutdown(ctx));
}
