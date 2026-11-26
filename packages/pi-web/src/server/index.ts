import type { JsonValue, PiWebServerPluginV5, PiWebHostPiSessionEventsV1, PluginCapability, ServerPluginPeerScope } from "@jmfederico/pi-web/server-plugin-api";
import { binding, identity, isRecord, keysOnly } from "../../../../src/app/operation-contract.js";
import { parseWireCall } from "../../../../src/adapters/wire.js";
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
function authorizedCall(value: unknown, sessionId: string, clientId: string) {
  const call = parseWireCall(value);
  switch (call?.action) {
    case "hello": return call.clientId === clientId ? call : undefined;
    case "query": return call.binding.sessionId === sessionId ? call : undefined;
    case "mutate": return call.meta.binding.sessionId === sessionId ? call : undefined;
    case "readOutput": return call.index >= 0 ? call : undefined;
    case "stage": return call.text.length <= 48 * 1024 ? call : undefined;
    case "releaseOutput": case "commit": return call;
    default: return undefined;
  }
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
            if (!keysOnly(input, ["sessionId", "clientId", "call"]) || operation !== "call") throw new Error("invalid-input");
            const call = authorizedCall(input.call, selected.sessionId, input.clientId as string);
            if (!call) throw new Error("invalid-input");
            const connection = await pool.get(selected, input.clientId as string);
            if (signal.aborted) throw new Error("outcome-unknown");
            return await connection.call(call, signal);
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
