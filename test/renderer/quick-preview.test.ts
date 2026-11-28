import { describe, expect, it } from "vitest";
import { stripVTControlCharacters as strip } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { QuickReader, quickTarget } from "../../src/quick-preview.js";
import { getThemeByName } from "../support/pi-theme.js";
import { record } from "../support/task-panel.js";

const sizes = [[80,24], [120,40], [160,50], [48,18], [240,60], [40,12]] as const;
const document = Array.from({length: 40}, (_, i) => `第${i}段 🧑‍💻 é\t\x1b[2J ` + "https://example.test/long-path/".repeat(4)).join("\n");

describe.each(["light", "dark"])("%s quick reader", name => {
  it.each(sizes)("bounds and locks Ready at %i×%i and preserves independent reading positions", (cols, rows) => {
    const reader = new QuickReader();
    const a = record(1), b = record(2);
    a.candidate!.text = "Short.";
    b.candidate!.text = document + "\nEND";
    b.candidate!.additional = [{name:"Explanation", text: "Only in expanded notes."}];
    const render = (r = b) => {
      const lines = reader.render(cols, rows, r, "", true, false, 2, getThemeByName(name)!);
      expect(lines.every(line => visibleWidth(line) <= cols)).toBe(true);
      expect(lines.join("")).not.toContain("\x1b[2J");
      return lines.map(strip);
    };
    const height = render(a).length;
    expect(height).toBeLessThanOrEqual(Math.min(12, Math.floor(rows * .3)));
    expect(render()).toHaveLength(height);
    reader.scroll("pageDown"); const page = render().join("\n");
    expect(page).not.toMatch(/Lines 1–/);
    expect(render(a).join("\n")).toContain("Short.");
    expect(render().join("\n")).toBe(page);
    reader.scroll("end"); expect(render().join("\n")).toContain("END");
    reader.expanded = true;
    const expanded = render(); expect(expanded).toHaveLength(Math.floor(rows * .75));
    reader.scroll("end"); expect(render().join("\n")).toContain("Only in expanded notes.");
    reader.expanded = false; reader.scroll("home");
    expect(render().join("\n")).toContain("第0段");
  });
});

it("selects exact current-round snapshots and preserves whitespace and explicit candidate identity", () => {
  const a = record(1), b = record(2), c = record(3, 3);
  a.input.draft = b.input.draft = " A\n";
  b.acceptedAt = 1;
  c.archivedAt = 1;
  const rows = [a, b, c];
  expect(quickTarget(rows, 1, "A")).toBeUndefined();
  expect(quickTarget(rows, 2, " A\n")).toBeUndefined();
  expect(quickTarget(rows, 1, b.candidate!.text)?.id).toBe(2);
  expect(quickTarget(rows, 1, " A\n", undefined, new Map([[1,1]]))?.id).toBe(1);
  expect(quickTarget(rows, 1, "", 3)?.id).toBe(1);
  expect(quickTarget([b,c], 1, "")).toBeUndefined();
});
