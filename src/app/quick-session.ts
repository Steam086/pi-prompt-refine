import { isKeyRelease, matchesKey, parseKey, type KeyId } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { RefineController } from "../controller.js";
import { QuickReader } from "../quick-preview.js";
import type { TaskPanelPosition } from "../task-panel.js";
import type { RefineWorkspace } from "../workspace.js";
import type { TuiOperations } from "../adapters/tui-operations.js";
import type { createRequestFlows } from "./request-flows.js";

export interface QuickSelection { id: number; remembered: Map<number, number> }
interface QuickMount {
  selection: QuickSelection;
  controller: RefineController;
  ctx: ExtensionContext;
  theme: Theme;
  rows(): number;
  position: TaskPanelPosition;
  workspace: RefineWorkspace;
  run(id: number): void;
  operations: TuiOperations;
  check: ReturnType<typeof createRequestFlows>["checkOptimization"];
  model(id: number): void;
  shortcut: KeyId | null;
  close(): void;
}

export function mountQuick({ selection, controller, ctx, theme, rows, position, workspace, run, operations,
  check, model, shortcut, close }: QuickMount) {
  const session = controller.getSessionId();
  const round = controller.getRoundId();
  const reader = new QuickReader();
  let page: "reader" | "workspace" | "revision" | "preferences" = "reader";
  let id = selection.id;
  let confirm: { id: number; action: "accept" | "new"; text: string; version: number } | undefined;
  let renderedVersion: number | undefined;
  const current = () => ctx.sessionManager.getSessionId() === session && controller.getSessionId() === session &&
    round !== undefined && controller.getRoundId() === round;
  const records = () => controller.getTaskDisplayRecords().filter(r => r.input.roundId === round && r.archivedAt === undefined);
  const record = () => current() ? records().find(r => r.id === id) : undefined;
  const select = (next: number) => {
    id = next;
    const target = record();
    Object.assign(position, { selectedId: id, selectedTaskId: target?.status === "unsent" ? target.taskId : undefined, scroll: 0 });
    if (target) selection.remembered.set(target.taskId, id);
    renderedVersion = undefined;
  };
  select(id);
  const guardedWrite = (action: "accept" | "new", confirmed = false) => {
    const target = record();
    if (!target) return;
    const text = ctx.ui.getEditorText();
    const safe = !text.length || text === target.input.draft || records().some(r => r.taskId === target.taskId &&
      r.acceptedAt !== undefined && r.candidate?.text === text);
    if (!safe && !confirmed) {
      confirm = { id, action, text, version: controller.getRunVersion(id) };
      reader.question = action === "new" ? "Start a new draft? The editor contains unsaved text."
        : "Replace editor? The editor has changed since this prompt was captured.";
      return;
    }
    if (action === "new") {
      if (!safe && operations.create(text).kind !== "captured") {
        ctx.ui.notify("Could not protect the current draft. Editor unchanged.", "warning"); return;
      }
      if (text) ctx.ui.setEditorText("");
    } else {
      if (!controller.applyResult(id)) return;
      const token = controller.getCandidateToken();
      if (!token || !controller.acceptCandidate(token, text, true, value => ctx.ui.setEditorText(value))) return;
    }
    close();
  };
  return {
    get reading() { return page === "reader"; },
    get viewedId() { return page === "workspace" ? undefined : id; },
    valid: () => !!record(),
    back() { page = "reader"; select(id); },
    followRun(next: number) {
      const target = record();
      if (page === "workspace" || !target || !records().some(r => r.id === next && r.taskId === target.taskId)) return;
      select(next);
      reader.expanded = false;
    },
    render(width: number) {
      const target = record();
      if (!target) return [];
      renderedVersion = controller.getRunVersion(id);
      const current = records();
      const group = current.filter(r => r.taskId === target.taskId && (!reader.expanded || r.candidate));
      const tasks = [...new Set(current.map(r => r.taskId))];
      const index = group.length > 1 ? ` · ${group.findIndex(r => r.id === id) + 1}/${group.length}`
        : tasks.length > 1 ? ` · ${tasks.indexOf(target.taskId) + 1}/${tasks.length}` : "";
      const text = ctx.ui.getEditorText();
      return reader.render(width, rows(), target, index, group.length > 1,
        !!text && text !== target.input.draft && !current.some(r => r.taskId === target.taskId && r.acceptedAt && r.candidate?.text === text),
        (target.status === "generating" ? controller.getRunElapsed(id) : target.elapsedSeconds) ?? 0, theme);
    },
    input(data: string): boolean {
      const target = record();
      if (!target) { close(); return true; }
      const key = parseKey(data);
      if (shortcut && matchesKey(data, shortcut) && page !== "workspace" && !workspace.choosingPreferences()) { close(); return true; }
      if (page === "workspace") return false;
      if (isKeyRelease(data)) return true;
      if (page !== "reader") {
        workspace.handleInput(data);
        if (!workspace.inQuickChild()) page = "reader";
        return true;
      }
      if (confirm) {
        const pending = confirm;
        confirm = undefined;
        reader.question = undefined;
        if (key === "y" && pending.id === id && ctx.ui.getEditorText() === pending.text && controller.getRunVersion(id) === pending.version)
          guardedWrite(pending.action, true);
        return true;
      }
      if (key === "?") reader.help = !reader.help;
      else if (key === "escape" || key === "q") {
        if (reader.help) reader.help = false;
        else if (reader.expanded) reader.expanded = false;
        else close();
      } else if (key && ["up","down","pageUp","pageDown","home","end"].includes(key)) reader.scroll(key);
      else if (reader.help) return true;
      else if (key === "left" || key === "right") {
        const group = records().filter(r => r.taskId === target.taskId && (!reader.expanded || r.candidate));
        select(group[(group.indexOf(target) + (key === "right" ? 1 : -1) + group.length) % group.length]!.id);
      } else if (key === "w") { select(id); workspace.openTasks(); page = "workspace"; }
      else if (key === "v" && target.candidate) reader.expanded = !reader.expanded;
      else if (key === "a" && target.candidate && renderedVersion === controller.getRunVersion(id)) guardedWrite("accept");
      else if (key === "f" && target.candidate) { workspace.openRevision(id, target.candidate.text); if (workspace.inQuickChild()) page = "revision"; }
      else if (reader.expanded) return true;
      else if (key === "n") guardedWrite("new");
      else if (key === "enter" && target.status === "unsent") run(id);
      else if (key === "x" && ["queued","generating"].includes(target.status)) operations.stop(id);
      else if (key === "p" && (target.candidate || target.status === "unsent")) {
        workspace.openDraftPreferences(id, target.status === "unsent"); page = "preferences";
      } else if (key === "m" && !["queued","generating"].includes(target.status)) model(id);
      else if (key === "r" && ["cancelled","interrupted","error"].includes(target.status)) {
        const validation = check(ctx, target.input.draft, target.input.model);
        if ("error" in validation) ctx.ui.notify(validation.error, "warning");
        else {
          const result = controller.rerunRecord(id, target.input.model, target.input.thinkingLevel);
          if (result.kind === "started") select(result.recordId);
          else ctx.ui.notify(`Retry unavailable (${result.kind}). Existing work kept.`, "warning");
        }
      }
      return true;
    },
  };
}
