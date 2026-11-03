import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRef } from "./config.js";
import type { HistorySnapshot, RevisionInput } from "./context.js";
import type { TokenUsage } from "./usage.js";
import type { ProjectSnapshot } from "./project-context.js";
import { RefineHistory, type RefineRecord } from "./history.js";

interface RequestProjectContext { cwd: string; snapshot: ProjectSnapshot }

export type RefinePhase = "idle" | "generating" | "ready" | "error";
export type RefineStopReason = "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred" | "pending";

export interface RefineRequestInput {
  /** Original task, unchanged across explicit candidate revisions. */
  draft: string;
  revision?: RevisionInput;
  model: ModelRef;
  thinkingLevel?: ModelThinkingLevel;
  generateTitle?: boolean;
  sessionId: string;
  branchLeafId: string | null;
  history: HistorySnapshot;
  systemPrompt: string;
  /** Final JSON input, frozen after project directory collection. */
  preparedInput?: string;
  project?: RequestProjectContext;
}

export interface RefineRequest extends RefineRequestInput {
  requestId: number;
  generation: number;
  modelVersion: number;
  recordId: number;
}

export interface RefineCompletion {
  usage?: TokenUsage;
  title?: string;
  invalidOutput?: boolean;
  text: string;
  stopReason: RefineStopReason;
}

export interface Candidate extends RefineRequestInput {
  recordId?: number;
  /** Frozen request duration, retained in accepted/restored snapshots. */
  elapsedSeconds?: number;
  usage?: TokenUsage;
  title?: string;
  requestId: number;
  version: number;
  generation: number;
  text: string;
}

export interface CandidateToken {
  requestId: number;
  version: number;
  generation: number;
  sessionId: string;
}

export interface RestoreSnapshot {
  id: number;
  generation: number;
  sessionId: string;
  before: string;
  applied: string;
}

export interface RestoreToken {
  id: number;
  generation: number;
  sessionId: string;
}

/** Literal source captured only when a request starts; retained on failure for inspection. */
export interface RequestSource {
  draft: string;
  revisionInstruction?: string;
}

export interface ControllerState {
  elapsedSeconds?: number;
  usage?: TokenUsage;
  phase: RefinePhase;
  requestId: number;
  model?: ModelRef;
  error?: "timeout" | "failed" | "empty" | "truncated" | "tool-call" | "invalid-output";
  pendingSend: boolean;
}

export interface Scheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RefineControllerOptions {
  complete(request: RefineRequest, signal: AbortSignal): Promise<RefineCompletion>;
  timeoutMs: number;
  maxDraftChars: number;
  maxOutputChars?: number;
  scheduler?: Scheduler;
  onState(state: ControllerState): void;
  /** Runs only after a successful editor write or Pi send acknowledgement. */
  onAccepted?(candidate: Candidate): void;
}

export type TriggerResult =
  | { kind: "started"; requestId: number }
  | { kind: "duplicate" }
  | { kind: "ready" }
  | { kind: "empty" }
  | { kind: "too-long" }
  | { kind: "no-model" }
  | { kind: "stale-source" }
  | { kind: "busy" };

interface ActiveRequest {
  /** Roll back a failed revision without making the old result actionable in flight. */
  previousCandidate?: Candidate;
  startedAt: number;
  request: RefineRequest;
  controller: AbortController;
  timeout: unknown;
}

interface PendingSend {
  token: CandidateToken;
  text: string;
  timeout: unknown;
}

const defaultScheduler: Scheduler = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function sameModel(left: ModelRef | undefined, right: ModelRef | undefined): boolean {
  return left?.provider === right?.provider && left?.id === right?.id;
}

function fingerprint(request: RefineRequestInput): string {
  return JSON.stringify([request.draft, request.model.provider, request.model.id, request.thinkingLevel, request.sessionId, request.branchLeafId, request.history, request.project, request.generateTitle, request.systemPrompt, request.revision]);
}

function elapsedSeconds(active: ActiveRequest): number {
  return Math.max(0, Math.floor((Date.now() - active.startedAt) / 1_000));
}

