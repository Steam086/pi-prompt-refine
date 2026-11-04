import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRef, ProjectContextConfig } from "./config.js";
import type { HistorySnapshot, RevisionInput } from "./context.js";
import type { TokenUsage } from "./usage.js";
import type { ProjectSnapshot } from "./project-context.js";
import { RefineHistory, type RefineRecord } from "./history.js";

interface RequestProjectContext { cwd: string; snapshot: ProjectSnapshot; revisionSnapshot?: ProjectSnapshot; config?: ProjectContextConfig }
export type RefinePhase = "idle" | "generating" | "ready" | "error";
export type RefineStopReason = "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred" | "pending";
export interface RefineRequestInput {
  draft: string;
  revision?: RevisionInput;
  model: ModelRef;
  thinkingLevel?: ModelThinkingLevel;
  generateTitle?: boolean;
  sessionId: string;
  branchLeafId: string | null;
  history: HistorySnapshot;
  systemPrompt: string;
  preparedInput?: string;
  project?: RequestProjectContext;
  projectDiagnostics?: { warnings: string[]; referencedDirectoryCount: number };
  roundId?: number;
}
export interface RefineRequest extends RefineRequestInput {
  requestId: number;
  generation: number;
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
  elapsedSeconds?: number;
  usage?: TokenUsage;
  title?: string;
  requestId: number;
  version: number;
  generation: number;
  text: string;
}
export interface CandidateToken { requestId: number; version: number; generation: number; sessionId: string }
export interface RestoreSnapshot { id: number; generation: number; sessionId: string; before: string; applied: string }
export interface RestoreToken { id: number; generation: number; sessionId: string }
export interface RequestSource { draft: string; revisionInstruction?: string }
export interface ControllerState {
  elapsedSeconds?: number;
  usage?: TokenUsage;
  phase: RefinePhase;
  requestId: number;
  recordId?: number;
  model?: ModelRef;
  thinkingLevel?: ModelThinkingLevel;
  error?: "timeout" | "failed" | "empty" | "truncated" | "tool-call" | "invalid-output";
  pendingSend: boolean;
  runningCount?: number;
  queuedCount?: number;
}
export interface Scheduler { setTimeout(callback: () => void, delayMs: number): unknown; clearTimeout(handle: unknown): void }
export interface RefineControllerOptions {
  complete(request: RefineRequest, signal: AbortSignal): Promise<RefineCompletion>;
  timeoutMs: number;
  maxDraftChars: number;
  maxOutputChars?: number;
  maxConcurrent?: number;
  scheduler?: Scheduler;
  onState(state: ControllerState): void;
  onAccepted?(candidate: Candidate): void;
}
export type TriggerResult =
  | { kind: "started"; requestId: number }
  | { kind: "captured"; recordId: number }
  | { kind: "duplicate" | "ready" | "empty" | "too-long" | "no-model" | "stale-source" | "busy" };
interface ActiveRequest {
  previousCandidate?: Candidate;
  startedAt?: number;
  request: RefineRequest;
  controller: AbortController;
  timeout?: unknown;
}
interface PendingSend { token: CandidateToken; text: string; timeout: unknown }
const defaultScheduler: Scheduler = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};
function sameModel(a: ModelRef | undefined, b: ModelRef | undefined): boolean { return a?.provider === b?.provider && a?.id === b?.id; }
function fingerprint(input: RefineRequestInput): string {
  return JSON.stringify([input.draft, input.model, input.thinkingLevel, input.sessionId, input.roundId, input.revision]);
}
function elapsed(active: ActiveRequest): number { return active.startedAt === undefined ? 0 : Math.max(0, Math.floor((Date.now() - active.startedAt) / 1000)); }

/** Journal entries own requests. The applied preview is independent of background completion. */
export class RefineController {
  private readonly scheduler: Scheduler;
  private readonly journal = new RefineHistory();
  private readonly active = new Map<number, ActiveRequest>();
  private round?: { id: number; input: RefineRequestInput };
  private roundSequence = 0;
  private taskSequence = 0;
  private taskId?: number;
  private lastCapturedDraft?: string;
  private foregroundId?: number;
  private sessionId?: string;
  private currentModel?: ModelRef;
  private generation = 0;
  private requestSequence = 0;
  private candidateSequence = 0;
  private restoreSequence = 0;
  private candidate?: Candidate;
  private accepted?: Candidate;
  private viewedAccepted?: Candidate;
  private restore?: RestoreSnapshot;
  private restoreAccepted?: Candidate;
  private pendingSend?: PendingSend;
  private requestSource?: RequestSource;
  private state: ControllerState = { phase: "idle", requestId: 0, pendingSend: false };

