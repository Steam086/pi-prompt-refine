import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ConfigReader } from "../config.js";
import { REFINE_SYSTEM_PROMPT, type RevisionInput } from "../context.js";
import type { PreferenceStore } from "../preference-store.js";
import type { RefineController } from "../controller.js";
import type { CandidateToken, RefineRequestInput, TriggerResult } from "../request-types.js";
import type { HistoryStorageStatus } from "../history-store.js";
import type { TuiOperations } from "../adapters/tui-operations.js";
import type { RefineWorkspace } from "../workspace.js";
import type { RevisionDraft } from "../revision-preferences.js";
import type { TaskPanelPosition } from "../task-panel.js";
import type { createRequestFlows } from "./request-flows.js";
import type { createConfigService } from "./config-service.js";
import type { SessionPreferences } from "./session-preferences.js";
import { displayModel, effectiveThinkingLevel, modelRef, sameModel, thinkingSource } from "./model-utils.js";
import { RESTORED_CONTEXT_HINT, type Notify, type WorkspaceSelection } from "./contracts.js";

type WorkspaceOptions = ConstructorParameters<typeof RefineWorkspace>[4];
interface WorkspaceActionsDependencies {
  controller: Pick<RefineController,
    "applyResult" | "deleteRecords" | "getAppliedRecordId" | "getCandidate" |
    "getCandidateToken" | "getGeneration" | "getTaskDisplayRecords" | "getModel" | "getOriginalRecord" | "getRecord" |
    "getRunElapsed" | "getSessionId" | "getState" | "hasWorkspaceContent" | "isCandidateCurrent" | "updateDraftPreferences">;
  readConfig: ConfigReader<"preferencesKey" | "maxDraftChars" | "projectContext" | "thinkingLevel" | "systemPrompt">;
  settings: Pick<ReturnType<typeof createConfigService>, "contextSettings" | "saveContext" | "saveSystemPrompt">;
  setCompletionContext(ctx: ExtensionContext): void;
  saveOptimizer(model: RefineRequestInput["model"], thinking: NonNullable<RefineRequestInput["thinkingLevel"]> | "inherit"): Promise<boolean>;
  historyStorage(ctx: ExtensionContext, sessionId: string): HistoryStorageStatus;
  checkOptimization: ReturnType<typeof createRequestFlows>["checkOptimization"];
  operations: TuiOperations;
  triggerOptimize: ReturnType<typeof createRequestFlows>["triggerOptimize"];
  reviseCandidate(ctx: ExtensionContext, token: CandidateToken, instruction: string, resultNotes?: RevisionInput["resultNotes"]): string | undefined;
  registeredModels(ctx: ExtensionContext): ReturnType<ExtensionContext["modelRegistry"]["getAvailable"]>;
  showOptimizerQuota(): boolean;
  notify: Notify;
  preferenceRepository(ctx: ExtensionContext): PreferenceStore;
  sessionPreferences: SessionPreferences;
}
interface WorkspaceMount {
  ctx: ExtensionContext;
  sessionId: string;
  isClosed(): boolean;
  isUsage(): boolean;
  position: TaskPanelPosition;
  usagePosition: TaskPanelPosition;
  openModelPicker(id?: number, origin?: "settings"): void;
  finish(value?: WorkspaceSelection): void;
}

