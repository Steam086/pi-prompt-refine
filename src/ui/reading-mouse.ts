import { sliceByColumn, visibleWidth, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";

export interface ReadingRegion {
  key: string;
  x: number;
  y: number;
  width: number;
  lines: readonly string[];
  scroll(delta: number): void;
}

interface Cell { x: number; y: number }
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function range(line: string, left: number, right: number): [number, number] {
  if (/^[\x20-\x7e]*$/.test(line)) return [left, right];
  let column = 0;
  for (const { segment } of graphemes.segment(line)) {
    const end = column + visibleWidth(segment);
    if (left > column && left < end) left = column;
    if (right > column && right < end) right = end;
    if (end >= right) break;
    column = end;
  }
  return [left, right];
}

export class ReadingMouse {
  private regions: readonly ReadingRegion[] = [];
  private selection?: { region: ReadingRegion; anchor: Cell; focus: Cell; dragging: boolean };

  clear(): void { this.selection = undefined; }

  handle(event: TuiMouseEvent, copy: (text: string) => void): TuiMouseEventResult | undefined {
    if (event.type === "wheel" || (event.type === "press" && event.button === "left")) {
      const region = this.regions.find(({ x, y, width, lines }) =>
        event.x >= x && event.x < x + width && event.y >= y && event.y < y + lines.length);
      if (!region) return;
      if (event.type === "wheel") {
        if (!event.wheelDelta) return;
        this.clear();
        region.scroll(event.wheelDelta);
        return { handled: true, render: true };
      }
      const anchor = { x: event.x - region.x, y: event.y - region.y };
      this.selection = { region, anchor, focus: anchor, dragging: true };
      return { handled: true, capture: true, render: true };
    }
    const selected = this.selection;
    if (!selected?.dragging || !["drag", "move", "release"].includes(event.type)) return;
    selected.focus = {
      x: Math.min(selected.region.width - 1, Math.max(0, event.x - selected.region.x)),
      y: Math.min(selected.region.lines.length - 1, Math.max(0, event.y - selected.region.y)),
    };
    if (event.type === "release") {
      selected.dragging = false;
      const text = this.ranges().map(({ line, start, end }) => sliceByColumn(line, start, end - start).trimEnd()).join("\n").trimEnd();
      if (text) copy(text);
      else this.clear();
    }
    return { handled: true, render: true };
  }

  render(frame: string[], regions: readonly ReadingRegion[], theme: Theme): string[] {
    this.regions = regions;
    const selected = this.selection;
    if (!selected) return frame;
    const old = selected.region;
    const next = regions.find(({ key }) => key === old.key);
    if (!next || next.x !== old.x || next.y !== old.y || next.width !== old.width ||
      next.lines.length !== old.lines.length || next.lines.some((line, index) => line !== old.lines[index])) {
      this.clear();
      return frame;
    }
    selected.region = next;
    for (const { row, start, end } of this.ranges()) {
      const index = next.y + row;
      const line = frame[index] ?? "";
      const before = sliceByColumn(line, 0, next.x + start, true);
      const highlight = sliceByColumn(stripVTControlCharacters(line), next.x + start, end - start, true);
      const after = sliceByColumn(line, next.x + end, Math.max(0, visibleWidth(line) - next.x - end), true);
      frame[index] = before + "\x1b[0m" + theme.bg("selectedBg", theme.fg("text", highlight)) + after;
    }
    return frame;
  }

  private ranges(): { row: number; start: number; end: number; line: string }[] {
    const { region, anchor, focus } = this.selection!;
    if (anchor.x === focus.x && anchor.y === focus.y) return [];
    const forwards = anchor.y < focus.y || (anchor.y === focus.y && anchor.x < focus.x);
    const [first, last] = forwards ? [anchor, focus] : [focus, anchor];
    return region.lines.slice(first.y, last.y + 1).map((text, index) => {
      const row = first.y + index;
      const line = stripVTControlCharacters(text);
      const [start, end] = range(line, row === first.y ? first.x : 0, row === last.y ? last.x + 1 : region.width);
      return { row, start, end, line };
    });
  }
}
