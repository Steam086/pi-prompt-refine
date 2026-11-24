# Project semantic fidelity v1

Design only, dated 2026-11-09. This suite has 12 synthetic first-pass rewrite cases. The fixtures and case-specific expectations live in [cases.json](cases.json), and [judge.md](judge.md) defines adjudication. There is no benchmark runner or measured result for this suite.

The cases measure whether a rewrite preserves project-task meaning and makes explicitly authorized edits. Some fixtures were adapted from repository examples. Treat the suite as diagnostic regression coverage and record new, independently sourced cases separately if measuring generalization.

## Prepare a run

- Freeze the fixture and judge hashes, production code revision, exact prompts, model IDs, reasoning settings and schedule before collecting outputs. Keep all attempts, including transport failures and replacements.
- Build requests from the synthetic data using the production [history selection, packet and system-prompt constructors](../../../src/context.ts). Verify every fixture history item is complete, selected and in order. Use the fixture settings and no tools. Keep names, rubrics, labels and expected output out of the refiner input.
- Calibrate the judge with the unscored examples in [judge.md](judge.md). Schedule three independent requests per case, for 36 attempts. Review disagreements or uncertain judgments separately. The suite assesses prompts without executing the original tasks.

## Score and report

Require normal completion, no tool calls and a single JSON object containing only a nonempty `prompt` string. Apply each deterministic fixture check to the decoded string, using exact equality or substring matching without normalization. Blind the judge to the model and condition, then apply its semantic contract and the per-case rubric. A strict pass requires every applicable check to pass.

Also score the original draft against the same semantic requirements. Construct its JSON envelope locally. Cases requiring particular edits should fail this baseline. Compare each condition without retrying valid but incorrect outputs until they pass.

Report passes per scheduled slot and per case, with failures, pending adjudications and infrastructure issues visible in the denominators. Record latency, token usage and cost where available. Save a manifest and the inputs, outputs, judgments and local checks needed for audit, excluding credentials and unrelated sessions. Repetitions show variation on the same cases. They do not increase the number of independent tasks.
