import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG as DEFAULTS } from "../../src/config.js";
import { assembleProjectContext, captureProjectContext, collectDirectoryContext, collectTree, directoryReferences, formatProjectResources, resourcesFromPrompt } from "../../src/project-context.js";

// Resource/scanner tests opt in; production defaults are covered separately.
const DEFAULT_CONFIG = { ...DEFAULTS, projectContext: {
  ...DEFAULTS.projectContext, instructionsEnabled: true,
  tree: { ...DEFAULTS.projectContext.tree, enabled: true },
} };

const dirs: string[] = [];
async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "refine-project-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => { vi.useRealTimers(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("host project resources", () => {
  it("can extract the actual Pi 1.4.0 system-prompt format, including hidden skill filtering", async () => {
    const { buildSystemPrompt } = await import("../support/pi-system-prompt.js");
    const prompt = buildSystemPrompt({
      cwd: "/repo", selectedTools: ["read"],
      contextFiles: [{ path: "/repo/AGENTS.md", content: "Use npm.\nKeep tests." }],
      skills: [
        { name: "pdf", description: "Read <PDF> & tables", filePath: "/skills/pdf/SKILL.md", disableModelInvocation: false },
        { name: "hidden", description: "Do not advertise", filePath: "/skills/hidden/SKILL.md", disableModelInvocation: true },
      ] as any,
    });
    const result = resourcesFromPrompt(prompt);
    expect(result.warnings).toEqual([]);
    expect(result.resources.contextFiles).toEqual([{ path: "/repo/AGENTS.md", content: "Use npm.\nKeep tests." }]);
    expect(result.resources.skills).toEqual([{ name: "pdf", description: "Read <PDF> & tables" }]);
  });

  it("extracts only current Pi resource sections before any user message, with XML-decoded metadata", () => {
    const prompt = `PRIVATE SYSTEM RULES\n<tools>\nPRIVATE TOOL DEFINITIONS\n</tools>\n<project_context>\nProject-specific instructions and guidelines:\n\n<project_instructions path="/repo/AGENTS.md">\n# Rules\nUse the existing parser.\n</project_instructions>\n</project_context>\n<skills>\nUse bash to read files.\n<available_skills>\n<skill><name>pdf</name><description>Read &amp; inspect &lt;PDF&gt; files.</description><location>/private/skill/SKILL.md</location></skill>\n</available_skills>\n</skills>\n<cwd>\n/repo\n</cwd>`;
    const ctx = { getSystemPrompt: () => prompt } as ExtensionContext;
    const snapshot = captureProjectContext(ctx, { ...DEFAULT_CONFIG.projectContext, skillsEnabled: true }, "Explain PDFs");
    expect(snapshot.warnings).toEqual([]);
    expect(snapshot.text).toContain("Use the existing parser.");
    expect(snapshot.text).toContain("Read & inspect <PDF> files.");
    expect(snapshot.text).not.toContain("PRIVATE");
    expect(snapshot.text).not.toContain("Use bash");
    expect(snapshot.text).not.toContain("/private/skill");
    expect(snapshot).toMatchObject({ instructionCount: 1, skillCount: 1 });
  });

  it("prefers structured resources, preserves host precedence, and hides manual-only skills unless named exactly", () => {
    const resources = {
      contextFiles: [{ path: "/global/AGENTS.md", content: "Global rule" }, { path: "/repo/CLAUDE.md", content: "Local override" }],
      skills: [{ name: "pdf", description: "Extract tables" }, { name: "publish", description: "Publish releases", disableModelInvocation: true }],
    };
    const ctx = { getSystemPromptOptions: () => resources, getSystemPrompt: () => { throw new Error("must not read full system"); } } as unknown as ExtensionContext;
    const snapshot = captureProjectContext(ctx, { ...DEFAULT_CONFIG.projectContext, skillsEnabled: true }, "Use /skill:publisher");
    expect(snapshot.text.indexOf("Global rule")).toBeLessThan(snapshot.text.indexOf("Local override"));
    expect(snapshot.text).not.toContain("Publish releases");
    expect(captureProjectContext(ctx, { ...DEFAULT_CONFIG.projectContext, skillsEnabled: true }, "Use /skill:publish now").text).toContain("Publish releases");
  });

  it("distinguishes absent resources, opaque system prompts, malformed sections and read failures", () => {
    expect(resourcesFromPrompt("<cwd>\n/repo\n</cwd>").warnings).toEqual([]);
    expect(resourcesFromPrompt("opaque custom prompt").warnings.join(" ")).toContain("did not provide recognizable project resources");
    expect(resourcesFromPrompt("<project_context>\nunknown custom format\n</project_context>").warnings.join(" ")).toContain("unrecognized format");
    const snapshot = captureProjectContext({ getSystemPrompt() { throw new Error("unavailable"); } } as unknown as ExtensionContext, DEFAULT_CONFIG.projectContext, "draft");
    expect(snapshot.warnings.join(" ")).toContain("Could not read Pi's loaded project");
  });

  it("keeps complete Markdown sections with line provenance and warns rather than silently head/tail truncating instructions", () => {
    const content = "# Environment\nUse the project venv.\n\n# Large section\n" + "x".repeat(3000) + "\n\n# Restrictions\nNever publish.\n";
    const config = { ...DEFAULT_CONFIG.projectContext, instructionsMaxChars: 512 };
    const snapshot = formatProjectResources({ contextFiles: [{ path: "/repo/AGENTS.md", content }] }, config, "draft");
    expect(snapshot.text).toContain("Use the project venv.");
    expect(snapshot.text).toContain("Never publish.");
    expect(snapshot.text).toContain('"complete":false');
    expect(snapshot.text).toContain('"startLine":');
    expect(snapshot.text).not.toContain("x".repeat(100));
    const assembled = assembleProjectContext(snapshot, { text: "", warnings: [] }, config);
    expect(assembled.warnings.join(" ")).toContain("Project instructions are incomplete");
    expect(assembled.text).toContain("CONTEXT WARNINGS");
  });

  it("does not truncate a larger ancestor file when all applicable instructions fit together", () => {
    const result = formatProjectResources({ contextFiles: [
      { path: "/global/AGENTS.md", content: "Global agreement " + "g".repeat(10_000) },
      { path: "/repo/AGENTS.md", content: "Local agreement" },
    ] }, DEFAULT_CONFIG.projectContext, "draft");
    expect(result.warnings).toEqual([]);
    expect(result.text).toContain("g".repeat(10_000));
    expect(result.text).toContain("Local agreement");
    expect(result.text).not.toContain('"complete":false');
  });

  it("does not mistake headings inside fenced examples for independently complete instruction sections", () => {
    const content = "# Long example\n```bash\n# Example heading\n" + "x".repeat(2000) + "\n# Important command\nrm -rf example\n```\n# Actual rule\nNever publish.\n";
    const config = { ...DEFAULT_CONFIG.projectContext, instructionsMaxChars: 512 };
    const result = formatProjectResources({ contextFiles: [{ path: "/repo/AGENTS.md", content }] }, config, "draft");
    expect(result.text).toContain("Never publish.");
    expect(result.text).not.toContain("Important command");
    expect(result.text).not.toContain("rm -rf");
  });

  it("respects the total project character budget and retains whole skill descriptions", () => {
    const config = { ...DEFAULT_CONFIG.projectContext, maxChars: 512 };
    const snapshot = formatProjectResources({
      contextFiles: [{ path: "/repo/AGENTS.md", content: "# Rules\n" + "x".repeat(2000) }],
      skills: [{ name: "huge", description: "a".repeat(2000) }, { name: "small", description: "Read PDFs" }],
    }, config, "draft");
    const assembled = assembleProjectContext(snapshot, { text: "t".repeat(1000), warnings: [] }, config);
    expect(assembled.text.length).toBeLessThanOrEqual(512);
    expect(assembled.warnings.join(" ")).toContain("skills catalog is incomplete");
    expect(assembled.warnings.join(" ")).toContain("total project context budget was exceeded");
    expect(assembled.text).not.toContain("a".repeat(10));
    const smallSkills = formatProjectResources({ skills: [{ name: "huge", description: "a".repeat(2000) }, { name: "small", description: "Read PDFs" }] }, { ...config, maxChars: 1024 }, "draft");
    expect(smallSkills.text).toContain("Read PDFs");
  });
});

