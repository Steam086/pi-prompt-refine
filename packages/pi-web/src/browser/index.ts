import type { PiWebPluginV5 } from "@jmfederico/pi-web/plugin-api";
import { RefinePanel } from "./panel.js";
import { randomId } from "./random-id.js";

// A reloaded module must not silently reuse the previous revision's element class.
const moduleTag = randomId();
const plugin: PiWebPluginV5 = {
  apiVersion: 5, name: "Prompt Refine",
  activate({ html, runtimePluginId, lifetimeSignal }) {
    const tag = `pi-refine-${runtimePluginId.replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase()}-${moduleTag}`;
    if (!customElements.get(tag)) customElements.define(tag, class extends RefinePanel {});
    const panel = document.createElement(tag) as RefinePanel;
    const dispose = () => panel.dispose();
    lifetimeSignal.addEventListener("abort", dispose, { once: true });
    return {
      contributions: { workspacePanels: [{
        id: "refine", title: "Refine", order: 40,
        render(context) { panel.context = context; return html`${panel}`; },
      }] },
      dispose() { lifetimeSignal.removeEventListener("abort", dispose); dispose(); },
    };
  },
};
export default plugin;
