# RPC `/refine` in unmodified T3 Code

Install the root Refine extension in the Pi instance used by the T3 Code server, and configure its optimizer in native Pi with `/refine model` using the same Pi agent directory. Use a T3 Code thread backed by that Pi instance. There is no separate T3 Code package or build step.

In Pi RPC mode, enter `/refine optimize <draft>` once. Refine reports background progress, queueing, and completion near the composer on hosts that render Pi extension status. The progress status tells you the result will open automatically. Refine waits for Pi to be idle and for any active Pi dialog to close, then opens the result in the originating session. Pi cannot detect typing in the T3 composer: even when Pi is idle, a preview can interrupt typing.

In unmodified T3 Code, the candidate opens as a prefilled `Question`. Click inside the text, select all with Ctrl+A or Cmd+A, and copy with Ctrl+C or Cmd+C. Use `Submit` to close the preview and return to the previous draft. T3 uses the composer for the preview while it is open. Refine discards the editor response, including any edits. The red Stop control is part of the host UI. The slash command and preview are handled independently of the main Agent.

To reopen a result without another rewrite, use the same command from the ready status or submission receipt. Reloading or changing the session or branch invalidates that ID.

## Host behavior

T3 routes the Pi RPC `editor` to its original thread and uses the composer for the prefilled answer. The editor provides text selection and copying. A dedicated Copy full text button requires a host result view. [Thread routing](https://github.com/pingdotgg/t3code/blob/344de5fe8e70e9eeaacaedc34e7aa5e2a29287d1/packages/provider-pi/src/server/adapter.ts#L1864-L1928) · [Editor mapping](https://github.com/pingdotgg/t3code/blob/344de5fe8e70e9eeaacaedc34e7aa5e2a29287d1/packages/provider-pi/src/server/adapter.ts#L4400-L4412) · [Composer rendering](https://github.com/pingdotgg/t3code/blob/344de5fe8e70e9eeaacaedc34e7aa5e2a29287d1/apps/web/src/components/chat/ChatComposer.tsx#L3859-L3865)

- Refine uses `setStatus` for updates between turns. T3 shows `notify` messages only during an active turn. [T3 notification handling](https://github.com/pingdotgg/t3code/blob/344de5fe8e70e9eeaacaedc34e7aa5e2a29287d1/packages/provider-pi/src/server/adapter.ts#L1804-L1825)
- Refine preserves the draft it receives after the single body delimiter and passes the full candidate to the editor. T3 trims the submitted slash command before the RPC call. [Composer submission](https://github.com/pingdotgg/t3code/blob/344de5fe8e70e9eeaacaedc34e7aa5e2a29287d1/apps/web/src/components/ChatView.logic.ts#L1393-L1404)

## Evidence and outstanding checks

- **Pi RPC 1.6.0, Linux x86_64, isolated profile:** Before implementation, a synthetic slash probe returned `handled` before emitting a delayed editor request. The prefill survived RPC byte for byte. After implementation, a separate process loaded the real extension and a synthetic optimizer. Invalid slash input returned usage, one optimization produced one request with the exact draft, and explicit viewing and reopening delivered all 262,144 UTF-16 code units unchanged. Confirming edited text and cancelling did not change the candidate or add Pi transcript messages.
- **Root regression tests** cover progress and ready status, automatic preview of the candidate text alone, explicit reopening from the ready command, deferral during Pi turns and dialogs, queueing, duplicates, out-of-order and immediate completion, failures, timeout, cancellation, and invalidated results. The mocked editor received the full 2,097,152-code-unit result, including leading and trailing whitespace, Chinese, blank lines, a URL, and nested code fences.
- **T3 Code desktop, user report:** A short rewrite was available through the receipt's result command. The user opened, copied, and closed the prefilled `Question` editor. The installed build was unrecorded.

## Synthetic probe in unmodified T3 Code

The Linux test used T3 Code `0.1.12-nightly.20261120.4994`, Pi `1.6.0`, and Chrome `156.0.8078.47` at 460 × 570. A temporary Pi extension registered a slash command that immediately acknowledged the request and waited 5.5 seconds before publishing a status or opening the editor. The fixtures included Chinese, emoji, blank lines, code fences, a long URL, tabs, and surrounding whitespace. The isolated Pi profile pointed at an unreachable loopback model endpoint. The tested commands produced no Pi `agent_start` event.

| Check | Observation |
| --- | --- |
| Thread routing | After switching threads during the delay, the result appeared only in the initiating thread. The draft in the other thread stayed intact. |
| Automatic editor while typing | Opening the editor replaced the visible composer with the prefilled question. Submitting the question restored the unsent draft. |
| Scroll and copy | The 51-, 4,700-, and 262,144-code-unit fixtures copied exactly using Select All and Copy. The two longer fixtures could scroll to their final marker. |
| Closing a very long result | The 262,144-code-unit fixture took about 10 seconds to return to the normal composer after Submit in the measured run. |
| Status without an editor | Pi `setStatus` showed working and ready beside the composer. The ready update left the draft and keyboard focus intact. Explicit viewing then opened the candidate. |

## Earlier host check: automatic preview (before the current status and title wording)

An isolated run with the same T3, Pi, and Chrome versions loaded the actual Refine extension and a deterministic loopback optimizer. A delayed `/refine optimize` showed `Rewriting in background` and `run-1 ready`, then opened its result automatically in the same thread. At 460 × 570, the 4,700-code-unit candidate scrolled to its last line, copied exactly, and restored a new unsent draft after Submit. An immediate response at 1120 × 780 also opened automatically and copied its 51-code-unit fixture exactly. An independent Pi input dialog stayed open when a rewrite finished, and Refine opened the result after that dialog closed. The three rewrites each issued one tool-free request and emitted no Pi `agent_start` event. The 2,097,152-code-unit check uses the mocked editor. Manual IME remains open.
