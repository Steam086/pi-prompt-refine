import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalShortcut, configPath, DEFAULT_CONFIG, DEFAULT_SHORTCUTS, loadConfig, parseConfig, saveConfig } from "../src/config.js";

const tempDirs: string[] = [];
async function tempDirectory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-prompt-refine-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Prompt Refine configuration", () => {
  it("uses documented defaults and leaves the model unconfigured", () => {
    const result = parseConfig({ version: 1 });
    expect(result.warnings).toEqual([]);
    expect(result.config).toEqual(DEFAULT_CONFIG);
    expect(result.config.model).toBeUndefined();
    expect(result.config.timeoutMs).toBe(60_000);
    expect(result.config.context).toEqual({ maxMessages: 12, maxChars: 16_000 });
  });

  it("accepts an optional thinking override and leaves it unset for session inheritance", () => {
    expect(parseConfig({ version: 1 }).config.thinkingLevel).toBeUndefined();
    expect(parseConfig({ version: 1, thinkingLevel: "high" }).config.thinkingLevel).toBe("high");
    expect(parseConfig({ version: 1, thinkingLevel: "off" }).config.thinkingLevel).toBe("off");
    const invalid = parseConfig({ version: 1, thinkingLevel: "turbo" });
    expect(invalid.config.thinkingLevel).toBeUndefined();
    expect(invalid.warnings.join(" ")).toContain("thinkingLevel");
  });

  it("migrates only complete legacy default maps and preserves explicit custom bindings", () => {
    const actions = ["optimize", "view", "dismiss", "selectModel", "cycleModel", "restore"];
    for (const keys of [
      ["f2", "f3", "f4", "f5", "f6", "f7"],
      ["alt+shift+r", "alt+shift+v", "alt+shift+x", "alt+shift+m", "alt+shift+c", "alt+shift+z"],
    ]) {
      const shortcuts = Object.fromEntries(actions.map((action, index) => [action, keys[index]]));
      const result = parseConfig({ version: 1, shortcuts, model: { provider: "p", id: "m" } });
      expect(result.shortcutsMigrated).toBe(true);
      expect(result.warnings).toEqual([]);
      expect(result.config.shortcuts).toEqual(DEFAULT_SHORTCUTS);
      expect(result.config.model).toEqual({ provider: "p", id: "m" });
    }
    const custom = parseConfig({ version: 1, shortcuts: { optimize: "f2", view: "f3", dismiss: "f4", selectModel: "f5", cycleModel: "f6", restore: "f8" } });
    expect(custom.shortcutsMigrated).toBeUndefined();
    expect(custom.config.shortcuts.restore).toBe("f8");
    expect(custom.config.shortcuts.optimize).toBe("f2");
    const disabled = parseConfig({ version: 1, shortcuts: { optimize: null } });
    expect(disabled.warnings).toEqual([]);
    expect(Object.values(disabled.config.shortcuts)).toEqual([null, null, null, null, null, null]);
  });

  it("keeps the checked-in example valid", async () => {
    const example = JSON.parse(await readFile(new URL("../examples/prompt-refine.json", import.meta.url), "utf8")) as unknown;
    const result = parseConfig(example);
    expect(result.warnings).toEqual([]);
    expect(result.config.model).toEqual({ provider: "openai", id: "gpt-4.1-mini" });
  });

  it("validates bounds and resets duplicate or invalid shortcuts without crashing", () => {
    const result = parseConfig({
      version: 1,
      timeoutMs: 10,
      maxDraftChars: -1,
      maxOutputTokens: 50_000,
      shortcuts: { optimize: "alt+shift+v", view: "alt+shift+v", dismiss: "escape" },
      favorites: [{ provider: "openai", id: "gpt-chat" }, { provider: "openai", id: "gpt-chat" }, { provider: "", id: "bad" }],
    });
    expect(result.config.timeoutMs).toBe(DEFAULT_CONFIG.timeoutMs);
    expect(result.config.maxDraftChars).toBe(DEFAULT_CONFIG.maxDraftChars);
    expect(result.config.maxOutputTokens).toBe(DEFAULT_CONFIG.maxOutputTokens);
    expect(result.config.shortcuts).toEqual(DEFAULT_SHORTCUTS);
    expect(result.config.favorites).toEqual([{ provider: "openai", id: "gpt-chat" }]);
    expect(result.warnings.length).toBeGreaterThanOrEqual(5);
    expect(canonicalShortcut("ctrl+alt+z")).toBe(canonicalShortcut("alt+ctrl+z"));
    expect(canonicalShortcut("escape")).toBe(canonicalShortcut("esc"));
    expect(canonicalShortcut("enter")).toBe(canonicalShortcut("return"));
    expect(canonicalShortcut("ctrl+ctrl+a")).toBeUndefined();
    expect(canonicalShortcut("ctrl+not-a-key")).toBeUndefined();
  });

  it("does not overwrite malformed or unsupported configuration files", async () => {
    const dir = await tempDirectory();
    const path = configPath(dir);
    const original = "{not json";
    await writeFile(path, original, "utf8");
    const loaded = await loadConfig(path);
    expect(loaded.config.model).toBeUndefined();
    expect(loaded.warnings).toHaveLength(1);
    expect(await readFile(path, "utf8")).toBe(original);

    const wrongVersion = parseConfig({ version: 2, model: { provider: "x", id: "y" } });
    expect(wrongVersion.warnings).toHaveLength(1);
    expect(wrongVersion.config.model).toBeUndefined();
  });

  it("atomically persists validated settings under the supplied agent directory", async () => {
    const dir = await tempDirectory();
    const path = configPath(join(dir, "agent"));
    const config = structuredClone(DEFAULT_CONFIG);
    config.model = { provider: "openai", id: "gpt-chat" };
    config.favorites = [config.model];
    config.shortcuts.view = "alt+shift+w";
    await saveConfig(path, config);

    const written = JSON.parse(await readFile(path, "utf8")) as typeof config;
    expect(written).toEqual(config);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("removes the temporary file when atomic persistence fails", async () => {
    const dir = await tempDirectory();
    const target = join(dir, "prompt-refine.json");
    await mkdir(target);
    await expect(saveConfig(target, structuredClone(DEFAULT_CONFIG))).rejects.toBeDefined();
    expect(await readdir(dir)).toEqual(["prompt-refine.json"]);
  });

  it("keeps missing configuration optional and reports unreadable paths", async () => {
    const dir = await tempDirectory();
    const missing = await loadConfig(join(dir, "not-created.json"));
    expect(missing.warnings).toEqual([]);
    expect(missing.config.model).toBeUndefined();
    const unreadable = await loadConfig(dir);
    expect(unreadable.warnings).toHaveLength(1);
  });
});
