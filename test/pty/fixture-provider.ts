import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { appendFileSync } from "node:fs";
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function fixture(pi: ExtensionAPI) {
  const log = (event: string) => {
    if (process.env.REFINE_FIXTURE_LOG) appendFileSync(process.env.REFINE_FIXTURE_LOG, event + "\n");
  };
  pi.on("message_start", event => { if (event.message.role === "user") log("user message_start"); });
  pi.registerCommand("fixture-modal", { description: "Test host selector", handler: async (_args, ctx) => {
    await ctx.ui.select("Fixture selector", ["First", "Second"]);
  }});
  pi.registerCommand("fixture-overlay", { description: "Schedule a focus probe over the reader", handler: async (_args, ctx) => {
    setTimeout(() => {
      void ctx.ui.custom((_, _theme, _keys, done) => ({
        render: () => ["Fixture overlay · Esc to close"], invalidate() {},
        handleInput(data) { log("overlay " + JSON.stringify(data)); if (data === "\x1b") done(undefined); },
      }), {overlay:true});
    }, 2200);
  }});
  if (process.env.REFINE_FIXTURE_CUSTOM_EDITOR === "1") pi.on("session_start", (_event, ctx) => {
    ctx.ui.setEditorComponent((tui, theme, keys) => new class extends CustomEditor {
      override handleInput(data: string) { log("editor " + JSON.stringify(data)); super.handleInput(data); }
    }(tui, theme, keys));
  });
  pi.registerProvider("fixture", {
    baseUrl: "http://127.0.0.1:1", apiKey: "offline-fixture", api: "local-fixture",
    models: [{ id: "writer", name: "Offline writer", input: ["text"], reasoning: false, contextWindow: 32000,
      maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, ctx) {
      log("fixture stream");
      const stream = createAssistantMessageEventStream();
      const content = ctx.messages.at(-1)?.content;
      if (Array.isArray(content) && content[0]?.type === "text" && content[0].text.startsWith("{")) {
        const expected = Array.from({length:18}, (_, i) => `  paste ${i} 中文\n`).join("") + "  end  ";
        if (JSON.parse(content[0].text).draft === expected) log("expanded paste matched");
      }
      const long = JSON.stringify(ctx.messages.at(-1)).includes("Long fixture");
      const prompt = long ? Array.from({length: 60}, (_, i) =>
        `${i+1}. Compare 中文 and 👩‍💻 output, preserve é, and explain the scheduling constraints.`).join("\n")
        : "Review the scheduling design and explain the main trade-offs.";
      setTimeout(() => {
        const message = {role: "assistant" as const, provider: model.provider, model: model.id, api: model.api,
          content: [{type: "text" as const, text: JSON.stringify({prompt})}], stopReason: "stop" as const,
          timestamp: Date.now(), usage: {input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0,
            cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}};
        stream.push({type: "done", reason: "stop", message});
        stream.end();
      }, 1200);
      return stream;
    },
  });
}
