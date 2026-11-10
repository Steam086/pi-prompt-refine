import { parseKey, type Component } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RefineConfig } from "../config.js";
import { RefineWorkspace, type ContextSettings } from "../workspace.js";
import { REFINE_OVERLAY_OPTIONS } from "../workspace-overlay.js";
import { PreviewPanel, type PreviewOptions } from "../preview.js";
import type { RefineController } from "../controller.js";
import type { CandidateToken, ControllerState } from "../request-types.js";
import type { TaskPanelPosition } from "../task-panel.js";
import { truncatedOutputHint } from "../usage.js";
import { effectiveThinkingLevel, sameModel } from "./model-selection.js";
import type { createEditorActions } from "./editor-actions.js";
import type { createModelSelection } from "./model-selection.js";
import type { createRequestFlows } from "./request-flows.js";
import type { createWorkspaceActions } from "./workspace-actions.js";
import { STATUS_KEY, type ModelSelection, type Notify, type NotifyCurrent, type PreviewAction, type WorkspaceSelection } from "./contracts.js";

function errorStatus(state: ControllerState): string {
  switch (state.error) {
    case "budget": return `⚠ ${state.budget?.message ?? "Request does not fit the model budget. Draft unchanged."}`;
    case "timeout": return "Refine: timed out. Retry.";
    case "empty": return "Refine: no prompt returned. Retry.";
    case "truncated": return `Refine: ${truncatedOutputHint(state.usage)}`;
    case "tool-call": return "Refine: unexpected tool call. Retry.";
    case "invalid-output": return "Refine: invalid output. Retry.";
    default: return "Refine: request failed. Check model/network.";
  }
}

interface WorkspaceHostDependencies {
  controller: Pick<RefineController,
    "cancelAndDismiss" | "cycleCandidate" | "getCandidate" | "getCandidatePosition" | "getCandidateToken" |
    "getDisplayedInput" | "getGeneration" | "getModel" | "getRequestSource" | "getRestore" | "getSessionId" |
    "getState" | "getViewedAccepted" | "isCandidateCurrent" | "stopRequest">;
  config: Pick<RefineConfig, "thinkingLevel">;
  openHint: string;
  taskPositions: Map<string, TaskPanelPosition>;
  usagePositions: Map<string, TaskPanelPosition>;
  useContext(ctx: ExtensionContext): void;
  canNameSession(ctx: ExtensionContext): boolean;
  updatePresentation(): void;
  acknowledge(sessionId: string): void;
  workspaceActions: ReturnType<typeof createWorkspaceActions>;
  editor: ReturnType<typeof createEditorActions>;
  models: Pick<ReturnType<typeof createModelSelection>, "selectModel" | "editSystemPrompt" | "cycleModel" | "modelSwitchBlocked" | "registeredModels">;
  requests: Pick<ReturnType<typeof createRequestFlows>, "triggerOptimize" | "generateSameInput" | "contextLabel">;
  notify: Notify;
  notifyCurrent: NotifyCurrent;
}

