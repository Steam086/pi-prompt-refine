# Testing

Run the offline checks from the repository root. To run a single suite, pass its path to Vitest, for example `npm test -- test/integration/extension-rounds.test.ts`.

```sh
npm run typecheck
npm test
```

## Where to test a change

| Behavior | Start here |
| --- | --- |
| Frozen context, queues and cancellation | [Round integration](../test/integration/extension-rounds.test.ts) and [controller lifecycle](../test/unit/controller-lifecycle.test.ts) |
| Accept, send, restore and stale confirmations | [Editor actions](../test/integration/extension-editor-actions.test.ts) |
| Binding, object versions and retry after a lost receipt | [Application contract](../test/integration/application-contract.test.ts) and [operation ledger](../test/unit/application-idempotency.test.ts) |
| RPC result delivery | [RPC slash integration](../test/integration/rpc-slash.test.ts) and [version-specific host observations](rpc-slash-verification.md) |
| Paged output and reconnection | [Output paging](../test/unit/output-paging.test.ts) and the Web subpackage’s [separate checks](../packages/pi-web/README.md#build-and-offline-checks) |
| Native TUI changes | [Workspace rendering](../test/renderer/workspace-consistency.test.ts), [overlay integration](../test/integration/extension-overlay.test.ts) and [Preferences interactions](../test/integration/extension-preferences.test.ts). Check focus and side effects as well as visible text, styling and bounds. |
| Package contents and actual Pi loading | Run `npm run check:pack` and follow the [tarball smoke test](release.md#verify-the-candidate). |
| Rewrite quality | Review candidates using the [semantic acceptance cases](optimizer-evaluation.md). Real-provider suites and benchmarks are opt-in. |

Use synthetic fixtures. Give each harness its own temporary state and cleanup. Tests sharing a Pi agent directory must run serially. Restore environment variables and dispose of renderers, subscriptions and timers. Wait for observable completion when testing asynchronous behavior. [Test helpers](../test/support/)

When refactoring a suite, preserve the scenarios and side effects each case checks. Route Pi test internals through the existing compatibility helpers. Review changed renderer snapshots against the intended behavior in both themes. Use a physical terminal for keyboard and IME acceptance. [UI conventions](ui-conventions.md) · [Release checks](release.md#manual-checks)
