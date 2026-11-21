import { constants } from "node:fs";
import { open, opendir, realpath } from "node:fs/promises";
import { join, relative, isAbsolute, sep } from "node:path";
import type { HostResources } from "../../../src/project-context.js";

async function readText(root: string, path: string, maxBytes: number): Promise<string | undefined> {
  try {
    const resolved = await realpath(path);
    const relativePath = relative(await realpath(root), resolved);
    if (isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${sep}`)) return;
    const file = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > maxBytes) return;
      const bytes = Buffer.alloc(maxBytes + 1);
      let size = 0;
      while (size < bytes.length) {
        const { bytesRead } = await file.read(bytes, size, bytes.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size <= maxBytes) return bytes.toString("utf8", 0, size);
    } finally { await file.close(); }
  } catch { /* Optional project resources may be missing or unreadable. */ }
}

export async function readDesktopResources(cwd: string, instructions: boolean, skillMetadata: boolean): Promise<HostResources> {
  const path = join(cwd, "AGENTS.md");
  const content = instructions ? await readText(cwd, path, 128 * 1024) : undefined;
  const skills: Array<{ name: string; description: string }> = [];
  if (skillMetadata) {
    for (const base of [join(cwd, ".agents", "skills"), join(cwd, ".pi", "skills")]) {
      const directory = await opendir(base).catch(() => undefined);
      if (!directory) continue;
      let scanned = 0;
      for await (const entry of directory) {
        if (++scanned > 64 || skills.length >= 32) break;
        if (!entry.isDirectory()) continue;
        const source = await readText(cwd, join(base, entry.name, "SKILL.md"), 16 * 1024);
        const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source ?? "")?.[1];
        const description = /^description:\s*([^\r\n]+)$/m.exec(frontmatter ?? "")?.[1]?.trim().slice(0, 500);
        if (description) skills.push({ name: entry.name, description });
      }
    }
  }
  return { cwd, contextFiles: content ? [{ path, content }] : [], skills };
}
