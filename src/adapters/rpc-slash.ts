import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ApplicationApi, Binding, Receipt, Reply, RunDetail } from "../app/api.js";
import { STATUS_KEY } from "../app/contracts.js";

const usage = "Usage: /refine optimize <draft>. The result opens automatically when ready.";
const scope = (binding: Binding) => `${binding.runtimeId}.${binding.lifecycleEpoch}`;
const resultArgs = /^result\s+(run-[1-9][0-9]{0,14})@([a-f0-9-]{36}\.[1-9][0-9]*)\s*$/i;
const resultCommand = (binding: Binding, runId: string) => `/refine result ${runId}@${scope(binding)}`;
const rewriteReceipt = {
  started: "Refine started a background rewrite.",
  queued: "Refine queued a background rewrite.",
  duplicate: "Refine already has a rewrite run for this draft.",
};

interface Presentation {
  binding: Binding;
  ctx: ExtensionContext;
  pending: Set<string>;
  ready: Set<string>;
  unsubscribe?: () => void;
  feedback?: string;
  status?: string;
}

function statusMessage(run: RunDetail): string {
  switch (run.status) {
    case "queued": return "Background rewrite still queued.";
    case "generating": return "Background rewrite still running.";
    case "cancelled": return "Cancelled.";
    case "interrupted": return "Interrupted.";
    case "error": return run.diagnostic ?? "Failed to produce a candidate.";
    case "generated": return "No candidate.";
  }
}

