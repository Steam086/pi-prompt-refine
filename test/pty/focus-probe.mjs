import { appendFileSync } from "node:fs";
export default function probe(pi) {
  const log = value => appendFileSync(process.env.PROBE_LOG, value + "\n");
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setWidget("probe", () => ({
      render: () => ["aboveEditor witness"], invalidate() {}, handleInput(data) { log("widget " + JSON.stringify(data)); },
    }), { placement: "aboveEditor" });
  });
  pi.registerShortcut("ctrl+\\", {description: "Probe", handler: async ctx => {
    log("editor shortcut " + JSON.stringify(ctx.ui.getEditorText()));
    await ctx.ui.custom((tui, _theme, _keys, done) => ({
      render: () => ["FOCUS PROBE"], invalidate() {},
      handleInput(data) { log("overlay " + JSON.stringify(data)); if (data === "\x1b") done(); },
    }), { overlay: true, overlayOptions: {anchor: "bottom-center", offsetY: -3} });
  }});
}
