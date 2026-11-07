export interface SelectionWindow {
  start: number;
  end: number;
  /** Entry indices and optional group headings/spacers, in physical row order. */
  rows: (number | string)[];
}

/** Stable selection scrolling with one selectable neighbour on either side.
 * Group chrome counts against the budget, but is never a selection target.
 * When cramped, prefer the neighbour in the navigation direction; selection wins.
 */
export function selectionWindow(
  count: number, selected: number, height: number, previousStart = 0,
  group?: (index: number) => string, gap = 0, direction = 1,
): SelectionWindow {
  if (count <= 0 || height <= 0) return { start: 0, end: 0, rows: [] };
  selected = Math.max(0, Math.min(selected, count - 1));
  // One physical row must show the actionable entry, not just its heading.
  const heading = group && height > 1 ? group : undefined;
  const firstCost = heading ? 2 : 1;
  const cost = (index: number) => 1 + (heading && heading(index - 1) !== heading(index) ? 1 + gap : 0);
  const fits = (start: number, end: number) => {
    let used = firstCost;
    for (let i = start + 1; i <= end; i++) used += cost(i);
    return used <= height;
  };
  let first = Math.max(0, selected - 1);
  let last = Math.min(count - 1, selected + 1);
  if (!fits(first, last)) {
    if (direction < 0) last = selected;
    else first = selected;
  }
  if (!fits(first, last)) { first = selected; last = selected; }
  // Find the earliest top that can include the desired trailing neighbour.
  // Work backwards only one viewport, even for Home/End or large lists.
  let earliest = last;
  let used = firstCost;
  while (earliest > 0 && used + cost(earliest) <= height) {
    used += cost(earliest);
    earliest--;
  }
  let start = Math.max(earliest, Math.min(previousStart, first));
  let end = start + 1;
  used = firstCost;
  while (end < count && used + cost(end) <= height) { used += cost(end); end++; }
  // Resize and end-of-list navigation should not leave avoidable blank space.
  while (end === count && start > 0 && used + cost(start) <= height) {
    used += cost(start);
    start--;
  }
  const rows: (number | string)[] = [];
  for (let i = start; i < end; i++) {
    if (heading && (i === start || heading(i - 1) !== heading(i))) {
      if (i !== start) for (let j = 0; j < gap; j++) rows.push("");
      rows.push(heading(i));
    }
    rows.push(i);
  }
  return { start, end, rows };
}
