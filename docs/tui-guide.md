# TUI guide

For installation and your first rewrite, start with the [README](../README.md). The native Pi TUI is the supported interface for this release.

## Work with drafts and results

Press `Ctrl+\` in the editor to open a compact centered preview. Press `a` to put the full result in the editor. Pi handles the next editor submission. Use `v` for a full-height reading pane, `f` for revision instructions, or `w` for the workspace. Esc returns one level. Closing a running preview moves its progress to the single line above the editor.

The workspace has three tabs: **Preview** for the current round, **Usage** for current and earlier records, and **Settings** for configuration. Use the Left and Right arrow keys to switch tabs and `?` to see the actions available for your current selection. Press `Esc` from a top-level tab to close the workspace. Settings asks before discarding staged changes. In a subpage, such as Usage record details, `Esc` returns to the parent page.

Scroll within the workspace to read long results. The frame stays stable as you switch pages and may cover part of the Pi footer in a short terminal.

With Pi's mouse support enabled, wheel over a document to scroll its pane. Drag across visible text to copy from that pane. The current action target stays selected.

| To… | Do this |
| --- | --- |
| Refine from the Pi editor | With an optimizer selected, type a new draft and press `Ctrl+\`. Each new draft starts with the captured session choices, including inherited project defaults. An exact match opens the existing task. |
| Rewrite an Unsent draft | Press `Enter` in the quick preview to start. To choose Preferences first, press `p`, toggle items with `Space`, then return with `Esc`. In the workspace, `Tab` opens the inline checklist. Press `Enter` to start the rewrite. |
| Try a different model | Select the draft or a run and press `m`. Choose a model and press `Enter` to run it without changing your default. |
| Revise a result | Select the result and press `f`. Enter your revision instructions, then press `Ctrl+S` to request a new rewrite. |
| Use a result | Press `a` to put it in the Pi editor **without sending**. Review and submit it yourself, or press `s` in result details to send directly. The first direct send after loading asks for confirmation. |
| Stop a rewrite | Select its queued or running entry and press `x`. Closing the workspace does not stop it. |

With an empty editor the shortcut resumes an actionable task in the current round. An accepted result still in the editor reopens for reading. Use `n` in the quick preview to start a fresh editor draft. Refine asks before clearing unrelated text and keeps a confirmed copy as an in-memory Unsent draft. A user message starting in Pi ends the round.

### Preferences

In **Preview**, press `p` on an editable **Unsent** original to choose preferences for that prompt. With any other selection, or with an empty workspace, `p` opens **This session**: choices for new prompts and explicit copies in this Pi session. `Space` toggles and saves immediately. The checkbox and selected count update without another key; `Esc` just returns. Neither action runs a rewrite or writes to the Pi editor.

`g` changes the **project default** (`*`) from either chooser. A session choice inherits that default until you override it with `Space`. For example, `[ ] *` means the project default is on but this session has opted out. In **This session**, `r` restores inheritance for the highlighted item. Session choices survive closing the workspace and starting a new round, but not `/reload`. They don't change existing drafts or runs, same-input retries, or Revise drafts.

From the **Library** list, press `n` to add an entry or use `e` and `d` to edit or delete the highlighted entry. Add highlights **Name** and Edit highlights **Instruction**. Use `↑` and `↓` to browse fields and `Enter` or `Space` to edit text. In **Instruction**, `Enter` inserts a newline and the arrow keys move the cursor. Press `Esc` to return to the fields and `Ctrl+S` to save to the library. Existing drafts retain their captured versions. To use a new version in an existing draft, deselect the old entry and select it again. In **Usage**, `p` on a run opens a read-only audit of its adopted preferences.

On **Type** or **Scope**, press `Enter` or `Space` to cycle through the options in display order. The filled dot marks the current value. **Scope** is editable when adding an entry. When the form asks about unsaved edits, `Esc` returns to the form and `y` discards it. In the library, press `?` for shortcuts.

For an existing result, press `f` to open **Revise**, then `Alt+P` (or `Tab`, then `Enter`) to choose preferences for the revision draft. `Ctrl+S` in Revise or `Enter` on an Unsent original starts a rewrite; `Space` in a chooser never does.

Select **In Your Own Words** in Preferences to see how the rewrite model understood your draft. The note appears below the rewritten prompt and is not included when you accept or send it. You can also add your own **Result notes** in Preferences.

## Settings

- Use `/refine model` to choose the default rewrite model. Your main agent's model does not change, and Pi still manages provider authentication.
- Walk through **Context** and **Optimizer** with `↑` and `↓`. Use `Enter` or `Space` to change the highlighted setting. `Tab` jumps between the groups. Use `PgUp` / `PgDn` to read more detail about the highlighted setting.
- Open a numeric setting with `Enter` or `Space`. Type a value or press `↑` or `↓` to browse presets, then `Enter` or `Space` to use the highlighted preset. `Esc` goes back to the value from the presets and cancels from the value. Press `Enter` on the value to stage it or `Ctrl+S` to save it along with other staged settings. On the Settings list, `Esc` asks before discarding staged changes and closing. Context changes apply from the next round. The model, thinking level, and optimization prompt save separately.
- In **Optimizer → Optimization prompt**, press `Enter` to edit Refine’s rewrite policy. Press `Ctrl+S`, then `y` to confirm the save. Press `Esc` on a changed draft to review whether to discard it. From either confirmation, `Esc` returns to the draft. The policy applies only to Refine, starting with the next round.
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

- **Usage** shows `Error: network` when Pi reports a recognizable transport failure, such as a connection reset, DNS lookup failure, or TLS error. History stores the category alone. The provider's error text and stack are excluded.
- To stop loading and saving history, set `"historyPersistence": false` in the config and run `/reload`. This does **not** delete existing files.
- These are plaintext files, not encrypted storage. The sidecar writer requests owner-only permissions (`0600` on POSIX) and limits each session to 100 runs / 2 MiB. Accepting or sending a result can also set a previously unnamed Pi session's title. Clearing Refine history does not clear Pi metadata, the provider's records, or backups.
- To remove the saved history for the current session, run `/refine history clear` and confirm. This leaves the Pi conversation and in-memory Refine records intact, and pauses saving until the next reload.

Config and preferences are separate from history. The Pi agent directory can contain `prompt-refine.json` (model and policy) and `prompt-refine-preferences.json` (names and bodies). Project entries and enabled defaults live in `.pi/prompt-refine-preferences.json` and `.pi/prompt-refine-preference-defaults.json` under the working directory. Removing the package leaves these files in place; if you no longer want them, close Pi and remove only the Refine files you identified. Never share a Pi profile, `.npmrc`, sidecar, or raw session to report a bug. Use a synthetic draft instead.

## If the shortcut does not work

Use `/refine` to open the workspace without a model call, or `/refine optimize <text>` to request a rewrite without the shortcut. If your draft is itself a reserved command name, use the explicit form, for example `/refine optimize model`. Check `/hotkeys` in Pi to see the loaded binding. Avoid testing `Ctrl+\` at a shell prompt: it may send `SIGQUIT`.
