import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ConfigReader } from "../config.js";
import { buildRefineSystemPrompt, selectHistory, type RevisionInput, type HistorySnapshot } from "../context.js";
import { captureProjectContext } from "../project-context.js";
import type { RefineController } from "../controller.js";
import type { CandidateToken, RefineRequest, RefineRequestInput, RunModel, TriggerResult } from "../request-types.js";
import { displayModel, effectiveThinkingLevel, modelRef, resolveAvailableModel } from "./model-utils.js";
import { RESTORED_CONTEXT_HINT, type Notify, type NotifyCurrent } from "./contracts.js";
import { composeRevision, PREFERENCE_SELECTION_LIMIT, type SelectedPreference } from "../revision-preferences.js";

interface RequestFlowDependencies {
  controller: Pick<RefineController,
    "capture" | "createDraft" | "getCandidate" | "getGeneration" | "getModel" | "getState" | "getTaskInput" |
    "isCandidateCurrent" | "startRecord" | "trigger">;
  readConfig: ConfigReader<"maxDraftChars" | "context" | "projectContext" | "systemPrompt" | "thinkingLevel">;
  useContext(ctx: ExtensionContext): void;
  setCompletionContext(ctx: ExtensionContext): void;
  canNameSession(ctx: ExtensionContext): boolean;
  modelSwitchBlocked(ctx: ExtensionContext): boolean;
  showPreview(ctx: ExtensionContext): Promise<void>;
  updatePresentation(): void;
  notify: Notify;
  notifyCurrent: NotifyCurrent;
  initialPreferences(ctx: ExtensionContext): SelectedPreference[];
}

