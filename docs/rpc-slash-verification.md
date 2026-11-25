# RPC `/refine` in unmodified T3 Code

Install the root extension in the Pi instance that backs your T3 Code thread. Configure the optimizer with `/refine model` in native Pi using the same agent directory.

1. In T3 Code, submit `/refine optimize <draft>`. Refine runs in the background. Hosts that display Pi extension status show progress and the result command near the composer.
2. Refine opens the candidate in the originating session when Pi is idle and its active prompt is closed. T3 presents it as a prefilled **Question** in the composer. Automatic preview can interrupt typing because Pi cannot detect composer activity.
3. Click the candidate, select all with Ctrl+A or Cmd+A, and copy with Ctrl+C or Cmd+C. Use **Submit** to close the preview and return to the previous draft. Edits made inside the preview are discarded. Copying leaves the main Agent transcript and the saved candidate intact.
4. To reopen without another model call, copy the full `/refine result` command from the ready status or submission receipt. Its ID includes the runtime and lifecycle scope. A session or branch change, or a reload, expires that ID.

## Host behavior

Refine passes the full candidate to Pi's RPC editor and uses status updates for hosts that can show progress between turns. Keep candidate delivery outside the main transcript. T3's client may trim the submitted slash command before Refine receives it. [Thread routing](https://github.com/pingdotgg/t3code/blob/344de5fe8e70e9eeaacaedc34e7aa5e2a29287d1/packages/provider-pi/src/server/adapter.ts#L1864-L1928) · [Composer submission](https://github.com/pingdotgg/t3code/blob/344de5fe8e70e9eeaacaedc34e7aa5e2a29287d1/apps/web/src/components/ChatView.logic.ts#L1393-L1404) · [Refine adapter](../src/adapters/rpc-slash.ts)

## Evidence and outstanding checks

- **Pi RPC 1.6.0, Linux x86_64, isolated profile.** A deterministic optimizer received the exact draft in one request. Explicit viewing and reopening delivered 262,144 UTF-16 code units unchanged. Confirming edited text or cancelling left the candidate and transcript unchanged.
- **T3 Code desktop.** The user reported opening and copying a short result through the receipt's command. The installed build was unrecorded.
- **Offline tests.** The RPC integration suite exercises scheduling, deferral, expiration and exact delivery, including a 2,097,152-code-unit result through the mocked editor. [RPC integration tests](../test/integration/rpc-slash.test.ts)

For a stable T3 build, record the extension revision, host and Pi versions, and viewport. Use an isolated profile and a deterministic stub. With an unsent draft and a Chinese IME composition in progress, check which thread receives the preview, when focus moves and what text returns on close. Scroll a long synthetic candidate to its end and compare the clipboard with the original fixture. Reopen it using the receipt, then check that a session change expires the command.

## Synthetic probe in unmodified T3 Code

T3 Code `0.1.12-nightly.20261120.4994`, Pi `1.6.0`, Chrome `156.0.8078.47`, 460 × 570. A temporary slash command acknowledged immediately and delivered fixed text after 5.5 seconds. There were no Pi `agent_start` events.

| Check | Observation |
| --- | --- |
| Thread switching | The preview opened in the initiating thread. The other thread's draft stayed intact. |
| Typing and restoring the draft | The question replaced the visible composer. Submit restored the unsent draft. A status-only update preserved draft and focus. |
| Exact copy and reading | The 51-, 4,700- and 262,144-code-unit fixtures copied exactly. The two longer fixtures scrolled to their final marker. |
| Closing long text | Submit took about 10 seconds for the 262,144-code-unit fixture in the measured run. |

An earlier run in the same T3, Pi and Chrome versions used the actual extension with a deterministic loopback optimizer. It verified automatic preview for delayed and immediate rewrites, exact copying at 460 × 570 and 1120 × 780, draft restoration, and deferral until an independent Pi input dialog closed. Each of the three rewrites issued one tool-free request without starting the main Agent.
