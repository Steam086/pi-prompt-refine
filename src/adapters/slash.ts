import { randomUUID } from "node:crypto";
import { Text, matchesKey } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ApplicationApi, Mutation, MutationMeta, Query, Reply } from "../app/api.js";
import { identity, parseMutation, parseQuery } from "./wire.js";
import { REFINE_OVERLAY_OPTIONS, workspaceLayout, workspaceFrame } from "../workspace-overlay.js";
import { panelFrame } from "../panel-layout.js";
import { formatKeyHint } from "../key-hints.js";

type Parsed = { kind: "query"; value: Query } | { kind: "mutation"; value: Mutation; operationId?: string };
/** Deliberately not a shell: no interpolation, escapes, evaluation, or global trim. */
export function parseSlash(source: string): Parsed | undefined {
  if (source.length > 102_000) return undefined;
  const tokens: string[] = [];
  let body: string | undefined;
  let i = 0;
  while (i < source.length) {
    while (/\s/.test(source[i] ?? "") && i < source.length) i++;
    if (i === source.length) break;
    if (source.slice(i, i + 2) === "--" && (i + 2 === source.length || /\s/.test(source[i + 2]!))) {
      body = source.slice(i + 2 + (i + 2 < source.length ? 1 : 0));
      break;
    }
    let token = "";
    const quote = ["'", '"'].includes(source[i]!) ? source[i++] : undefined;
    if (quote) {
      while (i < source.length && source[i] !== quote) token += source[i++];
      if (source[i++] !== quote || (i < source.length && !/\s/.test(source[i]!))) return undefined;
    } else while (i < source.length && !/\s/.test(source[i]!)) token += source[i++];
    tokens.push(token);
    if (tokens.length > 24) return undefined;
  }
  const [group, action] = tokens;
  const start = group === "status" || group === "optimize" ? 1 : 2;
  const rest = tokens.slice(start);
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let n = 0; n < rest.length; n++) {
    const token = rest[n]!;
    if (!token.startsWith("--")) { positional.push(token); continue; }
    const value = rest[++n];
    if (value === undefined || token in flags || value.startsWith("--")) return undefined;
    flags[token] = value;
  }
  const makeQuery = (value: unknown, allowed: string[] = []): Parsed | undefined => {
    if (body !== undefined || Object.keys(flags).some((key) => !allowed.includes(key))) return undefined;
    const query = parseQuery(value);
    return query ? { kind: "query", value: query } : undefined;
  };
  if (group === "status" && !positional.length) return makeQuery({ method: "snapshot", scope: "current" });
  if (group === "tasks" && action === "list" && !positional.length) return makeQuery({ method: "snapshot", scope: flags["--scope"] ?? "current" }, ["--scope"]);
  if (["tasks", "runs"].includes(group!) && action === "show" && positional.length === 1) return makeQuery(group === "tasks" ? { method: "task", taskId: positional[0] } : { method: "run", runId: positional[0] });
  if (group === "models" && action === "list" && !positional.length) return makeQuery({ method: "models" });
  const operationId = flags["--operation-id"];
  if (operationId !== undefined && !identity(operationId)) return undefined;
  const expectedVersion = /^[1-9][0-9]*$/.test(flags["--expected-version"] ?? "") ? Number(flags["--expected-version"]) : undefined;
  const modelString = flags["--model"];
  const slash = modelString?.indexOf("/") ?? -1;
  const model = modelString === undefined ? undefined : slash > 0 ? { provider: modelString.slice(0, slash), id: modelString.slice(slash + 1) } : null;
  const thinking = flags["--thinking"];
  let value: unknown;
  let allowed = ["--operation-id"];
  if (group === "drafts" && action === "create" && !positional.length && body !== undefined) value = { method: "createDraft", text: body };
  else if (group === "optimize" && !positional.length && body !== undefined) value = { method: "optimizeText", text: body };
  else if (group === "drafts" && ["update", "copy", "discard"].includes(action!) && positional.length === 1) {
    if ((action === "update") !== (body !== undefined)) return undefined;
    allowed.push("--expected-version");
    value = { method: action === "update" ? "updateDraft" : action === "copy" ? "copyToCurrent" : "discardDraft",
      taskId: positional[0], expectedVersion, ...(body !== undefined ? { text: body } : {}) };
  } else if (group === "runs" && action === "stop" && positional.length === 1 && body === undefined) value = { method: "stopRun", runId: positional[0] };
  else if (group === "runs" && action === "start" && positional.length === 1 && body === undefined) {
    allowed.push("--expected-version", "--model", "--thinking");
    value = { method: "startRun", taskId: positional[0], expectedVersion,
      ...(model !== undefined ? { model } : {}), ...(thinking !== undefined ? { thinking } : {}) };
  } else if (group === "optimizer" && action === "set" && !positional.length && body === undefined) {
    allowed.push("--expected-version", "--model", "--thinking");
    value = { method: "setDefaultOptimizer", expectedVersion, model, thinking };
  }
  if (Object.keys(flags).some((key) => !allowed.includes(key))) return undefined;
  const mutation = parseMutation(value);
  return mutation ? { kind: "mutation", value: mutation, operationId } : undefined;
}

