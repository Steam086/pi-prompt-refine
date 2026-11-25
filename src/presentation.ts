import type { ResultNote } from "./revision-preferences.js";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ControllerState } from "./request-types.js";

/** Keep prose readable on wide terminals; widths are terminal columns, not characters. */
export const READING_WIDTH = 100;
export type PresentationTheme = Pick<Theme, "fg" | "bold">;

export function sanitizeTerminalText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\t/g, "    ")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "�");
}

export interface SummaryOptions {
  state: ControllerState;
  candidateText?: string;
  contextLabel: string;
  openHint: string;
  elapsedSeconds: number;
  errorLabel?: string;
}

export function resultHeading(options: SummaryOptions, theme: PresentationTheme, includeBrand = true): string {
  const { state } = options;
  const time = `${options.elapsedSeconds}s`;
  const label = state.phase === "generating" ? `◌ Refining · ${time}`
    : state.phase === "error" ? `! Failed · ${time}`
      : state.phase === "idle" ? "Refine"
        : state.pendingSend ? `◌ Send pending · ${time}` : `✓ Done · ${time}`;
  const color = state.phase === "error" ? "warning" : state.phase === "ready" && !state.pendingSend ? "success" : "accent";
  const warning = state.budget && (state.budget.status !== "ok" || state.budget.message) ? theme.fg("warning", " ⚠") : "";
  const status = theme.fg(color, theme.bold(label)) + warning;
  return includeBrand ? `${status} · ${theme.fg("muted", "Prompt Refine")}` : status;
}

export function resultNoteHint(notes: readonly ResultNote[] | undefined, theme: PresentationTheme): string {
  if (!notes?.length) return "";
  return theme.fg("muted", ` · ${notes.length} ${notes.length === 1 ? "note" : "notes"} below`);
}

/** Literal, read-only run metadata, laid out in the result's existing scroll pane. */
export function resultNoteLines(notes: readonly ResultNote[] | undefined, theme: PresentationTheme): string[] {
  if (!notes?.length) return [];
  const lines = ["", theme.fg("text", theme.bold("Result notes")) + theme.fg("muted", " · preview only")];
  for (const note of notes) {
    lines.push("", theme.fg("text", theme.bold(sanitizeTerminalText(note.name).replace(/\n/g, " "))),
      note.text ? theme.fg("text", sanitizeTerminalText(note.text)) : theme.fg("warning", "Note unavailable for this run."));
  }
  return lines;
}
