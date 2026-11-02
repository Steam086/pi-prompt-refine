import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRef } from "./config.js";
import type { TokenUsage } from "./usage.js";
import type { ProjectSnapshot } from "./project-context.js";

interface RequestProjectContext { cwd: string; snapshot: ProjectSnapshot }

export type RefinePhase = "idle" | "generating" | "ready" | "error";
export type RefineStopReason = "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred" | "pending";

export interface RefineRequestInput {
  draft: string;
  model: ModelRef;
  thinkingLevel?: ModelThinkingLevel;
  generateTitle?: boolean;
  sessionId: string;
  branchLeafId: string | null;
  historyText: string;
  project?: RequestProjectContext;
}

export interface RefineRequest extends RefineRequestInput {
  requestId: number;
  generation: number;
  modelVersion: number;
}

export interface RefineCompletion {
  usage?: TokenUsage;
  title?: string;
  invalidOutput?: boolean;
  text: string;
  stopReason: RefineStopReason;
}

export interface Candidate {
  usage?: TokenUsage;
  title?: string;
  generateTitle?: boolean;
  requestId: number;
  version: number;
  generation: number;
  sessionId: string;
  draft: string;
  text: string;
  model: ModelRef;
  branchLeafId: string | null;
  historyText: string;
  project?: RequestProjectContext;
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

export interface ControllerState {
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
  | { kind: "no-model" };

interface ActiveRequest {
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
  return JSON.stringify([request.draft, request.model.provider, request.model.id, request.thinkingLevel, request.sessionId, request.branchLeafId, request.historyText, request.project, request.generateTitle]);
}

function cloneCandidate(candidate: Candidate): Candidate {
  return { ...candidate, ...(candidate.project ? { project: structuredClone(candidate.project) } : {}), ...(candidate.usage ? { usage: { ...candidate.usage } } : {}), model: { ...candidate.model } };
}

export class RefineController {
  private readonly scheduler: Scheduler;
  private readonly complete: RefineControllerOptions["complete"];
  private readonly timeoutMs: number;
  private readonly maxDraftChars: number;
  private readonly maxOutputChars: number;
  private readonly onState: RefineControllerOptions["onState"];
  private readonly onAccepted: RefineControllerOptions["onAccepted"];
  private currentModel?: ModelRef;
  private sessionId?: string;
  private generation = 0;
  private requestSequence = 0;
  private candidateSequence = 0;
  private restoreSequence = 0;
  private modelVersion = 0;
  private active?: ActiveRequest;
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
    const usage = this.candidate?.usage ?? this.state.usage;
    return { ...this.state, ...(usage ? { usage: { ...usage } } : {}), ...(this.state.model ? { model: { ...this.state.model } } : {}) };
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

  /** Only a fresh idle workflow may use the shortcut to start a model request. */
  shouldOpenPanel(): boolean {
    return this.state.phase !== "idle" || this.accepted !== undefined;
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
    if (sameModel(this.currentModel, model)) return false;
    this.invalidateLifecycle();
    this.modelVersion += 1;
    this.currentModel = model ? { ...model } : undefined;
    this.state = {
      phase: "idle",
      requestId: this.requestSequence,
      pendingSend: false,
      ...(this.currentModel ? { model: { ...this.currentModel } } : {}),
    };
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
    if (this.active || this.candidate || this.accepted || this.restore || this.pendingSend) this.invalidateLifecycle(true);
  }

  invalidateLifecycle(clearRestore = false): void {
    this.generation += 1;
    this.cancelActive();
    this.clearPendingSend();
    this.candidate = undefined;
    if (clearRestore) {
      this.restore = undefined;
      this.restoreAccepted = undefined;
      this.accepted = undefined;
    } else if (this.restore) this.restore = { ...this.restore, generation: this.generation };
    this.state = { phase: "idle", requestId: this.requestSequence, pendingSend: false };
    this.emitState();
  }

