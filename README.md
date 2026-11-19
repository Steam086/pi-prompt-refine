# Pi Prompt Refine

[简体中文](https://github.com/Steam086/pi-prompt-refine/blob/main/README.zh-CN.md)

Turn a rough draft into a clearer prompt using the current conversation, before you send it to your main agent. Refine uses a separate model to rewrite the text. It does not run the task, and you decide whether to use the result.

## Install

Requires **Node.js 22.19+**, [Pi Coding Agent](https://pi.dev/) in its interactive TUI, and a model configured in Pi.

```sh
pi install git:github.com/Steam086/pi-prompt-refine
```

Start Pi, or run `/reload` in an existing session. Extensions run with your Pi process's permissions; install only from sources you trust. The [experimental Web integration](https://github.com/Steam086/pi-prompt-refine/tree/main/packages/pi-web#readme) is not part of this release.

## Quick start

1. **Choose a model.** Run `/refine model` and pick the model that will rewrite your drafts. This does not change your main agent's model.
2. **Write and refine.** Type a draft in the Pi editor, such as “Explain why the second option might be faster. Don't change any code yet.” Press `Ctrl+\` to start the first rewrite of the round. Until you send a message to Pi, another new draft opens as **Unsent**; press `Enter` to rewrite it. Rewriting can use quota or incur charges.
3. **Review the result.** Select the result and press `a` to put it back in the Pi editor **without sending it**. Edit it if needed, then submit it yourself to the main agent. That is a separate model request.

`/refine` opens the workspace without running a model. `/refine <text>` requests a rewrite directly. If the shortcut is intercepted by your terminal, see [shortcut troubleshooting](https://github.com/Steam086/pi-prompt-refine/blob/main/docs/tui-guide.md#if-the-shortcut-does-not-work).

## Try a Preference

If no global Refine preference library exists, the first TUI load adds four editable starter Preferences. Existing libraries, including empty ones, are left alone. Nothing is selected or applied automatically.

| Starter | What it changes |
| --- | --- |
| **Clarify Prompt Intent** | Clarifies references or scope only when the conversation makes them clear. |
| **Prompt Bullet Structure** | Organizes parallel points in the prompt, not the answer. |
| **Translate Prompt to English** | Translates the prompt without changing literal text or the requested answer language. |
| **Answer in Bullet Points** | Adds an answer-format requirement when bullets make sense. |

To choose Preferences before the first rewrite, open `/refine` and press `n` to create a draft without a model call. On an **Unsent** draft, press `Tab`, choose a Preference, and press `Space` to toggle it. `Enter` starts the rewrite. Use `p` to manage the library. The [full example catalog](examples/prompt-refine-preferences.json) has more templates.

## Model calls and local history

- The selected Refine provider receives the draft and selected context. It may be different from your main agent's provider. Refine does not load file contents from `@file` references, but selected conversation history can already contain sensitive text. See [how to limit context](https://github.com/Steam086/pi-prompt-refine/blob/main/docs/tui-guide.md#what-the-rewrite-provider-receives).
- The rewrite model receives no tools. Review the result before sending it, especially your constraints, commands, and quoted text. The first direct send with `s` in Refine asks for confirmation before handing it to Pi.
- Submitted drafts, results, and submitted revision instructions are saved locally alongside the Pi session file by default. Disabling `historyPersistence` stops reading and writing that history after `/reload`; it does not delete previously saved files. See [history and cleanup](https://github.com/Steam086/pi-prompt-refine/blob/main/docs/tui-guide.md#local-history-and-cleanup).

## Documentation

- **English:** [TUI guide](https://github.com/Steam086/pi-prompt-refine/blob/main/docs/tui-guide.md) · [macOS smoke test](https://github.com/Steam086/pi-prompt-refine/blob/main/docs/macos-smoke-test.md) · [Contributing](https://github.com/Steam086/pi-prompt-refine/blob/main/CONTRIBUTING.md) · [Reporting security issues](https://github.com/Steam086/pi-prompt-refine/blob/main/SECURITY.md)
- **简体中文:** [安装与入门](https://github.com/Steam086/pi-prompt-refine/blob/main/README.zh-CN.md) · [详细用法](https://github.com/Steam086/pi-prompt-refine/blob/main/docs/usage.md) · [配置参考](https://github.com/Steam086/pi-prompt-refine/blob/main/docs/configuration.md)

To remove the extension, run `pi remove git:github.com/Steam086/pi-prompt-refine` and restart Pi or run `/reload`. Uninstalling does not delete your Refine preferences or saved history.
