# TUI guide

For installation and your first rewrite, start with the [README](../README.md). The native Pi TUI is the supported interface for this release.

## Work with drafts and results

The workspace has three tabs: **Preview** for the current round, **Usage** for current and earlier records, and **Settings** for configuration. Use the Left and Right arrow keys to switch tabs and `?` to see the actions available for your current selection.

The centered workspace uses about 96% of the terminal width and 75% of its height, leaving the Pi session visible above and below. Switching tabs or opening a long result does not resize it; scroll within the page to read more. Pi still renders its footer behind the workspace, but on short terminals the overlay can cover part of it.

| To… | Do this |
| --- | --- |
| Refine from the Pi editor | With an optimizer selected, type a new draft and press `Ctrl+\`. The first rewrite of the round starts immediately with your project defaults. Later new drafts open as **Unsent**. |
| Rewrite an Unsent draft | Select it and press `Enter`. To add Preferences first, press `Tab`, then `Space` on each item you want. Press `Enter` to start the rewrite. |
| Try a different model | Select the draft or a run and press `m`. Choose a model and press `Enter` to run it without changing your default. |
| Revise a result | Select the result and press `f`. Enter your revision instructions, then press `Ctrl+S` to request a new rewrite. |
| Use a result | Press `a` to put it in the Pi editor **without sending**. Review and submit it yourself, or press `s` in result details to send directly. The first direct send after loading asks for confirmation. |
| Stop a rewrite | Select its queued or running entry and press `x`. Closing the workspace does not stop it. |

The first request counts as soon as Refine queues it, even if you stop it, it fails, or you delete its record. An unchanged draft reopens its existing entry without calling the optimizer again. Sending a user message to Pi ends the round; merely accepting a result into the editor does not. The shortcut never changes the editor or sends to the main agent.

To choose Preferences before the first rewrite, open `/refine`, press `n`, and save a draft with `Enter` before choosing Preferences.

## Settings

- Use `/refine model` to choose the default rewrite model. Your main agent's model does not change, and Pi still manages provider authentication.
- In **Settings**, use `Tab` to switch between **Context** and **Optimizer**. **Draft character limit** is the last Optimizer setting, or the last Context setting if Optimizer is unavailable. Select a row to read its full details; use `PgUp` / `PgDn` if they span multiple pages.
- `Enter` stages a numeric edit; `Ctrl+S` back in Settings saves it without leaving the current group or selection. `Esc` returns to Preview. Context changes apply to the next round, not the current round. The model, thinking level, and optimization prompt save separately.
- In **Optimizer → Optimization prompt**, press `Enter` to edit Refine’s rewrite policy without leaving Settings. Press `Ctrl+S`, then `y` to confirm. `Esc` from confirmation returns to your draft; `Esc` from the editor discards your edits. The policy applies only to Refine, starting with the next round.
- The config file is `prompt-refine.json` in your Pi agent directory. See the [example config](../examples/prompt-refine.json); its model entry is illustrative. After editing the file, run `/reload` in Pi.

## What the rewrite provider receives

Refine sends the draft and selected context to the rewrite provider, which may differ from your main agent's provider. Conversation history can contain sensitive text. The rewrite model has no tools, and Refine does not load file contents from `@file` references.

| Context | Default | How to limit it in **Settings → Context** |
| --- | --- | --- |
| Conversation history | Up to 12 visible user or assistant messages from the current branch, within a 16,000-character budget. Raw tool results and thinking are excluded. | Lower **History messages** or **History characters**. Set either to `0` to exclude conversation history. |
| Working directory and rule sources | Refine uses the absolute working directory locally, not as a field in the request. Project rule sources are relative to that directory (e.g. `docs/AGENTS.md`); rules from elsewhere are labeled `external rule`. | No setting is needed to hide the absolute source path. Paths already in your draft, selected history or rule text are not redacted. |
| Explicit directory references | On. Refine can include bounded name listings from directories inside the working directory, not file contents. | Turn **Directory references** off. This is separate from **Directory tree**. |
| Project instructions | Off. When enabled, Refine can send rules Pi has already loaded, such as `AGENTS.md`, to the rewrite model. | **First request only** includes rules on the first request of each task, not on Revise. **Off** does not change the main agent's rules. |
| Default directory tree and skill metadata | Both off unless enabled. Refine uses the default tree only when no conversation history is included. | Turn **Project context** off to exclude rules, skills, and both kinds of directory listing. Child settings keep their values; any that were on are marked inactive. Conversation history is unaffected. |

To exclude both conversation history and project context, set either history limit to `0`, turn **Project context** off, and save with `Ctrl+S`. Use the next round for the new settings. The draft, rewrite policy, and any submitted editing instructions (including project-default or manually selected Preference bodies) are still sent. Revise also sends the previous candidate and can include earlier editing instructions. These settings exclude conversation text, not the packet's history counts. Refine cannot redact arbitrary secrets or control a provider's retention. These context controls do not change local history storage.

## Local history and cleanup

By default, when Pi uses a session file, Refine stores submitted drafts, results, submitted initial and revision instructions, and run metadata alongside it in `<session-file>.prompt-refine.json`. It does not store unsent drafts, the full captured context, or the provider request payload. Drafts and results can still contain sensitive text. In **Usage**, press `b` to see the storage status and file path.

- To stop loading and saving history, set `"historyPersistence": false` in the config and run `/reload`. This does **not** delete existing files.
- These are plaintext files, not encrypted storage. The sidecar writer requests owner-only permissions (`0600` on POSIX) and limits each session to 100 runs / 2 MiB. Accepting or sending a result can also set a previously unnamed Pi session's title. Clearing Refine history does not clear Pi metadata, the provider's records, or backups.
- To remove the saved history for the current session, run `/refine history clear` and confirm. This leaves the Pi conversation and in-memory Refine records intact, and pauses saving until the next reload.

Config and preferences are separate from history. The Pi agent directory can contain `prompt-refine.json` (model and policy) and `prompt-refine-preferences.json` (names and bodies). Project entries and enabled defaults live in `.pi/prompt-refine-preferences.json` and `.pi/prompt-refine-preference-defaults.json` under the working directory. Removing the package leaves these files in place; if you no longer want them, close Pi and remove only the Refine files you identified. Never share a Pi profile, `.npmrc`, sidecar, or raw session to report a bug. Use a synthetic draft instead.

## If the shortcut does not work

Use `/refine` to open the workspace without a model call, or `/refine optimize <text>` to request a rewrite without the shortcut. If your draft is itself a reserved command name, use the explicit form, for example `/refine optimize model`. Check `/hotkeys` in Pi to see the loaded binding. Avoid testing `Ctrl+\` at a shell prompt: it may send `SIGQUIT`.