  trigger(input: RefineRequestInput, options: { force?: boolean } = {}): TriggerResult {
    this.ensureSession(input.sessionId);
    if (!input.draft.trim()) return { kind: "empty" };
    if (input.draft.length > this.maxDraftChars) return { kind: "too-long" };
    if (!input.model.provider || !input.model.id) return { kind: "no-model" };

    const requestFingerprint = fingerprint(input);
    if (this.active && this.active.request.generation === this.generation && fingerprint(this.active.request) === requestFingerprint) {
      return { kind: "duplicate" };
    }
    if (!options.force && this.candidate && this.isCandidateCurrent(this.getCandidateToken()!) && fingerprint(this.candidate) === requestFingerprint) {
      return { kind: "ready" };
    }

    this.cancelActive();
    this.clearPendingSend();
    this.candidate = undefined;
    const requestId = ++this.requestSequence;
    const request: RefineRequest = {
      ...input,
      ...(input.project ? { project: structuredClone(input.project) } : {}),
      model: { ...input.model },
      requestId,
      generation: this.generation,
      modelVersion: this.modelVersion,
    };
    const controller = new AbortController();
    const timeout = this.scheduler.setTimeout(() => this.onTimeout(requestId), this.timeoutMs);
    this.active = { request, controller, timeout };
    this.state = { phase: "generating", requestId, model: { ...input.model }, pendingSend: false };
    this.emitState();
    void this.run(this.active).catch(() => undefined);
    return { kind: "started", requestId };
  }

  cancelAndDismiss(): void {
    this.invalidateLifecycle();
  }

  updateCandidate(token: CandidateToken, text: string): boolean {
    if (!this.isCandidateCurrent(token) || !text.trim() || text.length > this.maxDraftChars) return false;
    this.clearPendingSend();
    this.candidate = { ...this.candidate!, text, version: ++this.candidateSequence };
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
    this.restore = {
      id: ++this.restoreSequence,
      generation: this.generation,
      sessionId: candidate.sessionId,
      before: currentDraft,
      applied: candidate.text,
    };
    this.candidate = undefined;
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
      if (!this.isActiveCurrent(active.request)) return;
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
        ...(result.usage ? { usage: { ...result.usage } } : {}),
        requestId: active.request.requestId,
        version: ++this.candidateSequence,
        generation: active.request.generation,
        sessionId: active.request.sessionId,
        draft: active.request.draft,
        text: textBlocks,
        generateTitle: active.request.generateTitle,
        ...(active.request.generateTitle && result.title ? { title: result.title } : {}),
        model: { ...active.request.model },
        branchLeafId: active.request.branchLeafId,
        historyText: active.request.historyText,
        ...(active.request.project ? { project: structuredClone(active.request.project) } : {}),
      };
      this.candidate = candidate;
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
    this.generation += 1;
    this.candidate = undefined;
    if (this.restore) this.restore = { ...this.restore, generation: this.generation };
    this.clearPendingSend();
    this.state = { phase: "error", requestId: active.request.requestId, model: { ...active.request.model }, error, pendingSend: false, usage: this.state.usage };
    this.emitState();
  }

  private onTimeout(requestId: number): void {
    const active = this.active;
    if (!active || active.request.requestId !== requestId || !this.isActiveCurrent(active.request)) return;
    this.active = undefined;
    this.scheduler.clearTimeout(active.timeout);
    this.generation += 1;
    this.candidate = undefined;
    if (this.restore) this.restore = { ...this.restore, generation: this.generation };
    this.clearPendingSend();
    active.controller.abort();
    this.state = { phase: "error", requestId, model: { ...active.request.model }, error: "timeout", pendingSend: false };
    this.emitState();
  }

  private completeSend(): void {
    const candidate = this.candidate;
    this.clearPendingSend();
    this.cancelActive();
    this.generation += 1;
    this.candidate = undefined;
    this.accepted = undefined;
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
