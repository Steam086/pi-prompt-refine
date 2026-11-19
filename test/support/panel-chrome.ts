import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters as strip } from "node:util";

const actionKey = "(?:Ctrl\\+S|Esc|Tab|Enter|r|m|a|x|q|o|↵|\\^S|\\?|n):? ";
const leadingAction = new RegExp(`^[│ ]*${actionKey}`, "u");
const sharedAction = new RegExp(` {3,}(?=${actionKey})`, "u");

/** Return chrome without the separate transcript/shell borders or the content rule. */
export function frameHeader(lines: string[]): string[] {
  const end = lines.findIndex((line, index) => index > 0 && /^[│ ]*─+[│ ]*$/u.test(strip(line)));
  return end < 0 ? lines : lines.slice(1, end);
}

/** Keep the action columns when the active tabs share their first row. */
export function frameHints(lines: string[]): string[] {
  return frameHeader(lines).flatMap((line) => {
    const text = strip(line);
    if (leadingAction.test(text)) return [line];
    const shared = sharedAction.exec(text);
    if (!shared) return [];
    const column = visibleWidth(text.slice(0, shared.index + shared[0].length));
    const hints = sliceByColumn(line, column, visibleWidth(line) - column);
    // Column slicing preserves escape sequences from the skipped prefix with no visible text.
    return [hints.replace(/\x1b\[1m\x1b\[22m/g, "")];
  });
}
