# Project semantic fidelity — 12-case benchmark v1

**Status: design only. No refiner, judge, or downstream-task calls have been made for this benchmark.**

- Benchmark ID: `project-semantic-fidelity-v1`
- Version: `1.0.0`
- Designed and signed by: **gpt 6.1 sol**
- Date: **2026-11-09**
- Purpose: evaluate whether a general-purpose, lower-cost refiner preserves project-task semantics while obeying authorized editing requirements.
- Deliverables: [cases.json](cases.json), this specification, and [judge.md](judge.md). There is **no runner implementation** in this delivery.

## 1. Scope and provenance

This measures the rewritten **prompt**, not the main agent's eventual answer, code quality, or task success. The refiner must neither answer nor execute the original task. All 12 cases use first-pass `refine`; continuous `revise`, context truncation, UI acceptance, and downstream execution are separate tracks.

The recommended eventual real-world mix remains eight session-derived cases plus four constructed edge cases. **This v1 does not claim that provenance:** no private session records were read or extracted. All fixtures are synthetic, either newly designed or adapted from examples in [optimizer-evaluation.md](../../optimizer-evaluation.md) and [refine-policy.live.test.ts](../../../test/live/refine-policy.live.test.ts). Each fixture records its source. They form a usable diagnostic/regression suite now, but not an unseen, representative session benchmark. Add a separately versioned, consented and sanitized session-derived holdout later; do not silently relabel or replace these cases.

There are no downloaded benchmark dependencies, network lookups, private files, or live workspace resources in the fixtures. Published examples may already influence the production policy, so results must not be described as out-of-sample generalization.

## 2. Coverage and expected editing behavior

| ID | Focus | Unchanged acceptable? | Key distinction |
| --- | --- | --- | --- |
| PSF-01 | Clear short request | Yes; exact return required | Change one title, not the task scope |
| PSF-02 | Conditional structuring preference | Yes; exact return required | Conditional formatting is not a mandatory rewrite |
| PSF-03 | Analysis vs implementation | Yes | Possible gains remain unverified; no implementation |
| PSF-04 | Assistant proposal and project rule | Yes | Discussing subagents does not authorize launching them |
| PSF-05 | Paths, commands, version, limit | Yes | Preserve even an unusual command literally |
| PSF-06 | Explicit literal replacement | No; exact edited return required | Edit only the authorized occurrence |
| PSF-07 | Unique contextual reference | Yes | Hash-index comparison, not index implementation |
| PSF-08 | Ambiguous reference and unread file | Yes | Do not infer a referent or file contents |
| PSF-09 | Latest user correction | Yes | Current restrictions defeat old assistant proposals |
| PSF-10 | Explicit draft vs saved default | Yes | Explicit Chinese answer requirement wins |
| PSF-11 | Current correction vs conflicting preferences | No | Integrate paragraph-answer requirements, not conflicting defaults |
| PSF-12 | Translation plus compatible task requirement | No | English prompt, Chinese answer, at most 3 sentences |

Allocation: two short-request cases, two authorization cases, two literal cases, three contextual-reference cases, three preference-handling cases. PSF-06/11/12 prevent an always-return-the-original system from passing the suite. PSF-12 also tests compatible preference integration, not just refusal of conflicting preferences.

An unchanged contextual follow-up is valid when its supplied conversation already makes it usable. Explicitly naming a referent is not itself a required improvement. Do not grade self-contained verbosity above a faithful short follow-up.

## 3. Input construction and context controls

### Frozen inputs

`cases.json` is the source of truth. Each `input` contains a literal `draft`, a chronological `history` array, and optional `project_context` and `editing_instruction` strings. Missing project context means `null`; missing editing instruction means omit the key. `defaults` describes common settings; **do not send the fixture document or its defaults object as model content**.

For a later runner, construct the production JSON packet as follows:

1. Set `operation: "refine"` and `delivery_context: "existing_session"`.
2. Set `project_context` from the case, otherwise `null`.
3. Set `conversation.scope` to `current_branch_visible_user_assistant_text` and `status` to `complete`.
4. Set both `total_message_count` and `selected_message_count` to the length of `input.history`; set `omitted_message_count` and `excerpted_message_count` to zero.
5. Set `conversation.items` to the history entries with their exact IDs, roles, and texts, adding `status: "complete"` to each.
6. Copy `draft` and, when present, `editing_instruction` verbatim.

This corresponds to the current `buildRefineInput()` format in [src/context.ts](../../../src/context.ts). A runner may use `selectHistory()` and `buildRefineInput()` instead, but must assert equality with this logical packet and verify no fixture history was excerpted or omitted. Adapt source messages to host branch-entry shape when using `selectHistory()`; the fixture's simple history objects are not host entries.

