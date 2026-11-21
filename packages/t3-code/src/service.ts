import { join } from "node:path";
import { createHash } from "node:crypto";
import { binding, identity, isRecord, keysOnly, modelIdentity, parseMutation, thinkingLevels } from "../../../src/adapters/wire.js";
import type { Thinking } from "../../../src/app/api.js";
import { PreferenceStore } from "../../../src/preference-store.js";
import { FRAME_LIMIT, type DesktopCall, type DesktopReply } from "./protocol.js";
import { createDesktopRuntime, type DesktopRegistry, type ThreadContext } from "./runtime.js";
import { loadDesktopSettings } from "./settings.js";

export function parseDesktopCall(source: string): DesktopCall | undefined {
  if (Buffer.byteLength(source) > FRAME_LIMIT) return;
  let input: unknown;
  try { input = JSON.parse(source); } catch { return; }
  if (!isRecord(input)) return;
  if (input.method === "open" && typeof input.text === "string" && keysOnly(input, ["method", "text", "adopted"])) {
    const run = input.adopted;
    if (run === undefined) return { method: "open", text: input.text };
    if (isRecord(run) && binding(run.binding) && identity(run.runId) &&
      typeof run.version === "number" && Number.isSafeInteger(run.version) && run.version > 0) {
      return { method: "open", text: input.text, adopted: { binding: run.binding, runId: run.runId, version: run.version } };
    }
    return;
  }
  if (!binding(input.binding)) return;
  const scope = { binding: input.binding };
  switch (input.method) {
    case "snapshot": if (typeof input.all === "boolean") return { ...scope, method: input.method, all: input.all }; return;
    case "task":
    case "run": if (identity(input.id)) return { ...scope, method: input.method, id: input.id }; return;
    case "settings": return { ...scope, method: input.method };
    case "mutate": {
      const mutation = parseMutation(input.mutation);
      if (mutation?.method === "startRun" || mutation?.method === "stopRun") return { ...scope, method: "mutate", mutation };
      return;
    }
    case "saveSettings":
      if (identity(input.version) && isRecord(input.fields)) return { ...scope, method: input.method, version: input.version, fields: input.fields };
      return;
    case "saveOptimizer":
      if (identity(input.version) && modelIdentity(input.model) &&
        (input.thinking === "inherit" || thinkingLevels.includes(input.thinking as Thinking))) {
        return { ...scope, method: input.method, version: input.version, model: input.model, thinking: input.thinking as Thinking | "inherit" };
      }
      return;
  }
}

export function desktopThreadId(projectId: string, threadId: string): string {
  return createHash("sha256").update(JSON.stringify([projectId, threadId])).digest("hex");
}

async function loadRegistry(): Promise<DesktopRegistry> {
  const { ModelRegistry, ModelRuntime, getAgentDir } = await import("@earendil-works/pi-coding-agent");
  const agentDir = getAgentDir();
  return new ModelRegistry(await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false,
  }));
}

type Runtime = ReturnType<typeof createDesktopRuntime>;
export async function createDesktopService(stateDir: string, registry?: DesktopRegistry, preferenceDir = stateDir) {
  const [settings, models] = await Promise.all([loadDesktopSettings(stateDir), registry ?? loadRegistry()]);
  const sessions = new Map<string, Runtime>();
  return {
    async request(host: ThreadContext, call: DesktopCall): Promise<string> {
      let runtime = sessions.get(host.sessionId);
      if (!runtime) {
        if (call.method !== "open") return JSON.stringify({ kind: "conflict", code: "binding-stale" });
        if (sessions.size >= 128) {
          const idle = [...sessions].find(([, item]) => !item.busy());
          if (!idle) return JSON.stringify({ kind: "unavailable", message: "Too many Refine threads are active." });
          idle[1].close();
          sessions.delete(idle[0]);
        }
        runtime = createDesktopRuntime(host.sessionId, settings, models, async (cwd) => {
          const store = new PreferenceStore(preferenceDir, cwd);
          await store.load();
          return store.getDefaultPreferences();
        });
      }
      sessions.delete(host.sessionId);
      sessions.set(host.sessionId, runtime);
      const reply = JSON.stringify(await runtime.handle(host, call));
      return Buffer.byteLength(reply) <= FRAME_LIMIT ? reply : JSON.stringify({
        kind: "unavailable", message: "This result exceeds the desktop transport limit.",
      } satisfies DesktopReply);
    },
  };
}
