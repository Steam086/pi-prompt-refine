# Native TUI conventions

## Layout and reading

- Keep Preview, Usage, Settings and their child pages in one centered overlay. At a given terminal size, changing page, reading mode or run status keeps the same frame. Scroll long content within it. Reuse the [workspace overlay](../src/workspace-overlay.ts) and the shared tabs, header and frame in [panel layout](../src/panel-layout.ts).
- Keep the selected task or run and the top visible task row by identity when records arrive. Reuse the task tree while only focus or a running timer changes. [Task browser](../src/task-panel.ts)
- Give each view one horizontal split. The task browser owns the tree and summary, Details owns the result and reference panes, and Compare owns two candidates. Keep the selected run and each document’s scroll position when reading focus moves. On a narrow terminal, show one document at a time. [Task documents](../src/ui/task-documents.ts)
- Where Pi forwards mouse input, wheel over a document to scroll that pane. Drag within it to copy the selected visible text. Both gestures preserve the keyboard action target. [Reading gestures](../src/ui/reading-mouse.ts)
- Only editable Unsent originals expose inline Preferences. On wide terminals the checklist can use the tree column while the original and highlighted instructions remain readable. On narrow terminals give the checklist the available width and let the reader open the full text. Preserve the original excerpt when moving between an original and its runs. [Inline Preferences rendering](../test/renderer/inline-preferences-renderer.test.ts)

## Text, selection and key hints

| Element | Convention |
| --- | --- |
| Headings and selection | Use neutral bold `text` for headings, the active tab and the focused item’s name. Use `selectedBg` for the active tab or row. Keep model badges and Settings row values regular weight. In the model picker, emphasize the active thinking level. |
| Draft, result and reference text | Render literal content in regular `text`, including Markdown. Use `muted` for labels, provenance, inactive tabs and timing. In Preview and Usage, identify the next model when Enter would start a run. Show a completed run’s own model in its details. |
| Warnings and errors | Use the semantic theme color on the affected marker or message. Keep actionable failures visible when shortening the header. |
| Browsing and Settings | Use regular `muted` key/action pairs. Keep shortcuts on one row and drop whole secondary hints as space runs out. Give the main action and the way back priority. Preview, Usage and Preferences show more shortcuts with `?`. |
| Details, editors, choosers and confirmations | Use neutral bold keys and regular `muted` descriptions. Show actions available at the current focus. Give Accept and Send the same weight as other actions. |

Limit the header to two rows with one divider before the content. Keep workspace tabs in a fixed position and use the bottom row for shortcuts. In Preferences, keep navigation on a single header row, put library editing shortcuts immediately below the Library heading, and show selection and reading shortcuts in the footer. Put shared shortcuts before any focus-specific action so their columns stay fixed when Tab moves focus. Sanitize external text before styling, measure terminal columns with Pi’s ANSI-aware width and wrapping helpers, and clip names before applying emphasis. Check both themes, wide Unicode, narrow and short viewports, and resize while scrolled. [Panel layout](../src/panel-layout.ts) · [Cross-page renderer tests](../test/renderer/workspace-consistency.test.ts)

## Focus and side effects

- Use Up and Down to browse settings and form fields in display order. Enter and Space activate the highlighted row. Keep standard cursor movement and text entry inside the active editor, and use Esc to return to browsing. Give the active row a `›` marker, bold label and `selectedBg`, and keep it visible in short viewports. Keep Ctrl+S and Esc visible before secondary shortcuts. [Workspace navigation tests](../test/ui/workspace-navigation.test.ts)
- Space in a Preferences chooser immediately updates its named target (Unsent, future prompts in this session, or Revise). Show the checkbox and count independently of the focused row and the `g` project-default marker. Esc just returns. Add, Edit and Delete work from the Library list and preserve existing prompt snapshots. Selected only shows captured selections and run audits are read-only. Tab switches between the list and Search, where the shortcut letters enter text. Reuse filtered entries and wrapped text across focus changes. To submit the chosen requirements, use Enter on the Unsent original or its inline checklist, or Ctrl+S in Revise. [Preference interaction tests](../test/integration/extension-preferences.test.ts)
- Keep editor writes, sending and restoration behind explicit actions. Recheck the candidate, session and intervening editor text when confirmation returns. [Editor action tests](../test/integration/extension-editor-actions.test.ts)
- Center confirmation questions and their shortcuts together in the existing frame. Esc returns to the previous focus. Destructive dialogs require an explicit confirmation key. Display small sets of form choices inline in their cycling order. Mark the current value with a filled dot and keep the field's focus marker visible. Stack choices on narrow terminals. Enter and Space advance the current value. [Preference interaction tests](../test/ui/preference-panel-library.test.ts)