Use `buildRefineSystemPrompt(false)` from a recorded code revision and save the **full resulting system string** and its hash before calls. A later code change must not silently change the policy during a run. Keep the same policy, packet and settings across the three repetitions. The fixture freezes task data; the run manifest freezes the evaluated production policy.

The refiner receives only that system message and one user message containing the serialized packet, with `tools: []`. Do not send case names, categories, rubrics, allowed-change notes, expected outputs, failure examples, signatures, or judge instructions to it.

### Resource boundary

- Empty history means complete history with zero messages, not omitted history.
- PSF-04 is the only case with project context; its text is a synthetic supplied rule, not a request to read the actual workspace's `AGENTS.md`.
- Disable automatic project-rule collection, skills, default trees, explicit-directory collection, title generation, and live session collection. File references remain literal task data, with no file-body loading.
- Use the complete fixture history. `12` messages / `16000` characters are ample source-selection limits, not instructions to pad context.
- Save source context and actual sent input separately. If model-budget fallback removes any fixture content, mark the attempt as a context/preflight failure; do not silently score a different, easier input under the same case ID.
- Choose a refiner whose documented context capacity fits these packets, the system prompt, and output allowance. Do not infer missing file contents from local repository knowledge.

## 4. Run plan for later

No particular refiner or judge version is asserted available by this design. Before running, select and record exact provider/model IDs: a generally capable lower-cost refiner and a stronger judge. The design signature is **not** a claim that `gpt 6.1 sol` was called as judge or refiner.

1. Human-approve this frozen case set and rubric before observing outputs. Revisions require a new fixture version/hash.
2. Freeze model IDs, policy, settings, fixture and judge-prompt hashes, and runner revision. Fix reasoning and sampling settings where supported; record unsupported options rather than assuming they took effect. Record seed only if actually supported.
3. Calibrate the judge using the four hand-written examples in `judge.md`. These are unscored checks, not additional benchmark cases. Resolve rubric misunderstandings before scored calls.
4. Make three independent refiner requests per case: **36 scored refiner attempts**. Do not feed prior outputs back into later repetitions. Interleave cases/repetitions with a recorded randomized schedule if feasible.
5. Apply envelope and deterministic checks locally. Make one blinded judge request per protocol-valid candidate, up to **36 scored judge requests**, including candidates with failed literal checks so their semantic failures can still be diagnosed. Protocol-invalid candidates already fail; do not fabricate a prompt for judging.
6. Human-review every failed or uncertain judgment and every disagreement between code and judge. For this small batch, reviewing all 36 outputs is preferable. Record original judge results and adjudicated results separately.
7. Do not execute the tasks, modify referenced files, install dependencies mentioned by drafts, or launch subagents. No downstream model is needed.

### Original-draft baseline

Evaluate each original draft against the same semantic rubric and editing requirements, without a refiner call. An optional judge audit adds 12 judge calls; label it separately. For this baseline only, construct `{"prompt": original_draft}` locally so a missing JSON envelope does not manufacture failures. PSF-06/11/12 must fail the original baseline because they require explicit edits/integration. This shows the suite penalizes under-editing as well as scope expansion; it is not evidence of downstream-task improvement.

### Attempts, failures, retries

Every scheduled slot has a unique `(run_id, case_id, repeat_index, attempt_id)`. A completed but semantically wrong, malformed, truncated, or tool-calling response is an observed failure, not permission to retry until success. A preflight rejection is a separately labeled context/protocol failure.

For authentication/transport/rate-limit failures with no usable response, retain the failed attempt. Any replacement attempt must be explicitly linked and reported; it is not an extra successful sample. Do not publish a complete 36-output score while scheduled slots remain unresolved. Report coverage, infrastructure failures, and semantic failures separately.

## 5. Scoring

### Local checks

Interpret the fixture's checks on the **decoded `prompt` string**, not JSON escape spelling:

- `exact_prompt`: Unicode string equality, with no trimming, case folding, Unicode normalization, punctuation conversion, or newline normalization.
- `contains_exact`: literal, case-sensitive substring inclusion. Passing it does not establish semantic preservation: the judge must still catch a retained literal used in a negation, obsolete quotation, or contradictory instruction.

For all cases, require normal completion, no tool call, and exactly one JSON object containing a nonempty `prompt` string. No outer Markdown, answer, commentary, title, or extra keys. This benchmark deliberately uses a strict prompt-only envelope; it is stricter than the current permissive parser on extra keys. Record envelope failures independently of semantic failures. Hidden provider reasoning, if any, is not user-visible output and is not requested as an artifact.

### Universal semantic contract

