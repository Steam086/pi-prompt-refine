# Pi Prompt Refine

[简体中文](https://github.com/Steam086/pi-prompt-refine/blob/main/README.zh-CN.md)

Turn a rough draft into a clearer prompt using the current conversation, before you send it to your main agent. Refine uses a separate model to rewrite the text. It does not run the task, and you decide whether to use the result.

Compare rewrites from different models against the same draft and conversation context. You can revise a candidate with follow-up instructions and put the result back in the editor for review.

## Install

The initial release is tested with [Pi Coding Agent](https://pi.dev/) **1.6.0** and requires **Node.js 22.19+**. Use Pi's interactive TUI with a model configured in Pi.

Once the first npm version is published, install the Pi package with `pi install npm:pi-prompt-refine`. To try the repository before then:

```sh
pi install git:github.com/Steam086/pi-prompt-refine
```

Use one source, not both. `npm install -g` does not register the extension in Pi.

Start Pi, or run `/reload` in an existing session. Extensions run with your Pi process's permissions. Install only from sources you trust. The npm release contains the native Pi extension. The repository also hosts separate [Pi Web and T3 Code integrations](https://github.com/Steam086/pi-prompt-refine/tree/main/packages).

## Quick start

1. **Choose a model.** Run `/refine model` and pick the model that will rewrite your drafts. This does not change your main agent's model.
2. **Write and refine.** Type a draft in the Pi editor, such as “Explain why the second option might be faster. Don't change any code yet.” Press `Ctrl+\` to start the first rewrite of the round. Rewrites include recent conversation text by default and can use quota or incur charges. Until you send a message to Pi, another new draft opens as **Unsent**. Press `Enter` to rewrite it.
3. **Review the result.** Select the result and press `a` to put it back in the Pi editor **without sending it**. Edit it if needed, then submit it yourself to the main agent. That is a separate model request.

`/refine` opens the workspace without running a model. `/refine <text>` requests a rewrite directly. If the shortcut is intercepted by your terminal, see [shortcut troubleshooting](https://github.com/Steam086/pi-prompt-refine/blob/main/docs/tui-guide.md#if-the-shortcut-does-not-work).

## Try a Preference

You don't need to choose a Preference for an ordinary rewrite. Refine keeps your tone, clarifies references when the context resolves them, and uses bullets or numbered steps when they make existing requirements easier to follow. It preserves what you asked the main agent to do and how to answer, without adding requirements of its own.

The only bundled Preference is **Translate Prompt to English**. It translates the prompt, not literal text or the requested answer language. The TUI adds it unchecked when no global library exists. Existing libraries (including empty ones), custom Preferences, and project defaults remain unchanged.

To choose Preferences before the first rewrite, open `/refine` and press `n` to create a draft without a model call. On an **Unsent** draft, press `Tab`, choose a Preference, and press `Space` to toggle it. `Enter` starts the rewrite. Use `p` to manage the library.

## Model calls and local history

- The rewrite provider may differ from your main agent's provider. It receives the draft, submitted editing instructions (including selected Preference bodies), and selected context. Refine uses the working directory locally but does not add its absolute path to the request. A reference such as `@src/` can include names under `src/`, not file contents. Paths already written in your draft, selected history or enabled rules are not redacted. See [how to limit context](https://github.com/Steam086/pi-prompt-refine/blob/main/docs/tui-guide.md#what-the-rewrite-provider-receives).
- The rewrite model receives no tools. Review the result before sending it, especially your constraints, commands, and quoted text. The first direct send with `s` in Refine asks for confirmation before handing it to Pi.
- Submitted drafts, results, and submitted initial and revision instructions are saved locally alongside the Pi session file by default. Disabling `historyPersistence` stops reading and writing that history after `/reload`; it does not delete previously saved files. See [history and cleanup](https://github.com/Steam086/pi-prompt-refine/blob/main/docs/tui-guide.md#local-history-and-cleanup).

## Documentation

- **English:** [TUI guide](https://github.com/Steam086/pi-prompt-refine/blob/main/docs/tui-guide.md) · [macOS smoke test](https://github.com/Steam086/pi-prompt-refine/blob/main/docs/macos-smoke-test.md) · [Contributing](https://github.com/Steam086/pi-prompt-refine/blob/main/CONTRIBUTING.md) · [Reporting security issues](https://github.com/Steam086/pi-prompt-refine/blob/main/SECURITY.md)
- **简体中文:** [安装与入门](https://github.com/Steam086/pi-prompt-refine/blob/main/README.zh-CN.md) · [详细用法](https://github.com/Steam086/pi-prompt-refine/blob/main/docs/usage.md) · [配置参考](https://github.com/Steam086/pi-prompt-refine/blob/main/docs/configuration.md)

To remove the extension, check `pi list` and use the installed source: `pi remove npm:pi-prompt-refine` for npm or `pi remove git:github.com/Steam086/pi-prompt-refine` for Git. Restart Pi or run `/reload`. Uninstalling does not delete your Refine preferences or saved history.
