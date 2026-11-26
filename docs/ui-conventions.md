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
| Browsing and Settings | Use regular `muted` key/action pairs. Aim for one row, allow two and drop whole secondary hints when space is tight. Keep the primary action and Close, Back or Cancel visible. Preview and Usage provide the full list through `?`. |
| Details, editors, choosers and confirmations | Use neutral bold keys and regular `muted` descriptions. Show actions available at the current focus. Give Accept and Send the same weight as other actions. |

Keep tabs on one row with a single divider below the header. When the hints fit beside the tabs, align them to the right. Omit secondary labels that repeat the heading or content. Sanitize external text before styling, measure terminal columns with Pi’s ANSI-aware width and wrapping helpers, and clip names before applying emphasis. Check both themes, wide Unicode, narrow and short viewports, and resize while scrolled. [Key hint helpers](../src/key-hints.ts) · [Cross-page renderer tests](../test/renderer/workspace-consistency.test.ts)

## Focus and side effects

- Use ordinary navigation keys and non-function modified keys that work with Pi’s bindings. In an editor, Tab and Shift+Tab move focus among available controls. Give the active field or control a `›` marker, bold label and `selectedBg`, and keep it visible in short viewports. Ctrl+S invokes the page’s primary save or submit action from any focus. Keep it and Esc visible before secondary shortcuts. Esc returns one level from a child page and asks before discarding unsaved library, Context or optimization prompt changes. [Workspace navigation tests](../test/ui/workspace-navigation.test.ts)
- Space in a Preferences chooser saves to its named target immediately: Unsent, future prompts in this session, or Revise. Show the checkbox and count independently of the focused row and the `g` project-default marker. Esc just returns. Library Add, Edit and Delete change saved entries and preserve existing prompt snapshots; run audits are read-only. Keep management shortcuts out of Search and reuse filtered entries and wrapped text across focus changes. To submit the chosen requirements, use Enter on the Unsent original or its inline checklist, or Ctrl+S in Revise. [Preference interaction tests](../test/integration/extension-preferences.test.ts)
- Keep editor writes, sending and restoration behind explicit actions. Recheck the candidate, session and intervening editor text when confirmation returns. [Editor action tests](../test/integration/extension-editor-actions.test.ts)
