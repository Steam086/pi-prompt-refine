import { describe, expect, it } from "vitest";
import { parseSlash } from "../../src/adapters/slash.js";

describe("refine-api grammar", () => {
  it("preserves case, embedded flags, Unicode, leading and trailing whitespace after exactly one delimiter", () => {
    const text = "  中文 😀\nAPI --model not-an-option\n ";
    expect(parseSlash(`drafts create -- ${text}`)).toEqual({ kind: "mutation", value: { method: "createDraft", text }, operationId: undefined });
    expect(parseSlash("optimize --\n CamelCase  \n")).toMatchObject({ value: { method: "optimizeText", text: " CamelCase  \n" } });
    expect(parseSlash("drafts create --")).toMatchObject({ value: { text: "" } });
  });
  it("parses quotes without shell evaluation and splits provider/model at the first slash", () => {
    expect(parseSlash('runs start "task-1" --expected-version 2 --model "provider/model/sub" --thinking high')).toEqual({ kind: "mutation",
      value: { method: "startRun", taskId: "task-1", expectedVersion: 2, model: { provider: "provider", id: "model/sub" }, thinking: "high" }, operationId: undefined });
    expect(parseSlash("optimize -- $(touch /tmp/never) $HOME")).toMatchObject({ value: { text: "$(touch /tmp/never) $HOME" } });
  });
  it.each([
    "status x", "status --scope all", "tasks list --scope unknown", "tasks list -- text", "models list x",
    "drafts create text", "drafts update task-1 -- missing-version", "drafts copy task-1 --expected-version -1",
    "drafts discard task-1 --expected-version 1 --", "drafts create --history injected -- text",
    "runs start task-1 --expected-version 1 --expected-version 1", "runs start task-1 --expected-version 1 --thinking turbo",
    "runs start task-1 --expected-version 1 --model invalid", "runs stop task-0", 'runs show "run-1',
    "optimizer set --expected-version 1 --model p/m", "runs stop run-1 --operation-id ../../bad",
  ])("rejects %s without fallback to prose", (source) => expect(parseSlash(source)).toBeUndefined());
  it.each([
    ["status", { method: "snapshot", scope: "current" }],
    ["tasks list --scope all", { method: "snapshot", scope: "all" }],
    ["tasks show task-1", { method: "task", taskId: "task-1" }],
    ["runs show run-2", { method: "run", runId: "run-2" }],
    ["models list", { method: "models" }],
  ])("parses read-only %s", (source, value) => expect(parseSlash(source)).toEqual({ kind: "query", value }));
});
