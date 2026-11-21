import { RefineController } from "../../../src/controller.js";
import { createApplication } from "../../../src/app/application.js";
import { createCompletion } from "../../../src/app/completion.js";
import { createContextJobs } from "../../../src/app/context-jobs.js";
import { createApplicationEvents } from "../../../src/app/events.js";
import { createModelService } from "../../../src/app/model-service.js";
import { localId, runId, taskId } from "../../../src/app/queries.js";
import type { Binding, Failure, RunDetail, Snapshot, TaskDetail } from "../../../src/app/api.js";
import { buildRefineSystemPrompt, selectHistory } from "../../../src/context.js";
import { formatProjectResources, type HostResources } from "../../../src/project-context.js";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { RefineRequestInput } from "../../../src/request-types.js";
import { composeRevision, type SelectedPreference } from "../../../src/revision-preferences.js";
import type { DesktopCall, DesktopReply } from "./protocol.js";
import { parseSettings, settingsFields, type loadDesktopSettings } from "./settings.js";
import { readDesktopResources } from "./resources.js";

export interface ThreadContext {
  sessionId: string;
  cwd: string;
  anchor: string;
  isCurrent?(): Promise<boolean>;
  loadHistory(): Promise<readonly { role: "user" | "assistant"; text: string }[]>;
}
export type DesktopRegistry = Pick<ModelRegistry, "find" | "getAvailable" | "isUsingOAuth" | "streamSimple">;
type Settings = Awaited<ReturnType<typeof loadDesktopSettings>>;
const reject = (code: Failure["code"]): Failure => ({ kind: "rejected", code });

