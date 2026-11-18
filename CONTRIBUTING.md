# Contributing

For bugs and feature requests, open a [GitHub issue](https://github.com/Steam086/pi-prompt-refine/issues). For a bug, include the installed ref or commit, Pi and Node versions, OS and terminal, and the shortest steps showing what you expected and what happened. Use a synthetic draft and redact screenshots or logs. Do not attach credentials, raw conversations, or Refine history files. For security issues, follow [SECURITY.md](SECURITY.md) instead.

Run the default checks from the repository root with Node.js 22.19 or later:

```sh
npm ci
npm run typecheck
npm test
```

The default tests do not need model credentials or a running Web host. Keep pull requests focused and include a regression test for changed behavior where practical. If you tested a terminal interaction by hand, report the terminal and OS. Web is not in the native TUI release scope.
