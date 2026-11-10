import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RefineConfig } from "../config.js";
import { PreferenceStore } from "../preference-store.js";
import type { RefineController } from "../controller.js";
import type { CandidateToken, RefineRequestInput, TriggerResult } from "../request-types.js";
import type { HistoryStorageStatus } from "../history-store.js";
import type { RefineWorkspace } from "../workspace.js";
import type { RevisionDraft } from "../revision-preferences.js";
import type { TaskPanelPosition } from "../task-panel.js";
import { displayModel, effectiveThinkingLevel, sameModel, thinkingSource } from "./model-selection.js";
import { RESTORED_CONTEXT_HINT, type Notify, type WorkspaceSelection } from "./contracts.js";

type WorkspaceOptions = ConstructorParameters<typeof RefineWorkspace>[4];
interface WorkspaceActionsDependencies {
  controller: Pick<RefineController,
    "applyResult" | "createDraft" | "deleteRecords" | "getAppliedRecordId" | "getCandidate" |
    "getCandidateToken" | "getGeneration" | "getHistory" | "getModel" | "getOriginalRecord" | "getRecord" |
    "getSessionId" | "getState" | "hasWorkspaceContent" | "removeDraft" | "runOriginal" | "startRecord" |
    "stopRequest" | "updateDraft" | "updateDraftPreferences">;
  config: Pick<RefineConfig, "preferencesKey" | "maxDraftChars" | "projectContext" | "context" | "maxOutputTokens" | "timeoutMs" | "thinkingLevel">;
  setCompletionContext(ctx: ExtensionContext): void;
  persistConfig(ctx: ExtensionContext): Promise<boolean>;
  historyStorage(ctx: ExtensionContext, sessionId: string): HistoryStorageStatus;
  optimizationError(ctx: ExtensionContext, draft: string): string | undefined;
  draftInput(ctx: ExtensionContext, draft: string): RefineRequestInput;
  triggerOptimize(ctx: ExtensionContext, force: boolean, draft: string, keepEditor: boolean, captureOnly: boolean): TriggerResult | undefined;
  reviseCandidate(ctx: ExtensionContext, token: CandidateToken, instruction: string): string | undefined;
  registeredModels(ctx: ExtensionContext): ReturnType<ExtensionContext["modelRegistry"]["getAvailable"]>;
  rememberThinking(model: RefineRequestInput["model"], level: NonNullable<RefineRequestInput["thinkingLevel"]>): boolean;
  notify: Notify;
}
interface WorkspaceMount {
  ctx: ExtensionContext;
  sessionId: string;
  isClosed(): boolean;
  isUsage(): boolean;
  position: TaskPanelPosition;
  usagePosition: TaskPanelPosition;
  openModelPicker(id?: number): void;
  finish(value?: WorkspaceSelection): void;
}

