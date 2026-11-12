import type { WorkspacePanelContextV5 } from "@jmfederico/pi-web/plugin-api";
import type { Binding, Receipt, RunDetail, TaskDetail, Thinking } from "../../../../src/app/api.js";
import { RefineClient } from "./client.js";

const scopeKey = (binding?: Binding) => binding ? JSON.stringify(binding) : "";
function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node;
}
function labelled(label: string, control: HTMLElement) {
  const node = element("label", label); node.append(control); return node;
}

export class RefinePanel extends HTMLElement {
  private root = this.attachShadow({ mode: "open" });
  private client?: RefineClient;
  private clients = new Map<string, RefineClient>();
  private key = "";
  private busy = false;
  private dirty = false;
  private draft?: { id: string; version: number; binding: string };
  private editorBinding = "";
  private loadedText?: { literal: string; display: string };
  private optimizerVersion = 0;
  private optimizerBinding = "";
  private optimizerDirty = false;
  private observedModels?: RefineClient["models"];
  private taskSignature = "";
  private runSignature = "";
  private selectedRunId = "";
  private selectedRunBinding = "";
  private output = element("pre");
  private notice = element("p");
  private optimizerStatus = element("p");
  private original = element("textarea");
  private models = element("select");
  private thinking = element("select");
  private tasks = element("select");
  private runs = element("select");
  private controls: HTMLButtonElement[] = [];
  private connectButton: HTMLButtonElement;
  private retryButton: HTMLButtonElement;
  private forgetButton: HTMLButtonElement;
  private startButton: HTMLButtonElement;
  private stopButton: HTMLButtonElement;
  private saveButton: HTMLButtonElement;
  constructor() {
    super();
    const style = element("style");
    style.textContent = `:host{display:block;color:inherit;font:inherit;min-width:0}*{box-sizing:border-box}section{min-width:0}label{display:grid;gap:.35rem;margin:.6rem 0}textarea,select,button{font:inherit;color:inherit;background:inherit;border:1px solid currentColor;border-radius:.25rem;padding:.4rem}textarea{width:100%;min-height:12rem;resize:vertical}button{margin:.2rem}button:disabled{opacity:.5}select{max-width:100%;width:100%}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,20rem),1fr));gap:1rem}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;max-height:60vh;overflow:auto}h2,h3{font-size:1em}p{overflow-wrap:anywhere}[role=alert]{font-weight:bold} :focus-visible{outline:2px solid currentColor;outline-offset:2px}`;
    this.notice.setAttribute("role", "status"); this.notice.setAttribute("aria-live", "polite");
    this.original.spellcheck = false; this.original.maxLength = 100_000;
    this.original.addEventListener("input", () => {
      if (!this.editorBinding) this.editorBinding = scopeKey(this.client?.hello?.binding) || "unbound";
      this.dirty = true; this.paint();
    });
    this.connectButton = this.button("Connect / reconnect", async () => { await this.client?.connect(true); });
    this.retryButton = this.button("Check / retry operation", async () => {
      const client = this.client, pending = client?.pending, receipt = await client?.retry();
      if (client === this.client && receipt) await this.receipt(receipt, pending);
    });
    this.forgetButton = this.button("Forget retry", async () => {
      if (confirm("Forget only the retry receipt? A committed request may still be running; this does not cancel it.")) this.client?.forgetRetry();
    });
    const modelSection = element("section");
    modelSection.append(element("h3", "Optimizer"), labelled("Model", this.models), labelled("Thinking", this.thinking), this.optimizerStatus);
    this.models.addEventListener("change", () => { this.optimizerDirty = true; this.updateThinking(); });
    this.thinking.addEventListener("change", () => { this.optimizerDirty = true; });
    modelSection.append(this.button("Save optimizer", async () => {
      const client = this.client!, model = client.models[Number(this.models.value)];
      if (!model || this.optimizerBinding !== scopeKey(client.hello?.binding)) throw new Error("Model selection is stale; reset it first.");
      await client.execute({ method: "setDefaultOptimizer", expectedVersion: this.optimizerVersion,
        model: { provider: model.provider, id: model.id }, thinking: this.thinking.value as Thinking | "inherit" });
      if (client !== this.client) return;
      this.optimizerDirty = false; this.paint();
    }), this.button("Reset model choice", async () => { this.optimizerDirty = false; this.paint(); }));
    const draftSection = element("section");
    this.tasks.addEventListener("change", () => { void this.perform(() => this.loadTask(this.tasks.value)); });
    this.saveButton = this.button("Save draft", async () => {
      const client = this.client!, display = this.original.value, text = this.draftText();
      this.guardDraft();
      const receipt = await client.execute(this.draft ? { method: "updateDraft", taskId: this.draft.id, expectedVersion: this.draft.version, text } : { method: "createDraft", text });
      if (client !== this.client) return;
      if ("taskId" in receipt && receipt.taskId && "version" in receipt) this.draft = { id: receipt.taskId, version: receipt.version, binding: scopeKey(client.hello?.binding) };
      this.editorBinding = scopeKey(client.hello?.binding); this.loadedText = { literal: text, display };
      if (this.original.value === display) this.dirty = false;
      this.paint();
    });
    this.startButton = this.button("Optimize saved draft", async () => {
      this.guardDraft(); if (!this.draft || this.dirty) throw new Error("Save the draft first.");
      const client = this.client!;
      const receipt = await client.execute({ method: "startRun", taskId: this.draft.id, expectedVersion: this.draft.version });
      if (client === this.client) await this.receipt(receipt);
    });
    draftSection.append(element("h3", "Drafts"), labelled("Saved task", this.tasks), this.button("New draft", async () => {
      if (this.dirty && !confirm("Discard unsaved local text?")) return;
      this.original.value = ""; this.draft = undefined; this.loadedText = undefined;
      this.editorBinding = scopeKey(this.client?.hello?.binding); this.dirty = false; this.tasks.value = "";
    }), labelled("Original", this.original), this.saveButton, this.startButton);
    const runSection = element("section");
    this.runs.addEventListener("change", () => { void this.perform(() => this.loadRun(this.runs.value)); });
    this.stopButton = this.button("Stop selected run", async () => { if (this.runs.value) await this.client!.execute({ method: "stopRun", runId: this.runs.value }); });
    runSection.append(element("h3", "Runs and results"), labelled("Run", this.runs), this.button("Read result", async () => this.loadRun(this.runs.value || this.selectedRunId)), this.stopButton, this.output);
    const grid = element("div"); grid.className = "grid"; grid.append(modelSection, draftSection, runSection);
    this.root.append(style, element("h2", "Refine"), this.notice, this.connectButton, this.retryButton, this.forgetButton, grid);
    this.paint();
  }
  /** The host calls this while rendering; only local selection changes happen here. No requests. */
  set context(context: WorkspacePanelContextV5) {
    const session = context.state?.selectedSession;
    const key = JSON.stringify([context.machine.id, context.workspace.projectId, context.workspace.id, session?.id]);
    if (key === this.key) return;
    this.client?.disconnect(); this.key = key;
    // Retain the original's identity with its text. Never silently turn an old edit into a new-session create.
    this.optimizerDirty = false; this.observedModels = undefined; this.taskSignature = ""; this.runSignature = "";
    this.tasks.replaceChildren(); this.runs.replaceChildren(); this.output.textContent = "";
    this.selectedRunId = ""; this.selectedRunBinding = "";
    const peer = context.backend?.forScope({ kind: "workspace", projectId: context.workspace.projectId, workspaceId: context.workspace.id }) ?? context.peer;
    this.client = peer && session && !session.archived && !session.pending ? this.clients.get(key) : undefined;
    if (!this.client && peer && session && !session.archived && !session.pending) {
      if (this.clients.size >= 8) {
        const removable = [...this.clients.entries()].find(([, client]) => !client.pending);
        if (removable) { removable[1].disconnect(); this.clients.delete(removable[0]); }
      }
      if (this.clients.size < 8) {
        this.client = new RefineClient(peer, session.id, () => this.paint()); this.clients.set(key, this.client);
      }
    }
    if (this.original.value) this.dirty = true;
    this.paint();
  }
  disconnectedCallback() { this.client?.disconnect(); }
  dispose() { for (const client of this.clients.values()) client.disconnect(); this.clients.clear(); }
  private button(text: string, action: () => Promise<void>) {
    const button = element("button", text); button.type = "button";
    button.addEventListener("click", () => { void this.perform(action); }); this.controls.push(button); return button;
  }
  private async perform(action: () => Promise<void>) {
    if (this.busy) return;
    const client = this.client;
    this.busy = true; this.notice.setAttribute("role", "status"); this.paint();
    try { await action(); } catch (error) {
      if (client === this.client) { client?.report(error); this.notice.setAttribute("role", "alert"); }
    }
    finally { this.busy = false; this.paint(); }
  }
  private draftText() {
    // textarea.value normalizes CRLF; an unchanged loaded draft must retain its literal text.
    return this.loadedText?.display === this.original.value ? this.loadedText.literal : this.original.value;
  }
  private guardDraft() {
    const binding = scopeKey(this.client?.hello?.binding);
    if ((this.editorBinding && this.editorBinding !== binding) || (this.draft && this.draft.binding !== binding)) {
      throw new Error("Draft binding changed. Reopen a task or explicitly create a new draft.");
    }
  }
  private async loadTask(id: string) {
    if (!id || !this.client) return;
    if (this.dirty && !confirm("Discard unsaved local text and open this task?")) { this.tasks.value = this.draft?.id ?? ""; return; }
    const client = this.client, previousText = this.original.value;
    const task = await client.query<TaskDetail>({ method: "task", taskId: id });
    if (client !== this.client) return;
    if (this.original.value !== previousText) {
      this.tasks.value = this.draft?.id ?? "";
      throw new Error("Local text changed while reading; no text replaced. Open the task again when ready.");
    }
    this.original.value = task.text; this.dirty = false;
    this.draft = { id: task.id, version: task.version, binding: scopeKey(client.hello?.binding) };
    this.editorBinding = this.draft.binding; this.loadedText = { literal: task.text, display: this.original.value };
  }
  private async loadRun(id: string) {
    if (!id || !this.client) return;
    const client = this.client;
    this.selectedRunId = id; this.selectedRunBinding = scopeKey(client.hello?.binding);
    const run = await client.query<RunDetail>({ method: "run", runId: id });
    if (client !== this.client) return;
    this.output.textContent = `${run.id} · ${run.model.provider}/${run.model.id} · ${run.status}\n\n${run.text ?? run.diagnostic ?? "No result yet."}\n\nOriginal\n${run.original}` +
      (run.initialInstruction ? `\n\nInitial requirements\n${run.initialInstruction}` : "") +
      (run.revisionInstruction ? `\n\nRevision requirements\n${run.revisionInstruction}` : "") +
      (run.previousResult ? `\n\nPrevious result\n${run.previousResult}` : "");
  }
  private async receipt(receipt: Receipt, pending?: RefineClient["pending"]) {
    const mutation = pending?.mutation;
    if (pending && (mutation?.method === "createDraft" || mutation?.method === "updateDraft") && "taskId" in receipt && "version" in receipt) {
      const binding = scopeKey(pending.meta.binding);
      if (binding !== scopeKey(this.client?.hello?.binding)) return;
      this.client!.notice = `${receipt.outcome}: ${receipt.taskId}`;
      const sameForm = (!this.editorBinding || this.editorBinding === binding) &&
        (mutation.method === "updateDraft" ? this.draft?.id === mutation.taskId : !this.draft);
      if (sameForm) {
        const unchanged = this.draftText() === mutation.text;
        this.draft = { id: receipt.taskId, version: receipt.version, binding }; this.editorBinding = binding;
        this.loadedText = { literal: mutation.text, display: mutation.text.replace(/\r\n?/g, "\n") };
        this.dirty = !unchanged;
      }
    }
    if ("runId" in receipt && receipt.runId) { this.runs.value = receipt.runId; await this.loadRun(receipt.runId); }
  }
  private restoreRunSelection() {
    const binding = scopeKey(this.client?.hello?.binding);
    if (binding && this.selectedRunBinding && binding !== this.selectedRunBinding) {
      this.selectedRunId = ""; this.selectedRunBinding = ""; this.runs.value = ""; this.output.textContent = "";
    }
    if (this.selectedRunId && [...this.runs.options].some((option) => option.value === this.selectedRunId)) this.runs.value = this.selectedRunId;
  }
  private updateThinking() {
    const model = this.client?.models[Number(this.models.value)];
    const old = this.thinking.value;
    this.options(this.thinking, [["inherit", "Inherit"], ...(model?.thinkingLevels ?? []).map((level) => [level, level] as [string, string])]);
    if ([...this.thinking.options].some((option) => option.value === old)) this.thinking.value = old;
  }
  private options(select: HTMLSelectElement, entries: Array<[string, string]>) {
    const selected = select.value;
    select.replaceChildren(...entries.map(([value, text]) => { const option = element("option", text); option.value = value; return option; }));
    if (entries.some(([value]) => value === selected)) select.value = selected;
  }
  private paint() {
    const client = this.client, snapshot = client?.snapshot;
    this.notice.textContent = client ? (!client.connected && client.notice === "Connected" ? "Disconnected; reconnect to read current state." : client.notice)
      : "Select a ready conversation with the Refine extension loaded.";
    if (this.dirty) this.notice.textContent += " · Unsaved local text (not sent)";
    if (client?.pending) this.notice.textContent += ` · Pending operation ${client.pending.meta.operationId}`;
    for (const button of this.controls) button.disabled = this.busy || !client?.connected || !!client.pending;
    if (this.connectButton) this.connectButton.disabled = this.busy || !client;
    if (this.retryButton) this.retryButton.disabled = this.busy || !client?.pending || !client.connected;
    if (this.forgetButton) this.forgetButton.disabled = this.busy || !client?.pending;
    this.models.disabled = this.thinking.disabled = this.tasks.disabled = this.runs.disabled = this.busy || !client?.connected;
    if (!snapshot || !client) return;
    this.original.maxLength = snapshot.maxDraftChars;
    const persistence = snapshot.optimizer.persistence;
    this.optimizerStatus.textContent = persistence === "persisted" ? "Saved" : persistence === "pending" ? "Saving…" : "Applied in memory only; configuration was not saved.";
    this.optimizerStatus.setAttribute("role", persistence === "failed" || persistence === "blocked" ? "alert" : "status");
    if (["load-error", "save-error", "clear-error", "unavailable"].includes(snapshot.storage.state)) {
      this.notice.textContent += " · History storage unavailable; inspect local diagnostics.";
      this.notice.setAttribute("role", "alert");
    }
    if (client.models !== this.observedModels) {
      this.observedModels = client.models;
      this.options(this.models, client.models.map((model, index) => [String(index), `${model.provider}/${model.id}`])); this.updateThinking();
    }
    if (!this.optimizerDirty) {
      const selected = client.models.findIndex((model) => model.provider === snapshot.optimizer.model?.provider && model.id === snapshot.optimizer.model?.id);
      this.models.value = String(selected); this.updateThinking();
      this.thinking.value = [...this.thinking.options].some((option) => option.value === snapshot.optimizer.thinking)
        ? snapshot.optimizer.thinking : "inherit";
      this.optimizerVersion = snapshot.optimizer.version; this.optimizerBinding = scopeKey(client.hello?.binding);
    }
    const tasks = [["", "Choose task"], ...snapshot.tasks.map((task) => [task.id, `${task.id}${task.archived ? " · archived" : ""} · ${task.excerpt}`])] as Array<[string, string]>;
    if (JSON.stringify(tasks) !== this.taskSignature) { this.taskSignature = JSON.stringify(tasks); this.options(this.tasks, tasks); }
    const runs = [["", "Choose run"], ...snapshot.runs.map((run) => [run.id, `${run.id} · ${run.status} · ${run.model.provider}/${run.model.id}`])] as Array<[string, string]>;
    if (JSON.stringify(runs) !== this.runSignature) { this.runSignature = JSON.stringify(runs); this.options(this.runs, runs); }
    this.restoreRunSelection();
    const staleDraft = !!this.editorBinding && this.editorBinding !== scopeKey(client.hello?.binding);
    if (staleDraft) {
      this.notice.textContent += " · Original belongs to another session/epoch; choose New draft or a saved task.";
      this.notice.setAttribute("role", "alert");
    }
    const task = snapshot.tasks.find((task) => task.id === this.draft?.id);
    if (!staleDraft && task) this.tasks.value = task.id;
    this.saveButton.disabled ||= staleDraft || (!!this.draft && !this.dirty) || (!!task && !task.actions.edit.enabled);
    this.startButton.disabled ||= staleDraft;
    this.startButton.disabled ||= !this.draft || this.dirty || !task?.actions.start.enabled;
    this.stopButton.disabled ||= !snapshot.runs.find((run) => run.id === this.runs.value)?.actions.stop.enabled;
  }
}
