import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RefineConfig } from "../config.js";
import { buildRefineSystemPrompt, selectHistory, type HistorySnapshot } from "../context.js";
import { captureProjectContext } from "../project-context.js";
import type { RefineController } from "../controller.js";
import type { CandidateToken, RefineRequest, RefineRequestInput, TriggerResult } from "../request-types.js";
import { displayModel, effectiveThinkingLevel, sameModel } from "./model-selection.js";
import { RESTORED_CONTEXT_HINT, type Notify, type NotifyCurrent } from "./contracts.js";
import { composeRevision, type SelectedPreference } from "../revision-preferences.js";

interface RequestFlowDependencies {
  controller: Pick<RefineController,
    "capture" | "getCandidate" | "getGeneration" | "getModel" | "getState" | "getTaskInput" |
    "isCandidateCurrent" | "trigger">;
  config: Pick<RefineConfig, "maxDraftChars" | "context" | "projectContext" | "systemPrompt" | "thinkingLevel">;
  useContext(ctx: ExtensionContext): void;
  setCompletionContext(ctx: ExtensionContext): void;
  canNameSession(ctx: ExtensionContext): boolean;
  modelSwitchBlocked(ctx: ExtensionContext): boolean;
  showPreview(ctx: ExtensionContext): Promise<void>;
  updatePresentation(): void;
  notify: Notify;
  notifyCurrent: NotifyCurrent;
  defaultPreferences(ctx: ExtensionContext): SelectedPreference[];
}