  constructor(private readonly options: RefineControllerOptions, initialModel?: ModelRef) {
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.currentModel = initialModel ? { ...initialModel } : undefined;
  }
  getState(): ControllerState {
    const running = [...this.active.values()].filter((item) => item.startedAt !== undefined);
    const active = this.foregroundId === undefined ? undefined : this.active.get(this.foregroundId);
    return structuredClone({ ...this.state,
      ...(active ? { elapsedSeconds: elapsed(active) } : {}),
      runningCount: running.length, queuedCount: this.active.size - running.length,
    });
  }
  getModel(): ModelRef | undefined { return this.currentModel ? { ...this.currentModel } : undefined; }
  getGeneration(): number { return this.generation; }
  getSessionId(): string | undefined { return this.sessionId; }
  getRoundId(): number | undefined { return this.round?.id; }
  getCandidate(): Candidate | undefined { return this.candidate ? structuredClone(this.candidate) : undefined; }
  getAppliedRecordId(): number | undefined { return (this.candidate ?? this.viewedAccepted)?.recordId; }
  getAccepted(): Candidate | undefined { return this.accepted ? structuredClone(this.accepted) : undefined; }
  getViewedAccepted(): Candidate | undefined { return this.viewedAccepted ? structuredClone(this.viewedAccepted) : undefined; }
  getHistory(): RefineRecord[] {
    const records = this.journal.list(this.sessionId ?? "");
    const running = new Map([...this.active.values()].map((run) => [run.request.recordId, run]));
    for (const record of records) {
      const run = running.get(record.id);
      if (run?.startedAt !== undefined) record.elapsedSeconds = elapsed(run);
    }
    return records;
  }
  getCurrentRecords(): RefineRecord[] { return this.getHistory().filter((record) => record.archivedAt === undefined); }
  getRecord(id: number): RefineRecord | undefined { return this.journal.get(id, this.sessionId ?? ""); }
  hasWorkspaceContent(): boolean { return !!(this.journal.has(this.sessionId ?? "") || this.candidate || this.accepted || this.requestSource); }
  hasCapturedDraft(draft: string): boolean {
    return draft === this.lastCapturedDraft || this.getCurrentRecords().some((record) => record.input.draft === draft);
  }
  shouldOpenPanel(draft: string): boolean { return !draft.trim() || this.hasWorkspaceContent(); }
  getTaskInput(): RefineRequestInput | undefined {
    const record = this.getHistory().find((item) => item.taskId === this.taskId && !item.input.revision);
    return record?.input;
  }
  getTaskModels(): ModelRef[] {
    return [...new Map(this.getHistory().filter((record) => record.taskId === this.taskId)
      .map((record) => [JSON.stringify(record.input.model), record.input.model])).values()];
  }
  getCandidatePosition(): { index: number; count: number; label: string } | undefined {
    if (this.taskId === undefined) return undefined;
    const records = this.modelCandidates();
    const record = records.find((item) => item.id === (this.candidate ?? this.viewedAccepted)?.recordId);
    return { index: record ? records.indexOf(record) + 1 : 0, count: records.length,
      label: record ? `#${record.id} ${record.kind}${record.archivedAt !== undefined ? " · Earlier context" : ""}` : "No candidate for this model" };
  }
  private modelCandidates(): RefineRecord[] {
    const model = (this.candidate ?? this.viewedAccepted)?.model ?? this.currentModel;
    return this.getHistory().filter((item) => item.taskId === this.taskId && item.candidate && sameModel(item.input.model, model));
  }
  cycleCandidate(direction: number): boolean {
    const records = this.modelCandidates();
    if (!records.length || this.pendingSend) return false;
    const index = records.findIndex((item) => item.id === (this.candidate ?? this.viewedAccepted)?.recordId);
    return this.applyResult(records[(index + direction + records.length) % records.length]!.id);
  }
  /** Apply changes only the Refine preview, never the Pi editor or current round. */
  applyResult(id: number): boolean {
    const record = this.getRecord(id);
    if (!record?.candidate || this.pendingSend) return false;
    this.rebase();
    this.foregroundId = undefined;
    this.taskId = record.taskId;
    this.candidate = { ...record.candidate, generation: this.generation, version: ++this.candidateSequence };
    this.viewedAccepted = undefined;
    this.requestSource = this.source(record.input);
    this.journal.update(id, { appliedAt: Date.now() });
    this.state = this.candidateState(this.candidate);
    this.emitState();
    return true;
  }
  capturePreparedInput(requestId: number, generation: number, text: string, diagnostics?: RefineRequestInput["projectDiagnostics"]): void {
    const active = this.active.get(requestId);
    if (!active || active.request.generation !== generation) return;
    active.request.preparedInput = text;
    if (diagnostics) active.request.projectDiagnostics = structuredClone(diagnostics);
    this.journal.captureInput(active.request.recordId, text, diagnostics);
  }
  getRequestSource(): RequestSource | undefined { return this.requestSource ? { ...this.requestSource } : undefined; }
  getDisplayedInput(): RefineRequestInput | undefined {
    const source = this.candidate ?? this.viewedAccepted;
    return source ? structuredClone(source) : this.state.recordId === undefined ? undefined : this.getRecord(this.state.recordId)?.input;
  }
  getCandidateToken(): CandidateToken | undefined {
    const c = this.candidate;
    return c ? { requestId: c.requestId, version: c.version, generation: c.generation, sessionId: c.sessionId } : undefined;
  }
  getRestore(): RestoreSnapshot | undefined { return this.restore ? { ...this.restore } : undefined; }
  getRestoreToken(): RestoreToken | undefined {
    const r = this.restore;
    return r ? { id: r.id, generation: r.generation, sessionId: r.sessionId } : undefined;
  }
  isCandidateCurrent(token: CandidateToken): boolean {
    const c = this.candidate;
    return !!c && c.requestId === token.requestId && c.version === token.version && c.generation === token.generation &&
      c.sessionId === token.sessionId && c.generation === this.generation && c.sessionId === this.sessionId;
  }
  isRestoreCurrent(token: RestoreToken): boolean {
    const r = this.restore;
    return !!r && r.id === token.id && r.generation === token.generation && r.sessionId === token.sessionId &&
      r.generation === this.generation && r.sessionId === this.sessionId;
  }
  setSession(sessionId: string): void { this.invalidateLifecycle(true); this.sessionId = sessionId; this.lastCapturedDraft = undefined; }
  ensureSession(sessionId: string): void { if (this.sessionId !== sessionId) this.setSession(sessionId); }
  setModel(model: ModelRef | undefined): boolean {
    if (sameModel(this.currentModel, model) || this.pendingSend) return false;
    this.currentModel = model ? { ...model } : undefined;
    // Choosing a launch model does not replace an applied result or cancel any run.
    this.emitState();
    return true;
  }
  /** Input is preflight, not acknowledgement: other extensions can handle/reject it. */
  onSubmittedInput(_text: string, _source: string, _streamingBehavior?: "steer" | "followUp"): "pending" {
    return "pending";
  }
  /** Called only for committed user messages, not before_agent_start or raw input. */
  onMessageStarted(text?: string): void {
    if (this.pendingSend && text === this.pendingSend.text && this.isCandidateCurrent(this.pendingSend.token)) {
      const candidate = this.candidate!;
      if (candidate.recordId) this.journal.update(candidate.recordId, { sentAt: Date.now() });
      this.accepted = structuredClone(candidate);
      this.viewedAccepted = structuredClone(candidate);
      this.candidate = undefined;
      this.state = { ...this.candidateState(candidate), phase: "idle" };
      this.emitAccepted(candidate);
    }
    this.clearPendingSend();
    this.archiveRound();
    this.restore = undefined;
    this.restoreAccepted = undefined;
    this.rebase();
    if (this.candidate) this.candidate = { ...this.candidate, generation: this.generation };
    this.state.pendingSend = false;
    this.emitState();
  }
  private archiveRound(): void {
    if (this.round) this.journal.archive(this.sessionId ?? "", this.round.id);
    this.round = undefined;
  }
  invalidateLifecycle(clearRestore = false): void {
    this.archiveRound();
    for (const active of [...this.active.values()]) this.cancelRun(active);
    this.clearPendingSend();
    this.rebase();
    this.candidate = undefined;
    this.taskId = undefined;
    this.foregroundId = undefined;
    this.viewedAccepted = undefined;
    this.requestSource = undefined;
    if (clearRestore) { this.restore = undefined; this.restoreAccepted = undefined; this.accepted = undefined; }
    this.state = { phase: "idle", requestId: this.requestSequence, pendingSend: false };
    this.emitState();
  }
  private validate(input: RefineRequestInput): TriggerResult | undefined {
    if (!input.draft.trim() || (input.revision && !input.revision.instruction.trim())) return { kind: "empty" };
    if (input.draft.length > this.options.maxDraftChars || (input.revision &&
      (input.revision.instruction.length > this.options.maxDraftChars || input.revision.previousCandidate.length > (this.options.maxOutputChars ?? 1_000_000)))) return { kind: "too-long" };
    if (!input.model.provider || !input.model.id) return { kind: "no-model" };
    return undefined;
  }
  private freezeRound(input: RefineRequestInput): RefineRequestInput {
    if (!this.round) this.round = { id: ++this.roundSequence, input: structuredClone(input) };
    const snapshot = this.round.input;
    return structuredClone({ ...input, roundId: this.round.id, history: snapshot.history, project: snapshot.project,
      systemPrompt: snapshot.systemPrompt, generateTitle: snapshot.generateTitle, branchLeafId: snapshot.branchLeafId });
  }
  /** Capture is a zero-call operation and never changes the applied preview. */
  capture(input: RefineRequestInput): TriggerResult {
    const invalid = this.validate(input);
    if (invalid) return invalid;
    this.ensureSession(input.sessionId);
    if (this.hasCapturedDraft(input.draft)) return { kind: "duplicate" };
    if (!this.journal.canStart()) return { kind: "busy" };
    const frozen = this.freezeRound(input);
    const recordId = this.journal.start(++this.taskSequence, frozen, undefined, "refine", "unsent");
    this.lastCapturedDraft = input.draft;
    this.emitState();
    return { kind: "captured", recordId };
  }
  /** Explicit creation is independent of shortcut deduplication, model selection and submission. */
  createDraft(input: RefineRequestInput): TriggerResult {
    if (input.draft.length > this.options.maxDraftChars) return { kind: "too-long" };
    this.ensureSession(input.sessionId);
    if (!this.journal.canStart()) return { kind: "busy" };
    const recordId = this.journal.start(++this.taskSequence, this.freezeRound(input), undefined, "refine", "unsent");
    this.emitState();
    return { kind: "captured", recordId };
  }
  updateDraft(id: number, expected: string, text: string): boolean {
    const record = this.getRecord(id);
    if (!record || record.status !== "unsent" || record.archivedAt !== undefined || record.input.draft !== expected ||
      text.length > this.options.maxDraftChars) return false;
    this.journal.editDraft(id, text);
    this.emitState();
    return true;
  }
  removeDraft(id: number): void {
    this.journal.removeDraft(id);
    if (this.round && !this.getCurrentRecords().length) this.round = undefined;
    this.emitState();
  }

