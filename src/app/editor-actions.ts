import type { ExtensionContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RefineConfig } from "../config.js";
import type { RefineController } from "../controller.js";
import type { CandidateToken } from "../request-types.js";
import type { Notify, NotifyIfSameSession } from "./contracts.js";

interface EditorActionsDependencies {
  controller: Pick<RefineController,
    "acceptCandidate" | "beginSend" | "failSend" | "getCandidate" | "getRestore" | "getRestoreToken" |
    "isCandidateCurrent" | "isRestoreCurrent" | "restoreDraft" | "updateCandidate">;
  config: Pick<RefineConfig, "maxDraftChars" | "maxOutputTokens">;
  useContext(ctx: ExtensionContext): void;
  sendUserMessage: ExtensionAPI["sendUserMessage"];
  notify: Notify;
  notifyIfSameSession: NotifyIfSameSession;
}

export function createEditorActions({ controller, config, useContext, sendUserMessage,
  notify, notifyIfSameSession }: EditorActionsDependencies) {
  async function confirmCurrentDraft(ctx: ExtensionContext, currentDraft: string, purpose: string): Promise<boolean> {
    return ctx.ui.confirm(
      purpose,
      `Replace the main editor? Current draft:\n---\n${currentDraft}\n---\n\nCancelled if the draft or session changes during confirmation.`,
    );
  }

  function acceptCandidate(ctx: ExtensionContext, token: CandidateToken): void {
    useContext(ctx);
    if (!controller.isCandidateCurrent(token)) return;
    const candidate = controller.getCandidate();
    if (!candidate) return;
    const currentDraft = ctx.ui.getEditorText();
    let confirmedOverwrite = false;
    if (currentDraft !== candidate.draft) {
      void confirmCurrentDraft(ctx, currentDraft, "Draft changed").then((confirmed) => {
        if (!confirmed) return;
        if (!controller.isCandidateCurrent(token) || ctx.ui.getEditorText() !== currentDraft) {
          notifyIfSameSession(token.sessionId, "Draft, candidate or session changed. Editor unchanged.");
          return;
        }
        const applied = controller.acceptCandidate(token, currentDraft, true, (text) => ctx.ui.setEditorText(text));
        if (applied) {
          notify(ctx, "Accepted into editor, not sent. Shortcut views; r refines again.", "info");
        }
      }).catch(() => notifyIfSameSession(token.sessionId, "Confirmation incomplete. Editor unchanged."));
      return;
    }
    confirmedOverwrite = true;
    if (!controller.isCandidateCurrent(token) || ctx.ui.getEditorText() !== currentDraft) return;
    const applied = controller.acceptCandidate(token, currentDraft, confirmedOverwrite, (text) => ctx.ui.setEditorText(text));
    if (applied) {
      notify(ctx, "Accepted into editor, not sent. Shortcut views; r refines again.", "info");
    }
  }

  async function editCandidate(ctx: ExtensionContext, token: CandidateToken): Promise<void> {
    if (!controller.isCandidateCurrent(token)) return;
    const candidate = controller.getCandidate();
    if (!candidate) return;
    const edited = await ctx.ui.editor("Edit candidate (cancel keeps original)", candidate.text);
    if (edited === undefined) return;
    if (!controller.isCandidateCurrent(token)) {
      notifyIfSameSession(token.sessionId, "Candidate or session changed. Edits not applied.");
      return;
    }
    if (edited.length > Math.max(config.maxDraftChars, config.maxOutputTokens * 32)) {
      notify(ctx, "Edit too long. Candidate unchanged.", "warning");
      return;
    }
    if (!controller.updateCandidate(token, edited)) {
      notify(ctx, "Empty edit or stale candidate. Candidate unchanged.", "warning");
      return;
    }
    notify(ctx, "Candidate updated. Editor unchanged.", "info");
  }

  async function restoreDraft(ctx: ExtensionContext): Promise<void> {
    useContext(ctx);
    if (ctx.mode !== "tui") {
      notify(ctx, "Restore requires TUI mode.", "warning");
      return;
    }
    const token = controller.getRestoreToken();
    const snapshot = controller.getRestore();
    if (!token || !snapshot) {
      notify(ctx, "Nothing to restore.", "info");
      return;
    }
    const currentDraft = ctx.ui.getEditorText();
    let confirmedOverwrite = false;
    if (currentDraft !== snapshot.applied) {
      const confirmed = await confirmCurrentDraft(ctx, currentDraft, "Editor changed since acceptance");
      if (!confirmed) return;
      if (!controller.isRestoreCurrent(token) || ctx.ui.getEditorText() !== currentDraft) {
        notifyIfSameSession(token.sessionId, "Draft or session changed. Restore cancelled.");
        return;
      }
      confirmedOverwrite = true;
    }
    if (!controller.isRestoreCurrent(token) || ctx.ui.getEditorText() !== currentDraft) return;
    if (controller.restoreDraft(token, currentDraft, confirmedOverwrite, (text) => ctx.ui.setEditorText(text))) {
      notify(ctx, "Draft restored, not sent.", "info");
    }
  }

  function sendCandidate(ctx: ExtensionContext, token: CandidateToken): void {
    useContext(ctx);
    if (ctx.mode !== "tui" || !controller.isCandidateCurrent(token)) return;
    const candidate = controller.getCandidate();
    if (!candidate) return;
    const send = controller.beginSend(token);
    if (!send) {
      notify(ctx, "Send already pending. Not resubmitted.", "warning");
      return;
    }
    try {
      const busy = !ctx.isIdle();
      if (busy) sendUserMessage(send.text, { deliverAs: "followUp" });
      else sendUserMessage(send.text);
      notify(ctx, busy
        ? "Queued as Pi follow-up. Editor draft kept."
        : "Sent to Pi. Editor draft kept.", "info");
    } catch {
      controller.failSend(send.requestId);
      notify(ctx, "Pi rejected the send. Candidate kept; retry.", "error");
    }
  }

  return { acceptCandidate, editCandidate, restoreDraft, sendCandidate };
}
