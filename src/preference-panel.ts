import { decodeKittyPrintable, getKeybindings, Input, parseKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { focusLabel, panelConfirmation, panelHeader, panelLayout, type PanelLayoutProvider } from "./panel-layout.js";
import { confirmationKeyHints, discardKeyHints, fittingKeyHints, type KeyHint } from "./key-hints.js";
import { PromptInput } from "./prompt-input.js";
import { sanitizeTerminalText } from "./presentation.js";
import { selectionWindow } from "./selection-window.js";
import { renderPreferenceRow } from "./preference-row.js";
import type { SessionPreferenceChange, SessionPreferenceTarget } from "./app/session-preferences.js";
import { preferenceGroup, preferenceGroupOrder, RESULT_NOTE_HINT, composeRevision, preferenceContentKey, preferenceKey, preferenceSelectionLabel, preferenceValidationIssue, searchPreferences, selectPreference, PREFERENCE_SELECTION_LIMIT,
  type PreferenceLibrary, type PreferenceMetadata, type PreferenceRepository, type PreferenceScope, type PreferenceValue, type RevisionPreference, type SelectedPreference } from "./revision-preferences.js";

type TextField = "name" | "instruction" | "description";
type ChoiceField = "scope" | "type";
const FORM_FIELDS = ["name", "instruction", "scope", "type", "description", "save"] as const;
type FormField = typeof FORM_FIELDS[number];
type Form = {
  kind: "new" | "library";
  expected?: RevisionPreference;
  scope: PreferenceScope;
  name: Input;
  rawName: string;
  initialEditorName: string;
  body: PromptInput;
  description: Input;
  rawDescription: string;
  initialEditorDescription: string;
  metadata?: PreferenceMetadata;
  rawBody: string;
  initialEditorBody: string;
  initial: string;
  focus: FormField;
  editing: boolean;
  top: number;
};

type DocumentPart = { text: string; color: "text" | "muted" | "warning" | "error"; heading?: boolean };
type PreferenceDocument = DocumentPart[];
type Page = { kind: "list" } | { kind: "read"; title: string; document: PreferenceDocument; scroll: number }
  | { kind: "form"; form: Form } | { kind: "discard"; form: Form }
  | { kind: "delete"; entry: RevisionPreference; document: PreferenceDocument };
type Action = "new" | "edit" | "delete";
const ACTIONS = [
  { id: "new", key: "n", label: "Add" },
  { id: "edit", key: "e", label: "Edit" },
  { id: "delete", key: "d", label: "Delete" },
] as const;
const MANAGEMENT_HINTS: KeyHint[] = ACTIONS.map(({ key, label }) => [key, label]);
const KINDS = ["rewrite", "task", "result"] as const;
const SCOPES = ["project", "global"] as const;
const TYPE_LABELS = KINDS.map((kind) => preferenceGroup({ metadata: { kind, description: "", activation: "manual" } }));
const SHORT_TYPES = ["Rewrite", "Task", "Result"];
const TYPE_HELP = {
  rewrite: "Guides how Refine rewrites the prompt.",
  task: "Adds requirements for the main agent.",
  result: RESULT_NOTE_HINT,
};
const textEditBindings = ["cursorLineStart", "cursorLineEnd", "deleteToLineStart", "deleteToLineEnd",
  "deleteCharBackward", "deleteCharForward", "yank"] as const;
const isTextField = (field: FormField): field is TextField => field === "name" || field === "instruction" || field === "description";
const scopeLabel = (scope: PreferenceScope) => scope === "project" ? "Project" : "Global";

function moveFormFocus(form: Form, step: number): void {
  const fields: readonly FormField[] = form.kind === "new" ? FORM_FIELDS : FORM_FIELDS.filter((field) => field !== "scope");
  form.focus = fields[(fields.indexOf(form.focus) + step + fields.length) % fields.length]!;
  form.editing = false;
}

function cycleChoice<T>(values: readonly T[], current?: T): T {
  const index = current === undefined ? -1 : values.indexOf(current);
  return values[(index + 1) % values.length]!;
}

type PreferencePanelActions = { back(): void; updateSelection?(selected: SelectedPreference[]): string | undefined; session?: SessionPreferenceTarget };

export class PreferencePanel {
  private page: Page = { kind: "list" };
  private library: PreferenceLibrary = { entries: [], errors: {} };
  private allSearch = new Input({ prompt: "" });
  private selectedSearch = new Input({ prompt: "" });
  private get search(): Input { return this.selectedOnly ? this.selectedSearch : this.allSearch; }
  private selected: SelectedPreference[];
  private get selectable(): boolean { return this.purpose !== "manage" && this.purpose !== "audit"; }
  private get canManageEntries(): boolean { return this.purpose !== "audit" && !this.selectedOnly; }
  private get projectDefaultsEditable(): boolean {
    return !!this.repository.setProjectDefault && this.purpose !== "audit";
  }
  private focus: "search" | "list" = "list";
  private index = 0;
  private top = 0;
  private navigationDirection = 1;
  private selectedOnly = false;
  private allView: { index: number; top: number; direction: number; key?: string } = { index: 0, top: 0, direction: 1 };
  private contentVersion = 0;
  private entriesCache?: { query: string; version: number; entries: RevisionPreference[] };
  private descriptionCache?: { entry: RevisionPreference; version: number; compact: boolean; document: PreferenceDocument };
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
    private readonly actions: PreferencePanelActions,
    private readonly purpose: "revise" | "refine" | "session" | "manage" | "audit" = "revise",
    private readonly layout: PanelLayoutProvider = (width) => panelLayout(width, this.tui.terminal.rows),
  ) {
    this.selected = structuredClone([...selected]);
    this.selectedOnly = purpose === "audit";
    this.requirementsChars = composeRevision(this.selected, freeText).length;
    void this.refresh();
  }

  set focused(value: boolean) { this.hasFocus = value; this.updateFocus(); }
  private updateFocus(): void {
    const searching = this.hasFocus && this.page.kind === "list" && this.focus === "search";
    this.allSearch.focused = searching && !this.selectedOnly;
    this.selectedSearch.focused = searching && this.selectedOnly;
    const form = "form" in this.page ? this.page.form : undefined;
    if (form) {
      const editing = this.hasFocus && this.page.kind === "form" && form.editing;
      form.name.focused = editing && form.focus === "name";
      form.body.editor.focused = editing && form.focus === "instruction";
      form.description.focused = editing && form.focus === "description";
    }
  }
  dispose(): void { this.focused = false; this.disposed = true; }
  invalidate(): void {
    this.allSearch.invalidate();
    this.selectedSearch.invalidate();
    this.documents = [];
    if ("form" in this.page) this.page.form.body.editor.invalidate();
  }
  private redraw(): void { if (!this.disposed) { this.updateFocus(); this.tui.requestRender(); } }
  private entries(): RevisionPreference[] {
    const query = this.search.getValue();
    if (this.entriesCache?.query === query && this.entriesCache.version === this.contentVersion) return this.entriesCache.entries;
    // Keep deleted sources visible until their snapshots are explicitly deselected.
    const keys = new Set(this.library.entries.map(preferenceKey));
    const missingDefaults: RevisionPreference[] = (this.library.projectDefaults ?? []).filter((key) => !keys.has(key) &&
      !this.selected.some((entry) => preferenceKey(entry) === key)).map((key) => {
        const [scope, id] = key.split(":") as [RevisionPreference["scope"], string];
        return { scope, id, version: 1, name: `Unavailable default · ${id}`, body: "" };
      });
    const candidates = this.selectedOnly ? this.selected
      : [...this.library.entries, ...this.selected.filter((entry) => !keys.has(preferenceKey(entry))), ...missingDefaults];
    const matches = searchPreferences(candidates, query);
    // Selected snapshots are audited in composeRevision order, never search rank.
    const matchedKeys = new Set(matches.map(preferenceKey));
    const entries = this.selectedOnly ? this.selected.filter((entry) => matchedKeys.has(preferenceKey(entry)))
      : matches.sort((a, b) => preferenceGroupOrder(a) - preferenceGroupOrder(b));
    this.entriesCache = { query, version: this.contentVersion, entries };
    return entries;
  }
  private highlighted(): RevisionPreference | undefined { return this.entries()[this.index]; }
  private toggleView(): void {
    if (!this.selectedOnly) {
      const entry = this.highlighted();
      this.allView = { index: this.index, top: this.top, direction: this.navigationDirection, key: entry && preferenceKey(entry) };
      this.navigationDirection = 1;
      this.selectedOnly = true;
      // Each audit starts unfiltered, including snapshots hidden by the all-view query.
      this.selectedSearch = new Input({ prompt: "" });
      this.index = 0;
      this.top = 0;
      this.contentVersion++;
    } else {
      this.selectedOnly = false;
      this.contentVersion++;
      const index = this.entries().findIndex((entry) => preferenceKey(entry) === this.allView.key);
      this.index = index >= 0 ? index : Math.min(this.allView.index, Math.max(0, this.entries().length - 1));
      this.top = this.allView.top;
      this.navigationDirection = this.allView.direction;
    }
  }
  private local(entry?: RevisionPreference): SelectedPreference | undefined {
    return entry && this.selected.find((item) => preferenceKey(item) === preferenceKey(entry));
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
      this.setLibrary(library);
      const index = identity ? this.entries().findIndex((entry) => preferenceKey(entry) === preferenceKey(identity)) : 0;
      this.index = Math.max(0, index);
    } catch (error) {
      if (!this.disposed) this.setLibrary({ ...this.library, errors: { project: this.error(error), global: this.error(error) } });
    } finally { this.busy = false; this.redraw(); }
  }
  private error(error: unknown): string { return error instanceof Error ? error.message : "Could not access preference library."; }
  private setLibrary(library: PreferenceLibrary): void {
    this.library = library;
    if (this.actions.session) this.setSelection(this.actions.session.read(library));
    else this.contentVersion++;
  }
  private setSelection(selected: SelectedPreference[]): void {
    this.selected = selected;
    this.contentVersion++;
    this.requirementsChars = composeRevision(selected, this.freeText).length;
    this.index = Math.min(this.index, Math.max(0, this.entries().length - 1));
  }
  private updateSelection(selected: SelectedPreference[]): boolean {
    if (!this.actions.updateSelection) return false;
    const error = this.actions.updateSelection(structuredClone(selected));
    if (error) { this.setNotice(error, "warning"); return false; }
    this.setSelection(selected);
    return true;
  }
  private changeSessionSelection(change: SessionPreferenceChange): boolean {
    const session = this.actions.session;
    if (!session) return false;
    const error = session.change(this.library, change);
    if (error) { this.setNotice(error, "warning"); return false; }
    this.setSelection(session.read(this.library));
    return true;
  }
  private toggle(): void {
    const entry = this.highlighted();
    if (!entry) return;
    const index = this.selected.findIndex((item) => preferenceKey(item) === preferenceKey(entry));
    if (index < 0 && (!this.source(entry) || this.library.errors[entry.scope])) {
      this.setNotice("Library entry unavailable or deleted; no selection applied.", "warning");
    } else if (index < 0 && this.selected.some((item) => preferenceContentKey(item) === preferenceContentKey(entry))) {
      this.setNotice("Same requirements already selected. Use Selected only (s) to inspect or remove them.", "warning");
    } else if (this.actions.session) this.changeSessionSelection({ kind: "set", key: preferenceKey(entry), enabled: index < 0 });
    else if (index >= 0) this.updateSelection(this.selected.filter((_, i) => i !== index));
    else if (this.selected.length >= PREFERENCE_SELECTION_LIMIT) this.setNotice(`Select at most ${PREFERENCE_SELECTION_LIMIT} preferences for one ${this.purpose === "refine" ? "refinement" : "revision"}.`, "warning");
    else this.updateSelection([...this.selected, selectPreference(entry)]);
  }
  private async toggleProjectDefault(): Promise<void> {
    const entry = this.highlighted();
    if (!entry || !this.repository.setProjectDefault) return;
    const enabled = !this.library.projectDefaults?.includes(preferenceKey(entry));
    this.busy = true; this.redraw();
    try {
      const library = await this.repository.setProjectDefault(entry, enabled);
      if (this.disposed) return;
      this.setLibrary(library);
      this.setNotice(`Project default ${enabled ? "enabled" : "disabled"}; ${this.actions.session ? "session overrides kept." : "current selection unchanged."}`);
    } catch (error) {
      if (!this.disposed) this.setNotice(`Project default not saved: ${this.error(error)}`, "error");
    } finally { this.busy = false; this.redraw(); }
  }
  private source(entry: RevisionPreference): RevisionPreference | undefined {
    return this.library.entries.find((item) => preferenceKey(item) === preferenceKey(entry));
  }
  private description(entry: RevisionPreference, compact = false): PreferenceDocument {
    if (this.descriptionCache?.entry === entry && this.descriptionCache.version === this.contentVersion &&
      this.descriptionCache.compact === compact) return this.descriptionCache.document;
    const local = this.local(entry);
    const source = this.source(entry);
    const changed = local && source && (source.version !== local.version || source.body !== local.sourceBody || source.name !== local.name ||
      JSON.stringify(source.metadata) !== JSON.stringify(local.metadata));
    const unavailable = !!this.library.errors[entry.scope];
    const status = local ? [local.body !== local.sourceBody ? "Edited for this revision" : "Saved snapshot",
      unavailable ? "Library unavailable" : !source ? "Source deleted" : changed ? "Library changed; snapshot kept" : ""].filter(Boolean).join(" · ") : "Library entry";
    const gap = { text: "", color: "text" } as const;
    const details = (value: RevisionPreference, state: PreferenceDocument): PreferenceDocument => {
      const group = value.metadata ? `${preferenceGroup(value)}${compact ? ""
        : "selectionSource" in value && value.selectionSource === "project-default" ? " · project default" : " · manual"}` : "";
      const projectDefault = this.repository.setProjectDefault && (!compact || this.projectDefaultsEditable)
        ? `Project default: ${this.library.projectDefaults?.includes(preferenceKey(value)) ? "On" : "Off"}` : "";
      const metadata = compact ? [[group, projectDefault].filter(Boolean).join(" · ")]
        : [`${value.scope} · ${value.id}`, projectDefault && `${projectDefault} · future drafts`, group];
      const description = [
        compact && value.metadata?.description === value.name ? "" : value.metadata?.description,
        value.metadata?.kind === "result" ? RESULT_NOTE_HINT : "",
      ].filter((text): text is string => !!text);
      return [
        { text: value.name, color: "text", heading: true },
        ...metadata.filter(Boolean).map((text) => ({ text, color: "muted" as const })),
        ...state,
        ...(description.length ? [gap, ...description.map((text) => ({ text, color: "muted" as const }))] : []),
        ...(value.body ? [gap, { text: value.body, color: "text" as const }] : []),
      ];
    };
    let document: PreferenceDocument;
    if (this.actions.session) {
      const override = this.actions.session.override(preferenceKey(entry));
      document = details(entry, [{ text: `This session: ${override === undefined ? "Inherits project default" : override ? "On" : "Off"}`, color: "muted" },
        ...(!source || unavailable ? [{ text: unavailable ? "Library unavailable" : "Deleted source", color: "warning" as const }] : [])]);
    } else if (this.selectedOnly && local) {
      document = [{ text: "Selected snapshot", color: "text", heading: true }, ...details(local, [
        { text: status, color: unavailable || !source || changed ? "warning" : "muted" },
        ...(!compact ? [{ text: preferenceSelectionLabel(local), color: "muted" as const }] : []),
      ])];
      if (source && !unavailable && (changed || source.body !== local.body)) document.push(
        { text: "", color: "text" }, { text: "Current library entry", color: "text", heading: true }, ...details(source, []));
    } else {
      const differentSnapshot = local && (changed || local.body !== entry.body);
      document = details(entry, differentSnapshot ? [{ text: "Current library version · not the selected snapshot", color: "warning" }]
        : compact && source && !unavailable ? [] : [{ text: unavailable ? "Library unavailable" : source ? "Library entry" : "Deleted source",
          color: unavailable || !source ? "warning" : "muted" }]);
      if (local) document.push({ text: "", color: "text" }, { text: "Selected snapshot", color: "text", heading: true },
        { text: status, color: unavailable || !source || changed ? "warning" : "muted" },
        ...(!local.metadata && !compact ? [{ text: preferenceSelectionLabel(local), color: "muted" as const }] : []),
        ...(local.metadata ? compact ? [
          { text: preferenceGroup(local), color: "muted" as const },
          { text: local.metadata.description, color: "muted" as const },
        ] : [{ text: `${local.metadata.kind} · ${preferenceSelectionLabel(local)} · ${local.metadata.description}`, color: "muted" as const }] : []),
        gap, { text: local.body, color: "text" });
    }
    this.descriptionCache = { entry, version: this.contentVersion, compact, document };
    return document;
  }
  private read(title: string, document: PreferenceDocument): void { this.page = { kind: "read", title, document, scroll: 0 }; }
  private listHelp(): PreferenceDocument {
    return [
      "Tab / Shift+Tab   Switch between list and Search",
      "Esc   Back (leave Search first)",
      "/   Search by name or instruction",
      "↑↓ / PgUp / PgDn   Browse entries",
      "Enter   Read the highlighted entry (leave Search first)",
      ...(this.purpose !== "audit" ? ["s   Switch between All and Selected only"] : []),
      ...(this.selectable ? ["Space   Save the highlighted selection", "c   Clear selections"] : []),
      ...(this.projectDefaultsEditable ? ["g   Toggle the highlighted project default"] : []),
      ...(this.selectable && this.actions.session ? ["r   Follow the project default for this item"] : []),
      ...(this.purpose !== "audit" ? ["n / e / d   Add, edit, or delete in Library (All)"] : []),
    ].map((text) => ({ text, color: "text" }));
  }
  private bodyText(form: Form): string {
    const text = form.body.editor.getExpandedText();
    // Native Editor normalizes tabs on setText; preserve untouched saved literals.
    return text === form.initialEditorBody ? form.rawBody : text;
  }
  private formValue(form: Form): PreferenceValue {
    const editedName = form.name.getValue();
    // Display sanitization must not silently rewrite an untouched saved name.
    const name = editedName === form.initialEditorName ? form.rawName : editedName;
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
    body.editor.disableSubmit = true;
    const rawBody = entry?.body ?? this.freeText;
    body.editor.setText(rawBody);
    const rawName = entry?.name ?? "";
    const name = new Input({ prompt: "" }); name.setValue(sanitizeTerminalText(rawName).replace(/\n/g, " "));
    const rawDescription = entry?.metadata?.description ?? "";
    const description = new Input({ prompt: "" }); description.setValue(sanitizeTerminalText(rawDescription).replace(/\n/g, " "));
    const form: Form = { kind, scope: entry?.scope === "global" ? "global" : "project", name, rawName, initialEditorName: name.getValue(),
      body, rawBody, initialEditorBody: body.editor.getExpandedText(),
      description, rawDescription, initialEditorDescription: description.getValue(),
      metadata: entry ? entry.metadata && structuredClone(entry.metadata) : { kind: "task", description: "", activation: "manual" },
      expected: kind === "library" ? structuredClone(entry) : undefined, initial: "",
      focus: kind === "library" ? "instruction" : "name", editing: false, top: 0 };
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
      if (source.scope === "builtin") {
        if (action === "edit") {
          this.openForm("new", source);
          this.setNotice("Editing a new copy of this built-in preference.");
        } else this.setNotice("Built-in preference. Use g to change its project default.", "warning");
        return;
      }
      if (action === "edit") this.openForm("library", source);
      else this.page = { kind: "delete", entry: structuredClone(source), document: [
        { text: `${source.name.replace(/\n/g, " ")} · ${source.scope === "global" ? "Global" : "Project"}`, color: "muted" },
        { text: source.body.trim(), color: "text" },
        ...(this.local(source) ? [{ text: "Selected snapshot kept", color: "muted" } as const] : []),
      ] };
    }
  }
  private async save(form: Form): Promise<void> {
    const value = this.formValue(form);
    const issue = preferenceValidationIssue(value);
    if (issue) {
      form.focus = issue.field;
      form.editing = isTextField(issue.field);
      this.setNotice(issue.message, "warning");
      this.redraw();
      return;
    }
    this.busy = true; this.redraw();
    try {
      const saved = await this.repository.save(form.scope, value, form.expected);
      if (this.disposed) return;
      this.page = { kind: "list" }; this.setNotice("Saved to library; current selection unchanged.");
      if (form.kind === "new") {
        const reset = !!this.allSearch.getValue().trim();
        this.allSearch = new Input({ prompt: "" });
        this.top = 0;
        this.navigationDirection = 1;
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
      this.page = { kind: "list" }; this.setNotice(this.actions.session ? "Deleted from library; existing prompts unchanged." : "Deleted from library; selected snapshots kept.");
      await this.refresh();
    } catch (error) { if (!this.disposed) { this.page = { kind: "list" }; this.setNotice(this.error(error), "error"); } }
    finally { this.busy = false; this.redraw(); }
  }

  private handleForm(form: Form, data: string, key: string | undefined, cancel: boolean, enter: boolean, step: number): void {
    if (key === "tab" || key === "shift+tab") {
      moveFormFocus(form, key === "tab" ? 1 : -1);
    } else if (cancel) {
      if (form.editing) form.editing = false;
      else this.page = this.stamp(form) === form.initial ? { kind: "list" } : { kind: "discard", form };
    } else if (form.editing && isTextField(form.focus)) {
      if (enter && form.focus !== "instruction") moveFormFocus(form, 1);
      else this.editFormField(form, form.focus, data, enter);
    } else if (step) {
      moveFormFocus(form, step);
    } else if (enter || key === "space") {
      if (isTextField(form.focus)) form.editing = true;
      else if (form.focus === "save") void this.save(form);
      else if (form.focus === "type") form.metadata = { kind: cycleChoice(KINDS, form.metadata?.kind),
        description: form.description.getValue(), activation: "manual" };
      else if (form.kind === "new") form.scope = cycleChoice(SCOPES, form.scope);
    } else if (isTextField(form.focus) &&
      (data.startsWith("\x1b[200~") || decodeKittyPrintable(data) !== undefined || /^[^\p{Cc}]+$/u.test(data) ||
        textEditBindings.some((action) => getKeybindings().matches(data, `tui.editor.${action}`)))) {
      form.editing = true;
      this.editFormField(form, form.focus, data, false);
    }
  }

  private editFormField(form: Form, field: TextField, data: string, enter: boolean): void {
    if (field === "instruction") {
      if (enter) form.body.editor.insertTextAtCursor("\n");
      else form.body.editor.handleInput(data);
    } else {
      const input = form[field];
      const before = input.getValue();
      input.handleInput(data);
      if (field === "description" && input.getValue() !== before) form.metadata ??= { kind: "task", description: "", activation: "manual" };
    }
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    const key = parseKey(data)?.toLowerCase();
    if (key && /(^|\+)f\d+$/.test(key)) return;
    const cancel = this.keys.matches(data, "tui.select.cancel") || key === "ctrl+\\";
    if (this.busy) {
      if (cancel && this.page.kind === "list") { this.actions.back(); this.redraw(); }
      return;
    }
    if (key === "ctrl+s") {
      if (this.page.kind === "form") { void this.save(this.page.form); return; }
      this.setNotice(this.purpose === "manage" ? "Library management only; no request sent."
        : this.purpose === "audit" ? "Read-only snapshot; no request sent."
        : this.purpose === "session" ? "Session choices are saved on Space; no request sent."
        : this.purpose === "refine" ? "Return to the Unsent original and press Enter to refine." : "Return to Revise to request revision with Ctrl+S.");
      this.redraw(); return;
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
      const step = this.keys.matches(data, "tui.select.up") ? -1 : this.keys.matches(data, "tui.select.down") ? 1 : 0;
      this.handleForm(this.page.form, data, key, cancel, enter, step);
    } else if (cancel) {
      if (this.focus === "search" && key !== "ctrl+\\") this.focus = "list";
      else this.actions.back();
    } else if (key === "alt+enter") return;
    else if (key === "tab" || key === "shift+tab") {
      this.focus = this.focus === "search" ? "list" : "search";
    } else if (this.focus === "search") {
      if (enter || key === "down") this.focus = "list";
      else { this.search.handleInput(data); this.index = 0; this.top = 0; this.navigationDirection = 1; }
    } else if (key === "s" && this.purpose !== "audit") this.toggleView();
    else if (key === "?") this.read("Preferences keys", this.listHelp());
    else if (key === "c" && this.selectable) {
      const cleared = this.actions.session ? this.changeSessionSelection({ kind: "clear" }) : this.selected.length && this.updateSelection([]);
      if (cleared) this.setNotice("Selection cleared; project defaults unchanged.");
    } else if (key === "g" && this.projectDefaultsEditable) void this.toggleProjectDefault();
    else if (key === "r" && this.selectable && this.actions.session) {
      const entry = this.highlighted();
      if (entry && this.changeSessionSelection({ kind: "inherit", key: preferenceKey(entry) })) this.setNotice("Session now follows the project default for this item.");
    } else if (key === "/") this.focus = "search";
    else {
      const action = this.canManageEntries && ACTIONS.find((action) => action.key === key);
      if (action) { this.activate(action.id); this.redraw(); return; }
      const max = Math.max(0, this.entries().length - 1);
      if (key === "up" || key === "pageup" || key === "home") this.navigationDirection = -1;
      else if (key === "down" || key === "pagedown" || key === "end") this.navigationDirection = 1;
      if (key === "up") this.index = this.index <= 0 ? max : this.index - 1;
      else if (key === "down") this.index = this.index >= max ? 0 : this.index + 1;
      else if (key === "pageup") this.index = Math.max(0, this.index - this.viewport);
      else if (key === "pagedown") this.index = Math.min(max, this.index + this.viewport);
      else if (key === "home") this.index = 0;
      else if (key === "end") this.index = max;
      else if (key === "space") {
        if (this.selectable) this.toggle();
        else this.setNotice(this.purpose === "audit" ? "Read-only snapshot. Edit choices in Preview."
          : "Select an Unsent original or open Revise to change preferences.", "warning");
      } else if (enter) {
        const entry = this.highlighted();
        if (entry) this.read(this.purpose === "audit" ? "Adopted preference" : this.purpose === "manage" || this.purpose === "session" ? "Preference details"
          : this.purpose === "refine" ? "Full editing instruction" : "Full revision instruction", this.description(entry));
      }
    }
    this.redraw();
  }

  private textField(input: Input, label: string, width: number, active: boolean): string {
    if (width < 3) return active && input.focused ? input.render(width)[0]! : focusLabel(this.theme, width, label, active);
    const prefix = focusLabel(this.theme, width - Math.min(4, width - 2), label, active) + " ";
    const remaining = width - visibleWidth(prefix);
    const value = active && input.focused ? input.render(remaining)[0]!
      : truncateToWidth(sanitizeTerminalText(input.getValue()).replace(/\n/g, " "), remaining, "…");
    return prefix + this.theme.fg("text", value);
  }

  private renderChoiceField(form: Form, field: ChoiceField, width: number, height: number): string[] {
    const { theme } = this;
    const active = field === form.focus;
    if (field === "scope" && form.kind === "library") {
      return [focusLabel(theme, width, `Scope: ${scopeLabel(form.scope)} (fixed)`, false)];
    }

    const label = field === "scope" ? "Scope:" : "Type:";
    const scopeLabels = SCOPES.map(scopeLabel);
    const labels = field === "scope" ? scopeLabels : TYPE_LABELS;
    const short = field === "scope" ? scopeLabels : SHORT_TYPES;
    const selected = field === "scope" ? SCOPES.indexOf(form.scope)
      : form.metadata ? KINDS.indexOf(form.metadata.kind) : -1;
    const prefix = (active ? "" : "  ") + focusLabel(theme, width, label.padEnd(6), active) + " ";
    const available = width - visibleWidth(prefix);
    if (available < 1) return [focusLabel(theme, width, label, active)];

    const cell = (name: string, index: number) => {
      const checked = index === selected;
      return theme.fg(checked ? "text" : "muted", `${checked ? "●" : "○"} ${name}`);
    };
    const pack = (names: readonly string[]) => {
      const lines: string[] = [];
      for (const [index, name] of names.entries()) {
        const option = cell(name, index);
        const last = lines.at(-1);
        if (last && visibleWidth(last + "  " + option) <= available) lines[lines.length - 1] = last + "  " + option;
        else lines.push(option);
      }
      return lines;
    };
    const names = labels.map((name, i) => visibleWidth(name) + 2 <= available ? name : short[i]!);
    const full = pack(names);
    const lines = full.length <= height ? full : pack(short);
    if (lines.length > height) {
      const value = selected < 0 ? "Unclassified" : `● ${short[selected]}`;
      return [prefix + theme.fg("text", truncateToWidth(value, available, "…"))];
    }
    const indent = " ".repeat(visibleWidth(prefix));
    return lines.map((line, i) => (i === 0 ? prefix : indent) + truncateToWidth(line, available, "…"));
  }

  private renderForm(form: Form, width: number, height: number): string[] {
    const scope = this.renderChoiceField(form, "scope", width, height);
    const type = this.renderChoiceField(form, "type", width, height);
    const fixedRows = scope.length + type.length + 4;
    if (width >= 32 && height >= fixedRows + 2) {
      const help = form.metadata ? TYPE_HELP[form.metadata.kind] : "Current type: Unclassified (legacy)";
      type.push(this.theme.fg("muted", "  " + truncateToWidth(help, width - 2, "…")));
    }

    const active = form.focus === "instruction";
    const instructionLabel = focusLabel(this.theme, width, "Instruction:", active);
    const instruction = height > 1
      ? [instructionLabel, ...form.body.render(width, Math.max(1, height - scope.length - type.length - 4))]
      : form.body.editor.focused ? form.body.render(width, 1) : [instructionLabel];
    const blocks: Record<FormField, string[]> = {
      name: [this.textField(form.name, "Name:", width, form.focus === "name")],
      instruction,
      scope,
      type,
      description: [this.textField(form.description, "Description:", width, form.focus === "description")],
      save: [focusLabel(this.theme, width, "Save to library", form.focus === "save")],
    };
    const rows = FORM_FIELDS.flatMap((field) => blocks[field]);
    const focusStart = FORM_FIELDS.slice(0, FORM_FIELDS.indexOf(form.focus))
      .reduce((index, field) => index + blocks[field].length, 0);
    const focusEnd = focusStart + blocks[form.focus].length;
    const maxStart = Math.max(0, rows.length - height);
    const start = Math.min(form.top, maxStart);
    form.top = Math.max(0, Math.min(focusStart, Math.max(start, focusEnd - height), maxStart));
    return rows.slice(form.top, form.top + height);
  }

  render(width: number): string[] {
    if (width < 1) return [];
    const layout = this.layout(width);
    const { innerWidth: w } = layout;
    const clean = (text: string) => sanitizeTerminalText(text);
    const wrap = (text: string, columns = w) => wrapTextWithAnsi(clean(text), columns);
    const { selectable } = this;
    const managing = this.purpose === "manage";
    const audit = this.purpose === "audit";
    const session = this.purpose === "session";
    const searching = this.focus === "search";
    const target = this.purpose === "refine" ? "Unsent original" : session ? "This session" : "This revision";
    const selectionLabel = `${this.selected.length} selected`;
    const selectionScope = !selectable ? " (read-only)" : session ? " · Future prompts" : "";
    let title = managing ? "Preferences library" : audit ? "Adopted preferences" : `Preferences · ${target}`;
    let subtitle = "";
    let subtitleColor: DocumentPart["color"] = "muted";
    let renderBody: (height: number) => string[];
    const viewHint: KeyHint = ["s", this.selectedOnly ? "All" : "Selected only"];
    const border = (line: string) => this.theme.fg("borderMuted", line);
    const back: KeyHint = ["Esc", "Back"];
    let hints: KeyHint[] = [back, ["Tab", "Focus"], ["?", "Keys"]];
    const page = this.page;
    if (page.kind === "read") {
      title = page.title;
      renderBody = (h) => {
        const lines = this.document(page.document, w);
        this.viewport = h;
        page.scroll = Math.min(page.scroll, Math.max(0, lines.length - h));
        return lines.slice(page.scroll, page.scroll + h);
      };
      hints = [back, [w >= 37 ? "↑↓ / PgUp / PgDn" : "↑↓", "Scroll"]];
    } else if (page.kind === "discard" || page.kind === "delete") {
      const discard = page.kind === "discard";
      title = discard ? "Discard unsaved form?" : "Delete library entry?";
      const actions = discard ? discardKeyHints(w, this.theme) : confirmationKeyHints(["Esc", "Cancel"], ["y", "Delete"], w, this.theme);
      const detail = discard ? [] : this.document(page.document, Math.min(w, 56)).slice(0, 5);
      return panelConfirmation(layout, this.theme.fg("warning", this.theme.bold(title)), actions, detail, border);
    } else if (page.kind === "form") {
      const form = page.form;
      title = form.kind === "library" ? "Edit library entry" : "Save new preference";
      renderBody = (h) => this.renderForm(form, w, h);
      const compact = w < 30;
      const editing = form.editing;
      const action: KeyHint = [w < 46 ? "↵" : editing ? "Enter" : "Enter/Space",
        editing ? form.focus === "instruction" ? compact ? "NL" : "Newline" : "Next"
          : form.focus === "scope" || form.focus === "type" ? w >= 72 ? "Next option" : "Next" : form.focus === "save" ? "Save" : "Edit"];
      hints = [["Esc", w < 20 ? "" : editing ? "Done" : "Back"], [w < 36 ? "^S" : "Ctrl+S", w >= 72 ? "Save to library" : w >= 11 ? "Save" : ""],
        ...(editing ? [] : [["↑↓", w >= 56 ? "Fields" : ""] as const]), action];
    } else {
      const entries = this.entries();
      this.index = Math.min(this.index, Math.max(0, entries.length - 1));
      const errors = Object.values(this.library.errors);
      const status = this.selectedOnly && !this.selected.length
        ? audit ? "No adopted preferences" : "No selections" : !this.library.entries.length && !this.selected.length
          ? "Library is empty" : !entries.length ? "No matches" : "";
      const source = entries[this.index] && this.source(entries[this.index]!);
      const toggle: KeyHint | undefined = !searching && selectable && entries.length
        ? ["Space", this.selectedOnly ? "Deselect" : "Toggle"] : undefined;
      const project: KeyHint | undefined = !searching && this.projectDefaultsEditable && entries.length ? ["g", "Project default"] : undefined;
      renderBody = (h) => {
        const view = !audit && (selectable || this.selected.length) ? [viewHint] : [];
        const context: KeyHint[] = searching ? [["Enter", "Browse"]]
          : [...(toggle ? [toggle] : []), ...(this.selectedOnly ? view : []), ...(entries.length ? [["Enter", "Read"] as const] : []),
            ...(project ? [project] : []), ...(!this.selectedOnly ? view : []),
            ...(selectable && this.selected.length ? [["c", "Clear all"] as const] : [])];
        const shortSelection = !!toggle && !!project && h < 6;
        const contextHints = shortSelection ? fittingKeyHints([["Space", ""], ["g", "Default"]], w, this.theme)
          : fittingKeyHints(context, w, this.theme);
        const statusRows = subtitle ? [feedback] : [];
        const footer = contextHints && (h >= statusRows.length + 5 || shortSelection) ? [contextHints] : [];
        const height = h - statusRows.length - footer.length;
        const room = height >= 3;
        const split = height >= 5 && w >= 76;
        const leftWidth = split ? Math.floor(w * 0.43) : w;
        const managementRow = this.canManageEntries && height >= 4;
        const managementHints = managementRow && !searching
          ? fittingKeyHints(MANAGEMENT_HINTS.slice(0, !source ? 1 : source.scope === "builtin" ? 2 : 3), leftWidth, this.theme) : "";
        const available = Math.max(1, height - (room ? 2 + Number(managementRow) : 0));
        const search = [this.textField(this.search, "Search:", leftWidth, searching)];
        const window = selectionWindow(entries.length, this.index, available, this.top,
          this.selectedOnly ? undefined : (index) => preferenceGroup(entries[index]!), available >= 10 ? 1 : 0, this.navigationDirection);
        this.top = window.start;
        const rows = window.rows;
        this.viewport = Math.max(1, rows.filter((row) => typeof row === "number").length);
        const list = rows.map((row) => {
          if (typeof row === "string") return this.theme.fg("text", this.theme.bold(truncateToWidth(row, leftWidth, "…")));
          const entry = entries[row]!;
          const current = row === this.index;
          const active = !searching && current;
          const local = this.local(entry);
          const source = this.source(entry);
          const unavailable = !!this.library.errors[entry.scope];
          const changed = local && source && (local.version !== source.version || local.name !== source.name || local.sourceBody !== source.body ||
            JSON.stringify(local.metadata) !== JSON.stringify(source.metadata));
          const warning = unavailable ? "unavailable" : !source ? "deleted" : changed ? "snapshot kept" : "";
          const cursor = active ? "›" : current ? "·" : " ";
          return renderPreferenceRow({ width: leftWidth, name: entry.name, scope: entry.scope,
            selected: !!local, selectionEditable: selectable, focused: active, cursor, warning,
            projectDefault: this.library.projectDefaults?.includes(preferenceKey(entry)) }, this.theme);
        });
        if (!entries.length && !errors.length) list.push(...wrap(status, leftWidth).map((line) => this.theme.fg("muted", line)));
        if (!room) {
          return [...statusRows, ...(searching ? search : list).slice(0, Math.max(1, height)), ...footer];
        }
        const rightWidth = split ? w - leftWidth - 3 : w;
        const detail = split && entries[this.index] ? this.document(this.description(entries[this.index]!, true), rightWidth) : [];
        const countLabel = ` ${entries.length ? this.index + 1 : 0}/${entries.length}`;
        const headingText = this.theme.fg("text", this.theme.bold(`${audit ? "Adopted" : this.selectedOnly ? "Selected only" : "Library"}${countLabel}`));
        const count = this.theme.fg("muted", ` · ${selectionLabel}${selectionScope}`);
        const compactCount = this.theme.fg("muted", ` · ${selectionLabel}`);
        const suffix = !managing || this.selected.length
          ? [count, compactCount].find((label) => visibleWidth(headingText + label) <= leftWidth) : undefined;
        const heading = truncateToWidth(suffix ? headingText + suffix
          : selectable ? this.theme.fg("muted", selectionLabel) : headingText, leftWidth, "");
        const left = [...search, heading, ...(managementRow ? [managementHints] : []), ...list];
        if (!split) return [...statusRows, ...Array.from({ length: height }, (_, i) => left[i] ?? ""), ...footer];
        const divider = this.theme.fg("borderMuted", " │ ");
        return [...statusRows, ...Array.from({ length: height }, (_, i) => {
          const line = left[i] ?? "";
          return line + " ".repeat(Math.max(0, leftWidth - visibleWidth(line))) + divider + (detail[i] ?? "");
        }), ...footer];
      };
      if (errors.length) { subtitle = `Load failed · ${errors.join(" · ")}`; subtitleColor = "error"; }
      else if (selectable && this.selected.length > PREFERENCE_SELECTION_LIMIT) {
        subtitle = `Too many selected · limit ${PREFERENCE_SELECTION_LIMIT}`; subtitleColor = "warning";
      } else if (selectable && this.requirementsChars > this.maxChars) {
        subtitle = `Too long · ${this.requirementsChars}/${this.maxChars} chars`; subtitleColor = "warning";
      }
    }
    if (this.busy) { subtitle = "Working…"; subtitleColor = "muted"; }
    else if (this.notice && (this.noticeColor !== "muted" || subtitleColor === "muted")) {
      subtitleColor = this.noticeColor;
      subtitle = this.notice;
    }
    const severe = subtitleColor !== "muted";
    const feedback = this.theme.fg(subtitleColor, clean(`${severe ? "⚠ " : ""}${subtitle}`));
    const heading = (text: string) => this.theme.fg("text", this.theme.bold(text));
    let headline = heading(clean(title));
    let actions = fittingKeyHints(hints, w, this.theme, w < 30 && page.kind === "form" ? " " : " · ");
    if (page.kind === "list" && layout.headerHeight > 0) {
      const shortTitle = managing ? "Library" : audit ? "Adopted" : this.purpose === "refine" ? "Unsent" : session ? "Session" : "Revision";
      const shownTitle = visibleWidth(title) + 3 + visibleWidth("Esc Tab ?") <= w ? title : shortTitle;
      const hintWidth = w - visibleWidth(shownTitle) - 3;
      const compact: KeyHint[] = [back, ["Tab", ""], ["?", "Keys"]];
      const bare: KeyHint[] = [["Esc", ""], ["Tab", ""], ["?", ""]];
      const [controls, separator] = visibleWidth(fittingKeyHints(hints, Infinity, this.theme)) <= hintWidth ? [hints, " · "]
        : visibleWidth(fittingKeyHints(compact, Infinity, this.theme, " ")) <= hintWidth ? [compact, " "] : [bare, " "];
      const shownHints = fittingKeyHints(searching ? controls.slice(0, 2) : controls, hintWidth, this.theme, separator);
      headline = heading(shownTitle) + (shownHints ? "   " + shownHints : "");
      actions = "";
    }
    const formFeedback = page.kind === "form" && !!subtitle;
    const chrome = panelHeader(layout, [formFeedback && layout.headerHeight === 1 ? feedback : headline,
      formFeedback ? feedback : ""], [], actions);
    const body = renderBody(chrome.layout.bodyHeight);
    if (formFeedback && layout.headerHeight === 0) body.unshift(feedback);
    return chrome.render(body, border);
  }
}