export function createWorkspaceActions({ controller, config, setCompletionContext, persistConfig,
  historyStorage, optimizationError, draftInput, triggerOptimize, reviseCandidate,
  registeredModels, rememberThinking, notify }: WorkspaceActionsDependencies) {
  // Runtime-only drafts survive overlay mounts, but never enter history persistence.
  const inputDrafts = new Map<string, string>();
  const revisionDrafts = new Map<string, RevisionDraft>();
  function preferenceRepository(ctx: ExtensionContext): PreferenceStore {
    return new PreferenceStore(getAgentDir(), ctx.cwd);
  }
  return ({ ctx, sessionId, isClosed, isUsage, position, usagePosition,
    openModelPicker, finish }: WorkspaceMount): WorkspaceOptions => {
    const runRecord = (id: number, retry = false) => {
      if (isClosed() || ctx.sessionManager.getSessionId() !== sessionId) return;
      const record = controller.getRecord(id);
      if (!record) return;
      if (record.input.contextUnavailable) { notify(ctx, RESTORED_CONTEXT_HINT, "info"); return; }
      const error = optimizationError(ctx, record.input.draft);
      if (error) { notify(ctx, error, "warning"); return; }
      const selected = controller.getModel()!;
      const model = ctx.modelRegistry.find(selected.provider, selected.id)!;
      setCompletionContext(ctx);
      const thinking = effectiveThinkingLevel(model, config.thinkingLevel, ctx.thinkingLevel);
      const result = retry && record.status !== "unsent" ? controller.runOriginal(id, selected, thinking) : controller.startRecord(id, selected, thinking);
      if (result.kind !== "started") notify(ctx, `Request not started (${result.kind}); existing work kept.`, "info");
    };
    return {
      preferences: { repository: preferenceRepository(ctx), key: config.preferencesKey, get maxChars() { return config.maxDraftChars; } },
      draftPreferences: (id, original) => {
        if (isClosed() || ctx.sessionManager.getSessionId() !== sessionId || controller.getSessionId() !== sessionId) return undefined;
        const source = id === undefined ? undefined : original ? controller.getOriginalRecord(id) : controller.getRecord(id);
        if (id !== undefined && !source) return undefined;
        const selected = source?.input.preferences ?? [];
        // A request (including its original row) only exposes adopted snapshots.
        if (!source || !original || source.status !== "unsent" || source.input.contextUnavailable || controller.getState().pendingSend) return { selected };
        return {
          selected,
          save: (selected) => {
            if (isClosed() || ctx.sessionManager.getSessionId() !== sessionId || controller.getSessionId() !== sessionId) return "Session changed; no selection applied.";
            return controller.updateDraftPreferences(source, selected);
          },
        };
      },
      original: (id) => {
        if (isClosed() || ctx.sessionManager.getSessionId() !== sessionId) return undefined;
        const source = id === undefined ? undefined : controller.getOriginalRecord(id);
        if (id !== undefined && !source) return undefined;
        const inPlace = source?.status === "unsent" && source.archivedAt === undefined;
        const text = source?.input.draft ?? "";
        const created = inPlace ? undefined : controller.createDraft(draftInput(ctx, text));
        if (!inPlace && created?.kind !== "captured") {
          notify(ctx, `Could not create draft (${created?.kind}); existing work kept.`, "warning");
          return undefined;
        }
        const targetId = inPlace ? source.id : (created as Extract<TriggerResult, { kind: "captured" }>).recordId;
        const target = controller.getRecord(targetId)!;
        const targetPosition = isUsage() ? usagePosition : position;
        const previousPosition = { ...targetPosition };
        Object.assign(targetPosition, { selectedId: targetId, selectedTaskId: target.taskId, scroll: 0 });
        return {
          text,
          save: (value) => {
            if (isClosed() || ctx.sessionManager.getSessionId() !== sessionId || controller.getSessionId() !== sessionId) return "Session changed; draft not saved.";
            if (value.length > config.maxDraftChars) return `The draft exceeds ${config.maxDraftChars} characters.`;
            return controller.updateDraft(targetId, text, value) ? undefined : "The draft or conversation context changed; cancel and reopen to edit a new copy.";
          },
          cancel: () => {
            if (!inPlace && controller.getSessionId() === sessionId) controller.removeDraft(targetId);
            Object.assign(targetPosition, previousPosition);
            targetPosition.selectedTaskId = previousPosition.selectedTaskId;
            targetPosition.selectedId = previousPosition.selectedId;
          },
        };
      },
      inputCaptureOnly: () => controller.hasWorkspaceContent(),
      inputDraft: {
        text: inputDrafts.get(sessionId) ?? "",
        save: (text) => {
          if (isClosed() || ctx.sessionManager.getSessionId() !== sessionId) return;
          if (text) inputDrafts.set(sessionId, text);
          else inputDrafts.delete(sessionId);
        },
      },
      history: () => controller.getHistory(),
      historyStorage: () => historyStorage(ctx, sessionId),
      taskPosition: position,
      usagePosition,
      tasks: {
        records: () => controller.getHistory(),
        launchModel: () => controller.getModel() ? displayModel(controller.getModel()!) : "No model",
        appliedId: () => controller.getAppliedRecordId(),
        activate: (id) => {
          const record = controller.getRecord(id);
          if (record?.status === "unsent") { runRecord(id); return false; }
          return controller.applyResult(id);
        },
        run: (id) => runRecord(id, true),
        stop: (id) => controller.stopRequest(id),
        deleteRecords: (ids) => !isClosed() && ctx.sessionManager.getSessionId() === sessionId && controller.deleteRecords(ids),
        chooseModel: (id) => openModelPicker(id),
        accept: (id) => {
          if (controller.applyResult(id)) finish({ action: "accept", generation: controller.getGeneration(), token: controller.getCandidateToken() });
          else notify(ctx, "Result unavailable or send pending; nothing accepted.", "warning");
        },
      },
      context: () => ({
        instructions: !config.projectContext.instructionsEnabled ? "off" : config.projectContext.instructionsOnFollowUp ? "always" : "first",
        tree: config.projectContext.tree.enabled,
        skills: config.projectContext.skillsEnabled,
        enabled: config.projectContext.enabled,
        referencedDirectories: config.projectContext.referencedDirectories.enabled,
        maxMessages: config.context.maxMessages,
        historyMaxChars: config.context.maxChars,
        maxOutputTokens: config.maxOutputTokens,
        timeoutMs: config.timeoutMs,
        maxDraftChars: config.maxDraftChars,
      }),
      contextEnabled: () => config.projectContext.enabled,
      optimizer: () => {
        const ref = controller.getModel();
        const model = registeredModels(ctx).find((candidate) => ref && sameModel(candidate, ref));
        const thinkingEnabled = !!model && getSupportedThinkingLevels(model).length > 1;
        return {
          model: ref ? displayModel(ref) : "Not configured",
          thinking: !model ? "Unavailable — select an available model first"
            : !thinkingEnabled ? "Unavailable — fixed for this model"
            : `${effectiveThinkingLevel(model, config.thinkingLevel, ctx.thinkingLevel)} · ${thinkingSource(config.thinkingLevel, ctx.thinkingLevel)}`,
          thinkingEnabled,
        };
      },
      chooseModel: () => openModelPicker(),
      editSystemPrompt: (context) => finish({ action: "system-prompt", generation: controller.getGeneration(), settingsContext: context }),
      cycleThinking: async () => {
        if (isClosed() || ctx.sessionManager.getSessionId() !== sessionId) return { message: "Session changed; settings not saved.", persisted: false };
        const ref = controller.getModel();
        const model = registeredModels(ctx).find((candidate) => ref && sameModel(candidate, ref));
        if (!model) return { message: "Choose an available model first.", persisted: false };
        const levels = getSupportedThinkingLevels(model);
        if (levels.length <= 1) return { message: "Thinking level is fixed for this model.", persisted: false };
        const current = effectiveThinkingLevel(model, config.thinkingLevel, ctx.thinkingLevel);
        config.thinkingLevel = levels[(levels.indexOf(current) + 1) % levels.length];
        rememberThinking(model, config.thinkingLevel!);
        const persisted = await persistConfig(ctx);
        return { message: persisted ? "Thinking level saved" : "Thinking applied · Not persisted; check configuration", persisted };
      },
      saveContext: async (selected) => {
        if (isClosed() || ctx.sessionManager.getSessionId() !== sessionId) return { message: "Session changed; settings not saved.", persisted: false };
        config.projectContext.instructionsEnabled = selected.instructions !== "off";
        // Off leaves the saved follow-up preference intact.
        if (selected.instructions !== "off") config.projectContext.instructionsOnFollowUp = selected.instructions === "always";
        config.projectContext.tree.enabled = selected.tree;
        config.projectContext.skillsEnabled = selected.skills;
        config.projectContext.enabled = selected.enabled ?? config.projectContext.enabled;
        config.projectContext.referencedDirectories.enabled = selected.referencedDirectories ?? config.projectContext.referencedDirectories.enabled;
        config.context.maxMessages = selected.maxMessages ?? config.context.maxMessages;
        config.context.maxChars = selected.historyMaxChars ?? config.context.maxChars;
        config.maxOutputTokens = selected.maxOutputTokens ?? config.maxOutputTokens;
        config.timeoutMs = selected.timeoutMs ?? config.timeoutMs;
        config.maxDraftChars = selected.maxDraftChars ?? config.maxDraftChars;
        const persisted = await persistConfig(ctx);
        return { message: persisted ? "Settings saved · Context applies to next round; limits apply to new work"
          : "Settings applied · Not persisted; check configuration", persisted };
      },
      revisionDrafts,
      revision: (id) => {
        const source = id === undefined ? controller.getCandidate() : controller.getRecord(id)?.candidate;
        if (source?.contextUnavailable) { notify(ctx, RESTORED_CONTEXT_HINT, "info"); return undefined; }
        if (id !== undefined && !controller.applyResult(id)) return undefined;
        const token = controller.getCandidateToken();
        if (!token || controller.getState().pendingSend) return undefined;
        return {
          // Failure rebases generation but keeps this source identity; retain its feedback.
          key: `${token.sessionId}:${controller.getCandidate()?.recordId ?? token.requestId}`,
          label: `Run #${controller.getCandidate()!.recordId ?? "?"} · ${displayModel(controller.getCandidate()!.model)}`,
          submit: (text: string) => {
            if (isClosed() || ctx.sessionManager.getSessionId() !== sessionId) return "Session changed; no request sent.";
            return reviseCandidate(ctx, token, text);
          },
        };
      },
      submit: (text) => {
        if (isClosed() || ctx.sessionManager.getSessionId() !== sessionId) return "Session changed; no request sent.";
        const error = optimizationError(ctx, text);
        if (error) return error;
        const result = triggerOptimize(ctx, true, text, true, controller.hasWorkspaceContent());
        return result && ["started", "captured", "duplicate", "ready"].includes(result.kind) ? undefined : "Could not add input; existing work kept.";
      },
    };
  };
}