export function createRequestFlows({ controller, config, useContext, setCompletionContext,
  canNameSession, modelSwitchBlocked, showPreview, updatePresentation, notify, notifyCurrent, defaultPreferences }: RequestFlowDependencies) {
  let historySnapshot: HistorySnapshot | undefined;
  let projectLabel = "";
  let projectWarnings: string[] = [];
  function contextLabel(source?: RefineRequestInput): string {
    const snapshot = source?.history ?? historySnapshot;
    if (!snapshot) return "Context: not captured";
    if (source?.budget?.status === "blocked") return "⚠ Budget blocked · no model request";
    if (source?.budget?.status === "trimmed") {
      return `⚠ Budget reduced · ${snapshot.messageCount - source.budget.removedMessages} msgs · input est. ${source.budget.inputTokens} tokens`;
    }
    const project = source ? (source.project ? `${source.project.snapshot.instructionCount} rules · ${source.project.snapshot.skillCount} skills${source.project.config?.tree.enabled && !source.history.text ? " · tree" : ""}${source.projectDiagnostics?.referencedDirectoryCount ? ` · @dirs ${source.projectDiagnostics.referencedDirectoryCount}` : ""}` : "") : projectLabel;
    const warnings = source ? source.projectDiagnostics?.warnings ?? source.project?.snapshot.warnings ?? [] : projectWarnings;
    const warning = warnings.length ? `⚠${warnings.length} · ` : "";
    const history = !snapshot.messageCount
      ? (project ? "No history" : "Draft only")
      : `${snapshot.messageCount} msgs · ${snapshot.characterCount} char · ${snapshot.latestAssistantIncluded ? "assistant" : "no assistant"}${snapshot.truncated ? " · trimmed" : ""}`;
    const completeness = snapshot.status === "disabled_by_policy"
      ? " · history off"
      : `${snapshot.omittedMessageCount ? ` · ${snapshot.omittedMessageCount} omitted` : ""}${snapshot.excerptedMessageCount ? ` · ${snapshot.excerptedMessageCount} excerpted` : ""}`;
    return `${warning}${history}${completeness}${project ? ` · ${project}` : ""}`;
  }

  function optimizationError(ctx: ExtensionContext, draft: string, selected = controller.getModel()): string | undefined {
    if (!draft.trim()) return "The editor is empty; no refinement request was sent.";
    if (draft.length > config.maxDraftChars) return `The draft exceeds ${config.maxDraftChars} characters; no request was sent, and the existing result was kept.`;
    if (!selected) return "No optimizer model is configured; use /refine model to select a text-generation model first.";
    if (!ctx.modelRegistry.find(selected.provider, selected.id) || !ctx.modelRegistry.getAvailable().some((candidate) => sameModel(candidate, selected))) {
      return `Optimizer model is missing or unavailable: ${displayModel(selected)}; no request was sent, and the existing result was kept.`;
    }
    return undefined;
  }

  function draftInput(ctx: ExtensionContext, draft: string): RefineRequestInput {
    const history = selectHistory(ctx.sessionManager.getBranch(), config.context.maxMessages, config.context.maxChars);
    const project = config.projectContext.enabled ? captureProjectContext(ctx, config.projectContext, draft) : undefined;
    const generateTitle = canNameSession(ctx);
    return {
      draft, model: controller.getModel() ?? { provider: "", id: "" },
      ...defaultSelection(ctx),
      generateTitle, systemPrompt: buildRefineSystemPrompt(generateTitle, config.systemPrompt),
      sessionId: ctx.sessionManager.getSessionId(), branchLeafId: ctx.sessionManager.getLeafId(), history,
      ...(project ? { project: { cwd: ctx.cwd, snapshot: project,
        revisionSnapshot: captureProjectContext(ctx, config.projectContext, draft, true), config: structuredClone(config.projectContext) } } : {}),
    };
  }

  function defaultSelection(ctx: ExtensionContext): Pick<RefineRequestInput, "preferences" | "editingInstruction"> {
    const preferences = defaultPreferences(ctx);
    return preferences.length ? { preferences, editingInstruction: composeRevision(preferences, "") } : {};
  }

  function triggerOptimize(ctx: ExtensionContext, force = false, suppliedDraft?: string, keepEditor = false, captureOnly = false): TriggerResult | undefined {
    useContext(ctx);
    if (ctx.mode !== "tui") {
      notify(ctx, "Background prompt refinement is only available in TUI mode; no model request was sent.", "warning");
      return;
    }
    const draft = suppliedDraft ?? ctx.ui.getEditorText();
    // Pi clears the editor on slash-command submission. Keep the supplied source
    // available for retry/accept/restore, but never overwrite another draft.
    if (!keepEditor && suppliedDraft !== undefined && !ctx.ui.getEditorText()) ctx.ui.setEditorText(draft);
    const error = optimizationError(ctx, draft);
    if (error) {
      notify(ctx, error, draft.trim() ? "warning" : "info");
      return;
    }
    const selected = controller.getModel()!;
    const model = ctx.modelRegistry.find(selected.provider, selected.id)!;

    setCompletionContext(ctx);
    const branch = ctx.sessionManager.getBranch();
    const history = selectHistory(
      branch,
      config.context.maxMessages,
      config.context.maxChars,
    );
    const previousContext = { historySnapshot, projectLabel, projectWarnings };
    historySnapshot = history;
    const project = config.projectContext.enabled ? captureProjectContext(ctx, config.projectContext, draft) : undefined;
    projectLabel = project ? `${project.instructionCount} rules · ${project.skillCount} skills${config.projectContext.tree.enabled && !history.text ? " · tree" : ""}` : "";
    projectWarnings = project?.warnings ?? [];
    const generateTitle = canNameSession(ctx);
    const input = {
      draft,
      ...defaultSelection(ctx),
      model: selected,
      thinkingLevel: effectiveThinkingLevel(model, config.thinkingLevel, ctx.thinkingLevel),
      generateTitle,
      systemPrompt: buildRefineSystemPrompt(generateTitle, config.systemPrompt),
      sessionId: ctx.sessionManager.getSessionId(),
      branchLeafId: ctx.sessionManager.getLeafId(),
      history,
      ...(project ? { project: { cwd: ctx.cwd, snapshot: project,
        revisionSnapshot: captureProjectContext(ctx, config.projectContext, draft, true), config: structuredClone(config.projectContext) } } : {}),
    };
    const result = captureOnly ? controller.capture(input) : controller.trigger(input, { force });
    if (result.kind !== "started") {
      ({ historySnapshot, projectLabel, projectWarnings } = previousContext);
    }
    if (result.kind === "empty") notify(ctx, "The editor is empty; no refinement request was sent.", "info");
    else if (result.kind === "too-long") notify(ctx, `The draft or editing requirements exceed ${config.maxDraftChars} characters; no request was sent. Reduce the text or selection and try again.`, "warning");
    else if (result.kind === "duplicate" || result.kind === "ready") {
      void showPreview(ctx).catch(() => notifyCurrent("Could not open the refinement panel; the main draft was not changed.", "warning"));
    }
    else if (result.kind === "busy") notify(ctx, "Work is pending or the 100-entry journal is full. Existing work kept.", "warning");
    if (result.kind === "captured" && (input.editingInstruction?.length ?? 0) > config.maxDraftChars) {
      notify(ctx, `Project defaults exceed ${config.maxDraftChars} characters. Reduce the selection or use c to clear all in Preferences before optimizing.`, "warning");
    }
    return result;
  }

  function generateSameInput(ctx: ExtensionContext): void {
    useContext(ctx);
    if (modelSwitchBlocked(ctx)) return;
    const input = controller.getTaskInput();
    if (!input) {
      notify(ctx, "No frozen input is available. Use r to refine the current editor first.", "info");
      return;
    }
    if (input.contextUnavailable) { notify(ctx, RESTORED_CONTEXT_HINT, "info"); return; }
    if (input.sessionId !== ctx.sessionManager.getSessionId()) {
      notify(ctx, "The session branch changed; use r to capture a new input.", "warning");
      return;
    }
    const error = optimizationError(ctx, input.draft);
    if (error) { notify(ctx, error, "warning"); return; }
    const selected = controller.getModel()!;
    const model = ctx.modelRegistry.find(selected.provider, selected.id)!;
    setCompletionContext(ctx);
    historySnapshot = input.history;
    projectLabel = "Frozen input";
    projectWarnings = [];
    const result = controller.trigger({ ...input, model: selected,
      thinkingLevel: effectiveThinkingLevel(model, config.thinkingLevel, ctx.thinkingLevel),
    }, { force: true, sameTask: true });
    if (result.kind !== "started") notify(ctx, "Same-input generation was not started; current results kept.", "warning");
  }

  function reviseCandidate(ctx: ExtensionContext, token: CandidateToken, instruction: string): string | undefined {
    if (!controller.isCandidateCurrent(token) || controller.getState().pendingSend) return "The result changed or is being sent. Reopen Revise for the current result.";
    if (!instruction.trim()) return "Enter revision instructions; the current result is unchanged.";
    if (instruction.length > config.maxDraftChars) return `Revision instructions exceed ${config.maxDraftChars} characters; the current result is unchanged.`;
    const source = controller.getCandidate()!;
    if (source.contextUnavailable) return RESTORED_CONTEXT_HINT;
    const error = optimizationError(ctx, source.draft, source.model);
    if (error) return error;
    const model = ctx.modelRegistry.find(source.model.provider, source.model.id)!;
    const generateTitle = source.generateTitle;
    const project = source.project?.revisionSnapshot ?? source.project?.snapshot;
    const previousContext = { historySnapshot, projectLabel, projectWarnings };
    historySnapshot = source.history;
    projectLabel = project ? `${project.instructionCount} rules · ${project.skillCount} skills${config.projectContext.tree.enabled && !source.history.text ? " · tree" : ""}` : "";
    projectWarnings = project?.warnings ?? [];
    setCompletionContext(ctx);
    const result = controller.trigger({
      draft: source.draft,
      revision: { previousCandidate: source.text, instruction, previousInstruction: source.revision?.instruction },
      editingInstruction: source.editingInstruction,
      preferences: source.preferences,
      model: source.model,
      thinkingLevel: effectiveThinkingLevel(model, config.thinkingLevel, ctx.thinkingLevel),
      generateTitle,
      systemPrompt: source.systemPrompt,
      roundId: source.roundId,
      sessionId: source.sessionId,
      branchLeafId: source.branchLeafId,
      history: source.history,
      ...(source.project ? { project: { ...source.project, snapshot: project! } } : {}),
    }, { force: true, revisionToken: token });
    if (result.kind !== "started") {
      ({ historySnapshot, projectLabel, projectWarnings } = previousContext);
      return "Could not revise this result. Reopen Revise; the current draft was not changed.";
    }
    return undefined;
  }

  function clearContext(): void {
    historySnapshot = undefined;
    projectLabel = "";
    projectWarnings = [];
  }
  function reportProject(ctx: ExtensionContext, request: RefineRequest, warnings: string[], referencedDirectoryCount: number): void {
    if (controller.getState().requestId !== request.requestId || controller.getGeneration() !== request.generation) return;
    projectWarnings = warnings;
    if (referencedDirectoryCount) projectLabel += ` · @dirs ${referencedDirectoryCount}`;
    if (projectWarnings.length) notify(ctx, projectWarnings.join("\n"), "warning");
    updatePresentation();
  }
  return { optimizationError, draftInput, triggerOptimize, generateSameInput, reviseCandidate, contextLabel, clearContext, reportProject };
}
