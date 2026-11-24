# macOS smoke test

Use this manual checklist on a named candidate. For the model steps, use a synthetic draft and a model approved for the test. Rewrites can use quota or incur charges.

## Clean install (Git, candidate tarball, or published npm version)

Install [Pi](https://pi.dev/) and use a Node.js version allowed by the [package manifest](../package.json). Record `sw_vers`, the terminal app and version, `node --version`, `pi --version`, and the installed tag or commit if known. The default GitHub source tests the default branch; add `@<tag-or-commit>` to the source when testing an exact ref.

Use a dedicated terminal with no inherited provider credentials or live-test flags. `PI_CODING_AGENT_DIR` isolates profile files, not secrets already exported by your shell. For a separate Pi profile and working directory:

```sh
smoke_dir=$(mktemp -d "${TMPDIR:-/tmp}/pi-refine.XXXXXX")
export PI_CODING_AGENT_DIR="$smoke_dir/agent"
cd "$smoke_dir"
source=git:github.com/Steam086/pi-prompt-refine
# After npm publication, use source=npm:pi-prompt-refine@<version> instead.
# Before publication, a locally installed candidate directory is also a Pi source
# (see the tarball smoke test in release.md). Choose just one source.
pi install "$source"
pi list
pi
```

If needed, authenticate through Pi's `/login` within the test profile before selecting an optimizer. Do not copy an existing credential or session file into it. Without model access, you can still open `/refine`, press `p`, inspect the starter library, and test uninstall.

## Walk through the TUI

1. Use `/refine model` to choose an optimizer. Type a synthetic draft using Chinese input, for example `解释第二个方案为什么可能更快，先给建议，别改代码。` Check that unfinished IME input does not submit the draft.
2. Press `Ctrl+\`. The first rewrite should start without `Enter`. Confirm the result still asks for explanation rather than implementation. Narrow the window and check that the key hints and result are readable.
3. Press `a` and verify the result is back in the editor and no main-agent reply starts. Replace it with a different synthetic draft and press `Ctrl+\` again. Without sending to Pi, the new draft should be **Unsent**. Press `Tab` to find only **Translate Prompt to English**, unchecked, in a new profile. Toggle it with `Space` and verify this alone does not call the model.
4. Press `Enter` to start the second rewrite. To check the direct-send guard without sending, open the new result's details, press `s`, and cancel at the quota confirmation.
5. Optionally edit or delete a starter in the `p` library, then run `/reload` and verify it stays changed or deleted.

Exit Pi, run `pi remove "$source"` (the same source you installed), and check `pi list` again. The isolated test directory may still contain credentials and history; do not share it. Close the dedicated terminal tab when done. If something fails, note the step and include only a redacted screenshot or synthetic reproduction.
