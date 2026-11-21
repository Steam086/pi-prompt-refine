import "~/index.css";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type {
  DesktopCall,
  DesktopReply,
  DesktopSettings,
  RunDetail,
  Snapshot,
} from "@t3tools/prompt-refine/protocol";
import { render } from "../../../../test/render";
import { RefineDialog } from "./RefineDialog";

const binding = { sessionId: "project:thread", runtimeId: "runtime", lifecycleEpoch: 1 };
const optimizer = { thinking: "inherit", persistence: "persisted", version: 1 } as const;
const storage = {
  state: "no-session-file",
  savedCount: 0,
  omittedCount: 0,
  memoryOnlyCount: 0,
} as const;
const task = {
  id: "task-1",
  version: 1,
  displayNumber: 1,
  archived: false,
  excerpt: "原稿",
  runIds: [],
  backgroundAvailable: true,
  actions: {
    edit: { enabled: true },
    start: { enabled: true },
    copy: { enabled: false },
    discard: { enabled: true },
  },
};
const snapshot: Snapshot = {
  binding,
  revision: 1,
  tasks: [task],
  runs: [],
  optimizer,
  maxDraftChars: 16_000,
  capabilities: { drafts: true, runs: true, editor: false, send: false },
  storage,
};
const open = { kind: "open", snapshot, taskId: task.id } as const;
const settings: DesktopSettings = {
  version: "settings-1",
  optimizer,
  models: [],
  writable: true,
  fields: {
    maxMessages: 12,
    historyMaxChars: 16_000,
    projectContext: true,
    instructions: "off",
    directoryTree: false,
    directoryReferences: true,
    skillMetadata: false,
    maxOutputTokens: 8192,
    timeoutMs: 60_000,
    maxDraftChars: 16_000,
    systemPrompt: "",
  },
};

it("opens an Unsent draft and starts only when the user presses Enter", async () => {
  const query = vi.fn(async (call: DesktopCall): Promise<DesktopReply> => {
    if (call.method === "snapshot") return { kind: "snapshot", value: snapshot };
    if (call.method === "task")
      return { kind: "task", value: { ...task, text: "原稿 😀", selectedNames: [] } };
    return { kind: "receipt", value: { outcome: "started", runId: "run-1", taskId: task.id } };
  });
  await using _screen = await render(
    <RefineDialog
      initial={open}
      text="原稿 😀"
      query={query}
      adopt={() => false}
      canAdopt
      canSave
      close={() => {}}
    />,
    { router: false },
  );
  await expect.element(page.getByText("原稿 😀")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Optimize" })).toHaveFocus();
  expect(query.mock.calls.some(([call]) => call.method === "mutate")).toBe(false);
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() =>
    expect(query).toHaveBeenCalledWith({
      method: "mutate",
      binding,
      mutation: { method: "startRun", taskId: task.id, expectedVersion: 1 },
    }),
  );
});

it("stages context fields and saves with Ctrl+S without issuing a run", async () => {
  const query = vi.fn(async (call: DesktopCall): Promise<DesktopReply> => {
    if (call.method === "snapshot") return { kind: "snapshot", value: snapshot };
    if (call.method === "task")
      return { kind: "task", value: { ...task, text: "original", selectedNames: [] } };
    if (call.method === "saveSettings")
      return {
        kind: "settings",
        saved: true,
        value: {
          ...settings,
          version: "settings-2",
          fields: { ...settings.fields, ...call.fields },
        },
      };
    return { kind: "settings", value: settings };
  });
  await using _screen = await render(
    <RefineDialog
      initial={open}
      text="original"
      query={query}
      adopt={() => false}
      canAdopt
      canSave
      close={() => {}}
    />,
    { router: false },
  );
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Context", exact: true }).click();
  await page.getByRole("spinbutton", { name: "History messages" }).fill("6");
  expect(query.mock.calls.some(([call]) => call.method === "saveSettings")).toBe(false);
  await userEvent.keyboard("{Control>}s{/Control}");
  await expect.element(page.getByText("Saved", { exact: true })).toBeVisible();
  expect(query).toHaveBeenCalledWith({
    method: "saveSettings",
    binding,
    version: "settings-1",
    fields: { maxMessages: 6 },
  });
  expect(query.mock.calls.some(([call]) => call.method === "mutate")).toBe(false);
});

it("keeps a candidate visible when the composer changed before adoption", async () => {
  const run: RunDetail = {
    id: "run-1",
    taskId: task.id,
    version: 2,
    displayNumber: 1,
    kind: "refine",
    status: "generated",
    model: { provider: "test", id: "rewriter" },
    createdAt: 0,
    archived: false,
    hasOutput: true,
    actions: { stop: { enabled: false } },
    original: "original",
    text: "改写结果",
    backgroundAvailable: true,
  };
  const completed = { ...snapshot, tasks: [{ ...task, runIds: [run.id] }], runs: [run] };
  const query = vi.fn(async (call: DesktopCall): Promise<DesktopReply> =>
    call.method === "run" ? { kind: "run", value: run } : { kind: "snapshot", value: completed },
  );
  const adopt = vi.fn(() => false);
  const close = vi.fn();
  await using _screen = await render(
    <RefineDialog
      initial={{ ...open, snapshot: completed, runId: run.id }}
      text="original"
      query={query}
      adopt={adopt}
      canAdopt
      canSave
      close={close}
    />,
    { router: false },
  );
  await page.getByRole("button", { name: "Apply to draft" }).click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent(
      "The composer draft or thread changed. Reopen Refine to apply to the current draft.",
    );
  expect(adopt).toHaveBeenCalledWith("改写结果", { binding, runId: run.id, version: run.version });
  expect(close).not.toHaveBeenCalled();
});

it("keeps long Unicode content scrollable in a short dark window", async () => {
  const text = "段落 😀\n".repeat(80);
  const query = vi.fn(async (call: DesktopCall): Promise<DesktopReply> =>
    call.method === "task"
      ? { kind: "task", value: { ...task, text, selectedNames: [] } }
      : { kind: "snapshot", value: snapshot },
  );
  await page.viewport(1280, 800);
  const root = document.documentElement;
  root.classList.add("dark");
  try {
    await using _screen = await render(
      <RefineDialog
        initial={open}
        text={text}
        query={query}
        adopt={() => false}
        canAdopt
        canSave
        close={() => {}}
      />,
      { router: false },
    );
    await expect.element(page.getByText("段落 😀", { exact: false })).toBeVisible();
    await page.viewport(420, 320);
    const dialog = page.getByRole("dialog").element();
    const scroller = dialog.querySelector<HTMLElement>(".overflow-auto");
    expect(scroller).not.toBeNull();
    expect(scroller!.scrollHeight).toBeGreaterThan(scroller!.clientHeight);
    await expect.element(page.getByRole("button", { name: "Optimize" })).toBeInViewport();
  } finally {
    root.classList.remove("dark");
    await page.viewport(1280, 800);
  }
});
