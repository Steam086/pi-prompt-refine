# Prompt Refine · PI WEB integration (experimental)

A private, independently built browser/server plugin for the first Refine application slice. It is **not deployed or host/browser-acceptance-tested** by the offline suite.

The browser and native `/refine-api` use the same hosted Pi session's application. The server uses only the public `pi-web.host / pi-session-events / v1` capability. It never creates a controller, calls a model, reads history sidecars, or imports the Refine runtime. The core extension remains independent of pi-web.

## Build and offline checks

From this directory in the source checkout (root `node_modules` is not required):

```sh
npm ci --ignore-scripts --omit=optional
npm run typecheck
npm test
```

Pinned development tools: TypeScript 5.9.3, Node types 22.20.5, pi-web public declarations 1.202611.1. No framework, bundler, root workspace migration, root dependency upgrade or publishing change. The two `tsc` graphs emit to separate `dist/browser` and `dist/server` trees. Common API/wire sources are compiled from the root, not copied or separately maintained. Browser assets contain only browser code and the pure contract/validator graph. All host imports are type-only, including on the server; the capability uses its public identity and a structural parser.

The offline suite connects two `RefineClient`s through the real server peer and real core events adapter, with a fake capability/application behind it. It checks scope rejection, Unicode staging/paged output, lost acknowledgments and same-lease reconnect, plus emitted import graphs. Root tests separately exercise the real controller and SDK-facing extension in native/RPC/print harnesses. These are not browser E2E or a real plugin load test.

## Supported panel workflow

1. Select an existing ready conversation that has the **root Refine extension** loaded.
2. Open Refine and explicitly Connect. Merely rendering/mounting the panel makes no requests.
3. Select a model/thinking and **Save optimizer**. This affects Refine only, not Pi's main model.
4. **New draft → Save draft → Optimize saved draft**. Saving/typing does not run a model.
5. Select a run, **Read result**, or **Stop selected run**. Close/disconnect never cancels committed work.

Local edited text is not replaced by background snapshots. Optimistic versions reject stale saves. Lifecycle changes require an explicit fresh binding; pending operations retain the original Binding/lease/nonce. **Check / retry operation** first queries its ledger status; **Forget retry** explicitly drops only local retry metadata, not the task. Up to eight conversation clients are retained in panel memory, so switching views does not automatically replay unknown writes.

The panel uses DOM textContent, not HTML/Markdown injection. It has no composer accept/send/restore action and does not manage the full Preferences/Settings UI. Advanced native TUI features remain native. Native slash has no browser caller identity: RPC slash only emits a short notice; the panel's tasks/runs expose the full saved data through bound queries, not private caller-targeted slash notifications.

## Transport bounds

- Host-authoritative project/workspace IDs plus exact session ID; browser-supplied paths/unknown fields are rejected. The public host capability validates session ownership.
- Up to 32 server connections; 16 pending calls/connection; 8-second local request deadline below the host's 10-second request callback limit.
- Pending/paged responses: 16 MiB encoded memory/connection, 64 MiB globally; four paged outputs/connection, 60-second TTL. Each page is at most 48 KiB. Read/release tokens remain connection-scoped.
- Input staging uses the core adapter's bounds (see [application protocol](../../docs/application-api.md)). Output paging keeps long valid results under host envelope limits without truncation.
- Channel invalidations trigger snapshots; 60-second heartbeats renew the core subscription. Disconnect triggers bounded-backoff reconnect without replaying writes. Expired binding/lease requires explicit reconnection and reconciliation.

These are admission limits, not throughput or exact process-memory guarantees. Provider work is not tied to transport AbortSignals.

**Known acceptance gap:** the server's 16 MiB budget counts base64, while the core output limit counts JSON bytes. Very large/escape-heavy run results and references can exceed that budget even within core output-character limits. They fail explicitly with `resource-limit` (no truncation); the offline quota test demonstrates cleanup. The full configured output range is therefore **not yet aligned**. Demand-driven output streaming/paging at the core boundary is needed before claiming full-range S6 acceptance; merely raising every queue limit is not a substitute for real host validation.

## Installation / S6 authorization boundary

Build first. Both the root Pi extension and this subpackage must be installed on the target machine. The root's existing package manifest is unchanged; it does not auto-install this subpackage. PI WEB accepts a local plugin directory/package according to its public plugin installation mechanism.

**Do not link this package into an active host or restart services just to run the offline suite.** Server-backed plugin installation/updates require a target session-daemon restart and browser reload. Restarting that daemon interrupts its active sessions and terminals, including agents it hosts. A web/API reload alone does not load the server peer.

For an isolated acceptance run, first agree on a separate `PI_WEB_DATA_DIR`, session-daemon socket/port, web port, and isolated Pi agent directory. Never inherit the hosting session's live state paths. Use no copied credentials; actual Provider calls need separate explicit approval. Production deployment also requires a verified external authentication boundary: Host/Origin checks alone are **not authentication**.

Outstanding S6 checks:

- Real installed-host manifest loading, public capability resolution and paired browser/server revision handshake.
- Two real browsers sharing one hosted runtime: draft save conflicts, queue/stop, reconnect and long Unicode text.
- Session switch/tree/reload, expired lease, malformed/oversize transport, and cleanup under real host limits.
- Narrow/wide layouts, both themes, keyboard/focus, IME and unsaved-text confirmation; automated native terminal captures are not browser visual validation.
- External authentication/proxy policy and any separately authorized live Provider call.

No production readiness claim until those checks and their evidence are recorded.