export function createRpcSlash(deps: {
  api: Pick<ApplicationApi, "isCurrentBinding" | "query" | "subscribe">;
  currentBinding(): Binding | undefined;
  optimize(binding: Binding, text: string, ctx: ExtensionContext): Reply<Receipt>;
}) {
  const { api } = deps;
  let tracking: Presentation | undefined;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  let previewOpen = false;
  let hostPrompts = 0;

  function clearPreviewTimer() {
    clearTimeout(previewTimer);
    previewTimer = undefined;
  }
  function clearTracking() {
    clearPreviewTimer();
    const watch = tracking;
    tracking = undefined;
    watch?.unsubscribe?.();
    if (watch?.status) watch.ctx.ui.setStatus(STATUS_KEY, undefined);
  }
  function queryRun(binding: Binding, runId: string): RunDetail | undefined {
    const result = api.query(binding, { method: "run", runId });
    return result.kind === "ok" && "original" in result.value ? result.value : undefined;
  }
  function refreshTracking() {
    const watch = tracking;
    if (!watch) return;
    if (!api.isCurrentBinding(watch.binding)) { clearTracking(); return; }
    let running = 0;
    let queued = 0;
    const finished: string[] = [];
    for (const id of watch.pending) {
      const run = queryRun(watch.binding, id);
      if (run?.status === "generating") { running++; continue; }
      if (run?.status === "queued") { queued++; continue; }
      watch.pending.delete(id);
      if (run?.status === "generated" && run.text !== undefined) {
        watch.ready.add(id);
        finished.push(`Ready: ${resultCommand(watch.binding, id)}`);
      } else if (run) {
        finished.push(`${id} · ${statusMessage(run)}`);
        watch.ctx.ui.notify(`Refine ${id}@${scope(watch.binding)}: ${statusMessage(run)}`, "warning");
      }
    }
    if (finished.length) watch.feedback = finished.join(" · ");
    if (!watch.pending.size) {
      watch.unsubscribe?.();
      watch.unsubscribe = undefined;
    }
    const parts: string[] = [];
    if (running) parts.push(running === 1 ? "Rewriting in background" : `${running} rewrites in progress`);
    if (queued) parts.push(`${queued} queued`);
    if (running || queued) parts.push("Results open automatically");
    if (watch.feedback) parts.push(watch.feedback);
    const status = parts.length ? `Refine · ${parts.join(" · ")}` : undefined;
    if (status !== watch.status) {
      watch.status = status;
      watch.ctx.ui.setStatus(STATUS_KEY, status);
    }
    schedulePreview();
  }

  function track(binding: Binding, runId: string, ctx: ExtensionContext) {
    if (tracking && !api.isCurrentBinding(tracking.binding)) clearTracking();
    const watch = tracking ??= { binding, ctx, pending: new Set(), ready: new Set() };
    if (!watch.pending.size) watch.feedback = undefined;
    watch.pending.add(runId);
    if (!watch.unsubscribe) {
      try { watch.unsubscribe = api.subscribe(binding, refreshTracking); }
      catch {
        watch.pending.delete(runId);
        ctx.ui.notify(`Refine could not track this run. To reopen it, use /refine result ${runId}@${scope(binding)}`, "warning");
        return;
      }
    }
    refreshTracking(); // The run may already be terminal before subscription.
  }

  function canOpen(ctx: ExtensionContext): boolean {
    return !previewOpen && !hostPrompts && ctx.isIdle();
  }

  function schedulePreview() {
    const watch = tracking;
    if (!watch?.ready.size || previewTimer !== undefined || !canOpen(watch.ctx)) return;
    // Let the host finish its slash/turn UI transition before presenting the next question.
    previewTimer = setTimeout(() => {
      previewTimer = undefined;
      if (tracking !== watch || !api.isCurrentBinding(watch.binding) || !canOpen(watch.ctx)) return;
      for (const id of watch.ready) {
        watch.ready.delete(id);
        const run = queryRun(watch.binding, id);
        if (run?.status === "generated" && run.text !== undefined) {
          void openEditor(watch.ctx, watch.binding, id, run.text);
          return;
        }
      }
    }, 250);
    previewTimer.unref?.();
  }

  async function openEditor(ctx: ExtensionContext, binding: Binding, runId: string, text: string) {
    previewOpen = true;
    try {
      await ctx.ui.editor(`Rewrite result · ${runId} · Select all to copy · Submit closes without sending`, text);
    } catch {
      if (api.isCurrentBinding(binding)) ctx.ui.notify("Refine: the host could not open the result editor.", "warning");
    } finally {
      previewOpen = false;
      schedulePreview();
    }
  }

  async function showResult(ctx: ExtensionContext, binding: Binding, runId: string, id: string) {
    if (!api.isCurrentBinding(binding)) { ctx.ui.notify("Refine result ID has expired.", "warning"); return; }
    const run = queryRun(binding, runId);
    if (!run) { ctx.ui.notify(`Unknown Refine result: ${id}.`, "warning"); return; }
    if (run.status !== "generated" || run.text === undefined) {
      ctx.ui.notify(`Refine ${id}: ${statusMessage(run)}`, "warning");
      return;
    }
    if (!canOpen(ctx)) {
      ctx.ui.notify(`Refine: retry /refine result ${id} after the current turn or dialog closes.`, "warning");
      return;
    }
    if (!api.isCurrentBinding(binding)) return;
    tracking?.ready.delete(runId);
    await openEditor(ctx, binding, runId, run.text);
  }
  return {
    clearTracking,
    hostSettled() {
      clearPreviewTimer();
      schedulePreview();
    },
    setHostPromptActive(active: boolean) {
      hostPrompts = Math.max(0, hostPrompts + (active ? 1 : -1));
      if (active) clearPreviewTimer();
      else schedulePreview();
    },
    async command(source: string, ctx: ExtensionContext): Promise<void> {
      const args = source.trimStart();
      const prefix = /^optimize(?:\r\n|\s)/i.exec(args);
      const text = prefix ? args.slice(prefix[0].length) : undefined;
      const result = resultArgs.exec(args);
      if (!text?.trim() && !result) { ctx.ui.notify(usage, "warning"); return; }
      const binding = deps.currentBinding();
      if (!binding || binding.sessionId !== ctx.sessionManager.getSessionId()) {
        ctx.ui.notify("Refine is not ready in this session.", "warning");
        return;
      }
      if (result) {
        if (result[2] !== scope(binding)) { ctx.ui.notify("Refine result ID has expired.", "warning"); return; }
        await showResult(ctx, binding, result[1]!, `${result[1]}@${result[2]}`);
        return;
      }
      const receipt = deps.optimize(binding, text!, ctx);
      if (receipt.kind !== "ok") { ctx.ui.notify(`Refine rejected: ${receipt.code}.`, "warning"); return; }
      const { value } = receipt;
      if (value.outcome !== "started" && value.outcome !== "queued" && value.outcome !== "duplicate") return;
      const message = rewriteReceipt[value.outcome];
      ctx.ui.notify(value.runId ? `${message} The result opens automatically. To reopen, use ${resultCommand(binding, value.runId)}` : message, "info");
      if (value.runId) track(binding, value.runId, ctx);
    },
  };
}
