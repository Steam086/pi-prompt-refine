import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
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
    "cancelAndDismiss" | "getAppliedRecordId" | "getHistory" | "getModel" | "hasCapturedDraft">;
  taskPositions: Map<string, TaskPanelPosition>;
  useContext(ctx: ExtensionContext): void;
  host: Pick<ReturnType<typeof createWorkspaceHost>, "showPreview" | "isInteracting">;
  requests: Pick<ReturnType<typeof createRequestFlows>, "triggerOptimize">;
  models: Pick<ReturnType<typeof createModelSelection>, "selectModel" | "cycleModel">;
  editor: Pick<ReturnType<typeof createEditorActions>, "restoreDraft">;
  clearHistory(ctx: ExtensionContext): Promise<void>;
  notify: Notify;
}

export function createCommands({ controller, taskPositions, useContext, host, requests,
  models, editor, clearHistory, notify }: CommandDependencies) {
  const { showPreview, isInteracting } = host;
  const { triggerOptimize } = requests;
  const { selectModel, cycleModel } = models;
  const { restoreDraft } = editor;
  const actions: Record<ShortcutAction, (ctx: ExtensionContext) => void | Promise<void>> = {
    optimize: (ctx) => {
      if (ctx.mode !== "tui") { triggerOptimize(ctx); return; }
      if (isInteracting()) return;
      useContext(ctx);
      const draft = ctx.ui.getEditorText();
      if (!controller.getModel() || !draft.trim()) return showPreview(ctx);
      const knownDraft = controller.hasCapturedDraft(draft);
      const captured = !knownDraft ? triggerOptimize(ctx, false, draft, true, true) : undefined;
      const records = controller.getHistory();
      const position = taskPositions.get(ctx.sessionManager.getSessionId());
      const selected = records.find((record) => position?.selectedTaskId !== undefined
        ? record.taskId === position.selectedTaskId
        : record.id === (position?.selectedId ?? controller.getAppliedRecordId()));
      // Opening with an editor draft is an explicit navigation intent. Background
      // updates still preserve selection; a newly captured prompt must not inherit it.
      let target = captured?.kind === "captured" ? records.find((record) => record.id === captured.recordId) : undefined;
      let original = true;
      if (!target && knownDraft) {
        let matching = records.filter((record) => record.input.draft === draft);
        if (!matching.length) {
          matching = records.filter((record) => record.candidate?.text === draft && (record.acceptedAt !== undefined || record.sentAt !== undefined));
          original = false;
        }
        const current = matching.filter((record) => record.archivedAt === undefined);
        if (current.length) matching = current;
        if (!matching.some((record) => original ? record.taskId === selected?.taskId : record.id === selected?.id && position?.selectedTaskId === undefined)) {
          target = matching.at(-1);
        }
      }
      if (target) taskPositions.set(ctx.sessionManager.getSessionId(), {
        ...position, selectedId: target.id, selectedTaskId: original ? target.taskId : undefined, scroll: 0,
        scrolls: { ...position?.scrolls, [`${original ? "task" : "run"}-${original ? target.taskId : target.id}`]: 0 },
      });
      return showPreview(ctx);
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
