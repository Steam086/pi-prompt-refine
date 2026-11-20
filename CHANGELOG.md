# Changelog

## [0.1.0]

Initial native Pi TUI package. Capture a draft, compare independent rewrites against the same round of context, and revise the result with optional Preferences. Accepting puts text back in the editor; it does not send it to the main agent.

The optimizer uses Pi's model registry without tools. By default it can receive visible conversation history, but Refine does not attach the absolute working directory. Enabled rule sources use project-relative paths or the label `external rule`; paths already in the text are left alone. Local directory snapshots now survive cache cleanup for retained drafts with editing preferences. Submitted drafts, instructions and results can be saved beside the Pi session. See the [TUI guide](docs/tui-guide.md) before using sensitive material.

The experimental Web integration is not included. The first version has no earlier npm release to roll back to; remove the extension to stop loading it. Uninstall does not delete local data.