export function createWorkspaceActions({ controller, readConfig, settings, setCompletionContext,
  historyStorage, checkOptimization, operations, triggerOptimize, reviseCandidate,
  registeredModels, showOptimizerQuota, notify, preferenceRepository, sessionPreferences, saveOptimizer }: WorkspaceActionsDependencies) {
  // Runtime-only drafts survive overlay mounts, but never enter history persistence.
  const inputDrafts = new Map<string, string>();
  const revisionDrafts = new Map<string, RevisionDraft>();
  return ({ ctx, sessionId, isClosed, isUsage, position, usagePosition,
    openModelPicker, finish }: WorkspaceMount): WorkspaceOptions => {
    const runRecord = (id: number) => {
      if (isClosed() || ctx.sessionManager.getSessionId() !== sessionId) return;
      const record = controller.getRecord(id);
      if (!record) return;
      if (record.input.contextUnavailable) { notify(ctx, RESTORED_CONTEXT_HINT, "info"); return; }
      const check = checkOptimization(ctx, record.input.draft);
      if ("error" in check) { notify(ctx, check.error, "warning"); return; }
      setCompletionContext(ctx);
      const thinking = effectiveThinkingLevel(check.model, readConfig().thinkingLevel, ctx.thinkingLevel);
      const result = operations.start(id, modelRef(check.model), thinking);
      if (result.kind !== "started") notify(ctx, `Request not started (${result.kind}); existing work kept.`, "info");
    };
    const currentSession = () => !isClosed() && ctx.sessionManager.getSessionId() === sessionId && controller.getSessionId() === sessionId;
    return {
      preferences: { repository: preferenceRepository(ctx), key: readConfig().preferencesKey, get maxChars() { return readConfig().maxDraftChars; } },
      sessionPreferences: sessionPreferences.target(sessionId, currentSession, () => readConfig().maxDraftChars),
      draftPreferences: (id, original) => {
        if (!currentSession()) return undefined;
        const source = id === undefined ? undefined : original ? controller.getOriginalRecord(id) : controller.getRecord(id);
        if (id !== undefined && !source) return undefined;
        const selected = source?.input.preferences ?? [];
        // A request (including its original row) only exposes adopted snapshots.
        if (!source || !original || source.status !== "unsent" || source.input.contextUnavailable || controller.getState().pendingSend ||
          (!isUsage() && source.archivedAt !== undefined)) return { selected };
        let expected = source;
        return {
          selected,
          save: (selected) => {
            if (!currentSession()) return "Session changed; no selection applied.";
            const error = controller.updateDraftPreferences(expected, selected);
            if (!error) expected = controller.getRecord(source.id) ?? expected;
            return error;
          },
        };
      },
      original: (id) => {
        if (isClosed() || ctx.sessionManager.getSessionId() !== sessionId) return undefined;
        const source = id === undefined ? undefined : controller.getOriginalRecord(id);
        if (id !== undefined && !source) return undefined;
        const inPlace = source?.status === "unsent" && source.archivedAt === undefined;
        const text = source?.input.draft ?? "";
        const created = inPlace ? undefined : operations.create(text);
        if (!inPlace && created?.kind !== "captured") {
          notify(ctx, `Could not create draft (${created?.kind}); existing work kept.`, "warning");
          return undefined;
        }
        const targetId = inPlace ? source.id : (created as Extract<TriggerResult, { kind: "captured" }>).recordId;
        const target = controller.getRecord(targetId)!;
        const targetVersion = operations.version(targetId);
        const targetPosition = isUsage() ? usagePosition : position;
        const previousPosition = { ...targetPosition };
        Object.assign(targetPosition, { selectedId: targetId, selectedTaskId: target.taskId, scroll: 0 });
        return {
          text,
          save: (value) => {
            if (isClosed() || ctx.sessionManager.getSessionId() !== sessionId || controller.getSessionId() !== sessionId) return "Session changed; draft not saved.";
            if (value.length > readConfig().maxDraftChars) return `The draft exceeds ${readConfig().maxDraftChars} characters.`;
            return operations.update(targetId, targetVersion, value) ? undefined : "The draft or conversation context changed; cancel and reopen to edit a new copy.";
          },
          cancel: () => {
            if (!inPlace && controller.getSessionId() === sessionId) operations.discard(targetId, targetVersion);
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
      history: () => controller.getTaskDisplayRecords(),
      historyStorage: () => historyStorage(ctx, sessionId),
      taskPosition: position,
      usagePosition,
      tasks: {
        records: () => controller.getTaskDisplayRecords(),
        elapsedSeconds: (id) => controller.getRunElapsed(id),
        launchModel: () => controller.getModel() ? displayModel(controller.getModel()!) : "No model",
        showOptimizerQuota,
        appliedId: () => controller.getAppliedRecordId(),
        activate: (id) => {
          const record = controller.getRecord(id);
          if (record?.status === "unsent") { runRecord(id); return false; }
          return controller.applyResult(id);
        },
        run: (id) => runRecord(id),
        stop: (id) => { operations.stop(id); },
        deleteRecords: (ids) => !isClosed() && ctx.sessionManager.getSessionId() === sessionId && controller.deleteRecords(ids),
        chooseModel: (id) => openModelPicker(id),
        accept: (id) => {
          if (controller.applyResult(id)) finish({ action: "accept", generation: controller.getGeneration(), token: controller.getCandidateToken() });
          else notify(ctx, "Result unavailable or send pending; nothing accepted.", "warning");
        },
      },
      context: settings.contextSettings,
      contextEnabled: () => readConfig().projectContext.enabled,
      optimizer: () => {
        const { thinkingLevel } = readConfig();
        const ref = controller.getModel();
        const model = registeredModels(ctx).find((candidate) => ref && sameModel(candidate, ref));
        const thinkingEnabled = !!model && getSupportedThinkingLevels(model).length > 1;
        return {
          model: ref ? displayModel(ref) : "Not configured",
          thinking: !model ? "Unavailable" : !thinkingEnabled ? "Fixed"
            : effectiveThinkingLevel(model, thinkingLevel, ctx.thinkingLevel),
          thinkingDetail: !model ? "To change thinking, select an available model first."
            : !thinkingEnabled ? "Thinking is fixed for this model."
            : `${thinkingSource(thinkingLevel, ctx.thinkingLevel)}. Changes save immediately.`,
          thinkingEnabled,
        };
      },
      chooseModel: () => openModelPicker(undefined, "settings"),
      editSystemPrompt: () => {
        if (!currentSession()) return undefined;
        const generation = controller.getGeneration();
        const original = readConfig().systemPrompt;
        return {
          text: original ?? REFINE_SYSTEM_PROMPT,
          save: async (text) => {
            if (!currentSession() || controller.getGeneration() !== generation) {
              return { message: "Not persisted · Context or policy changed. Reopen to edit.", persisted: false };
            }
            switch (await settings.saveSystemPrompt(original, text)) {
              case "stale": return { message: "Not persisted · Context or policy changed. Reopen to edit.", persisted: false };
              case "empty": return { message: "Not persisted · Prompt cannot be empty.", persisted: false };
              case "unchanged": return { message: "No optimization prompt changes.", persisted: true };
              case "saved": return { message: "Optimization prompt saved · Applies next round", persisted: true };
              case "memory-only": return { message: "Not persisted · Policy applied in this process only", persisted: false };
            }
          },
        };
      },
      cycleThinking: async () => {
        if (!currentSession()) return { message: "Session changed; settings not saved.", persisted: false };
        const ref = controller.getModel();
        const model = registeredModels(ctx).find((candidate) => ref && sameModel(candidate, ref));
        if (!model) return { message: "Choose an available model first.", persisted: false };
        const levels = getSupportedThinkingLevels(model);
        if (levels.length <= 1) return { message: "Thinking level is fixed for this model.", persisted: false };
        const current = effectiveThinkingLevel(model, readConfig().thinkingLevel, ctx.thinkingLevel);
        const next = levels[(levels.indexOf(current) + 1) % levels.length]!;
        const persisted = await saveOptimizer(ref!, next);
        return { message: persisted ? "Thinking level saved" : "Not persisted · Thinking applied in this process only", persisted };
      },
      saveContext: async (selected) => {
        if (!currentSession()) return { message: "Session changed; settings not saved.", persisted: false };
        const persisted = await settings.saveContext(selected);
        return { message: persisted ? "Settings saved · Context applies to next round; limits apply to new work"
          : "Not persisted · Settings applied in this process only", persisted };
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
          label: `#${controller.getCandidate()!.recordId ?? "?"} · ${displayModel(controller.getCandidate()!.model)}`,
          validateSelection: () => {
            if (isClosed() || ctx.sessionManager.getSessionId() !== sessionId) return "Session changed; no selection applied.";
            if (!controller.isCandidateCurrent(token) || controller.getState().pendingSend) return "The result changed or is being sent. Reopen Revise for the current result.";
            return undefined;
          },
          submit: (text: string, resultNotes?: RevisionInput["resultNotes"]) => {
            if (isClosed() || ctx.sessionManager.getSessionId() !== sessionId) return "Session changed; no request sent.";
            return reviseCandidate(ctx, token, text, resultNotes);
          },
        };
      },
      submit: (text) => {
        if (isClosed() || ctx.sessionManager.getSessionId() !== sessionId) return "Session changed; no request sent.";
        const check = checkOptimization(ctx, text);
        if ("error" in check) return check.error;
        const result = triggerOptimize(ctx, true, text, true, controller.hasWorkspaceContent() ? "capture" : "run");
        return result && ["started", "captured", "duplicate", "ready"].includes(result.kind) ? undefined : "Could not add input; existing work kept.";
      },
    };
  };
}
