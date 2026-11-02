import { lstat, open, opendir } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import ignore, { type Ignore } from "ignore";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ProjectContextConfig } from "./config.js";

interface ContextFile { path: string; content: string }
interface SkillMetadata { name: string; description: string; disableModelInvocation?: boolean }
export interface HostResources { cwd?: string; contextFiles?: readonly ContextFile[]; skills?: readonly SkillMetadata[] }
export interface ProjectSnapshot {
  text: string;
  warnings: string[];
  instructionCount: number;
  skillCount: number;
}
export interface TreeSnapshot {
  text: string;
  warnings: string[];
  entryCount?: number;
  scannedCount?: number;
  referencedDirectoryCount?: number;
}

function prefix(text: string, maxChars: number): string {
  let end = Math.max(0, maxChars);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text.charAt(end - 1))) end -= 1;
  return text.slice(0, end);
}

function decodeXml(text: string): string {
  return text.replace(/&(lt|gt|quot|apos|amp);/g, (_, key: string) => ({ lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" })[key]!);
}

/** Only extracts Pi's named resource sections, never its general system instructions/tools. */
export function resourcesFromPrompt(prompt: string): { resources: HostResources; warnings: string[] } {
  const resources: HostResources = { contextFiles: [], skills: [] };
  const warnings: string[] = [];
  const projectSection = /(?:^|\n)<project_context>\n([\s\S]*?)\n<\/project_context>(?=\n|$)/.exec(prompt)?.[1];
  if (projectSection !== undefined) {
    const files: ContextFile[] = [];
    const pattern = /<project_instructions path="([^"\n]+)">\n([\s\S]*?)\n<\/project_instructions>/g;
    for (const match of projectSection.matchAll(pattern)) files.push({ path: match[1]!, content: match[2]! });
    const remainder = projectSection.replace(pattern, "").replace("Project-specific instructions and guidelines:", "").trim();
    if (remainder) warnings.push("Pi project instructions use an unrecognized format; some rules were omitted.");
    resources.contextFiles = files;
  }
  const skillSection = /(?:^|\n)<skills>\n([\s\S]*?)\n<\/skills>(?=\n|$)/.exec(prompt)?.[1];
  if (skillSection !== undefined) {
    const skills: SkillMetadata[] = [];
    const catalog = /<available_skills>\s*([\s\S]*?)\s*<\/available_skills>/.exec(skillSection)?.[1];
    const pattern = /<skill>\s*<name>([\s\S]*?)<\/name>\s*<description>([\s\S]*?)<\/description>\s*<location>[\s\S]*?<\/location>\s*<\/skill>/g;
    if (catalog !== undefined) {
      for (const match of catalog.matchAll(pattern)) skills.push({ name: decodeXml(match[1]!), description: decodeXml(match[2]!) });
    }
    if (catalog === undefined || catalog.replace(pattern, "").trim()) warnings.push("The Pi skills catalog uses an unrecognized format; some skill descriptions were omitted.");
    resources.skills = skills;
  }
  if (!/<(?:cwd|project_context|skills)>\n/.test(prompt)) warnings.push("The host did not provide recognizable project resources; AGENTS.md and skills directories were not scanned automatically.");
  return { resources, warnings };
}

/** Command contexts expose structured base inputs; shortcuts use current rendered Pi sections. */
export function captureProjectContext(ctx: ExtensionContext, config: ProjectContextConfig, draft: string, followUp = false): ProjectSnapshot {
  if (!config.enabled) return { text: "", warnings: [], instructionCount: 0, skillCount: 0 };
  let resources: HostResources = {};
  let warnings: string[] = [];
  try {
    const command = ctx as ExtensionContext & { getSystemPromptOptions?: () => HostResources };
    if (typeof command.getSystemPromptOptions === "function") resources = command.getSystemPromptOptions();
    else ({ resources, warnings } = resourcesFromPrompt(ctx.getSystemPrompt()));
  } catch { warnings.push("Could not read Pi's loaded project instructions and skills; project resources are incomplete for this request."); }
  const omitInstructions = !config.instructionsEnabled || (followUp && !config.instructionsOnFollowUp);
  return formatProjectResources({ ...resources, cwd: ctx.cwd, ...(omitInstructions ? { contextFiles: [] } : {}),
    ...(!config.skillsEnabled ? { skills: [] } : {}) }, config, draft, warnings);
}

function markdownSections(content: string): Array<{ startLine: number; content: string }> {
  const sections: Array<{ startLine: number; content: string }> = [];
  let section = { startLine: 1, content: "" };
  let fence: { character: string; length: number } | undefined;
  let lineNumber = 0;
  for (const line of content.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    lineNumber += 1;
    if (!fence && /^ {0,3}#{1,6}[ \t]+\S/.test(line) && section.content) {
      sections.push(section);
      section = { startLine: lineNumber, content: "" };
    }
    section.content += line;
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(line);
    if (marker) {
      if (!fence) fence = { character: marker[1]![0]!, length: marker[1]!.length };
      else if (marker[1]![0] === fence.character && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined;
    }
  }
  if (section.content) sections.push(section);
  return sections;
}

function instructionRecord(file: ContextFile, budget: number): { text: string; incomplete: boolean } {
  if (budget < 80) return { text: "", incomplete: true };
  const source = { source: file.path, sourceDirectory: dirname(file.path) };
  if (file.content.length <= budget) {
    const full = JSON.stringify({ ...source, complete: true, content: file.content });
    if (full.length <= budget) return { text: full, incomplete: false };
  }
  // Retain whole Markdown sections only; never cut a prohibition or exception mid-sentence.
  const scannedText = prefix(file.content, Math.max(65_536, budget * 8));
  const sections = markdownSections(scannedText);
  if (scannedText.length < file.content.length) sections.pop(); // The final scanned section may be incomplete.
  const selected: Array<{ startLine: number; content: string }> = [];
  for (const section of sections) {
    const candidate = JSON.stringify({ ...source, complete: false, sections: [...selected, section] });
    if (candidate.length <= budget) selected.push(section);
  }
  const text = JSON.stringify({ ...source, complete: false, sections: selected });
  return { text: text.length <= budget ? text : "", incomplete: true };
}

export function formatProjectResources(resources: HostResources, config: ProjectContextConfig, draft: string, initialWarnings: string[] = []): ProjectSnapshot {
  const warnings = [...initialWarnings];
  const reserve = Math.min(1100, Math.floor(config.maxChars / 2));
  let available = config.maxChars - reserve;
  const files = resources.contextFiles ?? [];
  const instructions: string[] = [];
  let environment = resources.cwd ? `WORKING DIRECTORY: ${JSON.stringify(resources.cwd)}\n\n` : "";
  if (environment.length > available / 2) { environment = ""; warnings.push("The working directory name exceeded the context budget and was omitted."); }
  const instructionHeader = environment + "PROJECT INSTRUCTIONS (JSON records, in host precedence order):\n";
  const skillHeader = "\n\nMAIN AGENT SKILLS (metadata only; not optimizer tools):\n";
  available -= instructionHeader.length + skillHeader.length + 32;
  let instructionBudget = Math.min(config.instructionsMaxChars, Math.max(0, available));
  const fullSizes = files.map((file) => file.content.length <= instructionBudget
    ? JSON.stringify({ source: file.path, sourceDirectory: dirname(file.path), complete: true, content: file.content }).length
    : Number.POSITIVE_INFINITY);
  const allInstructionsFit = fullSizes.reduce((sum, size) => sum + size + 1, 0) <= instructionBudget;
  let incompleteFiles = 0;
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]!;
    const share = allInstructionsFit ? fullSizes[index]! : Math.floor(instructionBudget / (files.length - index));
    const result = instructionRecord(file, share);
    if (result.text) { instructions.push(result.text); instructionBudget -= result.text.length + 1; available -= result.text.length + 1; }
    if (result.incomplete) incompleteFiles += 1;
  }
  if (incompleteFiles) warnings.push(`Project instructions are incomplete: ${incompleteFiles}/${files.length} files exceeded the character budget; only complete sections that fit were included. Records marked complete=false do not represent all rules.`);
  let text = instructionHeader + (instructions.join("\n") || "(none provided)");
  const selectedSkills: string[] = [];
  const explicit = (skill: SkillMetadata): boolean => {
    const name = skill.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^\\w/-])(?:/skill:|\\$)${name}(?![\\w-])`).test(draft);
  };
  const skills = (resources.skills ?? []).filter((skill) => !skill.disableModelInvocation || explicit(skill));
  const ordered = [...skills.filter(explicit), ...skills.filter((skill) => !explicit(skill))];
  let skillBudget = Math.min(config.skillsMaxChars, Math.max(0, available));
  for (const skill of ordered) {
    if (skill.name.length + skill.description.length > skillBudget) continue;
    const entry = JSON.stringify({ name: skill.name, description: skill.description });
    if (entry.length + 1 > skillBudget) continue;
    selectedSkills.push(entry);
    skillBudget -= entry.length + 1;
  }
  if (selectedSkills.length < skills.length) warnings.push(`The skills catalog is incomplete: ${selectedSkills.length}/${skills.length} entries were provided; entries that exceeded the character budget were omitted. Omitted entries may still be available.`);
  text += skillHeader + (selectedSkills.join("\n") || "(none provided)");
  return { text, warnings, instructionCount: instructions.length, skillCount: selectedSkills.length };
}

interface TreeEntry { path: string; directory: boolean; symlink: boolean }
const IMPORTANT = ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md", "README.md", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "src", "app", "apps", "packages", "test", "tests", "docs", ".pi", ".github"];
function priority(name: string, draft: string): number {
  if (name.length > 2 && draft.includes(name)) return -1;
  const index = IMPORTANT.indexOf(name);
  return index < 0 ? IMPORTANT.length : index;
}

interface IgnoreRules { base: string; matcher: Ignore }

/** Bounded local ignore parsing; no subprocess, full repository enumeration, or symlink reads. */
async function readIgnore(base: string, reasons: Set<string>): Promise<IgnoreRules | undefined> {
  try {
    const file = await open(join(base, ".gitignore"), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!(await file.stat()).isFile()) return undefined;
      const buffer = Buffer.alloc(16_385);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 16_384) { reasons.add(".gitignore exceeded the read budget"); return undefined; }
      return { base, matcher: ignore().add(buffer.subarray(0, bytesRead).toString("utf8")) };
    } finally { await file.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") reasons.add(".gitignore could not be read");
    return undefined;
  }
}

async function ancestorIgnoreRules(cwd: string, reasons: Set<string>, signal: AbortSignal): Promise<IgnoreRules[]> {
  const ancestors: string[] = [];
  let current = cwd;
  let foundRoot = false;
  for (let depth = 0; depth < 32 && !signal.aborted; depth += 1) {
    ancestors.unshift(current);
    try { await lstat(join(current, ".git")); foundRoot = true; break; } catch { /* Not the repository root. */ }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const rules: IgnoreRules[] = [];
  // A non-Git project still gets its own .gitignore; do not read unrelated ancestor files.
  for (const base of foundRoot ? ancestors.slice(0, -1) : []) {
    if (signal.aborted) break;
    const entry = await readIgnore(base, reasons);
    if (entry) rules.push(entry);
  }
  return rules;
}

function isIgnored(path: string, directory: boolean, rules: IgnoreRules[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    const name = relative(rule.base, path).split(sep).join("/") + (directory ? "/" : "");
    const result = rule.matcher.test(name);
    if (result.ignored) ignored = true;
    if (result.unignored) ignored = false;
  }
  return ignored;
}

interface TreeOptions {
  inheritedRules?: IgnoreRules[];
  skipDirectories?: ReadonlySet<string>;
}

export async function collectTree(cwd: string, draft: string, config: ProjectContextConfig["tree"], signal: AbortSignal, options: TreeOptions = {}): Promise<TreeSnapshot> {
  if (!config.enabled || signal.aborted) return { text: "", warnings: [] };
  const local = new AbortController();
  const combined = AbortSignal.any([signal, local.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const scan = async (): Promise<TreeSnapshot> => {
    const root = resolve(cwd);
    const excluded = new Set([".git", ...config.exclude]);
    const entries: TreeEntry[] = [];
    const reasons = new Set<string>();
    const inherited = options.inheritedRules ?? await ancestorIgnoreRules(root, reasons, combined);
    const queue: Array<{ path: string; depth: number; rules: IgnoreRules[] }> = [{ path: "", depth: 0, rules: inherited }];
    let scanned = 0;
    while (queue.length && !combined.aborted && entries.length < config.maxEntries) {
      const parent = queue.shift()!;
      const localRules = await readIgnore(join(root, parent.path), reasons);
      const rules = localRules ? [...parent.rules, localRules] : parent.rules;
      const children: TreeEntry[] = [];
      try {
        const dir = await opendir(join(root, parent.path));
        for await (const item of dir) {
          if (combined.aborted) break;
          scanned += 1;
          if (scanned > config.maxScannedEntries) { reasons.add("scan entry limit"); break; }
          if (excluded.has(item.name) || item.name === ".env" || item.name.startsWith(".env.")) continue;
          if (isIgnored(join(root, parent.path, item.name), item.isDirectory(), rules)) continue;
          children.push({ path: join(parent.path, item.name), directory: item.isDirectory(), symlink: item.isSymbolicLink() });
          if (children.length >= Math.max(config.maxEntriesPerDirectory * 4, 100)) { reasons.add("directory enumeration limit"); break; }
        }
      } catch { if (!combined.aborted) reasons.add("directory could not be read"); }
      if (combined.aborted) break;
      children.sort((a, b) => priority(basename(a.path), draft) - priority(basename(b.path), draft) || Number(b.directory) - Number(a.directory) || a.path.localeCompare(b.path, "en"));
      if (children.length > config.maxEntriesPerDirectory) reasons.add("per-directory entry limit");
      for (const child of children.slice(0, config.maxEntriesPerDirectory)) {
        if (entries.length >= config.maxEntries) { reasons.add("total tree entry limit"); break; }
        entries.push(child);
        if (child.directory && parent.depth + 1 < config.maxDepth && !options.skipDirectories?.has(join(root, child.path))) {
          queue.push({ path: child.path, depth: parent.depth + 1, rules });
        }
      }
      if (scanned > config.maxScannedEntries) break;
    }
    if (queue.length && entries.length >= config.maxEntries) reasons.add("total tree entry limit");
    if (combined.aborted) return { text: "", warnings: [] };
    const visible = entries;
    const lines = [JSON.stringify(basename(root) || root) + "/"];
    const footer = `\n[Partial tree: maxDepth=${config.maxDepth}; default excludes + .gitignore; unlisted paths may exist.]`;
    if (lines[0]!.length + footer.length > config.maxChars) { lines[0] = "./"; reasons.add("tree character budget"); }
    let used = lines[0]!.length + footer.length;
    const render = (parent: string, indent: string): void => {
      const children = visible.filter((entry) => dirname(entry.path) === (parent || "."));
      for (let index = 0; index < children.length; index += 1) {
        const child = children[index]!;
        const last = index === children.length - 1;
        const separate = child.directory && options.skipDirectories?.has(join(root, child.path));
        const line = `${indent}${last ? "└── " : "├── "}${JSON.stringify(basename(child.path))}${child.directory ? "/" : child.symlink ? " [symlink; not followed]" : ""}${separate ? " [separate @reference]" : ""}`;
        if (used + line.length + 1 > config.maxChars) { reasons.add("tree character budget"); break; }
        lines.push(line); used += line.length + 1;
        if (child.directory) render(child.path, indent + (last ? "    " : "│   "));
      }
    };
    render("", "");
    const warnings = reasons.size ? [`Tree is incomplete: ${[...reasons].join(", ")}; additional entries were not displayed or enumerated.`] : [];
    return { text: prefix(lines.join("\n") + footer, config.maxChars), warnings, entryCount: entries.length, scannedCount: scanned };
  };
  try {
    return await Promise.race([
      scan(),
      new Promise<TreeSnapshot>((done) => {
        timer = setTimeout(() => { local.abort(); done({ text: "[Tree unavailable: collection time budget exhausted.]", warnings: ["Tree collection exceeded the time budget and was stopped; the project structure is incomplete."] }); }, config.timeoutMs);
        timer.unref?.();
      }),
      new Promise<TreeSnapshot>((done) => {
        onAbort = () => done({ text: "", warnings: [] });
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
    local.abort();
  }
}

/** Literal @paths only: no shell expansion; quote paths containing spaces or punctuation. */
export function directoryReferences(draft: string, maxReferences: number): { paths: string[]; truncated: boolean } {
  const paths = new Set<string>();
  const pattern = /(?:^|[\s([{"'`，。；：])@(?:"([^"\r\n]+)"|'([^'\r\n]+)'|`([^`\r\n]+)`|([^\s"'`<>(){}\[\],;:!?，。；：！？]+))/gu;
  for (const match of draft.matchAll(pattern)) {
    const path = match[1] ?? match[2] ?? match[3] ?? match[4]!;
    if (path.includes("@")) continue; // Not an email address or a nested scoped package token.
    if (paths.has(path)) continue;
    if (paths.size >= maxReferences) return { paths: [...paths], truncated: true };
    paths.add(path);
  }
  return { paths: [...paths], truncated: false };
}

