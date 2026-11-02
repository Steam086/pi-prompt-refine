import { CURSOR_MARKER, Editor, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

/** Adapt Pi's editor (which budgets 30% of terminal rows) to our shared viewport.
 * The scoped terminal facade never changes the real terminal's dimensions.
 * Keep this compatibility adapter covered when upgrading pi-tui.
 */
export class PromptInput {
  readonly editor: Editor;
  private height = 1;

  constructor(tui: TUI, theme: EditorTheme) {
    const terminal = new Proxy(tui.terminal, {
      get: (target, key) => key === "rows" ? Math.ceil(this.height / 0.3) : Reflect.get(target, key),
    });
    const scoped = new Proxy(tui, {
      get: (target, key) => {
        if (key === "terminal") return terminal;
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    this.editor = new Editor(scoped, theme, { paddingX: 0 });
  }

  render(width: number, height: number): string[] {
    this.height = Math.max(1, height);
    // Editor owns wrapping, paste expansion, scrolling, undo and IME cursor placement.
    const lines = this.editor.render(width).slice(1, -1);
    // Pi enforces a five-line minimum; tiny viewports must still show the cursor.
    const cursor = lines.findIndex((line) => line.includes(CURSOR_MARKER));
    const start = Math.max(0, cursor - this.height + 1);
    return lines.slice(start, start + this.height);
  }
}
