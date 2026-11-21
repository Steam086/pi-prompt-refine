# Prompt Refine for T3 Code desktop

This integration targets the T3 Code v0.1.11 source checkout at `59651c1`. The renderer and the authenticated environment server both need the patch. An environment running an unpatched server does not advertise Refine in its composer.

## Prepare a build

Run `npm ci --ignore-scripts` at the root of this repository, then prepare a fresh clone of the T3 Code tag:

```sh
git clone --branch v0.1.11 https://github.com/pingdotgg/t3code.git ../t3-code-refine
node packages/t3-code/prepare.mjs ../t3-code-refine
cd ../t3-code-refine
pnpm install --no-frozen-lockfile
vp run dev:desktop --home-dir "$PWD/.t3-refine-dev" --no-seed
```

Use the Node, pnpm, and Vite+ versions pinned by the T3 checkout. The preparation script compiles the Refine server module, copies the adapters, and checks that its patch applies to the target before changing it. Use a fresh source checkout to reapply an updated integration. A normal T3 desktop build uses the patched checkout as its source. Remote environments need a server built from that checkout as well.

Configure a model credential for the Pi SDK on the T3 environment that owns the thread. The optimizer reads that environment's Pi `auth.json` and `models.json` using `PI_CODING_AGENT_DIR` when set. API-key environment variables supported by the SDK also work. Then choose a model in **Refine → Settings → Optimizer**. The thread can use any T3 provider independently of that model.

## Use the popup

- Focus the composer and press `Ctrl+\`, or click the Refine button. Change the binding in **T3 Settings → Keybindings → Refine: Optimize Draft**.
- The first eligible new draft in a round starts immediately. Later new drafts are **Unsent** until you click **Optimize** or press Enter there. Reopening an existing draft keeps its original run. An empty composer opens the view for browsing.
- Use **Preview** for the current round, **Usage** for earlier runs, and **Settings** for the optimizer and context. In Settings, `Ctrl+S` saves staged fields. Model and rewrite-policy changes have separate save actions. Context and rewrite-policy changes apply when the next round captures its first draft.
- **Apply to draft** checks the candidate and the original composer draft again before replacing the text. Submit from the T3 composer when ready. Closing the popup leaves any active optimization running.

This version handles plain-text drafts. Drafts with attachments or structured inline context can open the popup for browsing. The server keeps Refine runs in memory. Optimizer and context settings are stored in the T3 environment state directory in `prompt-refine.json`. Project defaults are loaded from the project preference library and the environment state directory's global preference library. T3 uses its own thread projection for recent messages. Opt-in project rules come from the workspace's top-level `AGENTS.md`, and opt-in skill metadata comes from `.agents/skills` and `.pi/skills` in that workspace.

## Code and verification

- `src/` contains the transport contract, settings persistence, bounded project resource reads, and composition of Refine's controller and model request path.
- `host/apps/server/` binds calls to the authenticated T3 environment and thread projection. `host/apps/web/` owns the dialog, settings drafts, key handling, and candidate adoption in the composer.
- `t3-code.patch` adds the T3 registration, scope checks, round anchor, environment capability, and dependency notices. It applies its host changes to the pinned T3 source. The root Pi package does not include this integration.

From the Refine repository run `npm run typecheck` and `npm test`. From `apps/web` in the prepared T3 checkout run `vp test run --project browser src/components/chat/prompt-refine/RefineDialog.browser.test.tsx` after installing Playwright Chromium. The tests use synthetic drafts and a fake optimizer.
