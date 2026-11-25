# AGENTS.md

## Repository principles

- Read the relevant entry point, implementation, and tests before changing behavior. Source code defines current behavior.
- Document intent, constraints, contracts, and design decisions. Link to source for implementation details and prefer runnable examples or tests for behavior. Keep documentation short and easy to find.

## Read before changing

| Area | Start here |
| --- | --- |
| Extension registration and state ownership | [`src/extension.ts`](src/extension.ts), [`src/controller.ts`](src/controller.ts), [architecture](docs/architecture.md) |
| Rewrite policy, context, and model requests | [`src/context.ts`](src/context.ts), [context and protocol](docs/context.md) |
| Application API, slash, and RPC | [application contracts](docs/application-api.md), [RPC host behavior](docs/rpc-slash-verification.md) |
| Native TUI and Preferences | [UI conventions](docs/ui-conventions.md) |
| Tests, packaging, and public docs | [testing](docs/testing.md), [release checklist](docs/release.md), [documentation languages](CONTRIBUTING.md#documentation-languages) |

See the [documentation index](docs/index.md) for other topics.

## Guardrails and checks

- Write comments only when necessary. Prefer names, types, and code structure to express intent. Don't restate the implementation; use comments for information maintainers need but cannot reliably infer from the code, such as external constraints or public API contracts.
- Keep rewrites tool-free. Accepting, sending, and restoring require explicit user action. Preserve existing session, retry, and data boundaries.
- Run `npm run typecheck` and `npm test` from the root. Run `npm run check:pack` for packaging changes.
- Get separate approval for real provider calls, host deployment or restart, publishing, pushing tags, and rewriting Git history. Release-preparation approval covers documentation, manifests, lockfile sources, and verification. Behavior fixes require separate approval.
- Keep live tests and benchmarks opt-in. Keep real sessions, sidecars, credentials, and identifying experiment output out of Git.