export function createRequestFlows({ controller, readConfig, useContext, setCompletionContext,
  canNameSession, modelSwitchBlocked, showPreview, updatePresentation, notify, notifyCurrent, initialPreferences }: RequestFlowDependencies) {
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

  function checkOptimization(ctx: ExtensionContext, draft: string, selected = controller.getModel()): { model: Model<Api> } | { error: string } {
    const { maxDraftChars } = readConfig();
    if (!draft.trim()) return { error: "The editor is empty; no refinement request was sent." };
    if (draft.length > maxDraftChars) return { error: `The draft exceeds ${maxDraftChars} characters; no request was sent, and the existing result was kept.` };
    if (!selected) return { error: "No optimizer model is configured; use /refine model to select a text-generation model first." };
    const selection = resolveAvailableModel(ctx.modelRegistry, selected);
    if (selection.kind !== "available") {
      return { error: `Optimizer model is missing or unavailable: ${displayModel(selected)}; no request was sent, and the existing result was kept.` };
    }
    return { model: selection.model };
  }

  function captureOriginalInput(ctx: ExtensionContext, draft: string, choice?: RunModel): RefineRequestInput {
    const { context, projectContext: projectConfig, systemPrompt } = readConfig();
    // Read text only from projected messages. The source entry still holds the unedited original.
    const entries = ctx.sessionManager.buildSessionProjection().entries.flatMap(({ sourceEntry, messages }) =>
      sourceEntry.type === "message" ? messages.map((message) => ({ type: "message", id: sourceEntry.id, message })) : []);
    const history = selectHistory(entries, context.maxMessages, context.maxChars);
    const project = projectConfig.enabled ? {
      cwd: ctx.cwd, snapshot: captureProjectContext(ctx, projectConfig, draft),
      revisionSnapshot: captureProjectContext(ctx, projectConfig, draft, true), config: structuredClone(projectConfig),
    } : undefined;
    const preferences = initialPreferences(ctx);
    const generateTitle = canNameSession(ctx);
    return {
      draft, model: choice?.model ?? controller.getModel() ?? { provider: "", id: "" },
      ...(choice ? { thinkingLevel: choice.thinking } : {}),
      ...(preferences.length ? { preferences, editingInstruction: composeRevision(preferences, "") } : {}),
      generateTitle, systemPrompt: buildRefineSystemPrompt(generateTitle, systemPrompt),
      sessionId: ctx.sessionManager.getSessionId(), branchLeafId: ctx.sessionManager.getLeafId(), history,
      ...(project ? { project } : {}),
    };
  }

  function triggerOptimize(ctx: ExtensionContext, force = false, suppliedDraft?: string, keepEditor = false,
    mode: "run" | "capture" | "shortcut" = "run"): TriggerResult | undefined {
    useContext(ctx);
    if (ctx.mode !== "tui") {
      notify(ctx, "Background prompt refinement is only available in TUI mode; no model request was sent.", "warning");
      return;
    }
    const draft = suppliedDraft ?? ctx.ui.getEditorText();
    // Pi clears the editor on slash-command submission. Keep the supplied source
    // available for retry/accept/restore, but never overwrite another draft.
    if (!keepEditor && suppliedDraft !== undefined && !ctx.ui.getEditorText()) ctx.ui.setEditorText(draft);
    const check = checkOptimization(ctx, draft);
    if ("error" in check) {
      notify(ctx, check.error, draft.trim() ? "warning" : "info");
      return;
    }
    const { model } = check;
    const selected = modelRef(model);
    const { maxDraftChars, thinkingLevel } = readConfig();

    setCompletionContext(ctx);
    const input = captureOriginalInput(ctx, draft, { model: selected, thinking: effectiveThinkingLevel(model, thinkingLevel, ctx.thinkingLevel) });
    const previousContext = { historySnapshot, projectLabel, projectWarnings };
    historySnapshot = input.history;
    const project = input.project?.snapshot;
    projectLabel = project ? `${project.instructionCount} rules · ${project.skillCount} skills${input.project?.config?.tree.enabled && !input.history.text ? " · tree" : ""}` : "";
    projectWarnings = project?.warnings ?? [];
    const defaultsTooLong = (input.editingInstruction?.length ?? 0) > maxDraftChars;
    const tooMany = (input.preferences?.length ?? 0) > PREFERENCE_SELECTION_LIMIT;
    let result = mode === "run" ? controller.trigger(input, { force }) : mode === "shortcut" ? controller.createDraft(input) : controller.capture(input);
    if (mode === "shortcut" && result.kind === "captured" && !defaultsTooLong) {
      // Start the captured source in place. If admission is rejected, keep it editable.
      const started = controller.startRecord(result.recordId, selected, input.thinkingLevel);
      if (started.kind === "started") result = started;
      else notify(ctx, `Request not started (${started.kind}); draft kept as Unsent.`, "warning");
    }
    if (result.kind !== "started") {
      ({ historySnapshot, projectLabel, projectWarnings } = previousContext);
    }
    if (result.kind === "empty") notify(ctx, "The editor is empty; no refinement request was sent.", "info");
    else if (result.kind === "too-long") notify(ctx, tooMany ? `Select at most ${PREFERENCE_SELECTION_LIMIT} preferences before optimizing; no request was sent.`
      : `The draft or editing requirements exceed ${maxDraftChars} characters; no request was sent. Reduce the text or selection and try again.`, "warning");
    else if (result.kind === "duplicate" || result.kind === "ready") {
      void showPreview(ctx).catch(() => notifyCurrent("Could not open the refinement panel; the main draft was not changed.", "warning"));
    }
    else if (result.kind === "busy") notify(ctx, "Work is pending or the 100-entry journal is full. Existing work kept.", "warning");
    if (result.kind === "captured" && defaultsTooLong) {
      const scope = input.preferences?.every((entry) => entry.selectionSource === "project-default") ? "Project defaults" : "Initial preferences";
      notify(ctx, `${scope} exceed ${maxDraftChars} characters. Reduce the selection or use c to clear all in Preferences before optimizing.`, "warning");
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
    const check = checkOptimization(ctx, input.draft);
    if ("error" in check) { notify(ctx, check.error, "warning"); return; }
    setCompletionContext(ctx);
    historySnapshot = input.history;
    projectLabel = "Frozen input";
    projectWarnings = [];
    const result = controller.trigger({ ...input, model: modelRef(check.model),
      thinkingLevel: effectiveThinkingLevel(check.model, readConfig().thinkingLevel, ctx.thinkingLevel),
    }, { force: true, sameTask: true });
    if (result.kind !== "started") notify(ctx, "Same-input generation was not started; current results kept.", "warning");
  }

  function reviseCandidate(ctx: ExtensionContext, token: CandidateToken, instruction: string, resultNotes?: RevisionInput["resultNotes"]): string | number {
    const { maxDraftChars, projectContext, thinkingLevel } = readConfig();
    if (!controller.isCandidateCurrent(token) || controller.getState().pendingSend) return "The result changed or is being sent. Reopen Revise for the current result.";
    if (!instruction.trim()) return "Enter revision instructions; the current result is unchanged.";
    if (instruction.length > maxDraftChars) return `Revision instructions exceed ${maxDraftChars} characters; the current result is unchanged.`;
    const source = controller.getCandidate()!;
    if (source.contextUnavailable) return RESTORED_CONTEXT_HINT;
    const check = checkOptimization(ctx, source.draft, source.model);
    if ("error" in check) return check.error;
    const generateTitle = source.generateTitle;
    const project = source.project?.revisionSnapshot ?? source.project?.snapshot;
    const previousContext = { historySnapshot, projectLabel, projectWarnings };
    historySnapshot = source.history;
    projectLabel = project ? `${project.instructionCount} rules · ${project.skillCount} skills${(source.project?.config ?? projectContext).tree.enabled && !source.history.text ? " · tree" : ""}` : "";
    projectWarnings = project?.warnings ?? [];
    setCompletionContext(ctx);
    const result = controller.trigger({
      draft: source.draft,
      revision: { previousCandidate: source.text, instruction, ...(resultNotes ? { resultNotes } : {}),
        previousInstruction: source.revision?.resultNotes?.promptInstruction ?? source.revision?.instruction },
      editingInstruction: source.editingInstruction,
      preferences: source.preferences,
      model: source.model,
      thinkingLevel: effectiveThinkingLevel(check.model, thinkingLevel, ctx.thinkingLevel),
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
    return result.recordId;
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
  return { checkOptimization, captureOriginalInput, triggerOptimize, generateSameInput, reviseCandidate, contextLabel, clearContext, reportProject };
}
