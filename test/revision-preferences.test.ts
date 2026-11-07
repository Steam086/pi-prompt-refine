import { describe, expect, it } from "vitest";
import { automaticPreferences, composeRevision, searchPreferences, selectPreference, uniquePreferences, type RevisionPreference } from "../src/revision-preferences.js";

const entry = (id: string, name: string, description = "", body = ""): RevisionPreference => ({
  id, name, body, scope: "project", version: 1,
  ...(description ? { metadata: { description, kind: "task", activation: "manual" } } : {}),
});
const ids = (entries: RevisionPreference[], query: string) => searchPreferences(entries, query).map((item) => item.id);

describe("conservative automatic selection", () => {
  const entries: RevisionPreference[] = ["parallel", "sequence"].map((match) => ({
    id: match, version: 1, scope: "global", name: match, body: match,
    metadata: { kind: "rewrite", activation: "auto", description: match, match: match as "parallel" | "sequence" },
  }));
  it.each([
    ["为什么失败？？", []],
    ["Why???", []],
    ["为什么失败？如何处理？", ["parallel"]],
    ["Why?? How???", ["parallel"]],
    ["- 原因\n- 影响", ["parallel"]],
    ["不要先运行测试再解释，只讨论原因。", []],
    ["Do not first run tests, then explain.", []],
    ["Don't first run tests then explain.", []],
    ["无需按顺序操作，仅讨论。", []],
    ["解释：\n~~~text\nWhy? How?\n~~~", []],
    ["解释：\n````text\n```\nWhy? How?\n````", []],
    ["解释：\n```text\nFirst inspect then change", []],
    ["解释 `Why? How?` 的含义", []],
    ["解释 ``first `x` then y`` 的含义", []],
    ["解释：\n> Why? How?", []],
    ["解释：\n    Why? How?", []],
    ['解释 "Why? How?" 的含义', []],
    ["解释“先执行再验证”的含义", []],
    ["解释『Why? How?』的含义", []],
    ["解释“未闭合的引用 Why? How?", []],
    ["解释 https://example.org/?a?b", []],
    ["1. 检查状态\n2. 根据检查结果执行修复", []],
    ["1. 原因\n2. 影响", []],
    ["请按顺序：检查、修复、验证。", ["sequence"]],
    ["依次解释三个阶段。", ["sequence"]],
    ["First inspect, then explain. Why? How?", ["sequence"]],
    ["首先检查。然后解释。", ["sequence"]],
    ["先检查\n然后解释", ["sequence"]],
    ["Please first inspect. Then explain.", ["sequence"]],
    ["请你先查再改", ["sequence"]],
    ["不要修改文件，先检查再解释。", ["sequence"]],
    ["无需联网，依次解释三个阶段。", ["sequence"]],
    ["Don't edit files, first inspect then explain.", ["sequence"]],
    ["Don’t edit files, first inspect then explain.", ["sequence"]],
    ["不要先检查，再解释。", []],
    ["优先考虑兼容性，然后讨论性能。", []],
    ["系统先读取配置再启动服务，请解释失败原因。", []],
    ["解释 ‘先检查再修改’ 的含义", []],
    ["解释 'first inspect then change' 的含义", []],
    ["解释 'don't first inspect then change' 的含义", []],
    ["解释 '未闭合 first inspect then change", []],
    ["User's request: Why? How?", ["parallel"]],
    ["In order to understand this issue, explain the cause.", []],
    ["In order: inspect, explain.", ["sequence"]],
    ["- 第一步检查\n- 第二步修复", ["sequence"]],
    ["步骤一：检查\n步骤二：修复", ["sequence"]],
    ["Step 1: inspect\nStep 2: explain", ["sequence"]],
    ["步骤一：检查\n步骤一：解释", []],
    ["为什么先失败？然后怎么办？", []],
    ["1. 原因\n2. 影响\n还有什么？为什么？", ["parallel"]],
    ["• 原因\n• 影响", ["parallel"]],
    ["请分析原因、影响和解决方案。", []],
    ["保留原稿结构。原因是什么？怎么解决？", []],
    ["不要把原稿改成列表。原因是什么？怎么解决？", []],
    ["不要改变原稿结构。先检查再解释。", []],
    ["Keep the original structure. First inspect then explain.", []],
    ["Don't reformat. Why? How?", []],
    ["不要分条回答。原因是什么？怎么解决？", ["parallel"]],
    ["解释‘保留原稿结构’。原因是什么？怎么解决？", ["parallel"]],
    ["先" + "检查".repeat(100) + "，再解释。", ["sequence"]],
  ])("uses supported unquoted cues: %s", (draft, expected) => {
    expect(automaticPreferences(entries, draft as string).map((entry) => entry.id)).toEqual(expected);
  });
  it("keeps structure guards separate from explicit always defaults and manual requirements", () => {
    const always: RevisionPreference = { ...entries[0]!, id: "always", body: "Keep literals.",
      metadata: { kind: "rewrite", activation: "auto", match: "always", description: "Literal safety" } };
    expect(automaticPreferences([...entries, always], "保留原稿结构。为什么？怎么办？").map((entry) => entry.id)).toEqual(["always"]);
    expect(composeRevision([selectPreference(entries[0]!)], "保留原稿结构")).toContain("manually selected");
  });
  it("handles long plain text and repeated start words without quadratic suffix scans", () => {
    for (const draft of ["a".repeat(100_000), "再" + "先".repeat(99_999), "“".repeat(100_000), "literal " + "`".repeat(99_990)]) {
      expect(automaticPreferences(entries, draft)).toEqual([]);
    }
  });
});

