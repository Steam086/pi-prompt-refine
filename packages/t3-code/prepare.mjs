import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const destination = process.argv[2] ? resolve(process.argv[2]) : undefined;
if (!destination || process.argv.length !== 3) throw new Error("Usage: node packages/t3-code/prepare.mjs <T3 Code checkout>");
const git = (...args) => execFileSync("git", ["-C", destination, ...args], { encoding: "utf8" });
if (git("rev-parse", "HEAD").trim() !== "59651c1761f6c63e9b6056839067066968e6a406") {
  throw new Error("Expected the T3 Code v0.1.11 source checkout.");
}

const staging = mkdtempSync(join(tmpdir(), "prompt-refine-t3-"));
const moduleDir = join(destination, "packages/prompt-refine");
const overlay = join(here, "host");
const files = readdirSync(overlay, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
  .map((entry) => join(entry.parentPath.slice(overlay.length), entry.name));
try {
  git("apply", "--check", join(here, "t3-code.patch"));
  if (existsSync(moduleDir) || files.some((path) => existsSync(join(destination, path)))) {
    throw new Error("Refine files already exist in the target checkout.");
  }

  execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"),
    "--target", "ES2022", "--module", "NodeNext", "--strict", "--declaration", "--skipLibCheck",
    "--rootDir", root, "--outDir", join(staging, "dist"), join(here, "src/service.ts")], { cwd: root, stdio: "inherit" });
  writeFileSync(join(staging, "package.json"), JSON.stringify({
    name: "@t3tools/prompt-refine",
    version: "0.1.0",
    private: true,
    type: "module",
    exports: { ".": "./dist/packages/t3-code/src/service.js", "./protocol": "./dist/packages/t3-code/src/protocol.js" },
    dependencies: {
      "@earendil-works/pi-ai": "1.6.0",
      "@earendil-works/pi-coding-agent": "1.6.0",
      ignore: "^7.0.8",
    },
  }, null, 2) + "\n");
  cpSync(join(root, "LICENSE"), join(staging, "LICENSE"));
  mkdirSync(join(staging, "dist/examples"));
  cpSync(join(root, "examples/prompt-refine-preferences.json"), join(staging, "dist/examples/prompt-refine-preferences.json"));

  git("apply", join(here, "t3-code.patch"));
  cpSync(staging, moduleDir, { recursive: true });
  for (const path of files) {
    const target = join(destination, path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(overlay, path), target);
  }
  process.stdout.write("Refine integration prepared in the T3 Code checkout. Install its workspace dependencies and build with the T3 toolchain.\n");
} finally {
  rmSync(staging, { recursive: true, force: true });
}
