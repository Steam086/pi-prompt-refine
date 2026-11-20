# Contributing

For bugs and feature requests, open a [GitHub issue](https://github.com/Steam086/pi-prompt-refine/issues). For a bug, include the installed ref or commit, Pi and Node versions, OS and terminal, and the shortest steps showing what you expected and what happened. Use a synthetic draft and redact screenshots or logs. Do not attach credentials, raw conversations, or Refine history files. For security issues, follow [SECURITY.md](SECURITY.md) instead.

Run the default checks from the repository root with Node.js 22.19 or later:

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run check:pack
```

The default tests do not need model credentials or a running Web host. Keep pull requests focused and include a regression test for changed behavior where practical. If you tested a terminal interaction by hand, report the terminal and OS. Web is not in the native TUI release scope.

Maintainers: use the [release checklist](docs/release.md) to audit dependencies, inspect and try the actual tarball, and plan recovery. Keep registry credentials out of PRs. Tests, contributor docs and experimental Web code are repository resources, not Pi package entry points.

## Documentation languages

| Audience | Scope |
| --- | --- |
| English readers | English is the primary language for the native TUI release: [installation and first use](README.md), the [TUI guide](docs/tui-guide.md), [release smoke tests](docs/macos-smoke-test.md), contribution instructions, and [security reporting](SECURITY.md). Document new public workflows in English. |
| Simplified Chinese readers | Maintain the [Chinese README](README.zh-CN.md) for installation and first use. Keep the existing [usage](docs/usage.md) and [configuration](docs/configuration.md) references available; they need not mirror the English guide. |
| Maintainers and experimenters | Architecture, API, test, design, and experiment notes can stay in their existing language. Translate only what readers need to use a supported feature. The experimental Web integration is outside the native TUI release. |

When a change affects instructions shared by both READMEs (installation, first use, or key data warnings), update both in the same pull request. Update any affected reference in its existing language; don't create a second full reference just for parity. Keep commands, configuration keys, and TUI labels as displayed. This policy covers documentation, not translation of the TUI itself.
