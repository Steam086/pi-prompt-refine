import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { request } from "@t3tools/client-runtime/rpc";
import { WS_METHODS, type ProjectId, type ScopedThreadRef } from "@t3tools/contracts";
import type { DesktopCall, DesktopReply } from "@t3tools/prompt-refine/protocol";
import * as Effect from "effect/Effect";
import { AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "~/connection/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";

export async function requestRefine(
  scope: ScopedThreadRef,
  draftProjectId: ProjectId | undefined,
  call: DesktopCall,
): Promise<DesktopReply> {
  const body = JSON.stringify(call);
  const response = await Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, connectionAtomRuntime).pipe(
      Effect.flatMap((context) =>
        EnvironmentRegistry.EnvironmentRegistry.pipe(
          Effect.flatMap((registry) =>
            registry.run(
              scope.environmentId,
              request(WS_METHODS.promptRefine, {
                threadId: scope.threadId,
                ...(draftProjectId === undefined ? {} : { draftProjectId }),
                call: body,
              }),
            ),
          ),
          Effect.provide(context),
        ),
      ),
    ),
  );
  return JSON.parse(response) as DesktopReply;
}

export function refineError(reply: DesktopReply): string {
  if (reply.kind === "unavailable") return reply.message;
  if (reply.kind === "conflict") return "The Refine state changed. Reopen the view and try again.";
  if (reply.kind === "rejected" || reply.kind === "error")
    return `Refine request failed (${reply.code}).`;
  return "Unexpected Refine response.";
}
