import type { Terminal } from "@earendil-works/pi-tui";

// Capture real renderer I/O while retaining mutable dimensions for resize tests.
export function createRecordingTerminal(size: { rows: number; columns: number }, clearScreen = () => {}) {
  const writes: string[] = [];
  let onInput = (_data: string) => {};
  const terminal = {
    get rows() { return size.rows; }, set rows(rows) { size.rows = rows; },
    get columns() { return size.columns; }, set columns(columns) { size.columns = columns; },
    kittyProtocolActive: true,
    start: (handler) => { onInput = handler; }, stop() {}, write: (data) => { writes.push(data); },
    async drainInput() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {},
    clearScreen, setTitle() {}, setProgress() {}, setProgramStatus() {},
  } satisfies Terminal;
  return { terminal, writes, input: (data: string) => onInput(data) };
}