describe("explicit directory references", () => {
  function config() {
    const config = structuredClone(DEFAULT_CONFIG.projectContext);
    config.tree.timeoutMs = 2000;
    return config;
  }
  const signal = () => new AbortController().signal;

  it("parses literal, quoted and Markdown references without matching emails, URLs or escaped @", () => {
    const draft = 'Inspect @src/ (`@./tests`) @"docs with spaces" @\'more docs\' @`other docs` @src/ ' +
      'user@example.com https://example.com/@ignored \\@escaped @@scope/package';
    expect(directoryReferences(draft, 8)).toEqual({ paths: ["src/", "./tests", "docs with spaces", "more docs", "other docs"], truncated: false });
    expect(directoryReferences("@a @a @b @c", 2)).toEqual({ paths: ["a", "b"], truncated: true });
  });

  it.each([false, true])("lists referenced folders with default tree enabled=%s, without needing empty history", async (enabled) => {
    const dir = await fixture();
    await mkdir(join(dir, "src", "nested"), { recursive: true });
    await mkdir(join(dir, "docs with spaces"));
    await writeFile(join(dir, "src", "nested", "target.ts"), "PRIVATE CONTENT");
    await writeFile(join(dir, "docs with spaces", "guide.md"), "PRIVATE GUIDE");
    await writeFile(join(dir, "unrelated.txt"), "");
    const settings = config();
    settings.tree.enabled = enabled;
    const result = await collectDirectoryContext(dir, '@src @"docs with spaces"', settings, false, signal());
    expect(result.warnings).toEqual([]);
    expect(result.referencedDirectoryCount).toBe(2);
    expect(result.text).toContain('REFERENCED DIRECTORY: "src"');
    expect(result.text).toContain('REFERENCED DIRECTORY: "docs with spaces"');
    expect(result.text).toContain("target.ts");
    expect(result.text).toContain("guide.md");
    expect(result.text).not.toContain("unrelated.txt");
    expect(result.text).not.toContain("PRIVATE");
    expect(result.text.length).toBeLessThanOrEqual(settings.tree.maxChars);
  });

  it("deduplicates normalized aliases and overlapping default/explicit subtrees without losing deeper references", async () => {
    const dir = await fixture();
    await mkdir(join(dir, "src", "nested", "deep"), { recursive: true });
    await writeFile(join(dir, "src", "top.ts"), "");
    await writeFile(join(dir, "src", "nested", "deep", "bottom.ts"), "");
    await writeFile(join(dir, "README.md"), "");
    const result = await collectDirectoryContext(dir, `@src @./src/ @${join(dir, "src")} @src/nested`, config(), true, signal());
    expect(result.referencedDirectoryCount).toBe(2);
    expect(result.text.match(/top\.ts/g)).toHaveLength(1);
    expect(result.text.match(/bottom\.ts/g)).toHaveLength(1);
    expect(result.text).toContain("README.md");
    expect(result.text).toContain("[separate @reference]");
    const root = await collectDirectoryContext(dir, "@./ @.", config(), true, signal());
    expect(root.referencedDirectoryCount).toBe(1);
    expect(root.text).not.toContain("WORKING DIRECTORY TREE:");
  });

  it("keeps the default policy for no references, ordinary files and non-path mentions", async () => {
    const dir = await fixture();
    await writeFile(join(dir, "file.ts"), "PRIVATE FILE");
    const settings = config();
    const defaultTree = await collectTree(dir, "draft", settings.tree, signal());
    for (const draft of ["draft", "@file.ts", "user@example.com https://example.com/@src"]) {
      const without = await collectDirectoryContext(dir, draft, settings, false, signal());
      expect(without.text).toBe("");
      expect(without.warnings).toEqual([]);
      const withDefault = await collectDirectoryContext(dir, draft, settings, true, signal());
      expect(withDefault.text).toBe(defaultTree.text);
      expect(withDefault.text).not.toContain("PRIVATE FILE");
    }
  });

  it("honors independent opt-outs and does not inspect references when disabled", async () => {
    const settings = config();
    settings.referencedDirectories.enabled = false;
    expect(await collectDirectoryContext("/missing", "@missing", settings, false, signal())).toEqual({ text: "", warnings: [] });
    const dir = await fixture();
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "default-only.ts"), "");
    const defaultOnly = await collectDirectoryContext(dir, "@src", settings, true, signal());
    expect(defaultOnly.text).toContain("default-only.ts");
    expect(defaultOnly.text).not.toContain("REFERENCED DIRECTORY:");
    settings.referencedDirectories.enabled = true;
    settings.enabled = false;
    expect(await collectDirectoryContext("/missing", "@missing", settings, true, signal())).toEqual({ text: "", warnings: [] });
  });

  it("rejects outside, traversal, ignored and symlink paths, including symlink parents", async () => {
    const dir = await fixture();
    const outside = await fixture();
    await mkdir(join(outside, "nested"));
    await writeFile(join(outside, "nested", "outside-secret.txt"), "");
    await symlink(outside, join(dir, "linked"));
    await mkdir(join(dir, "ignored", "child"), { recursive: true });
    await writeFile(join(dir, "ignored", "child", "ignored-secret.txt"), "");
    await mkdir(join(dir, "node_modules"));
    await mkdir(join(dir, ".env.private"));
    await writeFile(join(dir, ".gitignore"), "ignored/\n");
    const result = await collectDirectoryContext(dir,
      `@${outside} @../escape @linked/nested @ignored/child @node_modules @.env.private @missing`, config(), false, signal());
    expect(result.text).toBe("");
    expect(result.warnings).toHaveLength(7);
    expect(result.warnings.join(" ")).toContain("within cwd");
    expect(result.warnings.join(" ")).toContain("symlink");
    expect(result.warnings.join(" ")).toContain("missing or unreadable");
  });

  it("inherits ignore rules through non-Git parents and respects nested negations", async () => {
    const dir = await fixture();
    await mkdir(join(dir, "src", "nested"), { recursive: true });
    await writeFile(join(dir, ".gitignore"), "*.log\n*.ts\n");
    await writeFile(join(dir, "src", ".gitignore"), "!keep.ts\n");
    await writeFile(join(dir, "src", "nested", "skip.log"), "");
    await writeFile(join(dir, "src", "nested", "skip.ts"), "");
    await writeFile(join(dir, "src", "nested", "keep.ts"), "");
    const result = await collectDirectoryContext(dir, "@src/nested", config(), false, signal());
    expect(result.warnings).toEqual([]);
    expect(result.text).toContain("keep.ts");
    expect(result.text).not.toContain("skip.log");
    expect(result.text).not.toContain("skip.ts");
  });

  it("bounds references, shares entry/character/scan budgets and prioritizes explicit directories", async () => {
    const dir = await fixture();
    for (const name of ["one", "two"]) {
      await mkdir(join(dir, name));
      for (let index = 0; index < 6; index += 1) await writeFile(join(dir, name, `item-${index}.ts`), "");
    }
    const settings = config();
    settings.tree.maxEntries = 2;
    const result = await collectDirectoryContext(dir, "@one @two", settings, true, signal());
    expect(result.text).toContain('REFERENCED DIRECTORY: "one"');
    expect(result.text.match(/item-\d\.ts/g)).toHaveLength(2);
    expect(result.warnings.join(" ")).toContain("Shared directory budget");
    expect(result.text).not.toContain("WORKING DIRECTORY TREE");
    settings.tree.maxEntries = 120;
    settings.tree.maxScannedEntries = 2;
    expect((await collectDirectoryContext(dir, "@one @two", settings, false, signal())).warnings.join(" ")).toContain("Shared directory budget");
    settings.tree.maxScannedEntries = 2000;
    settings.tree.maxChars = 256;
    const small = await collectDirectoryContext(dir, "@one @two", settings, true, signal());
    expect(small.text.length).toBeLessThanOrEqual(256);
    expect(small.warnings.join(" ")).toContain("Shared directory budget");
    settings.referencedDirectories.maxReferences = 1;
    const limited = await collectDirectoryContext(dir, "@one @two", settings, false, signal());
    expect(limited.warnings.join(" ")).toContain("reference limit");
    expect(limited.text).not.toContain('REFERENCED DIRECTORY: "two"');
  });

  it("cancels reference resolution and shares one deadline including filesystem validation", async () => {
    const dir = await fixture();
    await mkdir(join(dir, "src"));
    const abort = new AbortController();
    const pending = collectDirectoryContext(dir, "@src", config(), false, abort.signal);
    abort.abort();
    expect(await pending).toEqual({ text: "", warnings: [] });
    vi.useFakeTimers();
    const settings = config();
    settings.tree.timeoutMs = 10;
    const timed = collectDirectoryContext(dir, "@src", settings, false, signal());
    vi.advanceTimersByTime(10);
    expect((await timed).warnings.join(" ")).toContain("timed out");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("bounded asynchronous project tree", () => {
  it("shows source structure, honors Git ignore, and never descends into dependencies, symlinks or deep directories", async () => {
    const dir = await fixture();
    const outside = await fixture();
    await mkdir(join(dir, ".git"));
    await mkdir(join(dir, "src", "deep"), { recursive: true });
    await mkdir(join(dir, "node_modules"));
    await writeFile(join(dir, "src", "index.ts"), "PRIVATE FILE CONTENT");
    await writeFile(join(dir, "src", "deep", "hidden.ts"), "");
    await writeFile(join(dir, "node_modules", "unwanted.js"), "");
    await writeFile(join(dir, "ignored.log"), "");
    await writeFile(join(dir, ".gitignore"), "*.log\n");
    await writeFile(join(outside, "outside-secret.txt"), "");
    await symlink(outside, join(dir, "linked"));
    const result = await collectTree(dir, "draft", { ...DEFAULT_CONFIG.projectContext.tree, timeoutMs: 2000 }, new AbortController().signal);
    expect(result.warnings).toEqual([]);
    expect(result.text).toContain('"index.ts"');
    expect(result.text).toContain("├──");
    for (const excluded of ["ignored.log", "hidden.ts", "node_modules", "unwanted.js", "outside-secret", "PRIVATE FILE CONTENT"]) expect(result.text).not.toContain(excluded);
    expect(result.text).toContain("symlink; not followed");
  });

  it("bounds breadth and output characters and prioritizes manifests and explicit paths", async () => {
    const dir = await fixture();
    await Promise.all(Array.from({ length: 30 }, (_, index) => writeFile(join(dir, `aaa${index}.ts`), "")));
    await writeFile(join(dir, "package.json"), "{}");
    await writeFile(join(dir, "target.ts"), "");
    const result = await collectTree(dir, "Fix target.ts", { ...DEFAULT_CONFIG.projectContext.tree, maxEntriesPerDirectory: 2, maxEntries: 2, maxChars: 256, timeoutMs: 2000 }, new AbortController().signal);
    expect(result.text).toContain("target.ts");
    expect(result.text).toContain("package.json");
    expect(result.text.length).toBeLessThanOrEqual(256);
    expect(result.warnings.join(" ")).toContain("entry limit");
    const tiny = await collectTree(dir, "draft", { ...DEFAULT_CONFIG.projectContext.tree, maxChars: 128, timeoutMs: 2000 }, new AbortController().signal);
    expect(tiny.text.length).toBeLessThanOrEqual(128);
    expect(tiny.warnings.join(" ")).toContain("character budget");
  });

  it("stops enumeration at its scan cap and handles missing directories", async () => {
    const dir = await fixture();
    await Promise.all(Array.from({ length: 10 }, (_, index) => writeFile(join(dir, `${index}.txt`), "")));
    const result = await collectTree(dir, "draft", { ...DEFAULT_CONFIG.projectContext.tree, maxScannedEntries: 2, timeoutMs: 2000 }, new AbortController().signal);
    expect(result.warnings.join(" ")).toContain("scan entry limit");
    const missing = await collectTree(join(dir, "missing"), "draft", DEFAULT_CONFIG.projectContext.tree, new AbortController().signal);
    expect(missing.warnings.join(" ")).toContain("directory could not be read");
  });

  it("applies inherited and nested ignore rules including negation from a subdirectory", async () => {
    const dir = await fixture();
    await mkdir(join(dir, ".git"));
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, ".gitignore"), "*.log\n*.ts\n");
    await writeFile(join(dir, "sub", ".gitignore"), "!keep.ts\n");
    await writeFile(join(dir, "sub", "keep.ts"), "");
    await writeFile(join(dir, "sub", "skip.ts"), "");
    await writeFile(join(dir, "sub", "skip.log"), "");
    const tree = await collectTree(join(dir, "sub"), "draft", { ...DEFAULT_CONFIG.projectContext.tree, timeoutMs: 2000 }, new AbortController().signal);
    expect(tree.warnings).toEqual([]);
    expect(tree.text).toContain("keep.ts");
    expect(tree.text).not.toContain("skip.ts");
    expect(tree.text).not.toContain("skip.log");
  });

  it("cancels during collection and supports disabling collection", async () => {
    const dir = await fixture();
    const controller = new AbortController();
    const pending = collectTree(dir, "draft", DEFAULT_CONFIG.projectContext.tree, controller.signal);
    controller.abort();
    expect(await pending).toEqual({ text: "", warnings: [] });
    expect(await collectTree("/does-not-exist", "draft", { ...DEFAULT_CONFIG.projectContext.tree, enabled: false }, new AbortController().signal)).toEqual({ text: "", warnings: [] });
  });

  it("returns a warning at the collection deadline without waiting for filesystem work", async () => {
    const dir = await fixture();
    vi.useFakeTimers();
    const pending = collectTree(dir, "draft", { ...DEFAULT_CONFIG.projectContext.tree, timeoutMs: 10 }, new AbortController().signal);
    vi.advanceTimersByTime(10);
    const result = await pending;
    expect(result.warnings.join(" ")).toContain("time budget");
    expect(vi.getTimerCount()).toBe(0);
  });
});