/** Explicit directories get first use of one shared tree budget, regardless of history. */
export async function collectDirectoryContext(
  cwd: string, draft: string, config: ProjectContextConfig, includeDefault: boolean, signal: AbortSignal,
): Promise<TreeSnapshot> {
  const empty = (): TreeSnapshot => ({ text: "", warnings: [] });
  if (!config.enabled || signal.aborted) return empty();
  const refs = config.referencedDirectories.enabled
    ? directoryReferences(draft, config.referencedDirectories.maxReferences)
    : { paths: [], truncated: false };
  const defaultEnabled = includeDefault && config.tree.enabled;
  if (!refs.paths.length) return defaultEnabled ? collectTree(cwd, draft, config.tree, signal) : empty();

  const local = new AbortController();
  const combined = AbortSignal.any([signal, local.signal]);
  const warnings: string[] = refs.truncated ? ["Directory reference limit reached; later references omitted."] : [];
  const sections: string[] = [];
  let referenceCount = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const snapshot = (): TreeSnapshot => ({ text: sections.join("\n\n"), warnings: [...warnings], referencedDirectoryCount: referenceCount });
  const scan = async (): Promise<TreeSnapshot> => {
    const root = resolve(cwd);
    const reasons = new Set<string>();
    const inherited = await ancestorIgnoreRules(root, reasons, combined);
    const excluded = new Set([".git", ...config.tree.exclude]);
    const directories = new Map<string, IgnoreRules[]>();
    const checked = new Set<string>();
    for (const ref of refs.paths) {
      if (combined.aborted) return empty();
      const path = resolve(root, ref);
      const name = relative(root, path);
      const label = JSON.stringify(prefix(ref, 200));
      if (name === ".." || name.startsWith(`..${sep}`) || isAbsolute(name) ||
          ref.split(/[\\/]/).includes("..") || /[\x00-\x1f\x7f]/.test(ref) || (sep !== "\\" && ref.includes("\\"))) {
        warnings.push(`Directory reference ${label} skipped: only literal paths within cwd are supported.`);
        continue;
      }
      if (checked.has(path)) continue;
      checked.add(path);
      const parts = name ? name.split(sep) : [];
      if (parts.length > 32) { warnings.push(`Directory reference ${label} skipped: path depth limit.`); continue; }
      let current = root;
      const rules = [...inherited];
      let usable = true;
      try {
        // Check every component, so @link/subdir cannot bypass the symlink policy.
        const rootStat = await lstat(root);
        if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("unsafe root");
        for (let index = 0; index < parts.length; index += 1) {
          if (combined.aborted) return empty();
          const part = parts[index]!;
          const localRules = await readIgnore(current, reasons);
          if (localRules) rules.push(localRules);
          current = join(current, part);
          const stat = await lstat(current);
          if (stat.isSymbolicLink() || excluded.has(part) || part === ".env" || part.startsWith(".env.") || isIgnored(current, stat.isDirectory(), rules)) {
            warnings.push(`Directory reference ${label} skipped: ignored, excluded or symlink path.`);
            usable = false;
            break;
          }
          if (!stat.isDirectory()) {
            // Ordinary @file references stay literal; never open their contents.
            if (index < parts.length - 1) warnings.push(`Directory reference ${label} skipped: a parent is not a directory.`);
            usable = false;
            break;
          }
        }
        if (usable) directories.set(path, rules);
      } catch {
        if (!combined.aborted) warnings.push(`Directory reference ${label} unavailable: missing or unreadable path.`);
      }
    }
    if (combined.aborted) return empty();
    if (reasons.size) warnings.push(`Directory reference ignore rules incomplete: ${[...reasons].join("; ")}.`);
    if (!directories.size) {
      const tree = defaultEnabled ? await collectTree(root, draft, config.tree, combined) : empty();
      return { ...tree, warnings: [...warnings, ...tree.warnings] };
    }
    const skipDirectories = new Set(directories.keys());
    const targets = [...directories].map(([path, rules]) => ({ path, rules, explicit: true }));
    if (defaultEnabled && !directories.has(root)) targets.push({ path: root, rules: inherited, explicit: false });
    let remainingChars = config.tree.maxChars;
    let remainingEntries = config.tree.maxEntries;
    let remainingScans = config.tree.maxScannedEntries;
    for (const target of targets) {
      if (combined.aborted) return empty();
      const header = target.explicit ? `REFERENCED DIRECTORY: ${JSON.stringify(relative(root, target.path) || ".")}\n` : "WORKING DIRECTORY TREE:\n";
      const separator = sections.length ? 2 : 0;
      const room = remainingChars - header.length - separator;
      if (room < 128 || remainingEntries <= 0 || remainingScans <= 0) {
        warnings.push("Shared directory budget exhausted; remaining listings omitted.");
        break;
      }
      const result = await collectTree(target.path, draft, {
        ...config.tree, enabled: true, maxChars: room, maxEntries: remainingEntries, maxScannedEntries: remainingScans,
      }, combined, { inheritedRules: target.rules, skipDirectories });
      if (combined.aborted) return empty();
      warnings.push(...result.warnings);
      if (result.text) {
        const section = header + result.text;
        sections.push(section);
        remainingChars -= section.length + separator;
        if (target.explicit) referenceCount += 1;
      }
      remainingEntries -= result.entryCount ?? 0;
      remainingScans -= result.scannedCount ?? 0;
    }
    return snapshot();
  };
  try {
    return await Promise.race([
      scan(),
      new Promise<TreeSnapshot>((done) => {
        timer = setTimeout(() => {
          local.abort();
          warnings.push("Directory collection timed out; remaining listings omitted.");
          done(snapshot());
        }, config.tree.timeoutMs);
        timer.unref?.();
      }),
      new Promise<TreeSnapshot>((done) => {
        onAbort = () => done(empty());
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
    local.abort();
  }
}

export function assembleProjectContext(snapshot: ProjectSnapshot, tree: TreeSnapshot, config: ProjectContextConfig): { text: string; warnings: string[] } {
  const warnings = [...snapshot.warnings, ...tree.warnings];
  const treeHeader = "\n\nPROJECT TREE (names only, partial):\n";
  const warningHeader = (): string => {
    const note = prefix(warnings.join("\n"), Math.max(0, Math.min(1000, Math.floor(config.maxChars / 2)) - 80));
    return note ? `CONTEXT WARNINGS (do not assume omitted information is absent):\n${note}\n\n` : "";
  };
  const remaining = Math.max(0, config.maxChars - warningHeader().length - snapshot.text.length - treeHeader.length);
  let treeText = tree.text;
  if (treeText.length > remaining) {
    if (!warnings.some((warning) => warning.includes("total project context budget"))) warnings.push("The total project context budget was exceeded; the tree was omitted.");
    treeText = "";
  }
  // Snapshot formatting reserves room for diagnostics. Never silently cut instruction records.
  const text = warningHeader() + snapshot.text + (treeText ? treeHeader + treeText : "");
  return { text, warnings };
}