export function createSlashAdapter(api: ApplicationApi) {
  // Retain only retry routing, never task bodies/results. Unknown/evicted IDs cannot silently re-execute.
  const retryScopes = new Map<string, MutationMeta>();
  return async (source: string, ctx: ExtensionContext): Promise<void> => {
    const command = parseSlash(source);
    if (!command) { ctx.ui.notify("Invalid /refine-api command; see docs/usage.md. No changes made.", "warning"); return; }
    const hello = api.hello("native-slash");
    let result: Reply<unknown> = hello;
    let operationId: string | undefined;
    if (hello.kind === "ok") {
      if (command.kind === "query") result = api.query(hello.value.binding, command.value);
      else {
        operationId = command.operationId ?? randomUUID();
        const meta = command.operationId ? retryScopes.get(operationId) :
          { binding: hello.value.binding, clientLeaseId: hello.value.lease.id, operationId };
        if (meta) {
          if (!command.operationId) {
            if (retryScopes.size >= 256) retryScopes.delete(retryScopes.keys().next().value!);
            retryScopes.set(operationId, meta);
          }
          result = await api.execute(meta, command.value);
        } else result = { kind: "rejected", code: "lease-expired" };
      }
    }
    if (ctx.mode !== "tui") {
      // Native slash has no browser-client identity; never broadcast full result bodies.
      const detail = result.kind === "ok" ? "Query the Refine application for full results." : result.code;
      ctx.ui.notify(`Refine ${result.kind}${operationId ? ` · operation ${operationId}` : ""}. ${detail}`,
        result.kind === "ok" ? "info" : "warning");
      return;
    }
    await ctx.ui.custom<void>((tui, theme, _keys, done) => {
      let off: (() => void) | undefined;
      const close = () => { off?.(); done(); };
      if (hello.kind === "ok") {
        const bound = hello.value.binding;
        try {
          off = api.subscribe(bound, ({ binding }) => {
            if (binding.runtimeId !== bound.runtimeId || binding.sessionId !== bound.sessionId || binding.lifecycleEpoch !== bound.lifecycleEpoch) close();
          });
        } catch { queueMicrotask(close); }
      }
      const text = new Text(JSON.stringify({ ...result, ...(operationId ? { operationId } : {}) }, null, 2), 0, 0);
      let offset = 0;
      let page = 1;
      let count = 0;
      return {
        invalidate: () => text.invalidate(),
        dispose: () => off?.(),
        render(width) {
          const layout = workspaceLayout(width, tui.terminal.rows);
          const lines = text.render(layout.innerWidth);
          page = Math.max(1, layout.bodyHeight);
          count = lines.length;
          offset = Math.max(0, Math.min(offset, count - page));
          return workspaceFrame(width, tui.terminal.rows, panelFrame(layout,
            [theme.fg("text", theme.bold("Refine API")) + (result.kind === "ok" ? "" : theme.fg("warning", ` · ${result.code}`))], lines.slice(offset, offset + page),
            [formatKeyHint(["Esc", "Back"], theme)], (line) => theme.fg("borderMuted", line)), theme);
        },
        handleInput(data) {
          if (matchesKey(data, "escape") || matchesKey(data, "enter")) { close(); return; }
          if (matchesKey(data, "up")) offset--;
          if (matchesKey(data, "down")) offset++;
          if (matchesKey(data, "pageUp")) offset -= page;
          if (matchesKey(data, "pageDown")) offset += page;
          offset = Math.max(0, Math.min(offset, count - page));
          tui.requestRender();
        },
      };
    }, { overlay: true, overlayOptions: REFINE_OVERLAY_OPTIONS });
  };
}
