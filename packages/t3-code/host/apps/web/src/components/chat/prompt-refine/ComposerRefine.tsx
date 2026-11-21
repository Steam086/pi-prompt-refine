import { useEffect, useRef, useState } from "react";
import { SparklesIcon } from "lucide-react";
import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  type ProjectId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type { AdoptedRun, DesktopCall, DesktopReply } from "@t3tools/prompt-refine/protocol";
import { Button } from "~/components/ui/button";
import { isCommandPaletteOpen } from "~/commandPaletteBus";
import { registerCommands } from "~/shortcuts/dispatcher";
import { useEnvironmentScope } from "~/state/session";
import { useStableCallback } from "~/hooks/useStableCallback";
import { refineError, requestRefine } from "./client";
import { RefineDialog } from "./RefineDialog";

interface DraftSnapshot {
  text: string;
  version: object | null;
}
type Open = {
  draft?: DraftSnapshot;
  response?: Extract<DesktopReply, { kind: "open" }>;
  error?: string;
};

export function ComposerRefine({
  scope,
  projectId,
  ownsEditor,
  readDraft,
  adopt,
  restoreFocus,
}: {
  scope: ScopedThreadRef;
  projectId: ProjectId | undefined;
  ownsEditor: (target: EventTarget | null) => boolean;
  readDraft: () => DraftSnapshot | undefined;
  adopt: (draft: DraftSnapshot, text: string) => boolean;
  restoreFocus: () => void;
}) {
  const canOperate = useEnvironmentScope(scope.environmentId, AuthOrchestrationOperateScope);
  const canSave = useEnvironmentScope(scope.environmentId, AuthSettingsWriteScope);
  const [open, setOpen] = useState<Open>();
  const active = useRef<Open | undefined>(undefined);
  const adopted = useRef<{ text: string; run: AdoptedRun } | undefined>(undefined);
  useEffect(
    () => () => {
      active.current = undefined;
    },
    [],
  );
  const query = useStableCallback((call: DesktopCall) => requestRefine(scope, projectId, call));
  const close = useStableCallback(() => {
    active.current = undefined;
    setOpen(undefined);
    restoreFocus();
  });

  const show = useStableCallback((event?: KeyboardEvent) => {
    if (
      !canOperate ||
      isCommandPaletteOpen() ||
      (event && (event.isComposing || event.keyCode === 229))
    )
      return false;
    event?.preventDefault();
    event?.stopPropagation();
    if (active.current || event?.repeat) return true;
    const draft = readDraft();
    const opening: Open = draft ? { draft } : {};
    active.current = opening;
    setOpen(opening);
    const known = adopted.current;
    const currentAdoption = known && known.text === draft?.text ? known.run : undefined;
    void query({
      method: "open",
      text: draft?.text ?? "",
      ...(currentAdoption ? { adopted: currentAdoption } : {}),
    })
      .then((reply) => {
        if (active.current !== opening) return;
        if (reply.kind === "open") {
          if (currentAdoption && reply.runId !== currentAdoption.runId) adopted.current = undefined;
          setOpen({
            ...opening,
            response: draft
              ? reply
              : {
                  ...reply,
                  warning: "Refine supports text drafts without attachments or inline context.",
                },
          });
        } else setOpen({ ...opening, error: refineError(reply) });
      })
      .catch(() => {
        if (active.current === opening)
          setOpen({ ...opening, error: "Could not open Refine on this environment." });
      });
    return true;
  });

  const canHandle = useStableCallback(ownsEditor);
  useEffect(() => {
    if (!canOperate) return;
    return registerCommands(
      { "composer.refine": show },
      {
        capture: true,
        context: () => ({ composerFocus: canHandle(document.activeElement) }),
        when: (event) => canHandle(event.target),
      },
    );
  }, [canOperate, canHandle, show]);

  if (!canOperate) return null;
  return (
    <>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        title="Refine draft"
        aria-label="Refine draft"
        onClick={() => show()}
      >
        <SparklesIcon />
      </Button>
      {open && (
        <RefineDialog
          initial={open.response}
          text={open.draft?.text ?? ""}
          error={open.error}
          query={query}
          canSave={canSave}
          canAdopt={open.draft !== undefined}
          adopt={(text, run) => {
            if (!active.current || !open.draft || !adopt(open.draft, text)) return false;
            adopted.current = { text, run };
            return true;
          }}
          close={close}
        />
      )}
    </>
  );
}
