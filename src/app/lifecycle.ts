import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RefineConfig, loadConfig } from "../config.js";
import type { RefineController } from "../controller.js";
import type { Candidate } from "../request-types.js";
import { HistoryStore, historyPath, type HistoryStorageStatus } from "../history-store.js";
import type { PreferenceStore } from "../preference-store.js";
import type { Notify } from "./contracts.js";

interface LifecycleDependencies {
  controller: Pick<RefineController,
    "getHistory" | "getModel" | "getSessionId" | "invalidateLifecycle" | "restoreHistory" | "setSession">;
  config: Pick<RefineConfig, "historyPersistence" | "shortcuts">;
  loaded: Awaited<ReturnType<typeof loadConfig>>;
  getUiContext(): ExtensionContext | undefined;
  setUiContext(ctx: ExtensionContext | undefined): void;
  clearCompletionContext(): void;
  closePreview(): void;
  refreshPreview(): void;
  clearContextJobs(): void;
  preferenceRepository(ctx: ExtensionContext): PreferenceStore;
  getSessionName: ExtensionAPI["getSessionName"];
  setSessionName: ExtensionAPI["setSessionName"];
  notify: Notify;
}

export function createLifecycle({ controller, config, loaded, getUiContext, setUiContext,
  clearCompletionContext, closePreview, refreshPreview, clearContextJobs, preferenceRepository,
  getSessionName, setSessionName, notify }: LifecycleDependencies) {
  let historyStore: HistoryStore | undefined;
  let historyEpoch = 0;
  // Session-wide, not branch/workflow state; rebuilt from Pi metadata on resume.
  const namedSessions = new Set<string>();
  function canNameSession(ctx: ExtensionContext): boolean {
    const sessionId = ctx.sessionManager.getSessionId();
    if (getSessionName()?.trim()) namedSessions.add(sessionId);
    return !namedSessions.has(sessionId);
  }

  function applySessionTitle(candidate: Candidate): void {
    const ctx = getUiContext();
    if (!ctx || !candidate.title || candidate.sessionId !== ctx.sessionManager.getSessionId() ||
      candidate.sessionId !== controller.getSessionId() || !canNameSession(ctx)) return;
    try {
      // Rechecked at commit time; never overwrite a name set while the model/UI was waiting.
      setSessionName(candidate.title);
      namedSessions.add(candidate.sessionId);
    } catch {
      notify(ctx, "Prompt accepted, but session naming failed. Existing name kept.", "warning");
    }
  }

  function saveHistory(): void {
    if (config.historyPersistence && historyStore && historyStore.sessionId === controller.getSessionId()) historyStore.save(controller.getHistory());
  }
  function historyStorage(ctx: ExtensionContext, sessionId: string): HistoryStorageStatus {
    const file = ctx.sessionManager.getSessionFile();
    const records = controller.getHistory();
    if (config.historyPersistence && historyStore?.sessionId === sessionId) return historyStore.getStatus(records);
    return { state: !config.historyPersistence ? "disabled" : !file ? "no-session-file" : "unavailable",
      path: file ? historyPath(file) : undefined, savedIds: [], omittedIds: [],
      memoryOnlyIds: records.filter((record) => record.input.sessionId === sessionId && record.status !== "unsent").map((record) => record.id) };
  }
  async function clearHistory(ctx: ExtensionContext): Promise<void> {
    const file = ctx.sessionManager.getSessionFile();
    if (!file) { notify(ctx, "This session has no saved history file.", "info"); return; }
    if (!ctx.hasUI) { notify(ctx, "Clearing history requires confirmation in interactive mode.", "warning"); return; }
    const sessionId = ctx.sessionManager.getSessionId();
    const epoch = historyEpoch;
    if (!await ctx.ui.confirm("Clear saved Refine history?", "Delete this session's Refine sidecar only. In-memory records stay visible; saving pauses until reload. Pi conversation is unchanged.")) return;
    if (epoch !== historyEpoch || sessionId !== controller.getSessionId()) return;
    historyStore ??= new HistoryStore(historyPath(file), sessionId, (message) => notify(ctx, message, "warning"), () => {
      if (sessionId === controller.getSessionId()) refreshPreview();
    });
    try {
      await historyStore.clear();
      if (epoch !== historyEpoch) return;
      notify(ctx, "Saved Refine history cleared. Saving paused until reload; in-memory records and Pi conversation unchanged.", "info");
    } catch { if (epoch === historyEpoch) notify(ctx, "Could not delete saved Refine history. Saving is paused; check file permissions.", "warning"); }
  }
  async function start(event: { reason: string }, ctx: ExtensionContext): Promise<void> {
    const epoch = ++historyEpoch;
    const previousStore = historyStore;
    historyStore = undefined;
    setUiContext(ctx);
    // Include abandoned branches: session names are session-wide. A later explicit
    // clear must not re-enable automatic naming after a resume or /reload either.
    if (ctx.sessionManager.getEntries().some((entry) => entry.type === "session_info" && entry.name?.trim())) {
      namedSessions.add(ctx.sessionManager.getSessionId());
    }
    canNameSession(ctx);
    controller.setSession(ctx.sessionManager.getSessionId());
    const [preferences] = await Promise.all([preferenceRepository(ctx).load(), previousStore?.flush()]);
    if (epoch !== historyEpoch) return;
    for (const warning of Object.values(preferences.errors)) notify(ctx, `Preferences: ${warning}`, "warning");
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (config.historyPersistence && sessionFile) {
      const store = new HistoryStore(historyPath(sessionFile), ctx.sessionManager.getSessionId(), (message) => {
        if (store.sessionId === controller.getSessionId()) notify(ctx, message, "warning");
      }, () => {
        if (historyStore === store) refreshPreview();
      });
      const records = await store.load();
      if (epoch !== historyEpoch) return;
      controller.restoreHistory(records);
      historyStore = store;
      refreshPreview();
      if (records.length) notify(ctx, `Restored ${records.length} Refine runs · background not saved · /refine history`, "info");
    }
    for (const warning of loaded.warnings) notify(ctx, warning, "warning");
    if (loaded.shortcutsMigrated) notify(ctx, "Prompt Refine legacy default shortcuts were migrated to Control+\\; the original configuration file was not rewritten, and custom shortcuts are unchanged.", "info");
    if (ctx.mode === "tui" && event.reason === "startup") {
      const key = config.shortcuts.optimize?.replace(/ctrl/g, "Ctrl").replace(/\+/g, " + ");
      const setup = controller.getModel() ? "" : " No optimizer model selected; use /refine model.";
      notify(ctx, `Prompt Refine: Use ${key ?? "/refine optimize"} to refine your prompt.${setup}${config.historyPersistence && sessionFile ? " Minimal prompt/result history is saved beside this session; no full background. Disable with historyPersistence=false." : ""}`);
    }
  }
  function beforeTransition(ctx: ExtensionContext): void {
    setUiContext(ctx);
    closePreview();
    controller.invalidateLifecycle(true);
    setUiContext(undefined);
  }
  function tree(ctx: ExtensionContext): void {
    setUiContext(ctx);
    controller.invalidateLifecycle(true);
  }
  async function shutdown(ctx: ExtensionContext): Promise<void> {
    historyEpoch++;
    setUiContext(ctx);
    closePreview();
    controller.invalidateLifecycle(true);
    setUiContext(undefined);
    clearCompletionContext();
    clearContextJobs();
    const store = historyStore;
    historyStore = undefined;
    await store?.flush();
  }

  return { canNameSession, applySessionTitle, saveHistory, historyStorage, clearHistory, start, beforeTransition, tree, shutdown };
}