export function createWorkspaceHost({ controller, config, openHint, taskPositions, usagePositions,
  useContext, canNameSession, updatePresentation, acknowledge, workspaceActions,
  editor, models, requests, notify, notifyCurrent }: WorkspaceHostDependencies) {
  const { acceptCandidate, editCandidate, restoreDraft, sendCandidate } = editor;
  const { selectModel, editSystemPrompt, cycleModel, modelSwitchBlocked, registeredModels } = models;
  const { triggerOptimize, generateSameInput, contextLabel } = requests;
  const previewPositions = new Map<string, number>();
  let interacting = false;
  let refreshPreview: (() => void) | undefined;
  let closePreview: ((reason?: "idle") => void) | undefined;
  async function showPreview(ctx: ExtensionContext, initialPage?: "usage", resultView = false): Promise<void> {
    if (interacting || ctx.mode !== "tui") return;
    interacting = true;
    ctx.ui.setFooter(() => ({ render: () => [], invalidate() {} }));
    try { await showPreviewContent(ctx, undefined, 3, initialPage, resultView); }
    finally {
      interacting = false;
      ctx.ui.setFooter(undefined);
      updatePresentation();
    }
  }

  async function showPreviewContent(ctx: ExtensionContext, settingsContext?: ContextSettings, settingsCursor = 3, initialPage?: "usage", resultView = false): Promise<void> {
    useContext(ctx);
    if (ctx.mode !== "tui") {
      notify(ctx, "Preview requires TUI mode.", "warning");
      return;
    }
    if (closePreview) return; // One user-opened panel; never stack dialogs on repeated shortcuts.
    const sessionId = ctx.sessionManager.getSessionId();
    let selection: WorkspaceSelection | undefined;
    try {
      selection = await ctx.ui.custom<WorkspaceSelection | undefined>((tui, theme, keybindings, done) => {
        let displayedToken: CandidateToken | undefined;
        const snapshot = (): PreviewOptions => {
          const state = controller.getState();
          const candidate = controller.getCandidate();
          const accepted = state.phase === "idle" ? controller.getViewedAccepted() : undefined;
          const displayed = candidate ?? accepted;
          const source = controller.getRequestSource();
          // A failed revision may keep an older candidate. Its details must describe
          // that displayed result, not the instructions of the failed request.
          const revision = displayed ? displayed.revision : controller.getDisplayedInput()?.revision;
          const draft = displayed?.draft ?? source?.draft;
          const model = displayed?.model ?? state.model ?? controller.getModel();
          const registeredModel = model && registeredModels(ctx).find((candidate) => sameModel(candidate, model));
          // Saved results and in-flight requests must not inherit later setting changes.
          const thinkingLevel = displayed ? displayed.thinkingLevel
            : state.phase === "generating" || state.phase === "error" ? state.thinkingLevel
            : registeredModel ? effectiveThinkingLevel(registeredModel, config.thinkingLevel, ctx.thinkingLevel) : undefined;
          displayedToken = controller.getCandidateToken();
          return {
            state: { ...state, usage: state.phase === "error" ? state.usage : displayed?.usage ?? state.usage, model },
            candidateText: displayed?.text,
            sessionTitle: candidate?.title && canNameSession(ctx) ? candidate.title : undefined,
            draft,
            revisionInstruction: displayed ? revision?.instruction : source?.revisionInstruction,
            editingInstruction: displayed?.editingInstruction ?? controller.getDisplayedInput()?.editingInstruction,
            previousCandidate: revision?.previousCandidate,
            accepted: accepted ? { editorChanged: ctx.ui.getEditorText() !== accepted.text } : undefined,
            draftChanged: draft !== undefined && ctx.ui.getEditorText() !== draft,
            canRestore: !!controller.getRestore(),
            contextLabel: accepted ? "Accepted snapshot · no model call" : contextLabel(controller.getDisplayedInput()), openHint,
            elapsedSeconds: (state.phase === "error" ? state.elapsedSeconds : displayed?.elapsedSeconds ?? state.elapsedSeconds) ?? 0,
            errorLabel: errorStatus(state),
            navigation: controller.getCandidatePosition(),
            viewKey: (displayed?.recordId ?? state.recordId) ? `record-${displayed?.recordId ?? state.recordId}` : `idle-${controller.getModel()?.id ?? "none"}`,
            thinkingLevel,
            contextUnavailable: displayed?.contextUnavailable,
          };
        };
        const panel = new PreviewPanel(snapshot(), theme, () => tui.terminal.rows, () => tui.requestRender(), previewPositions);
        let closed = false;
        let focused = false;
        let choosingModel = false;
        let modelPicker: Component | undefined;
        let finishModelPicker: ((selection: ModelSelection) => void) | undefined;
        const openModelPicker = (recordId?: number) => {
          if (closed || choosingModel) return;
          choosingModel = true;
          // Replace only the modal's content. Calling the native done() here would
          // expose the conversation during Pi's immediate post-input redraw.
          void selectModel(ctx, recordId, workspace.isUsage(), (factory) => new Promise((resolve) => {
            let completed = false;
            finishModelPicker = (selection) => {
              if (completed) return;
              completed = true;
              finishModelPicker = undefined;
              resolve(selection);
            };
            modelPicker = factory(tui, theme, keybindings, finishModelPicker);
            workspace.focused = false;
            tui.requestRender();
          })).catch(() => {
            if (!closed) notify(ctx, "Could not select optimizer model; existing work kept.", "error");
          }).finally(() => {
            choosingModel = false;
            modelPicker = undefined;
            finishModelPicker = undefined;
            if (closed) return;
            workspace.focused = focused;
            refreshPreview?.();
          });
        };
        const position = taskPositions.get(sessionId) ?? {};
        taskPositions.set(sessionId, position);
        const usagePosition = usagePositions.get(sessionId) ?? {};
        usagePositions.set(sessionId, usagePosition);
        const workspace: RefineWorkspace = new RefineWorkspace(panel, tui, theme, keybindings, workspaceActions({
          ctx, sessionId, isClosed: () => closed, isUsage: () => workspace.isUsage(),
          position, usagePosition, openModelPicker, finish: (value) => finish(value),
        }));
        const finish = (value?: WorkspaceSelection) => {
          if (closed) return;
          closed = true;
          finishModelPicker?.(undefined);
          modelPicker = undefined;
          panel.rememberPosition();
          workspace.dispose();
          refreshPreview = undefined;
          closePreview = undefined;
          done(value);
        };
        if (settingsContext) workspace.openSettings(settingsContext, settingsCursor);
        if (initialPage) workspace.openUsage();
        else if (resultView) workspace.openResult();
        closePreview = (reason) => {
          // Choosing the first/default model emits an idle state with no records.
          // Keep this interaction open, but never suppress lifecycle invalidation.
          if (reason === "idle" && choosingModel) refreshPreview?.();
          else finish();
        };
        refreshPreview = () => {
          if (closed) return;
          panel.update(snapshot());
          workspace.refreshSettings();
          tui.requestRender();
        };
        // Opening the workspace acknowledges completed requests and hides the background status.
        acknowledge(sessionId);
        ctx.ui.setStatus(STATUS_KEY, undefined);
        ctx.ui.setWidget(STATUS_KEY, undefined);
        return {
          get focused() { return focused; },
          set focused(value: boolean) { focused = value; workspace.focused = value && !choosingModel; },
          render: (width) => modelPicker ? modelPicker.render(width) : workspace.render(width),
          invalidate: () => { workspace.invalidate(); modelPicker?.invalidate(); },
          handleInput(data) {
            if (closed) return;
            if (choosingModel) {
              // A confirmed picker remains visible while settings are persisted;
              // consume further keys instead of confirming twice or leaking input.
              if (finishModelPicker) modelPicker?.handleInput?.(data);
              return;
            }
            if (workspace.handleInput(data)) return;
            const navigationKey = parseKey(data);
            if (keybindings.matches(data, "tui.select.cancel") || navigationKey === "ctrl+\\") { finish(); return; }
            if (keybindings.matches(data, "tui.input.submit")) return;
            if (keybindings.matches(data, "tui.editor.cursorUp")) panel.scrollBy(-1);
            else if (keybindings.matches(data, "tui.editor.cursorDown")) panel.scrollBy(1);
            else if (keybindings.matches(data, "tui.editor.pageUp")) panel.page(-1);
            else if (keybindings.matches(data, "tui.editor.pageDown")) panel.page(1);
            else {
              const key = parseKey(data)?.toLocaleLowerCase();
              if (key === "[" || key === "]") {
                if (!modelSwitchBlocked(ctx)) controller.cycleCandidate(key === "[" ? -1 : 1);
                return;
              }
              if ((key === "x" || key === "d") && controller.getState().phase === "generating") {
                controller.stopRequest();
                return;
              }
              if (key === "g") { generateSameInput(ctx); workspace.openTasks(); return; }
              if (key === "c") {
                void cycleModel(ctx).catch(() => notifyCurrent("Could not switch optimizer model.", "warning"));
                return;
              }
              if (key === "o" || key === "?" || key === "v") {
                if (key === "o") panel.toggleOriginal();
                else if (key === "?") panel.toggleHelp();
                else panel.toggleSource();
                tui.requestRender();
                return;
              }
              const keys: Record<string, PreviewAction> = {
                a: "accept", e: "edit", s: "send", x: "dismiss", d: "dismiss", z: "restore",
                r: "optimize", m: "model", c: "cycle", q: "close",
              };
              const action = key ? keys[key] : undefined;
              if (action === "model") { openModelPicker(); return; }
              if (action) {
                if (["accept", "edit", "send"].includes(action) && !displayedToken) return;
                finish({ action, generation: controller.getGeneration(), token: displayedToken });
                return;
              }
            }
            tui.requestRender();
          },
        };
      }, { overlay: true, overlayOptions: REFINE_OVERLAY_OPTIONS });
    } finally {
      refreshPreview = undefined;
      closePreview = undefined;
      updatePresentation();
    }
    if (!selection || selection.action === "close") return;
    if (controller.getSessionId() !== sessionId || controller.getGeneration() !== selection.generation) return;
    const { action, token } = selection;
    if (action === "dismiss") controller.cancelAndDismiss();
    else if (action === "restore") await restoreDraft(ctx);
    else if (action === "system-prompt") {
      await editSystemPrompt(ctx);
      if (selection.settingsContext && ctx.sessionManager.getSessionId() === sessionId) {
        await showPreviewContent(ctx, selection.settingsContext, 5);
      }
    }
    else if (action === "cycle") await cycleModel(ctx);
    else if (action === "optimize") {
      triggerOptimize(ctx, true);
    } else if (token && controller.isCandidateCurrent(token)) {
      if (action === "accept") acceptCandidate(ctx, token);
      else if (action === "edit") {
        await editCandidate(ctx, token);
        if (ctx.sessionManager.getSessionId() === sessionId &&
          controller.getSessionId() === sessionId && controller.getGeneration() === selection.generation) {
          await showPreviewContent(ctx, undefined, 3, undefined, true);
        }
      }
      else if (action === "send") sendCandidate(ctx, token);
    }
  }

  return {
    showPreview,
    isInteracting: () => interacting,
    isOpen: () => !!closePreview,
    refresh: () => refreshPreview?.(),
    close: (reason?: "idle") => closePreview?.(reason),
  };
}
