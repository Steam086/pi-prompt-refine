import { Input, parseKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { panelFrame, panelLayout } from "./panel-layout.js";
import { PromptInput } from "./prompt-input.js";
import { sanitizeTerminalText } from "./presentation.js";
import { composeRevision, preferenceKey, preferenceValidation, searchPreferences, selectPreference, PREFERENCE_SELECTION_LIMIT,
  type PreferenceLibrary, type PreferenceRepository, type PreferenceScope, type RevisionPreference, type SelectedPreference } from "./revision-preferences.js";

type Form = {
  kind: "new" | "library" | "local";
  expected?: RevisionPreference;
  localKey?: string;
  scope: PreferenceScope;
  name: Input;
  body: PromptInput;
  rawBody: string;
  initialEditorBody: string;
  initial: string;
  focus: number;
};
type Page = { kind: "list" } | { kind: "read"; title: string; text: string; scroll: number }
  | { kind: "form"; form: Form } | { kind: "discard"; form: Form } | { kind: "delete"; entry: RevisionPreference };
type Action = "use" | "selected" | "current" | "pending" | "new" | "local" | "edit" | "copy" | "delete" | "refresh" | "clear";

/** One transactional child page. It has no model/editor/session mutation capability. */
export class PreferencePanel {
  private page: Page = { kind: "list" };
  private library: PreferenceLibrary = { entries: [], errors: {} };
  private readonly search = new Input({ prompt: "Search: " });
  private readonly working: SelectedPreference[];
  private selectedOnly = false;
  private focus = 0; // search, results, then individual action buttons
  private index = 0;
  private notice = "";
  private busy = false;
  private disposed = false;
  private hasFocus = false;
  private viewport = 1;

  constructor(
    private readonly tui: TUI, private readonly theme: Theme, private readonly keys: KeybindingsManager,
    private readonly repository: PreferenceRepository, private readonly selected: readonly SelectedPreference[],
    private readonly freeText: string, private readonly maxChars: number,
    private readonly close: (selected?: SelectedPreference[]) => void,
  ) {
    this.selected = structuredClone(selected);
    this.working = structuredClone([...selected]);
    void this.refresh();
  }

  set focused(value: boolean) { this.hasFocus = value; this.updateFocus(); }
  private updateFocus(): void {
    this.search.focused = this.hasFocus && this.page.kind === "list" && this.focus === 0;
    const form = this.page.kind === "form" || this.page.kind === "discard" ? this.page.form : undefined;
    if (form) {
      form.name.focused = this.hasFocus && this.page.kind === "form" && form.kind !== "local" && form.focus === 0;
      form.body.editor.focused = this.hasFocus && this.page.kind === "form" && form.focus === (form.kind === "local" ? 0 : 1);
    }
  }
  dispose(): void { this.focused = false; this.disposed = true; }
  invalidate(): void {
    this.search.invalidate();
    if (this.page.kind === "form") this.page.form.body.editor.invalidate();
  }
  private redraw(): void { if (!this.disposed) { this.updateFocus(); this.tui.requestRender(); } }
  private entries(): RevisionPreference[] {
    // Selected view intentionally ignores search, including removed library sources.
    return this.selectedOnly ? this.working : searchPreferences(this.library.entries, this.search.getValue());
  }
  private highlighted(): RevisionPreference | undefined { return this.entries()[this.index]; }
  private local(entry?: RevisionPreference): SelectedPreference | undefined {
    return entry && this.working.find((item) => preferenceKey(item) === preferenceKey(entry));
  }
  private actions(): { id: Action; label: string }[] {
    return [
      { id: "use", label: "Bring back to this revision" },
      { id: "selected", label: this.selectedOnly ? "Show library" : `Show all selected (${this.working.length})` },
      { id: "current", label: "Current actual requirements" },
      { id: "pending", label: "Preview after bringing back" },
      { id: "new", label: "Save new from free input…" },
      { id: "local", label: "Edit selected for this revision…" },
      { id: "edit", label: "Edit library entry…" },
      { id: "copy", label: "Save highlighted as…" },
      { id: "delete", label: "Delete library entry…" },
      { id: "refresh", label: "Refresh library" },
      { id: "clear", label: "Clear search" },
    ];
  }
  private async refresh(): Promise<void> {
    const identity = this.highlighted();
    this.busy = true; this.redraw();
    try {
      const library = await this.repository.load();
      if (this.disposed) return;
      this.library = library;
      const index = identity ? this.entries().findIndex((entry) => preferenceKey(entry) === preferenceKey(identity)) : 0;
      this.index = Math.max(0, index);
    } catch (error) {
      if (!this.disposed) this.library.errors = { project: this.error(error), global: this.error(error) };
    } finally { this.busy = false; this.redraw(); }
  }
  private error(error: unknown): string { return error instanceof Error ? error.message : "Could not access preference library."; }
  private toggle(): void {
    const entry = this.highlighted();
    if (!entry) return;
    const index = this.working.findIndex((item) => preferenceKey(item) === preferenceKey(entry));
    if (index >= 0) this.working.splice(index, 1);
    else if (this.working.length >= PREFERENCE_SELECTION_LIMIT) this.notice = `Select at most ${PREFERENCE_SELECTION_LIMIT} preferences for one revision.`;
    else this.working.push(selectPreference(entry));
    this.index = Math.min(this.index, Math.max(0, this.entries().length - 1));
  }
  private source(entry: RevisionPreference): RevisionPreference | undefined {
    return this.library.entries.find((item) => preferenceKey(item) === preferenceKey(entry));
  }
  private description(entry: RevisionPreference, selectedView = this.selectedOnly): string {
    const local = this.local(entry);
    const source = this.source(entry);
    const status = local ? [local.body !== local.sourceBody ? "Edited for this revision" : "Saved snapshot",
      this.library.errors[local.scope] ? "Library unavailable" : !source ? "Source deleted" : source.version !== local.version || source.body !== local.sourceBody || source.name !== local.name ? "Library changed; snapshot kept" : ""].filter(Boolean).join(" · ") : "Library entry";
    if (selectedView && local) return `${local.name}\n${local.scope} · ${local.id}\n${status}\n\n${local.body}`;
    const library = `${entry.name}\n${entry.scope} · ${entry.id}\nLibrary entry\n\n${entry.body}`;
    return local ? `${library}\n\nSelected snapshot · ${status}\n${local.body}` : library;
  }
  private read(title: string, text: string): void { this.page = { kind: "read", title, text, scroll: 0 }; }
  private preview(pending: boolean): void {
    const text = composeRevision(pending ? this.working : this.selected, this.freeText);
    this.read(pending ? "After bringing back · NOT active" : "Current actual requirements", [
      pending ? "Esc returns to selection; Bring back is required to activate these changes." : "These are the requirements currently active in Revise.",
      "The request also includes the original, source candidate and allowed background.",
      `${text.length}/${this.maxChars} characters${!text ? " · Empty; cannot submit" : text.length > this.maxChars ? " · Too long; cannot submit" : ""}`,
      "", text,
    ].join("\n"));
  }
  private bodyText(form: Form): string {
    const text = form.body.editor.getExpandedText();
    // Native Editor normalizes tabs on setText; preserve untouched saved literals.
    return text === form.initialEditorBody ? form.rawBody : text;
  }
  private formValue(form: Form): { name: string; body: string } { return { name: form.name.getValue(), body: this.bodyText(form) }; }
  private stamp(form: Form): string { return JSON.stringify([this.formValue(form), form.scope]); }
  private openForm(kind: Form["kind"], entry?: RevisionPreference): void {
    const body = new PromptInput(this.tui, {
      borderColor: (text) => this.theme.fg("borderMuted", text),
      selectList: { selectedPrefix: (text) => this.theme.fg("accent", text), selectedText: (text) => this.theme.fg("accent", text),
        description: (text) => this.theme.fg("muted", text), scrollInfo: (text) => this.theme.fg("muted", text), noMatch: (text) => this.theme.fg("warning", text) },
    });
    const rawBody = entry?.body ?? this.freeText;
    body.editor.setText(rawBody);
    const name = new Input({ prompt: "Name: " }); name.setValue(entry?.name ?? "");
    const form: Form = { kind, scope: entry?.scope ?? "project", name, body, rawBody, initialEditorBody: body.editor.getExpandedText(),
      expected: kind === "library" ? structuredClone(entry) : undefined,
      localKey: kind === "local" && entry ? preferenceKey(entry) : undefined, initial: "", focus: 0 };
    form.initial = this.stamp(form);
    this.page = { kind: "form", form }; this.notice = "";
  }
  private activate(action: Action): void {
    const entry = this.highlighted();
    this.notice = "";
    switch (action) {
      case "use": this.close(structuredClone(this.working)); break;
      case "selected": this.selectedOnly = !this.selectedOnly; this.index = 0; this.focus = 1; break;
      case "current": this.preview(false); break;
      case "pending": this.preview(true); break;
      case "new": this.openForm("new"); break;
      case "local": {
        const local = this.local(entry);
        if (local) this.openForm("local", local);
        else this.notice = "Select an entry first with Space; then edit it for this revision.";
        break;
      }
      case "edit":
      case "delete": {
        const source = entry && this.source(entry);
        if (!source) { this.notice = "No library entry; refresh or select an entry."; break; }
        if (action === "edit") this.openForm("library", source);
        else this.page = { kind: "delete", entry: structuredClone(source) };
        break;
      }
      case "copy": if (entry) this.openForm("new", entry); else this.notice = "Select an entry to copy."; break;
      case "refresh": void this.refresh(); break;
      case "clear": this.search.setValue(""); this.index = 0; this.focus = 0; break;
    }
  }
  private async save(form: Form): Promise<void> {
    const value = this.formValue(form);
    const error = preferenceValidation(value);
    if (error) { this.notice = error; return; }
    if (form.kind === "local") {
      const selected = this.working.find((entry) => preferenceKey(entry) === form.localKey);
      if (selected) selected.body = value.body;
      this.page = { kind: "list" }; this.notice = "Edited pending selection only; Bring back to activate.";
      return;
    }
    this.busy = true; this.redraw();
    try {
      await this.repository.save(form.scope, value, form.expected);
      if (this.disposed) return;
      this.page = { kind: "list" }; this.notice = "Saved to library; not added to selection; no request sent.";
      await this.refresh();
    } catch (error) { if (!this.disposed) this.notice = this.error(error); }
    finally { this.busy = false; this.redraw(); }
  }
  private async remove(entry: RevisionPreference): Promise<void> {
    this.busy = true; this.redraw();
    try {
      await this.repository.remove(entry);
      if (this.disposed) return;
      this.page = { kind: "list" }; this.notice = "Deleted from library; selected snapshots kept.";
      await this.refresh();
    } catch (error) { if (!this.disposed) { this.page = { kind: "list" }; this.notice = this.error(error); } }
    finally { this.busy = false; this.redraw(); }
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    const key = parseKey(data);
    if (key === "ctrl+s") { this.notice = "Return to Revise to request revision with Ctrl+S."; this.redraw(); return; }
    const cancel = this.keys.matches(data, "tui.select.cancel") || key === "ctrl+\\";
    if (this.busy) {
      // A load can be abandoned; writes remain until their result is known.
      if (cancel && this.page.kind === "list") this.close();
      return;
    }
    const enter = this.keys.matches(data, "tui.input.submit");
    if (this.page.kind === "read") {
      if (cancel) this.page = { kind: "list" };
      else if (key === "up" || key === "pageup") this.page.scroll = Math.max(0, this.page.scroll - (key === "up" ? 1 : this.viewport));
      else if (key === "down" || key === "pagedown") this.page.scroll += key === "down" ? 1 : this.viewport;
      else if (key === "home") this.page.scroll = 0;
      else if (key === "end") this.page.scroll = Number.MAX_SAFE_INTEGER;
    } else if (this.page.kind === "discard") {
      if (key === "y") { this.page = { kind: "list" }; this.notice = "Form discarded."; }
      else if (cancel || key === "n") this.page = { kind: "form", form: this.page.form };
    } else if (this.page.kind === "delete") {
      if (key === "y") void this.remove(this.page.entry);
      else if (cancel || key === "n") this.page = { kind: "list" };
    } else if (this.page.kind === "form") {
      const form = this.page.form;
      const local = form.kind === "local";
      const count = local ? 2 : 4;
      if (cancel) this.page = this.stamp(form) === form.initial ? { kind: "list" } : { kind: "discard", form };
      else if (key === "tab" || key === "shift+tab") form.focus = (form.focus + (key === "tab" ? 1 : count - 1)) % count;
      else if (form.focus === count - 1 && enter) void this.save(form);
      else if (!local && form.focus === 2 && (enter || key === "space") && form.kind !== "library") form.scope = form.scope === "project" ? "global" : "project";
      else if (form.focus === (local ? 0 : 1)) {
        if (enter) form.body.editor.insertTextAtCursor("\n");
        else form.body.editor.handleInput(data);
      } else if (!local && form.focus === 0) {
        if (enter) form.focus = 1; else form.name.handleInput(data);
      }
    } else if (cancel) this.close();
    else if (key === "tab" || key === "shift+tab") {
      const count = this.actions().length + 2;
      this.focus = (this.focus + (key === "tab" ? 1 : count - 1)) % count;
    } else if (this.focus === 0) {
      if (enter) this.focus = 1;
      else { this.search.handleInput(data); this.index = 0; }
    } else if (this.focus === 1) {
      const max = Math.max(0, this.entries().length - 1);
      if (key === "up" || key === "pageup") this.index = Math.max(0, this.index - (key === "up" ? 1 : this.viewport));
      else if (key === "down" || key === "pagedown") this.index = Math.min(max, this.index + (key === "down" ? 1 : this.viewport));
      else if (key === "space") this.toggle();
      else if (enter) { const entry = this.highlighted(); if (entry) this.read("Full revision instruction", this.description(entry)); }
    } else if (enter) this.activate(this.actions()[this.focus - 2]!.id);
    this.redraw();
  }

  render(width: number): string[] {
    if (width < 1) return [];
    const layout = panelLayout(width, this.tui.terminal.rows);
    const { innerWidth: w, bodyHeight: h } = layout;
    const clean = (text: string) => sanitizeTerminalText(text);
    const wrap = (text: string, columns = w) => wrapTextWithAnsi(clean(text), columns);
    const button = (text: string, active: boolean) => active ? this.theme.bg("selectedBg", this.theme.fg("text", `› ${text}`)) : this.theme.fg("muted", `  ${text}`);
    let title = "Preferences · only this revision";
    let subtitle = `${this.working.length} selected · ${this.selectedOnly ? "All selected (search ignored)" : "Project + global"}`;
    let body: string[] = [];
    let footer = ["Tab / Shift+Tab Focus · Enter Open", "Space Select · Esc Cancel selection"];
    const page = this.page;
    if (page.kind === "read") {
      title = page.title; subtitle = "↑↓ / PgUp / PgDn Scroll · Esc Back";
      const lines = wrap(page.text); this.viewport = Math.max(1, h);
      page.scroll = Math.min(page.scroll, Math.max(0, lines.length - h));
      body = lines.slice(page.scroll, page.scroll + h);
      footer = [`${Math.min(lines.length, page.scroll + 1)}–${Math.min(lines.length, page.scroll + h)} / ${lines.length} lines`, "Esc Back · No request sent"];
    } else if (page.kind === "discard" || page.kind === "delete") {
      title = page.kind === "discard" ? "Discard unsaved form?" : "Delete library entry?";
      body = wrap(page.kind === "discard" ? "Unsaved form changes will be discarded. Pending selection and saved library entries stay unchanged." : this.description(page.entry, false));
      footer = [page.kind === "discard" ? "y Discard · n / Esc Keep editing" : "y Delete · n / Esc Cancel", "Selected snapshots stay unchanged"];
    } else if (page.kind === "form") {
      const form = page.form; const local = form.kind === "local";
      title = local ? "Edit for this revision only" : form.kind === "library" ? "Edit library entry" : "Save new preference";
      subtitle = local ? "Pending selection only · Bring back to activate" : "Save an editing instruction · Check paths and sensitive text";
      const name = form.name.render(w);
      const scope = button(`Scope: ${form.scope}${form.kind === "library" ? " (fixed; use Save as to copy)" : " (Enter change)"}`, form.focus === 2);
      const save = button(local ? "Save this revision's edit" : "Save to preference library", form.focus === (local ? 1 : 3));
      // Tiny viewports show the focused field; the same Tab order remains usable.
      if (h < 5) {
        body = !local && form.focus === 0 ? name : form.focus === (local ? 1 : 3) ? [save]
          : !local && form.focus === 2 ? [scope] : form.body.render(w, Math.max(1, h));
      } else {
        body = [...(!local ? name : []), ...form.body.render(w, h - (local ? 1 : 3)), ...(!local ? [scope] : []), save];
      }
      footer = ["Tab / Shift+Tab Fields · Enter Newline", "Focus Save + Enter · Esc Back"];
    } else {
      const entries = this.entries();
      this.index = Math.min(this.index, Math.max(0, entries.length - 1));
      const errors = Object.values(this.library.errors);
      const status = errors.length ? errors.join(" · ") : this.selectedOnly && !entries.length ? "No selected requirements"
        : !this.library.entries.length ? "Library is empty · Save new to start" : !entries.length ? "No matches · Clear search to see all" : "";
      const actions = this.actions();
      const actionIndex = Math.max(0, this.focus - 2);
      const action = button(`[${actionIndex + 1}/${actions.length}] ${actions[actionIndex]!.label}`, this.focus >= 2);
      if (h < 4) {
        body = this.focus === 0 ? this.search.render(w) : this.focus >= 2 ? wrap(action)
          : wrap(entries[this.index] ? `${this.local(entries[this.index]) ? "[x]" : "[ ]"} ${entries[this.index]!.name}` : status);
      } else {
        const available = Math.max(1, h - 3);
        this.viewport = available;
        const split = w >= 76;
        const leftWidth = split ? Math.floor(w * 0.43) : w;
        const top = Math.max(0, this.index - available + 1);
        const list = entries.slice(top, top + available).map((entry, i) => button(
          `${this.local(entry) ? "[x]" : "[ ]"} ${entry.name} · ${entry.scope}`, this.focus === 1 && top + i === this.index));
        const detail = split && entries[this.index] ? wrap(this.description(entries[this.index]!), w - leftWidth - 3) : [];
        const panes = Array.from({ length: available }, (_, i) => {
          if (!split) return list[i] ?? "";
          const left = truncateToWidth(list[i] ?? "", leftWidth, "…");
          return left + " ".repeat(Math.max(0, leftWidth - visibleWidth(left))) + " │ " + (detail[i] ?? "");
        });
        body = [...this.search.render(w), ...panes, ...wrap(status || `${entries.length} entries · ${this.working.length} selected`).slice(0, 1), action];
      }
      if (errors.length && !this.notice) subtitle = `Load failed · ${errors.join(" · ")}`;
    }
    if (this.busy) subtitle = "Working…";
    else if (this.notice) subtitle = this.notice;
    // Error text must be inspectable even when too long for a header line.
    if (this.notice && this.notice.length > w && page.kind !== "read") footer = wrap(this.notice).slice(0, Math.max(1, layout.footerHeight));
    return panelFrame(layout, [this.theme.fg("text", this.theme.bold(clean(title))), this.theme.fg("muted", clean(subtitle))],
      body, footer.map(clean), (text) => this.theme.fg("borderMuted", text));
  }
}
