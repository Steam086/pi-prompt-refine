import { useEffect, useRef, useState } from "react";
import type {
  AdoptedRun,
  DesktopCall,
  DesktopReply,
  DesktopSettings,
  RunDetail,
  Snapshot,
  TaskDetail,
} from "@t3tools/prompt-refine/protocol";
import { Button } from "~/components/ui/button";
import { Dialog, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { RefineSettings } from "./RefineSettings";
import { refineError } from "./client";

type OpenReply = Extract<DesktopReply, { kind: "open" }>;
type Page = "Preview" | "Usage" | "Settings";
type Target = { taskId: string; runId?: string };
type Query = (call: DesktopCall) => Promise<DesktopReply>;

function RefineBody({
  initial,
  text,
  query,
  adopt,
  close,
  canSave,
  canAdopt,
}: {
  initial: OpenReply;
  text: string;
  query: Query;
  adopt: (text: string, run: AdoptedRun) => boolean;
  close: () => void;
  canSave: boolean;
  canAdopt: boolean;
}) {
  const binding = initial.snapshot.binding;
  const [page, setPage] = useState<Page>(
    initial.taskId && !initial.snapshot.tasks.some((task) => task.id === initial.taskId)
      ? "Usage"
      : "Preview",
  );
  const [snapshot, setSnapshot] = useState<Snapshot>(initial.snapshot);
  const [target, setTarget] = useState<Target | undefined>(() => {
    const taskId = initial.taskId ?? initial.snapshot.tasks[0]?.id;
    return taskId ? { taskId, ...(initial.runId ? { runId: initial.runId } : {}) } : undefined;
  });
  const [detail, setDetail] = useState<RunDetail | TaskDetail>();
  const [settings, setSettings] = useState<DesktopSettings>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initial.warning ?? "");
  const [confirmAdopt, setConfirmAdopt] = useState(false);
  const optimizeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    optimizeButton.current?.focus();
  }, []);
  const all = page === "Usage";
  const task =
    snapshot.tasks.find((row) => row.id === target?.taskId) ??
    (target === undefined ? snapshot.tasks[0] : undefined);
  const run = snapshot.runs.find((row) => row.id === target?.runId);
  const runId = run?.id;
  const taskId = task?.id;
  const detailId = runId ?? taskId;
  const displayed = detail?.id === detailId ? detail : undefined;
  const result = displayed && "status" in displayed ? displayed : undefined;

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      try {
        const reply = await query({ method: "snapshot", binding, all });
        if (!active) return;
        if (reply.kind !== "snapshot") {
          setError(refineError(reply));
          return;
        }
        setSnapshot(reply.value);
        if (
          reply.value.runs.some((row) => row.status === "generating" || row.status === "queued")
        ) {
          timer = setTimeout(() => void refresh(), 750);
        }
      } catch {
        if (active) setError("The Refine connection was lost.");
      }
    }
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, binding, all, busy]);

  useEffect(() => {
    if (!detailId || page === "Settings") return;
    let active = true;
    void query({ method: runId ? "run" : "task", binding, id: detailId })
      .then((reply) => {
        if (!active) return;
        if (reply.kind === "run" || reply.kind === "task") setDetail(reply.value);
        else setError(refineError(reply));
      })
      .catch(() => {
        if (active) setError("The Refine connection was lost.");
      });
    return () => {
      active = false;
    };
  }, [query, binding, detailId, runId, run?.version, task?.version, page]);

  useEffect(() => {
    if (page !== "Settings") return;
    let active = true;
    void query({ method: "settings", binding })
      .then((reply) => {
        if (!active) return;
        if (reply.kind === "settings") setSettings(reply.value);
        else setError(refineError(reply));
      })
      .catch(() => {
        if (active) setError("Could not load Refine settings.");
      });
    return () => {
      active = false;
    };
  }, [query, binding, page]);

  async function perform(call: DesktopCall): Promise<DesktopReply | undefined> {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      return await query(call);
    } catch {
      setError("The Refine connection was lost. Reopen to check the current state.");
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    if (!task?.actions.start.enabled || target?.runId) return;
    const reply = await perform({
      method: "mutate",
      binding,
      mutation: { method: "startRun", taskId: task.id, expectedVersion: task.version },
    });
    if (!reply) return;
    if (reply.kind !== "receipt") {
      setError(refineError(reply));
      return;
    }
    if ("runId" in reply.value && reply.value.runId)
      setTarget({ taskId: task.id, runId: reply.value.runId });
  }

  async function stop() {
    if (!run) return;
    const reply = await perform({
      method: "mutate",
      binding,
      mutation: { method: "stopRun", runId: run.id },
    });
    if (reply && reply.kind !== "receipt") setError(refineError(reply));
  }

  async function apply() {
    if (!result?.text) return;
    if (text !== result.original && text && !confirmAdopt) {
      setConfirmAdopt(true);
      return;
    }
    const reply = await perform({ method: "run", binding, id: result.id });
    if (!reply) return;
    if (
      reply.kind !== "run" ||
      reply.value.version !== result.version ||
      reply.value.text !== result.text ||
      reply.value.status !== "generated" ||
      reply.value.archived !== result.archived
    ) {
      setError("The candidate changed. Review the current result before applying it.");
      return;
    }
    if (!adopt(result.text, { binding, runId: result.id, version: result.version })) {
      setError(
        "The composer draft or thread changed. Reopen Refine to apply to the current draft.",
      );
      return;
    }
    close();
  }

  return (
    <>
      <div className="flex flex-wrap gap-1">
        {(["Preview", "Usage", "Settings"] as const).map((name) => (
          <Button
            key={name}
            type="button"
            size="sm"
            variant={page === name ? "secondary" : "ghost"}
            aria-pressed={page === name}
            onClick={() => {
              setPage(name);
              setError("");
              setConfirmAdopt(false);
            }}
          >
            {name}
          </Button>
        ))}
      </div>
      <div className="-my-1">
        {error && (
          <p role="alert" className="break-words text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
      <div className="min-h-0 overflow-auto py-1">
        {page === "Settings" ? (
          settings ? (
            <RefineSettings
              value={settings}
              disabled={busy || !canSave}
              save={async (call) => {
                const reply = await perform({ ...call, binding });
                if (!reply) return false;
                if (reply.kind !== "settings") {
                  setError(refineError(reply));
                  return false;
                }
                setSettings(reply.value);
                if (!reply.saved)
                  setError("Changes are active in this process. Saving to disk failed.");
                return reply.saved === true;
              }}
            />
          ) : (
            <p role="status">Loading settings…</p>
          )
        ) : (
          <>
            {snapshot.tasks.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No drafts in {all ? "this thread" : "the current round"}.
              </p>
            )}
            <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(8rem,1fr)_minmax(0,2fr)]">
              <div className="min-w-0 space-y-1">
                {snapshot.tasks.map((row) => (
                  <Button
                    key={row.id}
                    type="button"
                    size="sm"
                    variant={task?.id === row.id ? "secondary" : "ghost"}
                    className="w-full min-w-0 justify-start"
                    onClick={() => {
                      setTarget({ taskId: row.id });
                      setError("");
                      setConfirmAdopt(false);
                    }}
                  >
                    <span className="truncate">
                      {row.displayNumber}. {row.excerpt || "Draft"}
                    </span>
                  </Button>
                ))}
              </div>
              <div className="min-w-0 space-y-2">
                {task && (
                  <div className="flex flex-wrap gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant={!run ? "secondary" : "ghost"}
                      onClick={() => {
                        setTarget({ taskId: task.id });
                        setConfirmAdopt(false);
                      }}
                    >
                      {task.runIds.length ? "Original" : "Unsent"}
                    </Button>
                    {task.runIds.map((id) => {
                      const item = snapshot.runs.find((row) => row.id === id);
                      return (
                        item && (
                          <Button
                            key={id}
                            type="button"
                            size="sm"
                            variant={run?.id === id ? "secondary" : "ghost"}
                            onClick={() => {
                              setTarget({ taskId: task.id, runId: id });
                              setError("");
                              setConfirmAdopt(false);
                            }}
                          >
                            #{item.displayNumber} · {item.status}
                          </Button>
                        )
                      );
                    })}
                  </div>
                )}
                {run && (
                  <p className="break-words text-sm text-muted-foreground">
                    {run.model.provider}/{run.model.id} · {run.status}
                    {run.elapsedSeconds !== undefined && ` · ${run.elapsedSeconds}s`}
                    {run.usage?.totalTokens !== undefined && ` · ${run.usage.totalTokens} tokens`}
                    {run.usage?.cost?.total !== undefined &&
                      ` · $${run.usage.cost.total.toFixed(4)}`}
                  </p>
                )}
                {run?.diagnostic && (
                  <p role="alert" className="break-words text-sm text-destructive">
                    {run.diagnostic}
                  </p>
                )}
                {displayed && (
                  <pre className="font-mono text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
                    {result ? (result.text ?? result.original) : displayed.text}
                  </pre>
                )}
                {result?.text && (
                  <details className="text-sm">
                    <summary>Original draft</summary>
                    <pre className="mt-2 whitespace-pre-wrap [overflow-wrap:anywhere]">
                      {result.original}
                    </pre>
                  </details>
                )}
              </div>
            </div>
          </>
        )}
      </div>
      <div
        className="flex flex-wrap items-center gap-2"
        onKeyDown={(event) => {
          if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault();
        }}
      >
        {page !== "Settings" && !target?.runId && task?.actions.start.enabled && (
          <Button ref={optimizeButton} type="button" disabled={busy} onClick={() => void start()}>
            Optimize
          </Button>
        )}
        {page !== "Settings" && run?.actions.stop.enabled && (
          <Button type="button" variant="secondary" disabled={busy} onClick={() => void stop()}>
            Stop
          </Button>
        )}
        {page !== "Settings" && canAdopt && result?.text && result.status === "generated" && (
          <Button type="button" disabled={busy} onClick={() => void apply()}>
            {confirmAdopt ? "Confirm replacement" : "Apply to draft"}
          </Button>
        )}
        {confirmAdopt && (
          <span className="text-sm">Replace the current composer draft with this candidate?</span>
        )}
        <Button
          type="button"
          variant="ghost"
          className="ms-auto"
          onClick={() => (page === "Settings" ? setPage("Preview") : close())}
        >
          {page === "Settings" ? "Back" : "Close"}
        </Button>
      </div>
    </>
  );
}

export function RefineDialog({
  initial,
  text,
  error,
  query,
  adopt,
  close,
  canSave,
  canAdopt,
}: {
  initial?: OpenReply | undefined;
  text: string;
  error?: string | undefined;
  query: Query;
  adopt: (text: string, run: AdoptedRun) => boolean;
  close: () => void;
  canSave: boolean;
  canAdopt: boolean;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup
        data-prompt-refine-dialog=""
        className="grid h-[min(42rem,calc(100dvh-3rem))] w-[min(54rem,calc(100vw-2rem))] max-w-none grid-rows-[auto_auto_auto_minmax(0,1fr)_auto] gap-3 p-4 sm:p-5"
      >
        <DialogTitle>Refine</DialogTitle>
        {initial ? (
          <RefineBody
            initial={initial}
            text={text}
            query={query}
            adopt={adopt}
            close={close}
            canSave={canSave}
            canAdopt={canAdopt}
          />
        ) : error ? (
          <p role="alert">{error}</p>
        ) : (
          <p role="status">Opening Refine…</p>
        )}
      </DialogPopup>
    </Dialog>
  );
}
