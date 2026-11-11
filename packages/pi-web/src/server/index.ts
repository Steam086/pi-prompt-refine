import type { JsonValue, PiWebServerPluginV5, PiWebHostPiSessionEventsV1, PluginCapability, ServerPluginPeerScope } from "@jmfederico/pi-web/server-plugin-api";
import { binding, identity, isRecord, keysOnly, mutationMeta, parseMutation, parseQuery } from "../../../../src/adapters/wire.js";
import { createConnections } from "./connections.js";

/** Public capability identity, with local structural validation; no global-package runtime resolution. */
export const sessionEvents: PluginCapability<PiWebHostPiSessionEventsV1, 1> = Object.freeze({
  pluginId: "pi-web.host", id: "pi-session-events", version: 1,
  parse(value: unknown): PiWebHostPiSessionEventsV1 {
    if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 ||
      !("connect" in value) || typeof value.connect !== "function") throw new Error("Unsupported session events capability");
    const capability = value as PiWebHostPiSessionEventsV1;
    return Object.freeze({ version: 1 as const, connect: (selection: Parameters<PiWebHostPiSessionEventsV1["connect"]>[0]) => capability.connect(selection) });
  },
});
function selection(scope: ServerPluginPeerScope, input: unknown) {
  if (scope.kind !== "workspace" || !isRecord(input) || !identity(input.clientId) ||
    typeof input.sessionId !== "string" || !input.sessionId.length || input.sessionId.length > 512) throw new Error("invalid-scope");
  return { projectId: scope.project.id, workspaceId: scope.workspace.id, sessionId: input.sessionId };
}
function validCall(call: unknown, sessionId: string, clientId: string): call is Record<string, unknown> {
  if (!isRecord(call)) return false;
  if (call.action === "hello") return keysOnly(call, ["action", "clientId", "resumeLease"]) && call.clientId === clientId &&
    (call.resumeLease === undefined || identity(call.resumeLease));
  if (call.action === "query") return keysOnly(call, ["action", "binding", "query"]) && binding(call.binding) &&
    call.binding.sessionId === sessionId && !!parseQuery(call.query);
  if (call.action === "mutate") return keysOnly(call, ["action", "meta", "mutation"]) && mutationMeta(call.meta) &&
    call.meta.binding.sessionId === sessionId && !!parseMutation(call.mutation);
  if (call.action === "readOutput") return keysOnly(call, ["action", "outputId", "index"]) && identity(call.outputId) &&
    Number.isSafeInteger(call.index) && (call.index as number) >= 0;
  if (call.action === "releaseOutput") return keysOnly(call, ["action", "outputId"]) && identity(call.outputId);
  if (call.action === "stage") return keysOnly(call, ["action", "transferId", "index", "total", "text"]) && identity(call.transferId) &&
    Number.isSafeInteger(call.index) && Number.isSafeInteger(call.total) && typeof call.text === "string" && call.text.length <= 48 * 1024;
  return call.action === "commit" && keysOnly(call, ["action", "transferId"]) && identity(call.transferId);
}
const plugin: PiWebServerPluginV5 = {
  apiVersion: 5, name: "Prompt Refine", requires: [sessionEvents],
  activate() {
    let pool: ReturnType<typeof createConnections> | undefined;
    return {
      start({ capabilities }) { pool = createConnections(capabilities.resolve(sessionEvents)); },
      dispose() { pool?.dispose(); },
      peer: {
        async request({ scope, operation, input, signal }): Promise<JsonValue> {
          try {
            const selected = selection(scope, input);
            if (!pool || !isRecord(input)) return { kind: "rejected", code: "not-ready" };
            if (!keysOnly(input, ["sessionId", "clientId", "call"]) || operation !== "call" ||
              !validCall(input.call, selected.sessionId, input.clientId as string)) throw new Error("invalid-input");
            const connection = await pool.get(selected, input.clientId as string);
            if (signal.aborted) throw new Error("outcome-unknown");
            return await connection.call(input.call as Record<string, unknown>, signal);
          } catch (error) {
            const code = error instanceof Error && ["invalid-input", "invalid-scope", "resource-limit", "connection-closed", "transfer-expired", "outcome-unknown"].includes(error.message)
              ? error.message : "bridge-unavailable";
            return { kind: "error", code };
          }
        },
        async openChannel({ scope, operation, input, signal, send }) {
          const selected = selection(scope, input);
          if (operation !== "watch" || !pool || !isRecord(input) || !keysOnly(input, ["sessionId", "clientId", "binding"]) ||
            !binding(input.binding) || input.binding.sessionId !== selected.sessionId || signal.aborted) throw new Error("invalid-scope");
          const connection = await pool.get(selected, input.clientId as string);
          const bound = input.binding;
          let finish!: () => void;
          const closed = new Promise<void>((resolve) => { finish = resolve; });
          const off = connection.on((value) => {
            try { send(value); } catch { finish(); }
          });
          const close = () => { off(); connection.close(); signal.removeEventListener("abort", close); finish(); };
          signal.addEventListener("abort", close, { once: true });
          try {
            const reply = await connection.call({ action: "subscribe", binding: bound }, signal);
            if (!isRecord(reply) || reply.kind !== "ok") throw new Error("binding-stale");
            return {
              closed,
              async receive(value: JsonValue, pingSignal: AbortSignal) {
                if (!isRecord(value) || !keysOnly(value, ["action"]) || value.action !== "ping") throw new Error("invalid-input");
                const reply = await connection.call({ action: "subscribe", binding: bound }, pingSignal);
                if (!isRecord(reply) || reply.kind !== "ok") { close(); return; }
                send({ type: "pong", revision: reply.revision as number });
              },
              close,
            };
          } catch (error) { close(); throw error; }
        },
      },
    };
  },
};
export default plugin;