  /** Comparisons always start from the original, including when invoked on a revision/edit. */
  getOriginalRecord(id: number): RefineRecord | undefined {
    const record = this.getRecord(id);
    if (!record) return undefined;
    const source = this.getHistory().find((item) => item.taskId === record.taskId && !item.input.revision) ?? record;
    return { ...source, input: source.originalInput ?? source.input };
  }
  runOriginal(id: number, model: ModelRef, thinkingLevel?: ModelThinkingLevel): TriggerResult {
    const source = this.getOriginalRecord(id);
    if (!source) return { kind: "stale-source" };
    if (source.status === "unsent") return this.startRecord(source.id, model, thinkingLevel);
    // A source can outlive its earliest record when bounded history evicts completed calls.
    const input = { ...source.input, model, thinkingLevel, revision: undefined };
    if (source.input.revision) { delete input.preparedInput; delete input.projectDiagnostics; }
    const invalid = this.validate(input);
    if (invalid) return invalid;
    if (this.pendingSend || !this.journal.canStart()) return { kind: "busy" };
    if ([...this.active.values()].some((run) => this.getRecord(run.request.recordId)?.taskId === source.taskId && fingerprint(run.request) === fingerprint(input))) return { kind: "duplicate" };
    const recordId = this.journal.start(source.taskId, input, undefined, "refine");
    if (source.archivedAt !== undefined) this.journal.update(recordId, { archivedAt: source.archivedAt });
    return this.launch(recordId, false);
  }
  trigger(input: RefineRequestInput, options: { force?: boolean; revisionToken?: CandidateToken; sameTask?: boolean } = {}): TriggerResult {
    if (this.pendingSend) return { kind: input.revision ? "stale-source" : "busy" };
    const invalid = this.validate(input);
    if (invalid) return invalid;
    if (input.revision && (!options.revisionToken || !this.isCandidateCurrent(options.revisionToken) ||
      input.sessionId !== this.sessionId || input.branchLeafId !== this.candidate!.branchLeafId ||
      input.draft !== this.candidate!.draft || input.revision.previousCandidate !== this.candidate!.text)) return { kind: "stale-source" };
    const source = this.getTaskInput();
    if (options.sameTask && (!source || input.sessionId !== this.sessionId || input.draft !== source.draft)) return { kind: "stale-source" };
    this.ensureSession(input.sessionId);
    const frozen = input.revision ? structuredClone({ ...input, roundId: this.candidate!.roundId })
      : options.sameTask ? structuredClone({ ...source!, model: input.model, thinkingLevel: input.thinkingLevel }) : this.freezeRound(input);
    if ([...this.active.values()].some((run) => fingerprint(run.request) === fingerprint(frozen))) return { kind: "duplicate" };
    if (!options.force && this.candidate && fingerprint(this.candidate) === fingerprint(frozen)) return { kind: "ready" };
    if (!this.journal.canStart()) return { kind: "busy" };
    const taskId = (input.revision || options.sameTask) ? this.taskId! : ++this.taskSequence;
    const previous = (input.revision || options.sameTask) ? this.getCandidate() : undefined;
    const recordId = this.journal.start(taskId, frozen, input.revision ? this.candidate?.recordId : undefined);
    this.lastCapturedDraft = input.draft;
    if (frozen.roundId !== this.round?.id) this.journal.update(recordId, { archivedAt: Date.now() });
    return this.launch(recordId, !options.sameTask, previous);
  }
  startRecord(id: number, model = this.currentModel, thinkingLevel?: ModelThinkingLevel): TriggerResult {
    const record = this.getRecord(id);
    if (!record || !model) return { kind: "stale-source" };
    if (this.pendingSend) return { kind: "busy" };
    if (record.status !== "unsent") return { kind: "duplicate" };
    const invalid = this.validate({ ...record.input, model, thinkingLevel });
    if (invalid) return invalid;
    this.journal.setModel(id, model, thinkingLevel);
    // Starting another item never steals the applied preview.
    return this.launch(id, !this.candidate && !this.viewedAccepted && this.foregroundId === undefined);
  }
  /** Explicit retry / another-model run; source and earlier result are immutable. */
  rerunRecord(id: number, model = this.currentModel, thinkingLevel?: ModelThinkingLevel): TriggerResult {
    const record = this.getRecord(id);
    if (!record || !model) return { kind: "stale-source" };
    if (this.pendingSend || !this.journal.canStart()) return { kind: "busy" };
    const input = { ...record.input, model, thinkingLevel };
    if ([...this.active.values()].some((run) => fingerprint(run.request) === fingerprint(input))) return { kind: "duplicate" };
    const recordId = this.journal.start(record.taskId, input, record.parentId, record.kind === "edit" ? "refine" : record.kind);
    if (record.archivedAt !== undefined) this.journal.update(recordId, { archivedAt: record.archivedAt });
    return this.launch(recordId, false);
  }
  private launch(recordId: number, foreground: boolean, previousCandidate?: Candidate): TriggerResult {
    const record = this.getRecord(recordId)!;
    const requestId = ++this.requestSequence;
    if (foreground) {
      this.rebase();
      this.taskId = record.taskId;
      this.foregroundId = requestId;
      this.candidate = undefined;
      this.viewedAccepted = undefined;
      this.requestSource = this.source(record.input);
      this.state = { phase: "generating", requestId, recordId, model: record.input.model, thinkingLevel: record.input.thinkingLevel, pendingSend: false };
    }
    const request: RefineRequest = { ...record.input, requestId, recordId, generation: this.generation };
    this.active.set(requestId, { request, controller: new AbortController(), previousCandidate });
    this.journal.update(recordId, { status: "queued" });
    this.pump();
    this.emitState();
    return { kind: "started", requestId };
  }
  private pump(): void {
    let running = [...this.active.values()].filter((item) => item.startedAt !== undefined).length;
    for (const active of this.active.values()) {
      if (running >= (this.options.maxConcurrent ?? 4)) break;
      if (active.startedAt !== undefined) continue;
      running++;
      active.startedAt = Date.now();
      this.journal.update(active.request.recordId, { status: "generating" });
      active.timeout = this.scheduler.setTimeout(() => this.finishError(active, "timeout"), this.options.timeoutMs);
      void this.run(active);
    }
  }
  cancelAndDismiss(): void {
    // Dismiss the preview, not unrelated tasks or their results.
    this.stopRequest();
    this.rebase();
    this.clearPendingSend();
    this.foregroundId = undefined;
    this.candidate = undefined;
    this.viewedAccepted = undefined;
    this.requestSource = undefined;
    this.taskId = undefined;
    this.state = { phase: "idle", requestId: this.requestSequence, pendingSend: false };
    this.emitState();
  }
  stopRequest(recordId?: number): void {
    const active = recordId === undefined ? this.active.get(this.foregroundId ?? -1)
      : [...this.active.values()].find((item) => item.request.recordId === recordId);
    if (!active) return;
    this.cancelRun(active);
    if (this.foregroundId === active.request.requestId) {
      this.foregroundId = undefined;
      this.state = { phase: "idle", requestId: active.request.requestId, pendingSend: false };
    }
    this.pump();
    this.emitState();
  }
  updateCandidate(token: CandidateToken, text: string): boolean {
    if (!this.isCandidateCurrent(token) || !text.trim() || text.length > (this.options.maxOutputChars ?? 1_000_000) || !this.journal.canStart()) return false;
    this.clearPendingSend();
    const source = this.candidate!;
    const recordId = this.journal.start(this.taskId!, source, source.recordId, "edit");
    this.candidate = { ...source, recordId, text, version: ++this.candidateSequence };
    this.journal.update(recordId, { status: "generated", candidate: this.candidate,
      ...(source.roundId !== this.round?.id ? { archivedAt: Date.now() } : {}) });
    this.state = this.candidateState(this.candidate);
    this.emitState();
    return true;
  }
  acceptCandidate(token: CandidateToken, currentDraft: string, confirmedOverwrite: boolean, writeEditor: (text: string) => void): boolean {
    if (!this.isCandidateCurrent(token)) return false;
    const candidate = this.candidate!;
    if (currentDraft !== candidate.draft && !confirmedOverwrite) return false;
    try { writeEditor(candidate.text); } catch { return false; }
    this.clearPendingSend();
    this.restoreAccepted = this.accepted;
    this.lastCapturedDraft = candidate.text;
    this.accepted = structuredClone(candidate);
    this.viewedAccepted = structuredClone(candidate);
    if (candidate.recordId) this.journal.update(candidate.recordId, { acceptedAt: Date.now() });
    this.restore = { id: ++this.restoreSequence, generation: this.generation, sessionId: candidate.sessionId, before: currentDraft, applied: candidate.text };
    this.candidate = undefined;
    this.state = { ...this.candidateState(candidate), phase: "idle" };
    this.emitAccepted(candidate);
    this.emitState();
    return true;
  }
  restoreDraft(token: RestoreToken, currentDraft: string, confirmedOverwrite: boolean, writeEditor: (text: string) => void): boolean {
    if (!this.isRestoreCurrent(token)) return false;
    const restore = this.restore!;
    if (currentDraft !== restore.applied && !confirmedOverwrite) return false;
    try { writeEditor(restore.before); } catch { return false; }
    this.lastCapturedDraft = restore.before;
    this.accepted = this.restoreAccepted;
    this.viewedAccepted = this.accepted;
    this.restore = undefined;
    this.restoreAccepted = undefined;
    this.rebase();
    this.candidate = undefined;
    this.foregroundId = undefined;
    this.requestSource = undefined;
    this.state = { phase: "idle", requestId: this.requestSequence, pendingSend: false };
    this.emitState();
    return true;
  }
  beginSend(token: CandidateToken, sendTimeoutMs = this.options.timeoutMs): { text: string; requestId: number } | undefined {
    if (!this.isCandidateCurrent(token) || this.pendingSend) return undefined;
    const candidate = this.candidate!;
    const timeout = this.scheduler.setTimeout(() => this.failSend(candidate.requestId), sendTimeoutMs);
    this.pendingSend = { token: { ...token }, text: candidate.text, timeout };
    this.state = { ...this.candidateState(candidate), pendingSend: true };
    this.emitState();
    return { text: candidate.text, requestId: candidate.requestId };
  }
  failSend(requestId: number): void {
    if (this.pendingSend?.token.requestId !== requestId) return;
    this.clearPendingSend();
    this.state.pendingSend = false;
    this.emitState();
  }
  private async run(active: ActiveRequest): Promise<void> {
    try {
      const result = await this.options.complete(active.request, active.controller.signal);
      if (!this.isActive(active)) {
        if (result.usage) this.journal.update(active.request.recordId, { usage: result.usage });
        return;
      }
      this.journal.update(active.request.recordId, { usage: result.usage });
      const error = result.stopReason !== "stop" ? (result.stopReason === "length" ? "truncated" : result.stopReason === "toolUse" ? "tool-call" : "failed")
        : result.invalidOutput ? "invalid-output" : !result.text.trim() ? "empty"
          : result.text.length > (this.options.maxOutputChars ?? 1_000_000) ? "truncated" : undefined;
      if (error) { this.finishError(active, error); return; }
      this.release(active);
      const candidate: Candidate = { ...structuredClone(active.request), text: result.text, version: ++this.candidateSequence,
        elapsedSeconds: elapsed(active), usage: result.usage,
        ...(active.request.generateTitle && result.title ? { title: result.title } : {}) };
      this.journal.update(active.request.recordId, { status: "generated", candidate, usage: result.usage, elapsedSeconds: candidate.elapsedSeconds });
      if (this.foregroundId === active.request.requestId) {
        this.foregroundId = undefined;
        this.candidate = { ...candidate, generation: this.generation };
        this.state = this.candidateState(this.candidate);
      }
      this.pump();
      this.emitState();
    } catch { if (this.isActive(active)) this.finishError(active, "failed"); }
  }
  private finishError(active: ActiveRequest, error: ControllerState["error"]): void {
    if (!this.isActive(active)) return;
    this.release(active);
    const usage = this.getRecord(active.request.recordId)?.usage;
    this.journal.update(active.request.recordId, { status: "error", error, elapsedSeconds: elapsed(active) });
    active.controller.abort();
    if (this.foregroundId === active.request.requestId) {
      this.foregroundId = undefined;
      this.rebase();
      this.candidate = active.previousCandidate ? { ...active.previousCandidate, generation: this.generation } : undefined;
      this.state = { phase: "error", requestId: active.request.requestId, recordId: active.request.recordId, model: active.request.model,
        thinkingLevel: active.request.thinkingLevel, error, pendingSend: false, usage, elapsedSeconds: elapsed(active) };
    }
    this.pump();
    this.emitState();
  }
  private isActive(active: ActiveRequest): boolean {
    return this.active.get(active.request.requestId) === active && active.request.sessionId === this.sessionId;
  }
  private release(active: ActiveRequest): void {
    this.active.delete(active.request.requestId);
    if (active.timeout !== undefined) this.scheduler.clearTimeout(active.timeout);
  }
  private cancelRun(active: ActiveRequest): void {
    this.release(active);
    this.journal.update(active.request.recordId, { status: "cancelled", elapsedSeconds: elapsed(active) });
    active.controller.abort();
  }
  private clearPendingSend(): void {
    if (this.pendingSend) this.scheduler.clearTimeout(this.pendingSend.timeout);
    this.pendingSend = undefined;
  }
  private source(input: RefineRequestInput): RequestSource {
    return { draft: input.draft, ...(input.revision ? { revisionInstruction: input.revision.instruction } : {}) };
  }
  private candidateState(candidate: Candidate): ControllerState {
    return { phase: "ready", requestId: candidate.requestId, recordId: candidate.recordId, model: candidate.model, thinkingLevel: candidate.thinkingLevel,
      usage: candidate.usage, elapsedSeconds: candidate.elapsedSeconds, pendingSend: false };
  }
  private rebase(): void {
    this.generation++;
    if (this.restore) this.restore = { ...this.restore, generation: this.generation };
  }
  private emitAccepted(candidate: Candidate): void {
    try { this.options.onAccepted?.(structuredClone(candidate)); } catch { /* Metadata cannot undo acceptance. */ }
  }
  private emitState(): void {
    try { this.options.onState(this.getState()); } catch { /* UI failures must not break request cleanup. */ }
  }
}
