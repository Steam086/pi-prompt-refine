import { truncateToWidth, visibleWidth, type OverlayOptions } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { panelGeometry } from "./panel-layout.js";

const HEIGHT_PERCENT = 75;

export const REFINE_OVERLAY_OPTIONS = {
  anchor: "center", width: "96%", maxHeight: `${HEIGHT_PERCENT}%`, margin: 0,
} satisfies OverlayOptions;

export function workspaceHeight(rows: number): number {
  // Pi's maxHeight only clips; render exactly this many rows, including the border.
  // Match Pi's percentage rounding and minimum of one cell.
  return Math.max(1, Math.floor((rows * HEIGHT_PERCENT) / 100));
}

export function workspaceViewport(width: number, rows: number) {
  const height = workspaceHeight(rows);
  const framed = width >= 8 && height >= 6;
  return { height, framed, width: Math.max(1, width - (framed ? 2 : 0)),
    rows: Math.max(1, height - (framed ? 2 : 0)) };
}

/** Shared inner geometry for an outer overlay width and physical terminal rows. */
export function workspaceLayout(width: number, rows: number) {
  const viewport = workspaceViewport(width, rows);
  return panelGeometry(viewport.width, viewport.rows, 160, false, true,
    viewport.width >= 40 ? 2 : viewport.width >= 16 ? 1 : 0);
}

export function workspaceFrame(width: number, rows: number, content: string[], theme: Theme): string[] {
  const viewport = workspaceViewport(width, rows);
  const fit = (line: string) => {
    const fitted = truncateToWidth(line, viewport.width, "");
    return fitted + "\x1b[0m" + " ".repeat(Math.max(0, viewport.width - visibleWidth(fitted)));
  };
  const body = Array.from({ length: viewport.rows }, (_, index) => fit(content[index] ?? ""));
  if (!viewport.framed) return body;
  const border = (text: string) => theme.fg("borderMuted", text);
  const edge = border("│");
  return [border(`╭${"─".repeat(width - 2)}╮`), ...body.map((line) => edge + line + edge),
    border(`╰${"─".repeat(width - 2)}╯`)];
}