describe("requirement composition boundaries", () => {
  it("deduplicates literal type/body pairs, prefers manual provenance and preserves body bytes", () => {
    const automatic = { ...selectPreference({ ...entry("a", "Auto", "Description", "  Keep 中文\n"),
      metadata: { kind: "rewrite", activation: "auto", match: "always", description: "Not sent" } } as RevisionPreference), adoption: "auto" as const };
    const manual = { ...selectPreference(automatic), id: "manual", scope: "global" as const, adoption: undefined };
    const task = { ...manual, id: "task", metadata: { ...manual.metadata!, kind: "task" as const, activation: "manual" as const } };
    expect(uniquePreferences([automatic, manual, task])).toEqual([manual, task]);
    const composed = composeRevision([automatic, manual, task], "Replace only the answer format.");
    expect(composed).toBe("Prompt rewriting instructions (manually selected):\n  Keep 中文\n\n\nMain-agent task requirements (manually selected):\n  Keep 中文\n\n\nCurrent user instructions:\nReplace only the answer format.");
    expect(composeRevision([automatic], "")).toContain("(automatic default):");
    expect(automatic.adoption).toBe("auto");
    expect(composed).not.toContain("Not sent");
  });
});

describe("searchPreferences", () => {
  it("AND-matches whitespace tokens across name, description and body without fuzzy matching", () => {
    const entries = [entry("all", "Keep commands", "Literal paths", "Preserve 中文 flags"),
      entry("missing", "Keep commands", "Literal paths", "Translate flags"), entry("body", "Other", "", "keep 中文 paths")];
    expect(ids(entries, " KEEP\t中文\npaths ")).toEqual(["all", "body"]);
    expect(ids(entries, "keep nonexistent")).toEqual([]);
    expect(ids(entries, "kcommand")).toEqual([]);
    expect(ids(entries, "comands")).toEqual([]);
  });

  it("ranks exact name, substring/all-name tokens, description, then body with stable source ties", () => {
    const entries = [entry("body-first", "Other", "", "alpha beta"), entry("description-first", "Other", "alpha beta"),
      entry("substring", "Extended alpha beta"), entry("tokens", "Beta then ALPHA"), entry("exact", "ALPHA BETA"),
      entry("description-second", "Alpha", "Beta"), entry("body-second", "Alpha", "", "Beta"), entry("missing", "Alpha")];
    expect(ids(entries, "alpha beta")).toEqual(["exact", "substring", "tokens", "description-first", "description-second", "body-first", "body-second"]);
    expect(ids(entries, "beta alpha")).toEqual(["substring", "tokens", "exact", "description-first", "description-second", "body-first", "body-second"]);
    expect(entries.map((item) => item.id)).toEqual(["body-first", "description-first", "substring", "tokens", "exact", "description-second", "body-second", "missing"]);
  });

  it("uses case-insensitive literal Unicode matching and Unicode whitespace", () => {
    const entries = [entry("body", "Other", "", "CAFÉ 中文 😀 ΔΟΚΙΜΉ"), entry("name", "Café 中文", "Δοκιμή 😀")];
    expect(ids(entries, "café\u3000中文")).toEqual(["name", "body"]);
    expect(ids(entries, "δοκιμή\u00a0😀")).toEqual(["name", "body"]);
    expect(ids(entries, "cafe")).toEqual([]); // No accent folding or fuzzy matching.
  });

  it("preserves source order and identities for empty/whitespace queries without mutating input", () => {
    const entries = [entry("z", "Z"), entry("a", "A"), entry("b", "B")];
    for (const query of ["", " \t\n\u3000"]) {
      const result = searchPreferences(entries, query);
      expect(result).toEqual(entries);
      expect(result).not.toBe(entries);
      expect(result[0]).toBe(entries[0]);
    }
    const frozen = Object.freeze([...entries]);
    expect(searchPreferences(frozen, "a")).toEqual([entries[1]]);
  });
});
