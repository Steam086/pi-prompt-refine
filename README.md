# Pi Prompt Refine

[简体中文](README.zh-CN.md)

Pi Prompt Refine is an extension for Pi Coding Agent. It uses a separate model and the current conversation to clarify your draft, so you can review, edit, and choose what to send to your main agent.

## Features

- **Context-aware rewriting.** Clarify references from the current conversation and organize your draft while keeping your intent and constraints.
- **Independent rewrite model.** Pick any available model in Pi for rewrites and keep your main agent's model.
- **Model comparison.** Try multiple models in parallel on the same draft and context, then compare their rewrites and response times.
- **Iterative refinement.** Give follow-up directions such as “Make it shorter and keep the commands as written.”
- **Reusable Preferences.** Save instructions you often use and apply them to future rewrites.

## Installation

Use [Pi Coding Agent](https://pi.dev/) in its interactive terminal UI with a model configured in Pi. Refine requires **Node.js 22.19+** and has been tested with **Pi 1.6.0**.

```sh
pi install npm:pi-prompt-refine
```

Start Pi, or run `/reload` in an existing Pi session.

## Quick start

1. Run `/refine model` in Pi and choose your rewrite model.
2. Type a draft in the Pi editor. For example, “Look at the error handling we just discussed. Suggest improvements, but leave the code as it is.”
3. Press `Ctrl+\` to start the first rewrite and open the Refine workspace. If the draft appears as **Unsent**, select it and press `Enter` to start.
4. Review a completed result and press `a` to accept it into the Pi editor. Edit it if needed, then submit it yourself when you're ready.

## Essential commands

| Command or key | Action |
| --- | --- |
| `/refine` | Open the Refine workspace without a model call. |
| `/refine optimize <text>` | Request a rewrite if the editor shortcut is unavailable. |
| `?` in Refine | See the shortcuts for your current selection. |

## Important notes

- **Cost.** A rewrite is a separate model request and may use quota or incur charges.
- **Privacy.** The rewrite provider receives your draft, submitted editing instructions, and enabled context. By default, that includes selected recent messages. [See what is sent and how to limit it.](docs/tui-guide.md#what-the-rewrite-provider-receives)
- **Local history.** By default, Refine saves submitted drafts, results, and editing instructions alongside your Pi session file when one exists. [Manage or clear saved history.](docs/tui-guide.md#local-history-and-cleanup)

## Documentation

- [TUI guide](docs/tui-guide.md)
- [Configuration reference (Chinese)](https://github.com/Steam086/pi-prompt-refine/blob/main/docs/configuration.md)
- [Choosing and saving Preferences (Chinese)](https://github.com/Steam086/pi-prompt-refine/blob/main/docs/preference-selection.md)
- [Shortcut troubleshooting](docs/tui-guide.md#if-the-shortcut-does-not-work)
