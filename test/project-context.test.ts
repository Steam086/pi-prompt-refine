import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../src/config.js";
import { assembleProjectContext, captureProjectContext, collectTree, formatProjectResources, resourcesFromPrompt } from "../src/project-context.js";

const dirs: string[] = [];
async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "refine-project-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => { vi.useRealTimers(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("host project resources", () => {
  it("can extract the actual Pi 1.4.0 system-prompt format, including hidden skill filtering", async () => {
    const { buildSystemPrompt } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js");
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
    const snapshot = captureProjectContext(ctx, DEFAULT_CONFIG.projectContext, "Explain PDFs");
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
    const snapshot = captureProjectContext(ctx, DEFAULT_CONFIG.projectContext, "Use /skill:publisher");
    expect(snapshot.text.indexOf("Global rule")).toBeLessThan(snapshot.text.indexOf("Local override"));
    expect(snapshot.text).not.toContain("Publish releases");
    expect(captureProjectContext(ctx, DEFAULT_CONFIG.projectContext, "Use /skill:publish now").text).toContain("Publish releases");
  });

  it("distinguishes absent resources, opaque system prompts, malformed sections and read failures", () => {
    expect(resourcesFromPrompt("<cwd>\n/repo\n</cwd>").warnings).toEqual([]);
    expect(resourcesFromPrompt("opaque custom prompt").warnings.join(" ")).toContain("未提供可识别");
    expect(resourcesFromPrompt("<project_context>\nunknown custom format\n</project_context>").warnings.join(" ")).toContain("无法完整识别");
    const snapshot = captureProjectContext({ getSystemPrompt() { throw new Error("unavailable"); } } as unknown as ExtensionContext, DEFAULT_CONFIG.projectContext, "draft");
    expect(snapshot.warnings.join(" ")).toContain("无法获取");
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
    expect(assembled.warnings.join(" ")).toContain("项目指令未完整提供");
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
    expect(assembled.warnings.join(" ")).toContain("Skills 目录未完整提供");
    expect(assembled.warnings.join(" ")).toContain("项目上下文总预算");
    expect(assembled.text).not.toContain("a".repeat(10));
    const smallSkills = formatProjectResources({ skills: [{ name: "huge", description: "a".repeat(2000) }, { name: "small", description: "Read PDFs" }] }, { ...config, maxChars: 1024 }, "draft");
    expect(smallSkills.text).toContain("Read PDFs");
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
    expect(result.warnings.join(" ")).toContain("条目上限");
    const tiny = await collectTree(dir, "draft", { ...DEFAULT_CONFIG.projectContext.tree, maxChars: 128, timeoutMs: 2000 }, new AbortController().signal);
    expect(tiny.text.length).toBeLessThanOrEqual(128);
    expect(tiny.warnings.join(" ")).toContain("字符预算");
  });

  it("stops enumeration at its scan cap and handles missing directories", async () => {
    const dir = await fixture();
    await Promise.all(Array.from({ length: 10 }, (_, index) => writeFile(join(dir, `${index}.txt`), "")));
    const result = await collectTree(dir, "draft", { ...DEFAULT_CONFIG.projectContext.tree, maxScannedEntries: 2, timeoutMs: 2000 }, new AbortController().signal);
    expect(result.warnings.join(" ")).toContain("扫描条目上限");
    const missing = await collectTree(join(dir, "missing"), "draft", DEFAULT_CONFIG.projectContext.tree, new AbortController().signal);
    expect(missing.warnings.join(" ")).toContain("读取失败");
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
    expect(result.warnings.join(" ")).toContain("时间预算");
    expect(vi.getTimerCount()).toBe(0);
  });
});
