import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ApplicationApi, Binding, Receipt, Reply, RunDetail } from "../app/api.js";

const usage = "Usage: /refine optimize <draft> or /refine result <runId>.";
const scope = (binding: Binding) => `${binding.runtimeId}.${binding.lifecycleEpoch}`;
const resultArgs = /^result\s+(run-[1-9][0-9]{0,14})@([a-f0-9-]{36}\.[1-9][0-9]*)\s*$/i;

function statusMessage(run: RunDetail): string {
  switch (run.status) {
    case "queued": return "Still queued.";
    case "generating": return "Still running.";
    case "cancelled": return "Cancelled.";
    case "interrupted": return "Interrupted.";
    case "error": return run.diagnostic ?? "Failed to produce a candidate.";
    case "generated": return "No candidate.";
  }
}

/** RPC cannot inspect the host's composer, so only an explicit result command opens an editor. */
export function createRpcSlash(deps: {
  api: Pick<ApplicationApi, "isCurrentBinding" | "query" | "subscribe">;
  currentBinding(): Binding | undefined;
  optimize(binding: Binding, text: string, ctx: ExtensionContext): Reply<Receipt>;
}) {
  const { api } = deps;
  // Only pending presentation references live here. Reopening uses the scoped receipt and queries the application.
  let tracking: { binding: Binding; pending: Map<string, ExtensionContext>; off(): void } | undefined;
  let editorOpen = false;
  let hostPromptActive = false;
  function clearTracking() {
    tracking?.off();
    tracking = undefined;
  }
  function queryRun(binding: Binding, runId: string): RunDetail | undefined {
    const result = api.query(binding, { method: "run", runId });
    return result.kind === "ok" && "original" in result.value ? result.value : undefined;
  }
  function refreshRun(watch: NonNullable<typeof tracking>, runId: string, ctx: ExtensionContext) {
    const run = queryRun(watch.binding, runId);
    if (run?.status === "queued" || run?.status === "generating") return;
    watch.pending.delete(runId);
    if (!watch.pending.size) clearTracking();
    if (run && run.status !== "generated") {
      ctx.ui.notify(`Refine ${runId}@${scope(watch.binding)}: ${statusMessage(run)}`, "warning");
    }
  }
  function refreshTracking() {
    const watch = tracking;
    if (!watch) return;
    if (!api.isCurrentBinding(watch.binding)) { clearTracking(); return; }
    for (const [runId, ctx] of watch.pending) refreshRun(watch, runId, ctx);
  }
  function track(binding: Binding, runId: string, ctx: ExtensionContext) {
    if (tracking && !api.isCurrentBinding(tracking.binding)) clearTracking();
    if (!tracking) {
      try { tracking = { binding, pending: new Map(), off: api.subscribe(binding, refreshTracking) }; }
      catch { return; } // The receipt still works if background notifications are unavailable.
    }
    tracking.pending.set(runId, ctx);
    refreshRun(tracking, runId, ctx); // The run may already be terminal before subscription.
  }
  async function showResult(ctx: ExtensionContext, binding: Binding, runId: string, id: string) {
    if (!api.isCurrentBinding(binding)) { ctx.ui.notify("Refine result ID has expired.", "warning"); return; }
    const run = queryRun(binding, runId);
    if (!run) { ctx.ui.notify(`Unknown Refine result: ${id}.`, "warning"); return; }
    if (run.status !== "generated" || run.text === undefined) {
      ctx.ui.notify(`Refine ${id}: ${statusMessage(run)}`, "warning");
      return;
    }
    if (editorOpen || hostPromptActive || !ctx.isIdle()) {
      ctx.ui.notify(`Refine: retry /refine result ${id} after the current turn or dialog closes.`, "warning");
      return;
    }
    if (!api.isCurrentBinding(binding)) return;
    editorOpen = true;
    try {
      // Keep the explicit command open while the host handles its dialog. Edits and cancellations are ignored.
      await ctx.ui.editor(`Refine ${id} · Copy, then close`, run.text);
    } catch {
      if (api.isCurrentBinding(binding)) ctx.ui.notify("Refine: the host could not open the result editor.", "warning");
    } finally { editorOpen = false; }
  }
  return {
    clearTracking,
    setHostPromptActive(active: boolean) { hostPromptActive = active; },
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
      const id = value.runId && `${value.runId}@${scope(binding)}`;
      ctx.ui.notify(`Refine ${value.outcome}.${id ? ` Manual viewing: /refine result ${id}` : ""}`, "info");
      if (value.runId && value.outcome !== "duplicate") track(binding, value.runId, ctx);
    },
  };
}
