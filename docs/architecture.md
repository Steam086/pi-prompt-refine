# Architecture

Pi loads the root extension once per runtime. The native TUI, slash commands and session-events bridge use the same application. Clients attached to one hosted session see the same tasks and runs. The entry point registers handlers and the runtime wires together model access, storage and editor actions. [Extension entry point](../src/extension.ts) · [Runtime](../src/app/runtime.ts)

| When changing… | Ownership and contract |
| --- | --- |
| Rounds, queuing or cancellation | The [controller](../src/controller.ts) coordinates runs. The [journal](../src/history.ts) holds records and versions. The round ends when Pi starts processing a user message. |
| Model requests | [Request flows](../src/app/request-flows.ts) capture the draft, its background, and the effective preferences from [session overrides](../src/app/session-preferences.ts) and project defaults. [Completion](../src/app/completion.ts) budgets each request and calls the selected optimizer with an empty tool list. [Context and output protocol](context.md) |
| Native TUI or editor actions | The [workspace](../src/workspace.ts) owns pages and focus. [Editor actions](../src/app/editor-actions.ts) handle accept, send and restore, including confirmation if the user has edited the draft. [UI conventions](ui-conventions.md) |
| Session changes and persisted history | [Lifecycle](../src/app/lifecycle.ts) closes stale views and switches the session’s [history store](../src/history-store.ts). Restored records contain reviewable text. Running a restored draft again requires copying it into a round with fresh context. |
| Slash, RPC or Web clients | [Commands](../src/app/commands.ts) route by host mode. The [application API](application-api.md) scopes reads, writes and retries to a runtime and session. The [experimental Web client](../packages/pi-web/README.md) keeps its own form and reading state and uses the host’s session-events capability. |

Keep host capabilities with the module that owns the side effect. For example, closing a reader releases its subscription while a submitted run continues under the controller. [Application contract tests](../test/integration/application-contract.test.ts)