Every candidate must satisfy these in addition to its case-specific rubric:

- **U1 — Task fidelity:** preserve the requested subject, task type, applicable restrictions, uncertainty and authorization boundary; do not perform the underlying task.
- **U2 — Evidence fidelity:** do not invent facts, file contents, measurements, permissions or a definite referent unsupported by the supplied input.
- **U3 — Editing fidelity:** perform applicable explicit editing requirements, use the specified preference priority, preserve unedited literals and language requirements, and do not replay refiner-facing wrappers as main-agent work.
- **U4 — Minimality:** no unsupported task, tool, dependency, deadline, deliverable, acceptance criterion, or stylistic expansion. A faithful unchanged return is not a defect; an authorized required edit must not be skipped.

Universal criteria do not override explicit exceptions: PSF-06 authorizes one literal replacement; PSF-12 authorizes prompt-language translation, not a change in answer language.

**Strict attempt pass** requires the envelope, all deterministic checks, U1–U4, and every case rubric item to pass. `uncertain` is not a pass; show it as pending human adjudication, not as an automatic failure or an excluded denominator. Retain the pre-adjudication verdict for audit.

Report at least:

- Strict attempt passes / 36 scheduled slots, with failed and pending slots separately shown; publish a final percentage only when the run is complete and adjudicated.
- Per-case pass count / 3 and cases passing all three repetitions / 12.
- Per-category attempt counts using the table's fixed allocation; no average that hides category failures.
- Violation counts: unauthorized action, literal corruption, invented fact/reference, preference-priority error, required-edit omission, unnecessary expansion, and protocol failure. Categories may overlap.
- Exact-return rate on PSF-01/02 (6 attempts), and required-edit success on PSF-06/11/12 (9 attempts). Do not treat unchanged returns on other cases as automatically good or bad.
- Median and p95 refiner/judge latency, raw usage fields, provider-normalized token totals and cost where available. Do not double-count reasoning tokens already included in totals; label unavailable costs.

This is not a preference-ranking or prose-polish score. Do not replace the strict result with a mean 1–10 rating. Three repetitions measure instability, not 36 independent tasks. Twelve designed cases cannot establish general reliability or statistical non-inferiority.

## 6. Minimum saved artifacts

Use a new local output directory for each later run; raw records may be kept outside Git. Save:

- Run manifest: timestamps/timezone, signature/date, fixture version/hash, code revision plus dirty-state/diff hash, runner revision, exact system/judge prompts and hashes, provider/model IDs, parameters, schedule, concurrency, retry policy, and timeout policy.
- Per attempt: case/repetition/attempt IDs, source fixture, prepared and actual sent packet, raw visible response, decoded prompt, stop reason/tool-call presence, local checks, timestamps/latency, usage, errors, and linked replacement IDs.
- Judge records: blinded candidate ID, exact judge input/output, rubric verdicts, quoted evidence, usage/latency, and separate human adjudications with reasons.
- Summary: denominators, coverage, all failures, pending items, repetitions, cost, and comparisons. Never store credentials, authorization headers, hidden chain-of-thought, or unrelated session records.

Hash the delivered files immediately before the later run; no particular source hash or uncommitted production revision is claimed by this design. Once results are used to tune the refiner, keep this suite as regression coverage and use new cases for holdout claims.

## 7. Estimated elapsed time

These are planning estimates, **not observed timings**:

| Phase | Estimate / assumption |
| --- | --- |
| Preparing and reviewing this design | Approximately 10–15 minutes; runner implementation excluded |
| Later scored model work, sequential | 15–45 minutes if refiner calls take 15–45 seconds and judge calls take 10–30 seconds: `36 × (refiner + judge)` |
| Later scored model work, concurrency 3 | Ideally 5–15 minutes; budget about 10–25 minutes including scheduling and ordinary overhead, assuming provider limits permit it |
| Four judge calibration calls | Roughly 1–3 extra minutes including inspection |
| Optional 12-call baseline audit | Roughly 2–6 extra minutes of sequential judge time |
| Human review of 36 outputs | Approximately 20–40 minutes |

A practical future run budget is **about 35–75 minutes including calibration and human review at concurrency 3**, excluding runner implementation, credential setup, extensive retries, and optional baseline audit. Slow reasoning models, queues and rate limits can exceed it. After a small unscored timing pilot, replace assumptions with measured latency; do not present this estimate as a guarantee. Monetary cost cannot be responsibly estimated until model IDs, token usage and pricing are known.

---

**Design signature:** gpt 6.1 sol

**Signed:** 2026-11-09

**Execution attestation:** This delivery contains a benchmark design and fixtures only. No benchmark model calls, judge calls, downstream execution, or measured quality results.