function cloneCandidate(candidate: Candidate): Candidate {
  return { ...candidate, ...(candidate.revision ? { revision: { ...candidate.revision } } : {}), history: structuredClone(candidate.history), ...(candidate.project ? { project: structuredClone(candidate.project) } : {}), ...(candidate.usage ? { usage: { ...candidate.usage } } : {}), model: { ...candidate.model } };
}

export class RefineController {
  private readonly scheduler: Scheduler;
  private readonly complete: RefineControllerOptions["complete"];
  private readonly timeoutMs: number;
  private readonly maxDraftChars: number;
  private readonly maxOutputChars: number;
  private readonly onState: RefineControllerOptions["onState"];
  private readonly onAccepted: RefineControllerOptions["onAccepted"];
  private readonly journal = new RefineHistory();
  private taskSequence = 0;
  private task?: { id: number; input: RefineRequestInput; selected: Map<string, number> };
  private viewedAccepted?: Candidate;
  private currentModel?: ModelRef;
  private sessionId?: string;
  private generation = 0;
  private requestSequence = 0;
  private candidateSequence = 0;
  private restoreSequence = 0;
  private modelVersion = 0;
  private active?: ActiveRequest;
  private requestSource?: RequestSource;
  private candidate?: Candidate;
  /** Read-only provenance after acceptance, independent of the editable main draft. */
  private accepted?: Candidate;
  private restore?: RestoreSnapshot;
  private restoreAccepted?: Candidate;
  private pendingSend?: PendingSend;
  private state: ControllerState = { phase: "idle", requestId: 0, pendingSend: false };

  constructor(options: RefineControllerOptions, initialModel?: ModelRef) {
    this.complete = options.complete;
    this.timeoutMs = options.timeoutMs;
    this.maxDraftChars = options.maxDraftChars;
    this.maxOutputChars = options.maxOutputChars ?? 1_000_000;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.onState = options.onState;
    this.onAccepted = options.onAccepted;
    this.currentModel = initialModel ? { ...initialModel } : undefined;
    this.state = { ...this.state, ...(this.currentModel ? { model: { ...this.currentModel } } : {}) };
  }

  getState(): ControllerState {
    const usage = this.state.phase === "error" ? this.state.usage : this.candidate?.usage ?? this.state.usage;
    const elapsed = this.active ? elapsedSeconds(this.active) : this.state.phase === "error" ? this.state.elapsedSeconds : this.candidate?.elapsedSeconds ?? this.state.elapsedSeconds;
    return { ...this.state, ...(elapsed !== undefined ? { elapsedSeconds: elapsed } : {}), ...(usage ? { usage: { ...usage } } : {}), ...(this.state.model ? { model: { ...this.state.model } } : {}) };
  }

  getModel(): ModelRef | undefined {
    return this.currentModel ? { ...this.currentModel } : undefined;
  }

