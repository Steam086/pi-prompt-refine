import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { UserMessage } from "@earendil-works/pi-ai";
import type { RefineConfig } from "../config.js";
import type { RefineController } from "../controller.js";
import type { RefineRequest, RefineCompletion } from "../request-types.js";
import { buildRefineInput, parseRefineOutput } from "../context.js";
import { preserveDroppedTuiReference } from "../reference-preservation.js";
import { budgetRequest } from "../budget.js";
import { assembleProjectContext, collectDirectoryContext, type TreeSnapshot } from "../project-context.js";
import { readRunUsage } from "../usage.js";
import { displayModel, sameModel } from "./model-utils.js";
import { directoryJobKeys, type createContextJobs } from "./context-jobs.js";
import { finalResponseText } from "./provider-response.js";

type CompletionContext = { sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId">;
  modelRegistry: Pick<ExtensionContext["modelRegistry"], "find" | "getAvailable" | "isUsingOAuth" | "streamSimple"> };
interface CompletionDependencies<Context extends CompletionContext> {
  config: Pick<RefineConfig, "maxOutputTokens" | "projectContext">;
  getContext(): Context | undefined;
  getSessionId(): string | undefined;
  directorySnapshot: ReturnType<typeof createContextJobs>["directorySnapshot"];
  capturePreparedInput: RefineController["capturePreparedInput"];
  captureBudget: RefineController["captureBudget"];
  onOptimizerRequest(): void;
  reportProject(ctx: Context, request: RefineRequest, warnings: string[], referencedDirectoryCount: number): void;
  notify(ctx: Context, message: string, type?: "info" | "warning" | "error"): void;
  notifyIfSameSession(sessionId: string, message: string): void;
}

export function createCompletion<Context extends CompletionContext>({ config, getContext, getSessionId, directorySnapshot,
  capturePreparedInput, captureBudget, onOptimizerRequest, reportProject, notify, notifyIfSameSession }: CompletionDependencies<Context>) {
  return async (request: RefineRequest, signal: AbortSignal): Promise<RefineCompletion> => {
    const ctx = getContext();
    if (!ctx || ctx.sessionManager.getSessionId() !== request.sessionId || getSessionId() !== request.sessionId) {
      throw new Error("Execution context unavailable or stale");
    }
    const model = ctx.modelRegistry.find(request.model.provider, request.model.id);
    if (!model) throw new Error(`Unknown model ${displayModel(request.model)}`);
    const available = ctx.modelRegistry.getAvailable().some((candidate) => sameModel(candidate, request.model));
    if (!available) throw new Error(`Model is not currently available: ${displayModel(request.model)}`);

    const systemPrompt = request.systemPrompt;
    // Freeze runtime limits before asynchronous directory collection. Settings
    // changes must not alter a request that has already started.
    const outputLimit = config.maxOutputTokens;
    let projectText = "";
    let diagnostics = request.projectDiagnostics;
    const projectConfig = structuredClone(request.project?.config ?? config.projectContext);
    if (request.project && request.preparedInput === undefined) {
      // History gates only the default tree; explicit @directories are independent.
      const project = request.project;
      const { source, baseKey, referenceKey } = directoryJobKeys(request);
      // Reserve fixed shares so a frozen default tree and prompt-specific references
      // cannot double the configured per-request listing budgets. Both scopes run
      // under the same wall-clock collection deadline (in parallel).
      const sharedTreeBudget = !request.history.text && projectConfig.tree.enabled && projectConfig.referencedDirectories.enabled;
      const directoryConfig = sharedTreeBudget ? { ...projectConfig, tree: { ...projectConfig.tree,
        maxChars: Math.max(0, Math.floor((projectConfig.tree.maxChars - 2) / 2)),
        maxEntries: Math.floor(projectConfig.tree.maxEntries / 2),
        maxScannedEntries: Math.floor(projectConfig.tree.maxScannedEntries / 2),
      } } : projectConfig;
      const [base, references] = await Promise.all([
        directorySnapshot(baseKey, (sharedSignal) => collectDirectoryContext(project.cwd, "", directoryConfig, !request.history.text, sharedSignal)),
        directorySnapshot(referenceKey, (sharedSignal) => collectDirectoryContext(project.cwd, source, directoryConfig, false, sharedSignal)),
      ]);
      const tree: TreeSnapshot = { text: [base.text, references.text].filter(Boolean).join("\n\n"),
        warnings: [...new Set([...base.warnings, ...references.warnings])], referencedDirectoryCount: references.referencedDirectoryCount };
      if (signal.aborted) throw new Error("Context collection cancelled");
      const assembled = assembleProjectContext(request.project.snapshot, tree, projectConfig);
      projectText = assembled.text;
      diagnostics = { warnings: assembled.warnings, referencedDirectoryCount: assembled.text.includes("REFERENCED DIRECTORY:") ? tree.referencedDirectoryCount ?? 0 : 0 };
      reportProject(ctx, request, assembled.warnings, diagnostics.referencedDirectoryCount);
    }

    const preparedInput = request.preparedInput ?? buildRefineInput(request.draft, request.history, projectText, request.revision, request.editingInstruction, request.preferences);
    if (signal.aborted) throw new Error("Request cancelled");
    capturePreparedInput(request.requestId, request.generation, preparedInput, diagnostics);
    const budget = budgetRequest(systemPrompt, preparedInput, model, outputLimit, request.thinkingLevel);
    const blocked = budget.report.status === "blocked";
    captureBudget(request.requestId, request.generation, budget.report, blocked ? undefined : budget.input);
    if (budget.report.message && getSessionId() === request.sessionId && !signal.aborted) {
      notify(ctx, `⚠ Refine #${request.recordId}: ${budget.report.message}`, "warning");
    }
    if (blocked) return { text: "", stopReason: "budget" };
    if (signal.aborted) throw new Error("Request cancelled");
    const userMessage: UserMessage = {
      role: "user",
      content: [{ type: "text", text: budget.input }],
      timestamp: Date.now(),
    };
    const usageOptions = {
      hasPricing: [model.cost?.input, model.cost?.output, model.cost?.cacheRead, model.cost?.cacheWrite].some((rate) => typeof rate === "number" && rate > 0),
      subscription: ctx.modelRegistry.isUsingOAuth(model),
    };
    onOptimizerRequest();
    const response = await ctx.modelRegistry.streamSimple(
      model,
      { systemPrompt, messages: [userMessage], tools: [] },
      {
        signal,
        maxTokens: budget.maxTokens,
        ...(budget.thinkingBudgets ? { thinkingBudgets: budget.thinkingBudgets } : {}),
        ...(request.thinkingLevel && request.thinkingLevel !== "off" ? { reasoning: request.thinkingLevel } : {}),
      },
    ).result();
    const stopReason = response.content.some((block) => block.type === "toolCall") ? "toolUse" : response.stopReason;
    const parsed = stopReason === "stop" ? parseRefineOutput(finalResponseText(response.content)) : undefined;
    const guarded = parsed && !request.revision ? preserveDroppedTuiReference(request.draft, parsed.text, request.editingInstruction) : undefined;
    if (guarded?.restored && !signal.aborted) notifyIfSameSession(request.sessionId,
      `Refine #${request.recordId} omitted most of a pasted TUI reference. Original draft kept; review the result before accepting.`);
    return {
      text: guarded?.text ?? parsed?.text ?? "",
      title: request.generateTitle && !guarded?.restored ? parsed?.title : undefined,
      invalidOutput: stopReason === "stop" && !parsed,
      stopReason,
      usage: readRunUsage(response.usage, usageOptions),
    };
  };
}
