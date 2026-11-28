import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { quickTarget } from "../quick-preview.js";
import type { ShortcutAction } from "../config.js";
import type { RefineController } from "../controller.js";
import type { TaskPanelPosition } from "../task-panel.js";
import type { createWorkspaceHost } from "./workspace-host.js";
import type { createRequestFlows } from "./request-flows.js";
import type { createModelSelection } from "./model-selection.js";
import type { createEditorActions } from "./editor-actions.js";
import type { Notify } from "./contracts.js";

interface CommandDependencies {
  controller: Pick<RefineController,
    "cancelAndDismiss" | "getRoundId" | "getTaskDisplayRecords">;
  taskPositions: Map<string, TaskPanelPosition>;
  useContext(ctx: ExtensionContext): void;
  host: Pick<ReturnType<typeof createWorkspaceHost>, "showPreview" | "isInteracting">;
  requests: Pick<ReturnType<typeof createRequestFlows>, "triggerOptimize">;
  models: Pick<ReturnType<typeof createModelSelection>, "selectModel" | "cycleModel">;
  editor: Pick<ReturnType<typeof createEditorActions>, "restoreDraft">;
  rpcCommand(args: string, ctx: ExtensionContext): Promise<void>;
  clearHistory(ctx: ExtensionContext): Promise<void>;
  showOptimizerQuota(): boolean;
  notify: Notify;
}

export function createCommands({ controller, taskPositions, useContext, host, requests,
  models, editor, rpcCommand, clearHistory, showOptimizerQuota, notify }: CommandDependencies) {
  const { showPreview, isInteracting } = host;
  const { triggerOptimize } = requests;
  const { selectModel, cycleModel } = models;
  const { restoreDraft } = editor;
  const remembered = new Map<number, number>();
  const actions: Record<ShortcutAction, (ctx: ExtensionContext) => void | Promise<void>> = {
    optimize: (ctx) => {
      if (ctx.mode !== "tui") { triggerOptimize(ctx); return; }
      if (isInteracting()) return;
      useContext(ctx);
      const draft = ctx.ui.getEditorText();
      const position = taskPositions.get(ctx.sessionManager.getSessionId());
      const records = controller.getTaskDisplayRecords();
      const tasks = new Set(records.map(record => record.taskId));
      for (const task of remembered.keys()) if (!tasks.has(task)) remembered.delete(task);
      let id = quickTarget(records, controller.getRoundId(), draft, position?.selectedId, remembered, position?.selectedTaskId)?.id;
      if (id === undefined) {
        if (!draft.trim()) { notify(ctx, "Refine: Type a prompt first. /refine for workspace."); return; }
        const warnQuota = showOptimizerQuota();
        const result = triggerOptimize(ctx, false, draft, true, "shortcut");
        if (result?.kind !== "captured" && result?.kind !== "started") return;
        id = result.recordId;
        if (result.kind === "started" && warnQuota) notify(ctx, "Refine may use optimizer quota or incur charges.");
      }
      return showPreview(ctx, undefined, false, { id, remembered });
    },
    view: (ctx) => showPreview(ctx, undefined, true),
    dismiss: (ctx) => {
      useContext(ctx);
      controller.cancelAndDismiss();
      notify(ctx, "Refinement cancelled. Editor unchanged.", "info");
    },
    selectModel: (ctx) => selectModel(ctx),
    cycleModel: (ctx) => cycleModel(ctx),
    restore: (ctx) => restoreDraft(ctx),
  };

  async function command(args: string, ctx: ExtensionContext): Promise<void> {
    if (ctx.mode === "rpc") return rpcCommand(args, ctx);
    const text = args.trim();
    const action = text.toLocaleLowerCase();
    if (action === "history clear") { await clearHistory(ctx); return; }
    if (action === "history" || action === "usage") {
      await showPreview(ctx, "usage");
      return;
    }
    const mapping: Record<string, ShortcutAction> = {
      optimize: "optimize",
      view: "view",
      cancel: "dismiss",
      dismiss: "dismiss",
      model: "selectModel",
      cycle: "cycleModel",
      restore: "restore",
    };
    if (!action) {
      await showPreview(ctx);
      return;
    }
    // Only exact subcommands are reserved. Preserve prompt case and
    // internal whitespace; `optimize <text>` disambiguates reserved words.
    const explicitDraft = /^optimize\s+([\s\S]+)$/i.exec(text)?.[1];
    const selectedAction = Object.hasOwn(mapping, action) ? mapping[action] : undefined;
    if (explicitDraft !== undefined || !selectedAction) {
      triggerOptimize(ctx, true, explicitDraft ?? text);
      return;
    }
    if (selectedAction === "optimize") triggerOptimize(ctx, true);
    else await actions[selectedAction](ctx);
  }
  return { actions, command };
}
