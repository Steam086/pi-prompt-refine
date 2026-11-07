import { Input, parseKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { panelFrame, panelLayout } from "./panel-layout.js";
import { alignedKeyHints, fittingKeyHints, formatKeyHint, type KeyHint } from "./key-hints.js";
import { PromptInput } from "./prompt-input.js";
import { sanitizeTerminalText } from "./presentation.js";
import { composeRevision, preferenceContentKey, preferenceKey, preferenceValidation, searchPreferences, selectPreference, PREFERENCE_SELECTION_LIMIT,
  type PreferenceLibrary, type PreferenceMetadata, type PreferenceRepository, type PreferenceScope, type PreferenceValue, type RevisionPreference, type SelectedPreference } from "./revision-preferences.js";

type Form = {
  kind: "new" | "library";
  expected?: RevisionPreference;
  scope: PreferenceScope;
  name: Input;
  body: PromptInput;
  description: Input;
  rawDescription: string;
  initialEditorDescription: string;
  metadata?: PreferenceMetadata;
  rawBody: string;
  initialEditorBody: string;
  initial: string;
  focus: number;
};
type DocumentPart = { text: string; color: "text" | "muted" | "warning" | "error"; heading?: boolean };
type PreferenceDocument = DocumentPart[];
type Page = { kind: "list" } | { kind: "read"; title: string; document: PreferenceDocument; scroll: number }
  | { kind: "form"; form: Form } | { kind: "discard"; form: Form } | { kind: "delete"; entry: RevisionPreference };
type Action = "new" | "edit" | "delete";
const ACTIONS = [
  { id: "new", key: "n", label: "Add" },
  { id: "edit", key: "e", label: "Edit" },
  { id: "delete", key: "d", label: "Delete" },
] as const;

/** One transactional child page. It has no model/editor/session mutation capability. */
export class PreferencePanel {
  private page: Page = { kind: "list" };
  private library: PreferenceLibrary = { entries: [], errors: {} };
  private allSearch = new Input({ prompt: "Search: " });
  private selectedSearch = new Input({ prompt: "Search: " });
  private get search(): Input { return this.selectedOnly ? this.selectedSearch : this.allSearch; }
  private readonly working: SelectedPreference[];
  private focus = 1; // Search, library, actions: three regions, never one stop per action.
  private actionIndex = 0;
  private index = 0;
  private selectedOnly = false;
  private allView: { index: number; key?: string } = { index: 0 };
  private contentVersion = 0;
  private entriesCache?: { query: string; version: number; entries: RevisionPreference[] };
  private descriptionCache?: { entry: RevisionPreference; version: number; document: PreferenceDocument };
  private documents: { document: PreferenceDocument; width: number; lines: string[] }[] = [];
  private notice = "";
  private noticeColor: "muted" | "warning" | "error" = "muted";
  private busy = false;
  private disposed = false;
  private hasFocus = false;
  private viewport = 1;
  private requirementsChars = 0;

  constructor(
    private readonly tui: TUI, private readonly theme: Theme, private readonly keys: KeybindingsManager,
    private readonly repository: PreferenceRepository, selected: readonly SelectedPreference[],
    private readonly freeText: string, private readonly maxChars: number,
    private readonly close: (selected?: SelectedPreference[]) => string | void,
    private readonly purpose: "revise" | "refine" = "revise",
  ) {
    this.working = structuredClone([...selected]);
    this.requirementsChars = composeRevision(this.working, freeText).length;
    void this.refresh();
  }

  set focused(value: boolean) { this.hasFocus = value; this.updateFocus(); }
  private updateFocus(): void {
    const searching = this.hasFocus && this.page.kind === "list" && this.focus === 0;
    this.allSearch.focused = searching && !this.selectedOnly;
    this.selectedSearch.focused = searching && this.selectedOnly;
    const form = this.page.kind === "form" || this.page.kind === "discard" ? this.page.form : undefined;
    if (form) {
      form.name.focused = this.hasFocus && this.page.kind === "form" && form.focus === 0;
      form.body.editor.focused = this.hasFocus && this.page.kind === "form" && form.focus === 1;
      form.description.focused = this.hasFocus && this.page.kind === "form" && form.focus === 4;
    }
  }
  dispose(): void { this.focused = false; this.disposed = true; }
  invalidate(): void {
    this.allSearch.invalidate();
    this.selectedSearch.invalidate();
    this.documents = [];
    if (this.page.kind === "form") this.page.form.body.editor.invalidate();
  }
  private redraw(): void { if (!this.disposed) { this.updateFocus(); this.tui.requestRender(); } }
  private entries(): RevisionPreference[] {
    const query = this.search.getValue();
    if (this.entriesCache?.query === query && this.entriesCache.version === this.contentVersion) return this.entriesCache.entries;
    // Keep deleted sources visible until their snapshots are explicitly deselected.
    const keys = new Set(this.library.entries.map(preferenceKey));
    const candidates = this.selectedOnly ? this.working
      : [...this.library.entries, ...this.working.filter((entry) => !keys.has(preferenceKey(entry)))];
    const matches = searchPreferences(candidates, query);
    // Selected snapshots are audited in composeRevision order, never search rank.
    const matchedKeys = new Set(matches.map(preferenceKey));
    const entries = this.selectedOnly ? this.working.filter((entry) => matchedKeys.has(preferenceKey(entry))) : matches;
    this.entriesCache = { query, version: this.contentVersion, entries };
    return entries;
  }
  private highlighted(): RevisionPreference | undefined { return this.entries()[this.index]; }
  private toggleView(): void {
    if (!this.selectedOnly) {
      const entry = this.highlighted();
      this.allView = { index: this.index, key: entry && preferenceKey(entry) };
      this.selectedOnly = true;
      // Each audit starts unfiltered, including snapshots hidden by the all-view query.
      this.selectedSearch = new Input({ prompt: "Search: " });
      this.index = 0;
      this.contentVersion++;
    } else {
      this.selectedOnly = false;
      this.contentVersion++;
      const index = this.entries().findIndex((entry) => preferenceKey(entry) === this.allView.key);
      this.index = index >= 0 ? index : Math.min(this.allView.index, Math.max(0, this.entries().length - 1));
    }
  }
  private local(entry?: RevisionPreference): SelectedPreference | undefined {
    return entry && this.working.find((item) => preferenceKey(item) === preferenceKey(entry));
  }
  /** Only rewrap literal documents when content or width changes, not on Tab/scroll. */
  private document(document: PreferenceDocument, width: number): string[] {
    const cached = this.documents.find((item) => item.document === document && item.width === width);
    if (cached) return cached.lines;
    const lines = document.flatMap((part) => wrapTextWithAnsi(sanitizeTerminalText(part.text), width)
      .map((line) => this.theme.fg(part.color, part.heading ? this.theme.bold(line) : line)));
    if (this.documents.length >= 3) this.documents.shift();
    this.documents.push({ document, width, lines });
    return lines;
  }
  private setNotice(text: string, color: "muted" | "warning" | "error" = "muted"): void {
    this.notice = text;
    this.noticeColor = color;
  }
  private async refresh(): Promise<void> {
    const identity = this.highlighted();
    this.busy = true; this.redraw();
    try {
      const library = await this.repository.load();
      if (this.disposed) return;
      this.library = library;
      this.contentVersion++;
      const index = identity ? this.entries().findIndex((entry) => preferenceKey(entry) === preferenceKey(identity)) : 0;
      this.index = Math.max(0, index);
    } catch (error) {
      if (!this.disposed) { this.library.errors = { project: this.error(error), global: this.error(error) }; this.contentVersion++; }
    } finally { this.busy = false; this.redraw(); }
  }
  private error(error: unknown): string { return error instanceof Error ? error.message : "Could not access preference library."; }
  private toggle(): void {
    const entry = this.highlighted();
    if (!entry) return;
    const index = this.working.findIndex((item) => preferenceKey(item) === preferenceKey(entry));
    if (index >= 0) this.working.splice(index, 1);
    else if (this.working.some((item) => preferenceContentKey(item) === preferenceContentKey(entry))) {
      this.setNotice("Same requirements already selected. Use Selected only (s) to inspect or remove them.", "warning");
    }
    else if (this.working.length >= PREFERENCE_SELECTION_LIMIT) this.setNotice(`Select at most ${PREFERENCE_SELECTION_LIMIT} preferences for one ${this.purpose === "refine" ? "refinement" : "revision"}.`, "warning");
    else this.working.push(selectPreference(entry));
    this.contentVersion++;
    this.requirementsChars = composeRevision(this.working, this.freeText).length;
    this.index = Math.min(this.index, Math.max(0, this.entries().length - 1));
  }
  private source(entry: RevisionPreference): RevisionPreference | undefined {
    return this.library.entries.find((item) => preferenceKey(item) === preferenceKey(entry));
  }
  private description(entry: RevisionPreference): PreferenceDocument {
    if (this.descriptionCache?.entry === entry && this.descriptionCache.version === this.contentVersion) return this.descriptionCache.document;
    const local = this.local(entry);
    const source = this.source(entry);
    const changed = local && source && (source.version !== local.version || source.body !== local.sourceBody || source.name !== local.name ||
      JSON.stringify(source.metadata) !== JSON.stringify(local.metadata));
    const unavailable = !!this.library.errors[entry.scope];
    const status = local ? [local.body !== local.sourceBody ? "Edited for this revision" : "Saved snapshot",
      unavailable ? "Library unavailable" : !source ? "Source deleted" : changed ? "Library changed; snapshot kept" : ""].filter(Boolean).join(" · ") : "Library entry";
    const details = (value: RevisionPreference, state: PreferenceDocument): PreferenceDocument => [
      { text: value.name, color: "text", heading: true },
      { text: `${value.scope} · ${value.id}`, color: "muted" },
      ...state,
      ...(value.metadata ? [
        { text: `${value.metadata.kind === "rewrite" ? "Prompt rewriting" : "Task requirements"} · ${value.metadata.activation}${value.metadata.activation === "auto" ? ` · ${value.metadata.match}` : ""}`, color: "muted" as const },
        { text: value.metadata.description, color: "muted" as const },
      ] : []),
      { text: "", color: "text" }, { text: value.body, color: "text" },
    ];
    let document: PreferenceDocument;
    // Delete confirmation still describes its current-source operation target.
    if (this.selectedOnly && local && this.page.kind !== "delete") {
      document = [{ text: "Selected snapshot", color: "text", heading: true }, ...details(local, [
        { text: status, color: unavailable || !source || changed ? "warning" : "muted" },
        { text: local.adoption === "auto" ? `Automatically selected${local.metadata?.match ? ` · ${local.metadata.match}` : ""}` : "Manually selected", color: "muted" },
      ])];
      if (source && !unavailable && (changed || source.body !== local.body)) document.push(
        { text: "", color: "text" }, { text: "Current library entry", color: "text", heading: true }, ...details(source, []));
    } else {
      document = details(entry, [{ text: unavailable ? "Library unavailable" : source ? "Library entry" : "Deleted source",
        color: unavailable || !source ? "warning" : "muted" }]);
      if (local) document.push({ text: "", color: "text" }, { text: "Selected snapshot", color: "text", heading: true },
        { text: status, color: unavailable || !source || changed ? "warning" : "muted" },
        ...(local.metadata ? [{ text: `${local.metadata.kind} · ${local.adoption === "auto" ? `Automatically selected · ${local.metadata.match}` : "Manually selected"} · ${local.metadata.description}`, color: "muted" as const }] : []),
        { text: local.body, color: "text" });
    }
    this.descriptionCache = { entry, version: this.contentVersion, document };
    return document;
  }
  private read(title: string, document: PreferenceDocument): void { this.page = { kind: "read", title, document, scroll: 0 }; }
  private bodyText(form: Form): string {
    const text = form.body.editor.getExpandedText();
    // Native Editor normalizes tabs on setText; preserve untouched saved literals.
    return text === form.initialEditorBody ? form.rawBody : text;
  }
  private formValue(form: Form): PreferenceValue {
    const name = form.name.getValue();
    const edited = form.description.getValue();
    const description = edited === form.initialEditorDescription ? form.rawDescription : edited;
    return { name, body: this.bodyText(form), ...(form.metadata ? { metadata: { ...form.metadata,
      description: description.trim() ? description : name } } : {}) };
  }
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
    const rawDescription = entry?.metadata?.description ?? "";
    const description = new Input({ prompt: "Description: " }); description.setValue(sanitizeTerminalText(rawDescription).replace(/\n/g, " "));
    const form: Form = { kind, scope: entry?.scope ?? "project", name, body, rawBody, initialEditorBody: body.editor.getExpandedText(),
      description, rawDescription, initialEditorDescription: description.getValue(),
      metadata: entry ? entry.metadata && structuredClone(entry.metadata) : { kind: "task", description: "", activation: "manual" },
      expected: kind === "library" ? structuredClone(entry) : undefined, initial: "", focus: 0 };
    form.initial = this.stamp(form);
    this.page = { kind: "form", form }; this.setNotice("");
  }
  private activate(action: Action): void {
    const entry = this.highlighted();
    this.setNotice("");
    if (action === "new") this.openForm("new");
    else {
      const source = entry && this.source(entry);
      if (!source) { this.setNotice("Select a saved preference to edit or delete.", "warning"); return; }
      if (action === "edit") this.openForm("library", source);
      else this.page = { kind: "delete", entry: structuredClone(source) };
    }
  }
  private async save(form: Form): Promise<void> {
    const value = this.formValue(form);
    const error = preferenceValidation(value);
    if (error) { this.setNotice(error, "warning"); return; }
    this.busy = true; this.redraw();
    try {
      const saved = await this.repository.save(form.scope, value, form.expected);
      if (this.disposed) return;
      this.page = { kind: "list" }; this.setNotice("Saved to library; not added to selection; no request sent.");
      if (form.kind === "new") {
        const reset = this.selectedOnly || !!this.search.getValue().trim();
        this.selectedOnly = false;
        this.allSearch = new Input({ prompt: "Search: " });
        this.allView = { index: 0, key: preferenceKey(saved) };
        this.focus = 1;
        // The write result is authoritative even if the subsequent read fails.
        this.library.entries = this.library.entries.filter((entry) => preferenceKey(entry) !== preferenceKey(saved)).concat(saved);
        this.contentVersion++;
        await this.refresh();
        if (this.disposed) return;
        const errors = Object.values(this.library.errors);
        if (this.library.errors[saved.scope] && !this.source(saved)) {
          this.library.entries.push(saved);
          this.contentVersion++;
        }
        const index = this.entries().findIndex((entry) => preferenceKey(entry) === preferenceKey(saved));
        this.index = Math.max(0, index);
        const feedback = `Saved; not selected.${reset ? " Filters reset to All." : ""}`;
        const missing = index < 0 ? " Saved entry no longer in library; could not reveal it." : "";
        this.setNotice(errors.length ? `Refresh failed after save; not selected.${reset ? " Filters reset to All." : ""} ${errors.join(" · ")}${missing}`
          : feedback + missing,
          errors.length ? "error" : index < 0 ? "warning" : "muted");
      } else await this.refresh();
    } catch (error) { if (!this.disposed) this.setNotice(this.error(error), "error"); }
    finally { this.busy = false; this.redraw(); }
  }
  private async remove(entry: RevisionPreference): Promise<void> {
    this.busy = true; this.redraw();
    try {
      await this.repository.remove(entry);
      if (this.disposed) return;
      this.page = { kind: "list" }; this.setNotice("Deleted from library; selected snapshots kept.");
      await this.refresh();
    } catch (error) { if (!this.disposed) { this.page = { kind: "list" }; this.setNotice(this.error(error), "error"); } }
    finally { this.busy = false; this.redraw(); }
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    const key = parseKey(data);
    if (key && /(^|\+)f\d+$/.test(key)) return;
    if (key === "ctrl+s") {
      this.setNotice(this.purpose === "refine" ? "Bring back with Alt+Enter, then press Enter on the Unsent original to refine." : "Return to Revise to request revision with Ctrl+S.");
      this.redraw(); return;
    }
    const cancel = this.keys.matches(data, "tui.select.cancel") || key === "ctrl+\\";
    if (this.busy) {
      // A load can be abandoned; writes remain until their result is known.
      if (cancel && this.page.kind === "list") this.close();
      return;
    }
    const enter = this.keys.matches(data, "tui.input.submit");
    if (this.page.kind === "list" && key) this.setNotice("");
    if (this.page.kind === "read") {
      if (cancel) this.page = { kind: "list" };
      else if (key === "up" || key === "pageup") this.page.scroll = Math.max(0, this.page.scroll - (key === "up" ? 1 : this.viewport));
      else if (key === "down" || key === "pagedown") this.page.scroll += key === "down" ? 1 : this.viewport;
      else if (key === "home") this.page.scroll = 0;
      else if (key === "end") this.page.scroll = Number.MAX_SAFE_INTEGER;
    } else if (this.page.kind === "discard") {
      if (key === "y") { this.page = { kind: "list" }; this.setNotice("Form discarded."); }
      else if (cancel || key === "n") this.page = { kind: "form", form: this.page.form };
    } else if (this.page.kind === "delete") {
      if (key === "y") void this.remove(this.page.entry);
      else if (cancel || key === "n") this.page = { kind: "list" };
    } else if (this.page.kind === "form") {
      const form = this.page.form;
      const count = 7;
      if (cancel) this.page = this.stamp(form) === form.initial ? { kind: "list" } : { kind: "discard", form };
      else if (key === "tab" || key === "shift+tab") form.focus = (form.focus + (key === "tab" ? 1 : count - 1)) % count;
      else if (form.focus === count - 1 && enter) void this.save(form);
      else if (form.focus === 2 && (enter || key === "space") && form.kind !== "library") form.scope = form.scope === "project" ? "global" : "project";
      else if (form.focus === 3 && (enter || key === "space")) {
        form.metadata = { description: form.description.getValue(), kind: form.metadata?.kind === "rewrite" ? "task" : "rewrite", activation: "manual" };
      } else if (form.focus === 5 && (enter || key === "space")) {
        if (form.metadata?.kind !== "rewrite") this.setNotice("Automatic adoption is available only for prompt rewriting. Task requirements stay manual.", "warning");
        else {
          const choices = [undefined, "parallel", "sequence", "always"] as const;
          const index = form.metadata.activation === "manual" ? 0 : choices.indexOf(form.metadata.match);
          const match = choices[(index + 1) % choices.length];
          form.metadata = { kind: "rewrite", description: form.description.getValue(), activation: match ? "auto" : "manual", ...(match ? { match } : {}) };
        }
      } else if (form.focus === 4) {
        if (enter) form.focus = 5;
        else {
          form.description.handleInput(data);
          form.metadata ??= { kind: "task", description: "", activation: "manual" };
        }
      } else if (form.focus === 1) {
        if (enter) form.body.editor.insertTextAtCursor("\n");
        else form.body.editor.handleInput(data);
      } else if (form.focus === 0) {
        if (enter) form.focus = 1; else form.name.handleInput(data);
      }
    } else if (cancel) this.close();
    else if (key === "alt+enter") {
      const error = this.close(structuredClone(this.working));
      if (error) this.setNotice(error, "warning");
    }
    else if (key === "tab" || key === "shift+tab") this.focus = (this.focus + (key === "tab" ? 1 : 2)) % 3;
    else if (this.focus === 0) {
      if (enter || key === "down") this.focus = 1;
      else { this.search.handleInput(data); this.index = 0; }
    } else if (key === "s") this.toggleView();
    else if (key === "/") this.focus = 0;
    else if (ACTIONS.some((action) => action.key === key)) {
      this.actionIndex = ACTIONS.findIndex((action) => action.key === key);
      this.activate(ACTIONS[this.actionIndex]!.id);
    } else if (this.focus === 1) {
      const max = Math.max(0, this.entries().length - 1);
      if (key === "up" || key === "pageup") this.index = Math.max(0, this.index - (key === "up" ? 1 : this.viewport));
      else if (key === "down" || key === "pagedown") this.index = Math.min(max, this.index + (key === "down" ? 1 : this.viewport));
      else if (key === "home") this.index = 0;
      else if (key === "end") this.index = max;
      else if (key === "space") this.toggle();
      else if (enter) { const entry = this.highlighted(); if (entry) this.read(this.purpose === "refine" ? "Full editing instruction" : "Full revision instruction", this.description(entry)); }
    } else {
      if (key === "left" || key === "up") this.actionIndex = (this.actionIndex + ACTIONS.length - 1) % ACTIONS.length;
      else if (key === "right" || key === "down") this.actionIndex = (this.actionIndex + 1) % ACTIONS.length;
      else if (enter) this.activate(ACTIONS[this.actionIndex]!.id);
    }
    this.redraw();
  }

  render(width: number): string[] {
    if (width < 1) return [];
    const layout = panelLayout(width, this.tui.terminal.rows);
    const { innerWidth: w, bodyHeight: h } = layout;
    const clean = (text: string) => sanitizeTerminalText(text);
    const wrap = (text: string, columns = w) => wrapTextWithAnsi(clean(text), columns);
    const button = (text: string, active: boolean) => active ? this.theme.bg("selectedBg", this.theme.fg("text", `› ${clean(text)}`)) : this.theme.fg("muted", `  ${clean(text)}`);
    let title = this.purpose === "refine" ? "Preferences · Unsent original" : "Preferences";
    if (this.page.kind === "list" && this.selectedOnly) title = `Preferences · Selected only${this.purpose === "refine" ? " · Unsent original" : ""}`;
    const tooLong = this.requirementsChars > this.maxChars;
    let subtitle = `Focus: ${["Search", "Library", "Actions"][this.focus]} · ${this.working.length} selected · ${this.requirementsChars}/${this.maxChars} chars`;
    let subtitleColor: DocumentPart["color"] = "muted";
    let body: string[] = [];
    let hints: KeyHint[][] = [[["Alt+Enter", "Bring back"],
      ...(this.focus !== 0 ? [["s", this.selectedOnly ? "All" : w < 60 ? "Selected" : "Selected only"] as KeyHint] : []),
      ["Enter", this.focus === 0 ? "Browse" : this.focus === 1 ? "Read" : "Choose"],
      ...(this.focus === 1 ? [["Space", this.selectedOnly ? "Deselect" : "Select"] as KeyHint] : this.focus === 2 ? [["←→", "Choose action"] as KeyHint] : [])],
      [["Esc", "Cancel selection"], ["Tab / Shift+Tab", "Focus"], ...(this.focus !== 0 ? [["/", "Search"] as KeyHint] : [])]];
    const page = this.page;
    if (page.kind === "read") {
      title = page.title; subtitle = "Read-only · No request sent";
      const lines = this.document(page.document, w); this.viewport = Math.max(1, h);
      page.scroll = Math.min(page.scroll, Math.max(0, lines.length - h));
      body = lines.slice(page.scroll, page.scroll + h);
      hints = [[["↑↓ / PgUp / PgDn", "Scroll"], ["", `${Math.min(lines.length, page.scroll + 1)}–${Math.min(lines.length, page.scroll + h)} / ${lines.length} lines`]],
        [["Esc", "Back"], ["", "No request sent"]]];
    } else if (page.kind === "discard" || page.kind === "delete") {
      title = page.kind === "discard" ? "Discard unsaved form?" : "Delete library entry?";
      body = page.kind === "discard"
        ? wrap("Unsaved form changes will be discarded. Pending selection and saved library entries stay unchanged.").map((line) => this.theme.fg("warning", line))
        : this.document(this.description(page.entry), w);
      hints = [[["y", page.kind === "discard" ? "Discard" : "Delete"], ["", "Selected snapshots stay unchanged"]],
        [["n / Esc", page.kind === "discard" ? "Keep editing" : "Cancel"]]];
    } else if (page.kind === "form") {
      const form = page.form;
      title = form.kind === "library" ? "Edit library entry" : "Save new preference";
      subtitle = `Focus: ${["Name", "Instruction", "Scope", "Type", "Description", "Adoption", "Save"][form.focus]} · Check paths and sensitive text`;
      const name = form.name.render(w);
      const scope = button(`Scope: ${form.scope}${form.kind === "library" ? " (fixed)" : " (Enter change)"}`, form.focus === 2);
      const type = button(`Type: ${form.metadata?.kind === "rewrite" ? "Prompt rewriting" : form.metadata?.kind === "task" ? "Task requirements" : "Unclassified (legacy)"}`, form.focus === 3);
      const description = form.description.render(w);
      const adoption = button(`Adoption: ${form.metadata?.activation === "auto" ? `Auto · ${form.metadata.match}` : "Manual"}`, form.focus === 5);
      const save = button("Save to preference library", form.focus === 6);
      // Native Editor cannot wrap a wide glyph into a one-column line. The
      // outer frame clips its minimal safe canvas in extremely narrow terminals.
      const editorWidth = Math.max(4, w);
      // Tiny viewports show the focused field; the same Tab order remains usable.
      if (h < 9) {
        body = form.focus === 0 ? name : form.focus === 6 ? [save] : form.focus === 4 ? description
          : form.focus === 2 ? [scope] : form.focus === 3 ? [type] : form.focus === 5 ? [adoption] : form.body.render(editorWidth, Math.max(1, h));
      } else {
        body = [...name, ...form.body.render(editorWidth, h - 6), scope, type, ...description, adoption, save];
      }
      const enterLabel = form.focus === 6 ? "Save to library" : form.focus === 1 ? "Newline" : form.focus === 0 || form.focus === 4 ? "Next field"
        : form.focus === 3 ? "Change type" : form.focus === 5 ? "Change adoption" : form.kind === "library" ? "Scope fixed" : "Change scope";
      hints = [[["Enter", enterLabel], ["Tab / Shift+Tab", "Fields"]], [["Esc", "Back"], ["", "No request sent"]]];
    } else {
      const entries = this.entries();
      this.index = Math.min(this.index, Math.max(0, entries.length - 1));
      const errors = Object.values(this.library.errors);
      const status = errors.length ? errors.join(" · ") : this.selectedOnly && !this.working.length
        ? "No selections · s All to browse" : !this.library.entries.length && !this.working.length
          ? "Library is empty · n Add to start" : !entries.length ? "No matches · / Search to change query" : "";
      const columns = Math.max(1, Math.min(3, Math.floor(w / 12)));
      const cellWidth = Math.max(1, Math.floor((w - (columns - 1) * 2) / columns));
      const toolbar: string[] = [];
      for (let start = 0; start < ACTIONS.length; start += columns) {
        toolbar.push(ACTIONS.slice(start, start + columns).map((action, i) => {
          const active = this.focus === 2 && start + i === this.actionIndex;
          const hint = `${active ? "›" : " "} ${formatKeyHint([action.key, action.label], this.theme)}`;
          const cell = truncateToWidth(hint, cellWidth, "…");
          const padded = cell + " ".repeat(Math.max(0, cellWidth - visibleWidth(cell)));
          return active ? this.theme.bg("selectedBg", padded) : padded;
        }).join("  "));
      }
      const chrome = [...this.search.render(w), ...toolbar];
      const room = h >= chrome.length + 2;
      const available = Math.max(1, room ? h - chrome.length - 1 : h);
      this.viewport = available;
      const split = room && w >= 76;
      const leftWidth = split ? Math.floor(w * 0.43) : w;
      const top = Math.max(0, this.index - available + 1);
      const list = entries.slice(top, top + available).map((entry, i) => {
        const current = top + i === this.index;
        const active = this.focus === 1 && current;
        const local = this.local(entry);
        const source = this.source(entry);
        const unavailable = !!this.library.errors[entry.scope];
        const changed = local && source && (local.version !== source.version || local.name !== source.name || local.sourceBody !== source.body ||
          JSON.stringify(local.metadata) !== JSON.stringify(source.metadata));
        const warning = unavailable ? "unavailable" : !source ? "deleted" : changed ? "snapshot kept" : "";
        const prefix = this.theme.fg("muted", `${active ? "›" : current ? "·" : " "} ${local ? "[x]" : "[ ]"} `)
          + (warning ? this.theme.fg("warning", "! ") : "");
        const name = clean(entry.name).replace(/\n/g, " ");
        const metadata = ` · ${entry.scope === "project" ? "P" : "G"}${warning ? ` · ${warning}` : ""}`;
        const room = Math.max(0, leftWidth - visibleWidth(prefix));
        const showMetadata = visibleWidth(name) + visibleWidth(metadata) <= room;
        const label = truncateToWidth(name, room, "…");
        const cell = truncateToWidth(prefix + this.theme.fg("text", active ? this.theme.bold(label) : label)
          + (showMetadata ? this.theme.fg("muted", metadata) : ""), leftWidth, "…");
        return active ? this.theme.bg("selectedBg", cell + " ".repeat(Math.max(0, leftWidth - visibleWidth(cell)))) : cell;
      });
      if (!entries.length) list.push(...wrap(status, leftWidth).map((line) => this.theme.fg(errors.length ? "error" : "muted", line)));
      if (!room) {
        body = this.focus === 0 ? this.search.render(w) : this.focus === 2
          ? toolbar.slice(Math.min(Math.floor(this.actionIndex / columns), Math.max(0, toolbar.length - h))) : list;
      } else {
        const rightWidth = split ? w - leftWidth - 3 : w;
        const detail = split && entries[this.index] ? this.document(this.description(entries[this.index]!), rightWidth) : [];
        const headingText = this.theme.fg("text", this.theme.bold(`${this.selectedOnly ? "Selected" : "Library"} ${entries.length ? this.index + 1 : 0}/${entries.length}`));
        const count = this.theme.fg("muted", ` · ${this.working.length} selected`);
        const viewHint = this.focus !== 0 ? formatKeyHint(["s", this.selectedOnly ? "All" : "Selected"], this.theme) : "";
        const hintFits = !!viewHint && visibleWidth(headingText) + 3 + visibleWidth(viewHint) <= leftWidth;
        const countFits = visibleWidth(headingText + count) + (hintFits ? 3 + visibleWidth(viewHint) : 0) <= leftWidth;
        const heading = truncateToWidth(headingText + (countFits ? count : ""), leftWidth, "")
          + (hintFits ? this.theme.fg("muted", " · ") + viewHint : "");
        const panes = Array.from({ length: available }, (_, i) => {
          if (!split) return list[i] ?? "";
          const left = list[i] ?? "";
          return left + " ".repeat(Math.max(0, leftWidth - visibleWidth(left))) + this.theme.fg("borderMuted", " │ ") + (detail[i] ?? "");
        });
        const section = split ? truncateToWidth(heading, leftWidth, "") + " ".repeat(Math.max(0, leftWidth - visibleWidth(heading)))
          + this.theme.fg("borderMuted", " │ ") + this.theme.fg("muted", "Preview · Enter reads full text") : heading;
        body = [...chrome, section, ...panes];
      }
      if (errors.length) { subtitle = `Load failed · ${errors.join(" · ")}`; subtitleColor = "error"; }
      else if (tooLong) { subtitle = `Too long · ${this.requirementsChars}/${this.maxChars} chars`; subtitleColor = "warning"; }
    }
    if (this.busy) { subtitle = "Working…"; subtitleColor = "muted"; }
    else if (this.notice && (this.noticeColor !== "muted" || subtitleColor === "muted")) {
      subtitleColor = this.noticeColor;
      subtitle = page.kind === "list" && subtitleColor === "muted" ? `Focus: ${["Search", "Library", "Actions"][this.focus]} · ${this.notice}` : this.notice;
    }
    if (w < 30) {
      const labels: Record<string, string> = { "Cancel selection": "Cancel", "Keep editing": "Keep", "Next field": "Next",
        "Save to library": "Save", "Save this revision's edit": "Save edit", "Change scope": "Scope", "Scope fixed": "Fixed" };
      hints = hints.map((row) => row.map(([key, label]) => [key === "n / Esc" ? "Esc" : key.split(" / ")[0]!, labels[label] ?? label]));
    }
    const footer = w < 30
      ? hints.map((row) => fittingKeyHints(row, w, this.theme))
      : alignedKeyHints(hints, w, this.theme);
    if (layout.footerHeight === 1) footer[0] = fittingKeyHints([hints[1]![0]!, ...hints[0]!], w, this.theme);
    // Notices are untrusted plain text; sanitize before styling. Never sanitize
    // already-styled key hints, which would strip their ANSI emphasis/colors.
    if (this.notice && visibleWidth(clean(this.notice)) > w && page.kind !== "read" && layout.footerHeight > 1) {
      // A long notice must not hide Back/Cancel or region navigation.
      footer[0] = this.theme.fg(this.noticeColor, wrap(this.notice)[0] ?? "");
    }
    const severe = subtitleColor !== "muted";
    const feedback = this.theme.fg(subtitleColor, clean(`${severe ? "⚠ " : ""}${subtitle}`));
    const header = [this.theme.fg("text", this.theme.bold(clean(title))), feedback];
    if (severe && layout.headerHeight === 1) header[0] = feedback;
    if (severe && layout.headerHeight === 0) body = [feedback, ...body];
    return panelFrame(layout, header, body, footer, (text) => this.theme.fg("borderMuted", text));
  }
}