export function createDesktopRuntime(sessionId: string, settings: Settings, registry: DesktopRegistry,
  defaultPreferences: (cwd: string) => Promise<SelectedPreference[]>) {
  const config = settings.config;
  let background: Pick<RefineRequestInput, "history" | "systemPrompt" | "project"> | undefined;
  let anchor: string | undefined;
  let workspace: string | undefined;
  const events = createApplicationEvents();
  const controller = new RefineController({
    get timeoutMs() { return config.timeoutMs; },
    get maxDraftChars() { return config.maxDraftChars; },
    get maxOutputChars() { return Math.max(config.maxDraftChars, config.maxOutputTokens * 32); },
    onState: () => events.changed(),
    complete: (request, signal) => complete(request, signal),
  }, config.model);
  controller.ensureSession(sessionId);
  const contextJobs = createContextJobs(() => controller.getHistory());
  const complete = createCompletion({
    config,
    getContext: () => ({ sessionManager: { getSessionId: () => sessionId }, modelRegistry: registry }),
    getSessionId: () => sessionId,
    directorySnapshot: contextJobs.directorySnapshot,
    capturePreparedInput: (...args) => controller.capturePreparedInput(...args),
    captureBudget: (...args) => controller.captureBudget(...args),
    onOptimizerRequest() {},
    reportProject() {},
    notify() {},
    notifyIfSameSession() {},
  });

  let saving = Promise.resolve(true);
  const models = createModelService({
    controller, config,
    available: () => registry.getAvailable(),
    sessionThinking: () => undefined,
    writable: settings.writable,
    persist: () => saving = settings.save(config, settings.version()) ?? Promise.resolve(false),
    changed: () => events.changed(),
  });
  function capture(text: string, preferences: SelectedPreference[]): RefineRequestInput {
    if (!background) throw new Error("Missing Refine background");
    const selection = models.resolve();
    return { ...background, draft: text, sessionId, branchLeafId: null, generateTitle: false,
      ...(preferences.length ? { preferences, editingInstruction: composeRevision(preferences, "") } : {}),
      model: "kind" in selection ? { provider: "", id: "" } : selection.model,
      ...("kind" in selection ? {} : { thinkingLevel: selection.thinking }) };
  }
  const application = createApplication({
    controller, models, events, input: { capture: (text) => capture(text, []) }, maxDraftChars: () => config.maxDraftChars,
    storage: { summary: () => ({ state: "no-session-file", savedCount: 0, omittedCount: 0, memoryOnlyCount: controller.getHistory().length }) },
  });
  let binding: Binding;
  function bind() {
    application.bind(sessionId);
    const hello = application.api.hello("t3-desktop");
    if (hello.kind !== "ok") throw new Error("Cannot bind Refine runtime");
    binding = hello.value.binding;
  }
  bind();
  const readSettings = () => ({
    version: settings.version(), fields: settingsFields(config), optimizer: models.optimizer(),
    models: models.list(), writable: settings.writable,
  });

  function snapshot(all: boolean): Snapshot {
    const reply = application.api.query(binding, { method: "snapshot", scope: all ? "all" : "current" });
    if (reply.kind !== "ok") throw new Error("Missing Refine snapshot");
    return reply.value as Snapshot;
  }

  async function open({ text, adopted }: Extract<DesktopCall, { method: "open" }>, host: ThreadContext): Promise<DesktopReply> {
    const response = (task?: number, run?: number, warning?: string): DesktopReply =>
      ({ kind: "open", snapshot: snapshot(false), taskId: task === undefined ? undefined : taskId(task),
        runId: run === undefined ? undefined : runId(run), warning });
    if (!text.trim()) return response();
    if (adopted) {
      const id = application.api.isCurrentBinding(adopted.binding) ? localId(adopted.runId, "run") : undefined;
      const record = id === undefined ? undefined : controller.getRecord(id);
      if (record?.candidate?.text === text && controller.getRunVersion(record.id) === adopted.version) {
        return response(record.taskId, record.id);
      }
      return response(undefined, undefined, "That adopted result is no longer available.");
    }
    if (text.length > config.maxDraftChars) return response(undefined, undefined, `Draft exceeds ${config.maxDraftChars} characters.`);
    const known = controller.getHistory().filter((row) => row.input.draft === text || (row.acceptedAt !== undefined && row.candidate?.text === text));
    const existing = known.find((row) => row.archivedAt === undefined) ?? known[0];
    if (existing) return response(existing.taskId, existing.status === "unsent" ? undefined : existing.id);
    const selection = models.resolve();
    if ("kind" in selection) return response(undefined, undefined, "Choose an available optimizer model in Settings.");
    let frozen = background;
    const preferences = await defaultPreferences(host.cwd);
    if (!frozen) {
      const captured = structuredClone(config);
      const project = captured.projectContext;
      const [messages, resources] = await Promise.all([
        host.loadHistory(),
        project.enabled ? readDesktopResources(host.cwd, project.instructionsEnabled, project.skillsEnabled) : Promise.resolve({} as HostResources),
      ]);
      frozen = {
        history: selectHistory(messages.map(({ role, text }) => ({ type: "message", message: { role, content: text } })),
          captured.context.maxMessages, captured.context.maxChars),
        systemPrompt: buildRefineSystemPrompt(false, captured.systemPrompt),
        ...(project.enabled ? { project: { cwd: host.cwd, snapshot: formatProjectResources(resources, project, text), config: project } } : {}),
      };
    }
    if (host.isCurrent && !await host.isCurrent()) return { kind: "conflict", code: "binding-stale" };
    background = frozen;
    const input = capture(text, preferences);
    const result = controller.capture(input);
    if (result.kind !== "captured") return response(undefined, undefined, `Draft could not be captured (${result.kind}).`);
    const record = controller.getRecord(result.recordId)!;
    if ((input.editingInstruction?.length ?? 0) > config.maxDraftChars) {
      return response(record.taskId, undefined, "Project default preferences exceed the draft limit.");
    }
    if (!controller.hasSubmittedRunInRound()) {
      const started = controller.startRecord(record.id, selection.model, selection.thinking);
      if (started.kind === "started") return response(record.taskId, controller.getSubmission(started)?.recordId);
      return response(record.taskId, undefined, `Request could not start (${started.kind}).`);
    }
    return response(record.taskId);
  }

  let queue = Promise.resolve<unknown>(undefined);
  let pending = 0;
  function handle(host: ThreadContext, call: DesktopCall): Promise<DesktopReply> {
    pending++;
    const result = queue.then(async (): Promise<DesktopReply> => {
      const workspaceChanged = workspace !== undefined && workspace !== host.cwd;
      const roundChanged = anchor !== undefined && host.anchor !== anchor;
      if ((workspaceChanged || roundChanged || call.method === "mutate") && host.isCurrent && !await host.isCurrent()) {
        return { kind: "conflict", code: "binding-stale" };
      }
      if (workspaceChanged || (anchor !== undefined && host.anchor < anchor)) {
        controller.invalidateLifecycle(true);
        contextJobs.clear();
        background = undefined;
        bind();
      } else if (roundChanged) {
        controller.onMessageStarted();
        background = undefined;
      }
      workspace = host.cwd;
      anchor = host.anchor;
      if (call.method === "open") {
        const current = controller.getModel();
        if (current?.provider !== config.model?.provider || current?.id !== config.model?.id) controller.setModel(config.model);
        return open(call, host);
      }
      if (!application.api.isCurrentBinding(call.binding)) return { kind: "conflict", code: "binding-stale" };
      if (call.method === "snapshot") return { kind: "snapshot", value: snapshot(call.all) };
      if (call.method === "settings") {
        controller.setModel(config.model);
        return { kind: "settings", value: readSettings() };
      }
      if (call.method === "saveSettings" || call.method === "saveOptimizer") {
        if (!settings.writable) return { kind: "unavailable", message: "Fix prompt-refine.json before saving settings." };
        if (settings.version() !== call.version) return { kind: "conflict", code: "optimizer-version" };
        if (call.method === "saveSettings") {
          const next = parseSettings(call.fields, config);
          if (!next) return reject("invalid-input");
          const saved = await settings.save(next, call.version);
          return { kind: "settings", value: readSettings(), saved };
        }
        const result = models.configure(models.optimizer().version, call.model, call.thinking);
        if ("kind" in result) return result;
        const saved = await saving;
        return { kind: "settings", value: readSettings(), saved };
      }
      if (call.method === "mutate") {
        controller.setModel(config.model);
        const result = application.local(call.mutation);
        return result.kind === "ok" ? { kind: "receipt", value: result.value } : result;
      }
      const result = application.api.query(binding, call.method === "run" ? { method: "run", runId: call.id } : { method: "task", taskId: call.id });
      if (result.kind !== "ok") return result;
      return call.method === "run" ? { kind: "run", value: result.value as RunDetail } : { kind: "task", value: result.value as TaskDetail };
    }).finally(() => { pending--; });
    queue = result.catch(() => undefined);
    return result;
  }

  return {
    handle,
    busy: () => { const state = controller.getState(); return !!(pending || state.runningCount || state.queuedCount); },
    close() { application.invalidate(); controller.invalidateLifecycle(true); contextJobs.clear(); },
  };
}
