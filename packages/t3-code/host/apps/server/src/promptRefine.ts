import { createDesktopService, desktopThreadId, parseDesktopCall } from "@t3tools/prompt-refine";
import { type ProjectId, type ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ProjectStoreV2 } from "./orchestration-v2/ProjectStore.ts";
import type { ProjectionStoreV2 } from "./orchestration-v2/ProjectionStore.ts";
import type { ThreadManagementService } from "./orchestration-v2/ThreadManagementService.ts";

type Input = {
  readonly threadId: ThreadId;
  readonly draftProjectId?: ProjectId | undefined;
  readonly call: string;
};
const services = new Map<string, ReturnType<typeof createDesktopService>>();
const unavailable = (message: string) => JSON.stringify({ kind: "unavailable", message });
class RefineRuntimeUnavailable extends Schema.TaggedError<RefineRuntimeUnavailable>()(
  "RefineRuntimeUnavailable",
  {},
) {}

export const makePromptRefineHandler =
  (
    stateDir: string,
    threads: Pick<ThreadManagementService["Service"], "getThreadShell" | "getThreadSnapshotWindow">,
    projects: Pick<ProjectStoreV2["Service"], "getShell">,
    projection: Pick<ProjectionStoreV2["Service"], "getRefineRoundAnchor">,
    canSave: boolean,
  ) =>
  (input: Input) =>
    Effect.gen(function* () {
      const call = parseDesktopCall(input.call);
      if (!call) return '{"kind":"rejected","code":"invalid-input"}';
      if (!canSave && (call.method === "saveSettings" || call.method === "saveOptimizer")) {
        return unavailable("This connection cannot change environment settings.");
      }

      const thread = yield* threads.getThreadShell(input.threadId);
      const projectId = thread?.projectId ?? input.draftProjectId;
      if (!projectId || thread?.archivedAt)
        return unavailable("Open an active project thread to use Refine.");
      const project = Option.getOrUndefined(yield* projects.getShell(projectId));
      if (!project) return unavailable("This thread has no available workspace.");

      let service = services.get(stateDir);
      if (!service) {
        service = createDesktopService(stateDir);
        services.set(stateDir, service);
        void service.catch(() => {
          if (services.get(stateDir) === service) services.delete(stateDir);
        });
      }
      const anchor = thread ? yield* projection.getRefineRoundAnchor(input.threadId) : "";
      const run = Effect.runPromiseWith(yield* Effect.context<never>());
      const loadHistory = () =>
        !thread
          ? Promise.resolve([])
          : run(
              threads
                .getThreadSnapshotWindow(input.threadId, { rowLimit: 50, deferWork: true })
                .pipe(
                  Effect.map(({ projection: snapshot }) => {
                    const started = new Set(
                      snapshot.runs
                        .filter((entry) => entry.startedAt && entry.status !== "rolled_back")
                        .map((entry) => entry.id),
                    );
                    return snapshot.messages
                      .filter(
                        (message) =>
                          !message.notification &&
                          !message.delegatedCompletion &&
                          !message.workflowScript &&
                          !message.idleCompaction &&
                          (message.runId === null || started.has(message.runId)),
                      )
                      .flatMap(({ role, text }) =>
                        role === "user" || role === "assistant" ? [{ role, text }] : [],
                      );
                  }),
                ),
            );
      return yield* Effect.tryPromise({
        try: () =>
          service!.then((ready) =>
            ready.request(
              {
                sessionId: desktopThreadId(projectId, input.threadId),
                anchor,
                cwd: thread?.worktreePath ?? project.workspaceRoot,
                loadHistory,
                isCurrent: () =>
                  run(
                    Effect.gen(function* () {
                      const current = yield* threads.getThreadShell(input.threadId);
                      if (!thread) return current === null;
                      return (
                        current !== null &&
                        !current.archivedAt &&
                        current.projectId === projectId &&
                        current.worktreePath === thread.worktreePath &&
                        (yield* projection.getRefineRoundAnchor(input.threadId)) === anchor
                      );
                    }),
                  ),
              },
              call,
            ),
          ),
        catch: () => new RefineRuntimeUnavailable(),
      });
    }).pipe(Effect.orElseSucceed(() => unavailable("Could not reach the Refine runtime.")));
