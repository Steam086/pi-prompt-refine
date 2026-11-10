import { getKeybindings } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { vi } from "vitest";
import { selectHistory } from "../../src/context.js";
import type { RefineRecord } from "../../src/history.js";
import { TaskPanel, type TaskPanelPosition } from "../../src/task-panel.js";
import { getThemeByName } from "./pi-theme.js";

export function record(id = 1, taskId = 1): RefineRecord {
  const input = { draft: "本项目的原始要求", model: { provider: "openai-codex", id: `model-${id}` }, thinkingLevel: "xhigh" as const,
    sessionId: "session", branchLeafId: "private-branch", roundId: 1, systemPrompt: "Policy", history: selectHistory([], 12, 100) };
  return { id, taskId, kind: "refine", input, status: "generated", createdAt: id, elapsedSeconds: 23,
    usage: { totalTokens: 2989, input: 2319, output: 670, cacheRead: 0, cacheWrite: 0, reasoning: 585 },
    candidate: { ...input, requestId: id, version: 1, generation: 0, recordId: id, text: `Result ${id}\n正文 中文😀\nAnother line` } };
}

export function create(name = "dark", usage = false, records = [record()]) {
  const theme = getThemeByName(name)!;
  const size = { rows: 40 };
  const position: TaskPanelPosition = { selectedId: records[0]?.id };
  const actions = { records: () => records, appliedId: () => undefined, activate: vi.fn(() => true), run: vi.fn(), stop: vi.fn(), copy: vi.fn(),
    editOriginal: vi.fn(), chooseModel: vi.fn(), accept: vi.fn(), revise: vi.fn(), preferences: vi.fn(), preferencesKey: "alt+p" as const, launchModel: () => "Default model" };
  const panel = new TaskPanel(actions, theme, () => size.rows, getKeybindings(), usage, position);
  const text = (width = 100) => stripVTControlCharacters(panel.render(width).join("\n"));
  return { panel, theme, size, position, actions, records, text };
}