  getGeneration(): number {
    return this.generation;
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  getCandidate(): Candidate | undefined {
    return this.candidate ? cloneCandidate(this.candidate) : undefined;
  }

  getAccepted(): Candidate | undefined {
    return this.accepted ? cloneCandidate(this.accepted) : undefined;
  }

  getViewedAccepted(): Candidate | undefined {
    const accepted = this.task ? this.viewedAccepted : this.accepted;
    return accepted ? cloneCandidate(accepted) : undefined;
  }

  getTaskInput(): RefineRequestInput | undefined {
    return this.task ? structuredClone(this.task.input) : undefined;
  }

  getHistory(): RefineRecord[] {
    return this.journal.list(this.sessionId ?? "");
  }

  getTaskModels(): ModelRef[] {
    const models = new Map<string, ModelRef>();
    for (const record of this.taskRecords()) models.set(JSON.stringify(record.input.model), record.input.model);
    return [...models.values()];
  }

  private taskRecords(): RefineRecord[] {
    return this.task ? this.journal.list(this.sessionId ?? "", this.task.id) : [];
  }

  private modelCandidates(): RefineRecord[] {
    return this.taskRecords().filter((record) => record.candidate && sameModel(record.input.model, this.currentModel));
  }

  getCandidatePosition(): { index: number; count: number; label: string } | undefined {
    if (!this.task) return undefined;
    const records = this.modelCandidates();
    const id = this.candidate?.recordId ?? this.viewedAccepted?.recordId;
    const index = records.findIndex((record) => record.id === id);
    const record = records[index];
    return { index: index + 1, count: records.length, label: record
      ? `#${record.id} ${record.kind}${record.parentId ? ` from #${record.parentId}` : ""}${record.acceptedAt !== undefined ? " · accepted" : ""}`
      : "No candidate for this model" };
  }

  cycleCandidate(direction: number): boolean {
    if (this.active || this.pendingSend) return false;
    const records = this.modelCandidates();
    if (!records.length) return false;
    const id = this.candidate?.recordId ?? this.viewedAccepted?.recordId;
    const index = records.findIndex((record) => record.id === id);
    this.showRecord(records[(index + direction + records.length) % records.length]!);
    this.emitState();
    return true;
  }

  private showRecord(record?: RefineRecord): void {
    this.generation += 1;
    if (this.restore) this.restore = { ...this.restore, generation: this.generation };
    this.candidate = undefined;
    this.viewedAccepted = undefined;
    this.requestSource = this.task ? { draft: this.task.input.draft } : undefined;
    if (record?.candidate) {
      const candidate = { ...cloneCandidate(record.candidate), version: ++this.candidateSequence, generation: this.generation };
      if (record.acceptedAt !== undefined || record.sentAt !== undefined) this.viewedAccepted = candidate;
      else this.candidate = candidate;
      this.task?.selected.set(JSON.stringify(candidate.model), record.id);
      this.requestSource = { draft: candidate.draft, ...(candidate.revision ? { revisionInstruction: candidate.revision.instruction } : {}) };
    }
    this.state = { phase: this.candidate ? "ready" : "idle", requestId: record?.candidate?.requestId ?? this.requestSequence,
      model: this.currentModel ? { ...this.currentModel } : undefined, pendingSend: false };
  }

  /** Called by the adapter once the final, directory-enriched packet is ready. */
  capturePreparedInput(requestId: number, generation: number, text: string): void {
    const request = this.active?.request;
    if (!request || request.requestId !== requestId || request.generation !== generation) return;
    request.preparedInput = text;
    this.journal.captureInput(request.recordId, text);
    if (this.task && !request.revision && this.task.input.preparedInput === undefined) this.task.input.preparedInput = text;
  }

  getRequestSource(): RequestSource | undefined {
    return this.requestSource ? { ...this.requestSource } : undefined;
  }

  /** Viewing never calls the model; a changed non-empty draft is a new optimization. */
  shouldOpenPanel(draft: string): boolean {
    // Sending has crossed a delivery boundary; don't replace it while awaiting acknowledgement.
    if (!draft.trim() || this.pendingSend) return true;
    if (this.task && draft === this.task.input.draft) return true;
    if (this.state.phase !== "idle") return draft === this.requestSource?.draft;
    return !!this.accepted && (draft === this.accepted.text || draft === this.accepted.draft);
  }

  getCandidateToken(): CandidateToken | undefined {
    if (!this.candidate) return undefined;
    return {
      requestId: this.candidate.requestId,
      version: this.candidate.version,
      generation: this.candidate.generation,
      sessionId: this.candidate.sessionId,
    };
  }

  getRestore(): RestoreSnapshot | undefined {
    return this.restore ? { ...this.restore } : undefined;
  }

  getRestoreToken(): RestoreToken | undefined {
    if (!this.restore) return undefined;
    return { id: this.restore.id, generation: this.restore.generation, sessionId: this.restore.sessionId };
  }

  isCandidateCurrent(token: CandidateToken): boolean {
    return Boolean(
      this.candidate &&
      this.candidate.requestId === token.requestId &&
      this.candidate.version === token.version &&
      this.candidate.generation === token.generation &&
      this.candidate.sessionId === token.sessionId &&
      this.candidate.generation === this.generation &&
      this.candidate.sessionId === this.sessionId,
    );
  }

  isRestoreCurrent(token: RestoreToken): boolean {
    return Boolean(
      this.restore &&
      this.restore.id === token.id &&
      this.restore.generation === token.generation &&
      this.restore.sessionId === token.sessionId &&
      this.restore.generation === this.generation &&
      this.restore.sessionId === this.sessionId,
    );
  }

  setSession(sessionId: string): void {
    this.invalidateLifecycle(true);
    this.sessionId = sessionId;
  }

  ensureSession(sessionId: string): void {
    if (this.sessionId !== sessionId) this.setSession(sessionId);
  }

  setModel(model: ModelRef | undefined): boolean {
    if (sameModel(this.currentModel, model) || this.active || this.pendingSend) return false;
    this.modelVersion += 1;
    this.currentModel = model ? { ...model } : undefined;
    const records = this.modelCandidates();
    const selected = this.task?.selected.get(JSON.stringify(model));
    this.showRecord(records.find((record) => record.id === selected) ?? records.at(-1));
    this.emitState();
    return true;
  }

  /** Called synchronously at Pi's input boundary before normal delivery/queue handling. */
  onSubmittedInput(text: string, source: string, streamingBehavior?: "steer" | "followUp"): "sent" | "pending" | "invalidated" {
    const pending = this.pendingSend;
    if (pending && source === "extension" && text === pending.text && this.isCandidateCurrent(pending.token)) {
      if (streamingBehavior === "followUp") {
        this.completeSend();
        return "sent";
      }
      this.emitState();
      return "pending";
    }
    this.invalidateLifecycle(true);
    return "invalidated";
  }

  /** A user message start confirms an idle Pi send after preflight validation. */
  onMessageStarted(text?: string): void {
    if (this.pendingSend && text === this.pendingSend.text && this.isCandidateCurrent(this.pendingSend.token)) {
      this.completeSend();
      return;
    }
    if (this.task || this.active || this.candidate || this.accepted || this.restore || this.pendingSend) this.invalidateLifecycle(true);
  }

  invalidateLifecycle(clearRestore = false): void {
    this.generation += 1;
    this.cancelActive();
    this.clearPendingSend();
    this.candidate = undefined;
    this.task = undefined;
    this.viewedAccepted = undefined;
    this.requestSource = undefined;
    if (clearRestore) {
      this.restore = undefined;
      this.restoreAccepted = undefined;
      this.accepted = undefined;
    } else if (this.restore) this.restore = { ...this.restore, generation: this.generation };
    this.state = { phase: "idle", requestId: this.requestSequence, pendingSend: false };
    this.emitState();
  }

  trigger(input: RefineRequestInput, options: { force?: boolean; revisionToken?: CandidateToken; sameTask?: boolean } = {}): TriggerResult {
    if ((!input.revision && this.pendingSend) || (options.sameTask && this.active)) return { kind: "busy" };
    if (options.sameTask && (!this.task || input.sessionId !== this.sessionId || input.draft !== this.task.input.draft || input.branchLeafId !== this.task.input.branchLeafId)) return { kind: "stale-source" };
    if (input.revision && (!options.revisionToken || !this.isCandidateCurrent(options.revisionToken) || this.pendingSend ||
      input.sessionId !== this.sessionId || input.branchLeafId !== this.candidate!.branchLeafId ||
      input.draft !== this.candidate!.draft || input.revision.previousCandidate !== this.candidate!.text)) return { kind: "stale-source" };
    this.ensureSession(input.sessionId);
    if (!input.draft.trim() || (input.revision && !input.revision.instruction.trim())) return { kind: "empty" };
    if (input.draft.length > this.maxDraftChars || (input.revision &&
      (input.revision.instruction.length > this.maxDraftChars || input.revision.previousCandidate.length > this.maxOutputChars))) return { kind: "too-long" };
    if (!input.model.provider || !input.model.id) return { kind: "no-model" };

    const requestFingerprint = fingerprint(input);
    if (this.active && this.active.request.generation === this.generation && fingerprint(this.active.request) === requestFingerprint) {
      return { kind: "duplicate" };
    }
    if (!options.force && this.candidate && this.isCandidateCurrent(this.getCandidateToken()!) && fingerprint(this.candidate) === requestFingerprint) {
      return { kind: "ready" };
    }

    const parentId = input.revision ? this.candidate?.recordId : undefined;
    const previousCandidate = (input.revision || options.sameTask) && this.candidate ? cloneCandidate(this.candidate) : undefined;
    this.cancelActive();
    this.clearPendingSend();
    if (!this.task || (!input.revision && !options.sameTask)) {
      this.task = { id: ++this.taskSequence, input: structuredClone(input), selected: new Map() };
    }
    this.viewedAccepted = undefined;
    this.candidate = undefined;
    const recordId = this.journal.start(this.task.id, input, parentId);
    const requestId = ++this.requestSequence;
    const request: RefineRequest = {
      ...input,
      ...(input.revision ? { revision: { ...input.revision } } : {}),
      history: structuredClone(input.history),
      ...(input.project ? { project: structuredClone(input.project) } : {}),
      model: { ...input.model },
      requestId,
      recordId,
      generation: this.generation,
      modelVersion: this.modelVersion,
    };
    const controller = new AbortController();
    const timeout = this.scheduler.setTimeout(() => this.onTimeout(requestId), this.timeoutMs);
    this.requestSource = { draft: request.draft, ...(request.revision ? { revisionInstruction: request.revision.instruction } : {}) };
    this.active = { request, controller, timeout, previousCandidate, startedAt: Date.now() };
    this.state = { phase: "generating", requestId, model: { ...input.model }, pendingSend: false };
    this.emitState();
    void this.run(this.active).catch(() => undefined);
    return { kind: "started", requestId };
  }

  cancelAndDismiss(): void {
    this.invalidateLifecycle();
  }

  /** Stop only the in-flight request; keep this task available for comparison/retry. */
  stopRequest(): void {
    if (!this.active) return;
    this.cancelActive();
    const records = this.modelCandidates();
    const selected = this.task?.selected.get(JSON.stringify(this.currentModel));
    this.showRecord(records.find((record) => record.id === selected) ?? records.at(-1));
    this.emitState();
  }

  updateCandidate(token: CandidateToken, text: string): boolean {
    if (!this.isCandidateCurrent(token) || !text.trim() || text.length > this.maxOutputChars) return false;
    this.clearPendingSend();
    const source = this.candidate!;
    const recordId = this.journal.start(this.task!.id, source, source.recordId, "edit");
    this.candidate = { ...source, recordId, text, version: ++this.candidateSequence };
    this.journal.update(recordId, { status: "generated", candidate: this.candidate });
    this.task!.selected.set(JSON.stringify(source.model), recordId);
    this.state = { phase: "ready", requestId: this.candidate.requestId, model: { ...this.candidate.model }, pendingSend: false };
    this.emitState();
    return true;
  }

  acceptCandidate(
    token: CandidateToken,
    currentDraft: string,
    confirmedOverwrite: boolean,
    writeEditor: (text: string) => void,
  ): boolean {
    if (!this.isCandidateCurrent(token)) return false;
    const candidate = this.candidate!;
    if (currentDraft !== candidate.draft && !confirmedOverwrite) return false;

    try {
      writeEditor(candidate.text);
    } catch {
      return false;
    }

    this.clearPendingSend();
    this.restoreAccepted = this.accepted;
    this.accepted = cloneCandidate(candidate);
    this.viewedAccepted = cloneCandidate(candidate);
    if (candidate.recordId) this.journal.update(candidate.recordId, { acceptedAt: Date.now() });
    this.restore = {
      id: ++this.restoreSequence,
      generation: this.generation,
      sessionId: candidate.sessionId,
      before: currentDraft,
      applied: candidate.text,
    };
    this.candidate = undefined;
    this.requestSource = undefined;
    this.state = { phase: "idle", requestId: this.requestSequence, pendingSend: false };
    this.emitAccepted(candidate);
    this.emitState();
    return true;
  }

  restoreDraft(
    token: RestoreToken,
    currentDraft: string,
    confirmedOverwrite: boolean,
    writeEditor: (text: string) => void,
  ): boolean {
    if (!this.isRestoreCurrent(token)) return false;
    const restore = this.restore!;
    if (currentDraft !== restore.applied && !confirmedOverwrite) return false;

    try {
      writeEditor(restore.before);
    } catch {
      return false;
    }

    // Restoring an earlier optimized draft must restore its provenance too, otherwise
    // the next shortcut would mistake it for a fresh draft and silently call the model.
    const previousAccepted = this.restoreAccepted;
    this.invalidateLifecycle(true);
    this.accepted = previousAccepted;
    if (previousAccepted) this.emitState();
    return true;
  }

  beginSend(token: CandidateToken, sendTimeoutMs = this.timeoutMs): { text: string; requestId: number } | undefined {
    if (!this.isCandidateCurrent(token) || this.pendingSend) return undefined;
    const candidate = this.candidate!;
    const timeout = this.scheduler.setTimeout(() => this.onSendTimeout(candidate.requestId, token.version), sendTimeoutMs);
    this.pendingSend = { token: { ...token }, text: candidate.text, timeout };
    this.state = { phase: "ready", requestId: candidate.requestId, model: { ...candidate.model }, pendingSend: true };
    this.emitState();
    return { text: candidate.text, requestId: candidate.requestId };
  }

  failSend(requestId: number): void {
    if (!this.pendingSend || this.pendingSend.token.requestId !== requestId) return;
    this.clearPendingSend();
    const candidate = this.candidate;
    if (!candidate) return;
    this.state = { phase: "ready", requestId: candidate.requestId, model: { ...candidate.model }, pendingSend: false };
    this.emitState();
  }

  private async run(active: ActiveRequest): Promise<void> {
    try {
      const result = await this.complete(active.request, active.controller.signal);
      if (!this.isActiveCurrent(active.request)) {
        // Accounting may arrive after cancellation; never resurrect a result or UI state.
        if (result.usage) this.journal.update(active.request.recordId, { usage: result.usage });
        return;
      }
      // Retain reported usage even when the completed response is unusable.
      this.state = { ...this.state, usage: result.usage ? { ...result.usage } : undefined };
      if (result.stopReason !== "stop") {
        const error = result.stopReason === "length" ? "truncated" : result.stopReason === "toolUse" ? "tool-call" : "failed";
        this.finishWithError(active, error);
        return;
      }
      if (result.invalidOutput) {
        this.finishWithError(active, "invalid-output");
        return;
      }
      const textBlocks = result.text;
      if (!textBlocks.trim()) {
        this.finishWithError(active, "empty");
        return;
      }
      if (textBlocks.length > this.maxOutputChars) {
        this.finishWithError(active, "truncated");
        return;
      }

      this.clearActive(active);
      const candidate: Candidate = {
        recordId: active.request.recordId,
        preparedInput: active.request.preparedInput,
        elapsedSeconds: elapsedSeconds(active),
        ...(result.usage ? { usage: { ...result.usage } } : {}),
        requestId: active.request.requestId,
        version: ++this.candidateSequence,
        generation: active.request.generation,
        sessionId: active.request.sessionId,
        draft: active.request.draft,
        ...(active.request.revision ? { revision: { ...active.request.revision } } : {}),
        text: textBlocks,
        generateTitle: active.request.generateTitle,
        ...(active.request.generateTitle && result.title ? { title: result.title } : {}),
        model: { ...active.request.model },
        branchLeafId: active.request.branchLeafId,
        history: structuredClone(active.request.history),
        systemPrompt: active.request.systemPrompt,
        thinkingLevel: active.request.thinkingLevel,
        ...(active.request.project ? { project: structuredClone(active.request.project) } : {}),
      };
      this.candidate = candidate;
      this.journal.update(active.request.recordId, { status: "generated", candidate, usage: result.usage, elapsedSeconds: candidate.elapsedSeconds });
      this.task?.selected.set(JSON.stringify(candidate.model), active.request.recordId);
      this.state = { phase: "ready", requestId: candidate.requestId, model: { ...candidate.model }, pendingSend: false };
      this.emitState();
    } catch {
      if (this.isActiveCurrent(active.request)) this.finishWithError(active, "failed");
    } finally {
      // An older request must never clear the timer or status of a newer request.
      if (this.active?.request.requestId === active.request.requestId) this.clearActive(active);
    }
  }

  private isActiveCurrent(request: RefineRequest): boolean {
    return Boolean(
      this.active &&
      this.active.request.requestId === request.requestId &&
      this.active.request.generation === request.generation &&
      this.active.request.modelVersion === request.modelVersion &&
      this.generation === request.generation &&
      this.modelVersion === request.modelVersion &&
      this.sessionId === request.sessionId,
    );
  }

  private finishWithError(active: ActiveRequest, error: ControllerState["error"]): void {
    if (!this.isActiveCurrent(active.request)) return;
    this.clearActive(active);
    this.journal.update(active.request.recordId, { status: "error", error, usage: this.state.usage, elapsedSeconds: elapsedSeconds(active) });
    this.generation += 1;
    this.candidate = active.previousCandidate ? { ...cloneCandidate(active.previousCandidate), generation: this.generation } : undefined;
    if (this.restore) this.restore = { ...this.restore, generation: this.generation };
    this.clearPendingSend();
    this.state = { phase: "error", requestId: active.request.requestId, model: { ...active.request.model }, error, pendingSend: false, usage: this.state.usage, elapsedSeconds: elapsedSeconds(active) };
    this.emitState();
  }

  private onTimeout(requestId: number): void {
    const active = this.active;
    if (!active || active.request.requestId !== requestId || !this.isActiveCurrent(active.request)) return;
    this.active = undefined;
    this.scheduler.clearTimeout(active.timeout);
    this.journal.update(active.request.recordId, { status: "error", error: "timeout", elapsedSeconds: elapsedSeconds(active) });
    this.generation += 1;
    this.candidate = active.previousCandidate ? { ...cloneCandidate(active.previousCandidate), generation: this.generation } : undefined;
    if (this.restore) this.restore = { ...this.restore, generation: this.generation };
    this.clearPendingSend();
    active.controller.abort();
    this.state = { phase: "error", requestId, model: { ...active.request.model }, error: "timeout", pendingSend: false, elapsedSeconds: elapsedSeconds(active) };
    this.emitState();
  }

  private completeSend(): void {
    const candidate = this.candidate;
    if (candidate?.recordId) this.journal.update(candidate.recordId, { sentAt: Date.now() });
    this.task = undefined;
    this.viewedAccepted = undefined;
    this.clearPendingSend();
    this.cancelActive();
    this.generation += 1;
    this.candidate = undefined;
    this.accepted = undefined;
    this.requestSource = undefined;
    this.restore = undefined;
    this.restoreAccepted = undefined;
    this.state = { phase: "idle", requestId: this.requestSequence, pendingSend: false };
    if (candidate) this.emitAccepted(candidate);
    this.emitState();
  }

  private emitAccepted(candidate: Candidate): void {
    try {
      this.onAccepted?.(cloneCandidate(candidate));
    } catch {
      // Metadata failure must not undo an accepted prompt or a confirmed send.
    }
  }

  private onSendTimeout(requestId: number, version: number): void {
    if (!this.pendingSend || this.pendingSend.token.requestId !== requestId || this.pendingSend.token.version !== version) return;
    this.clearPendingSend();
    if (!this.candidate || this.candidate.requestId !== requestId) return;
    this.state = { phase: "ready", requestId, model: { ...this.candidate.model }, pendingSend: false };
    this.emitState();
  }

  private cancelActive(): void {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    this.scheduler.clearTimeout(active.timeout);
    this.journal.update(active.request.recordId, { status: "cancelled", elapsedSeconds: elapsedSeconds(active) });
    active.controller.abort();
  }

  private clearActive(active: ActiveRequest): void {
    if (this.active?.request.requestId !== active.request.requestId) return;
    this.active = undefined;
    this.scheduler.clearTimeout(active.timeout);
  }

  private clearPendingSend(): void {
    if (!this.pendingSend) return;
    this.scheduler.clearTimeout(this.pendingSend.timeout);
    this.pendingSend = undefined;
  }

  private emitState(): void {
    try {
      this.onState(this.getState());
    } catch {
      // A status-bar adapter must not turn a completed or cancelled request into an unhandled error.
    }
  }
}
