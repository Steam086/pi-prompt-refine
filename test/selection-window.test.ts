import { describe, expect, it } from "vitest";
import { selectionWindow } from "../src/selection-window.js";

describe("selection windows", () => {
  it("keeps the viewport still until a neighbour needs room, in both directions", () => {
    let top = 0;
    const tops: number[] = [];
    for (let selected = 0; selected < 10; selected++) {
      const window = selectionWindow(20, selected, 6, top);
      top = window.start; tops.push(top);
      if (selected > 0) expect(window.rows).toContain(selected - 1);
      expect(window.rows).toContain(selected + 1);
    }
    expect(tops).toEqual([0, 0, 0, 0, 0, 1, 2, 3, 4, 5]);
    expect(selectionWindow(20, 8, 6, top).start).toBe(5);
    expect(selectionWindow(20, 5, 6, top).start).toBe(4);
  });

  it("budgets group headings and gaps without leaving an orphan heading", () => {
    const group = (i: number) => i < 5 ? "Task" : "Rewrite";
    expect(selectionWindow(12, 4, 6, 0, group).rows).toEqual(["Task", 2, 3, 4, "Rewrite", 5]);
    expect(selectionWindow(12, 4, 4, 0, group).rows).toEqual(["Task", 4, "Rewrite", 5]);
    expect(selectionWindow(12, 4, 5, 0, group, 1).rows).toEqual(["Task", 4, "", "Rewrite", 5]);
    expect(selectionWindow(12, 4, 1, 0, group).rows).toEqual([4]);
    expect(selectionWindow(12, 5, 4, 5, group, 0, -1).rows).toEqual(["Task", 4, "Rewrite", 5]);
    expect(selectionWindow(12, 5, 4, 4, group, 0, -1).rows).toEqual(["Task", 4, "Rewrite", 5]);
    expect(selectionWindow(12, 5, 2, 5, undefined, 0, -1).rows).toEqual([4, 5]);
    expect(selectionWindow(12, 5, 2, 4).rows).toEqual([5, 6]);
    expect(selectionWindow(0, 0, 5)).toEqual({ start: 0, end: 0, rows: [] });
    expect(selectionWindow(12, 4, 0, 0, group).rows).toEqual([]);
  });

  it("keeps selection visible and renders idempotently through jumps, resize and list shrink", () => {
    for (const group of [undefined, (i: number) => `Group ${Math.floor(i / 3)}`]) {
      for (const direction of [-1, 1]) for (const count of [1, 2, 24]) for (const height of [1, 2, 3, 4, 6, 10, 30]) {
        for (let selected = 0; selected < count; selected++) for (const oldTop of [0, 5, 100]) {
          const window = selectionWindow(count, selected, height, oldTop, group, 1, direction);
          expect(window.rows).toContain(selected);
          expect(window.rows.length).toBeLessThanOrEqual(height);
          expect(window.start).toBeGreaterThanOrEqual(0);
          expect(window.end).toBeLessThanOrEqual(count);
          expect(typeof window.rows.at(-1)).toBe("number");
          expect(selectionWindow(count, selected, height, window.start, group, 1, direction)).toEqual(window);
          // Two headings and a gap suffice for a neighbour in the movement direction.
          if (height >= (direction > 0 ? 5 : 9) && selected + 1 < count) expect(window.rows).toContain(selected + 1);
          if (height >= (direction < 0 ? 5 : 9) && selected > 0) expect(window.rows).toContain(selected - 1);
        }
      }
    }
  });
});
