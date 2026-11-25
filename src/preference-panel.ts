import { Input, parseKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { panelHeader, panelLayout, type PanelLayoutProvider } from "./panel-layout.js";
import { alignedKeyHints, fittingKeyHints, formatKeyHint, type KeyHint } from "./key-hints.js";
import { PromptInput } from "./prompt-input.js";
import { sanitizeTerminalText } from "./presentation.js";
import { selectionWindow } from "./selection-window.js";
import { renderPreferenceRow } from "./preference-row.js";
import type { SessionPreferenceChange, SessionPreferenceTarget } from "./app/session-preferences.js";
import { preferenceGroup, preferenceGroupOrder, RESULT_NOTE_HINT, composeRevision, preferenceContentKey, preferenceKey, preferenceSelectionLabel, preferenceValidation, searchPreferences, selectPreference, PREFERENCE_SELECTION_LIMIT,
  type PreferenceLibrary, type PreferenceMetadata, type PreferenceRepository, type PreferenceScope, type PreferenceValue, type RevisionPreference, type SelectedPreference } from "./revision-preferences.js";

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

type PreferencePanelActions = { back(): void; updateSelection?(selected: SelectedPreference[]): string | undefined; session?: SessionPreferenceTarget };

/** Draft selection and library management have separate controls; neither submits a request. */
export class PreferencePanel {
  private page: Page = { kind: "list" };
  private library: PreferenceLibrary = { entries: [], errors: {} };
  private allSearch = new Input({ prompt: "Search: " });
  private selectedSearch = new Input({ prompt: "Search: " });
  private get search(): Input { return this.selectedOnly ? this.selectedSearch : this.allSearch; }
  private selected: SelectedPreference[];
  private libraryMode = false;
  private get managing(): boolean { return this.purpose === "manage" || this.libraryMode; }
  private get selectable(): boolean { return !this.managing && this.purpose !== "audit"; }
  private get projectDefaultsEditable(): boolean {
    return !!this.repository.setProjectDefault && (this.managing || this.purpose === "refine" || this.purpose === "session");
  }
  private focus = 1;
  private actionIndex = 0;
  private index = 0;
  private top = 0;
  private navigationDirection = 1;
  private selectedOnly = false;
  private allView: { index: number; top: number; direction: number; key?: string } = { index: 0, top: 0, direction: 1 };
  private contentVersion = 0;
  private entriesCache?: { query: string; version: number; entries: RevisionPreference[] };
  private descriptionCache?: { entry: RevisionPreference; version: number; compact: boolean; managing: boolean; document: PreferenceDocument };
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
      this.selectedSearch = new Input({ prompt: "Search: " });
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
  private back(): void {
    if (this.libraryMode) {
      this.libraryMode = false;
      this.focus = 1;
    } else this.actions.back();
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
    const managing = this.managing;
    if (this.descriptionCache?.entry === entry && this.descriptionCache.version === this.contentVersion &&
      this.descriptionCache.compact === compact && this.descriptionCache.managing === managing) return this.descriptionCache.document;
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
    // Delete confirmation still describes its current-source operation target.
    if (this.actions.session) {
      const override = this.actions.session.override(preferenceKey(entry));
      document = details(entry, [{ text: `This session: ${override === undefined ? "Inherits project default" : override ? "On" : "Off"}`, color: "muted" },
        ...(!source || unavailable ? [{ text: unavailable ? "Library unavailable" : "Deleted source", color: "warning" as const }] : [])]);
    } else if (this.selectedOnly && local && this.page.kind !== "delete") {
      document = [{ text: "Selected snapshot", color: "text", heading: true }, ...details(local, [
        { text: status, color: unavailable || !source || changed ? "warning" : "muted" },
        ...(!compact ? [{ text: preferenceSelectionLabel(local), color: "muted" as const }] : []),
      ])];
      if (source && !unavailable && (changed || source.body !== local.body)) document.push(
        { text: "", color: "text" }, { text: "Current library entry", color: "text", heading: true }, ...details(source, []));
    } else {
      const differentSnapshot = local && (changed || local.body !== entry.body);
      document = details(entry, differentSnapshot && this.page.kind !== "delete" ? [{ text: "Current library version · not the selected snapshot", color: "warning" }]
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
    this.descriptionCache = { entry, version: this.contentVersion, compact, managing, document };
    return document;
  }
  private read(title: string, document: PreferenceDocument): void { this.page = { kind: "read", title, document, scroll: 0 }; }
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
    const rawBody = entry?.body ?? this.freeText;
    body.editor.setText(rawBody);
    const rawName = entry?.name ?? "";
    const name = new Input({ prompt: "Name: " }); name.setValue(sanitizeTerminalText(rawName).replace(/\n/g, " "));
    const rawDescription = entry?.metadata?.description ?? "";
    const description = new Input({ prompt: "Description: " }); description.setValue(sanitizeTerminalText(rawDescription).replace(/\n/g, " "));
    const form: Form = { kind, scope: entry?.scope === "global" ? "global" : "project", name, rawName, initialEditorName: name.getValue(),
      body, rawBody, initialEditorBody: body.editor.getExpandedText(),
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
      if (source.scope === "builtin") {
        if (action === "edit") {
          this.openForm("new", source);
          this.setNotice("Editing a new copy of this built-in preference.");
        } else this.setNotice("Built-in preference. Use g to change its project default.", "warning");
        return;
      }
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
      this.page = { kind: "list" }; this.setNotice("Saved to library; current selection unchanged.");
      if (form.kind === "new") {
        const reset = this.selectedOnly || !!this.search.getValue().trim();
        this.selectedOnly = false;
        this.allSearch = new Input({ prompt: "Search: " });
        this.allView = { index: 0, top: 0, direction: 1, key: preferenceKey(saved) };
        this.top = 0;
        this.navigationDirection = 1;
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
      this.page = { kind: "list" }; this.setNotice(this.actions.session ? "Deleted from library; existing prompts unchanged." : "Deleted from library; selected snapshots kept.");
      await this.refresh();
    } catch (error) { if (!this.disposed) { this.page = { kind: "list" }; this.setNotice(this.error(error), "error"); } }
    finally { this.busy = false; this.redraw(); }
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    const key = parseKey(data)?.toLowerCase();
    if (key && /(^|\+)f\d+$/.test(key)) return;
    if (key === "ctrl+s") {
      this.setNotice(this.managing ? "Library management only; no request sent."
        : this.purpose === "audit" ? "Read-only snapshot; no request sent."
        : this.purpose === "session" ? "Session choices are saved on Space; no request sent."
        : this.purpose === "refine" ? "Return to the Unsent original and press Enter to refine." : "Return to Revise to request revision with Ctrl+S.");
      this.redraw(); return;
    }
    const cancel = this.keys.matches(data, "tui.select.cancel") || key === "ctrl+\\";
    if (this.busy) {
      if (cancel && this.page.kind === "list") { this.back(); this.redraw(); }
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
      const count = 6;
      if (cancel) this.page = this.stamp(form) === form.initial ? { kind: "list" } : { kind: "discard", form };
      else if (key === "tab" || key === "shift+tab") form.focus = (form.focus + (key === "tab" ? 1 : count - 1)) % count;
      else if (form.focus === count - 1 && enter) void this.save(form);
      else if (form.focus === 2 && (enter || key === "space") && form.kind !== "library") form.scope = form.scope === "project" ? "global" : "project";
      else if (form.focus === 3 && (enter || key === "space")) {
        form.metadata = { description: form.description.getValue(), kind: form.metadata?.kind === "rewrite" ? "result" : form.metadata?.kind === "result" ? "task" : "rewrite", activation: "manual" };
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
    } else if (cancel) {
      if (this.focus === 0 && key !== "ctrl+\\") this.focus = 1;
      else this.back();
    } else if (key === "alt+enter") return;
    else if (key === "tab" || key === "shift+tab") {
      const regions = this.managing ? 3 : 2;
      this.focus = (this.focus + (key === "tab" ? 1 : regions - 1)) % regions;
    } else if (this.focus === 0) {
      if (enter || key === "down") this.focus = 1;
      else { this.search.handleInput(data); this.index = 0; this.top = 0; this.navigationDirection = 1; }
    } else if (key === "s" && this.purpose !== "audit") this.toggleView();
    else if (key === "c" && this.selectable) {
      const cleared = this.actions.session ? this.changeSessionSelection({ kind: "clear" }) : this.selected.length && this.updateSelection([]);
      if (cleared) this.setNotice("Selection cleared; project defaults unchanged.");
    } else if (key === "g" && this.projectDefaultsEditable && this.focus === 1) void this.toggleProjectDefault();
    else if (key === "r" && this.selectable && this.actions.session && this.focus === 1) {
      const entry = this.highlighted();
      if (entry && this.changeSessionSelection({ kind: "inherit", key: preferenceKey(entry) })) this.setNotice("Session now follows the project default for this item.");
    } else if (key === "/") this.focus = 0;
    else if (key === "l" && this.selectable) this.libraryMode = true;
    else if (this.managing && ACTIONS.some((action) => action.key === key)) {
      this.actionIndex = ACTIONS.findIndex((action) => action.key === key);
      this.activate(ACTIONS[this.actionIndex]!.id);
    } else if (this.focus === 1) {
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
        else this.setNotice(this.libraryMode ? "Esc: return to the chooser." : this.purpose === "audit" ? "Read-only snapshot. Edit choices in Preview."
          : "Select an Unsent original or open Revise to change preferences.", "warning");
      } else if (enter) {
        const entry = this.highlighted();
        if (entry) this.read(this.purpose === "audit" ? "Adopted preference" : this.managing || this.purpose === "session" ? "Preference details"
          : this.purpose === "refine" ? "Full editing instruction" : "Full revision instruction", this.description(entry));
      }
    } else {
      if (key === "left" || key === "up") this.actionIndex = (this.actionIndex + ACTIONS.length - 1) % ACTIONS.length;
      else if (key === "right" || key === "down") this.actionIndex = (this.actionIndex + 1) % ACTIONS.length;
      else if (enter) this.activate(ACTIONS[this.actionIndex]!.id);
    }
    this.redraw();
  }

  render(width: number): string[] {
    if (width < 1) return [];
    const layout = this.layout(width);
    const { innerWidth: w } = layout;
    const clean = (text: string) => sanitizeTerminalText(text);
    const wrap = (text: string, columns = w) => wrapTextWithAnsi(clean(text), columns);
    const button = (text: string, active: boolean) => active ? this.theme.bg("selectedBg", this.theme.fg("text", `› ${clean(text)}`)) : this.theme.fg("muted", `  ${clean(text)}`);
    const { managing, selectable } = this;
    const audit = this.purpose === "audit";
    const session = this.purpose === "session";
    const target = this.purpose === "refine" ? "Unsent original" : session ? "This session" : "This revision";
    const selectionLabel = `${this.selected.length} selected`;
    const selectionScope = !selectable ? " (read-only)" : session ? " · Future prompts · Saved on Space" : " · Kept on return";
    let title = managing ? "Preferences library" : audit ? "Adopted preferences" : `Preferences · ${target}`;
    if (selectable && layout.headerHeight === 1) {
      const shortTarget = this.purpose === "refine" ? "Unsent" : session ? "Session" : "Revision";
      title = [`${title} · ${selectionLabel}`, `${shortTarget} · ${selectionLabel}`, `${shortTarget} ${selectionLabel}`,
        `${shortTarget} · ${this.selected.length}`, shortTarget].find((line) => visibleWidth(line) <= w) ?? shortTarget;
    }
    let subtitle = `${w >= 36 ? `Focus: ${["Search", "Library", "Actions"][this.focus]} · ` : ""}${selectionLabel}${selectionScope}`;
    let subtitleColor: DocumentPart["color"] = "muted";
    let renderBody: (height: number) => string[];
    const viewHint: KeyHint = ["s", this.selectedOnly ? "All" : w < 60 ? "Selected" : "Selected only"];
    const toggle: KeyHint | undefined = this.focus === 1 && selectable && (!this.selectedOnly || this.selected.length)
      ? ["Space", this.selectedOnly ? "Deselect" : "Toggle"] : undefined;
    const project: KeyHint | undefined = this.focus === 1 && this.projectDefaultsEditable ? ["g", "Project default"] : undefined;
    const selectionActions = [toggle, project].filter((hint): hint is KeyHint => !!hint);
    let hints: KeyHint[][] = [[
      ...(this.focus !== 0 && this.selectedOnly && !audit ? [viewHint] : []),
      ...selectionActions,
      ["Enter", this.focus === 0 ? "Browse" : this.focus === 1 ? "Read" : "Choose"],
      ...(this.focus === 2 ? [["←→", "Choose action"] as KeyHint] : []),
      ...(this.focus !== 0 && !this.selectedOnly ? [viewHint] : []),
    ], [["Esc", this.focus === 0 ? "End search" : this.libraryMode && w >= 30 ? "To selection" : "Back"],
      ...(this.focus !== 0 && selectable ? [["l", w < 30 ? "Library" : "Manage library"] as KeyHint] : []),
      ...(this.focus === 1 && selectable && session ? [["r", "Inherit default"] as KeyHint] : []),
      [w < 54 ? "Tab" : "Tab / Shift+Tab", "Focus"],
      ...(this.focus !== 0 ? [["/", "Search"] as KeyHint] : []),
      ...(this.focus !== 0 && selectable ? [["c", "Clear all"] as KeyHint] : [])]];
    const page = this.page;
    if (page.kind === "read") {
      title = page.title;
      subtitle = "Read-only";
      renderBody = (h) => {
        const lines = this.document(page.document, w);
        this.viewport = h;
        page.scroll = Math.min(page.scroll, Math.max(0, lines.length - h));
        return lines.slice(page.scroll, page.scroll + h);
      };
      hints = [[["↑↓ / PgUp / PgDn", "Scroll"]], [["Esc", "Back"]]];
    } else if (page.kind === "discard" || page.kind === "delete") {
      title = page.kind === "discard" ? "Discard unsaved form?" : "Delete library entry?";
      subtitle = "";
      renderBody = () => page.kind === "discard"
        ? wrap("Unsaved form changes will be discarded. Current selection and saved library entries stay unchanged.").map((line) => this.theme.fg("warning", line))
        : [...wrap(this.actions.session ? "Existing prompt snapshots stay unchanged." : "Selections for this request stay unchanged.").map((line) => this.theme.fg("muted", line)),
          "", ...this.document(this.description(page.entry), w)];
      hints = [[["y", page.kind === "discard" ? "Discard" : "Delete"]],
        [["n / Esc", page.kind === "discard" ? "Keep editing" : "Cancel"]]];
    } else if (page.kind === "form") {
      const form = page.form;
      title = form.kind === "library" ? "Edit library entry" : "Save new preference";
      subtitle = `Focus: ${["Name", "Instruction", "Scope", "Type", "Description", "Save"][form.focus]} · Check paths and sensitive text`;
      const name = form.name.render(w);
      const scope = button(`Scope: ${form.scope}${form.kind === "library" ? " (fixed)" : " (Enter change)"}`, form.focus === 2);
      const type = button(`Type: ${form.metadata ? preferenceGroup({ metadata: form.metadata }) : "Unclassified (legacy)"}`, form.focus === 3);
      if (form.metadata?.kind === "result") subtitle = RESULT_NOTE_HINT;
      const description = form.description.render(w);
      const save = button("Save to preference library", form.focus === 5);
      // Native Editor cannot wrap a wide glyph into a one-column line. The
      // outer frame clips its minimal safe canvas in extremely narrow terminals.
      const editorWidth = Math.max(4, w);
      // Tiny viewports show the focused field; the same Tab order remains usable.
      renderBody = (h) => {
        if (h < 9) return form.focus === 0 ? name : form.focus === 5 ? [save] : form.focus === 4 ? description
          : form.focus === 2 ? [scope] : form.focus === 3 ? [type] : form.body.render(editorWidth, Math.max(1, h));
        return [...name, ...form.body.render(editorWidth, h - 5), scope, type, ...description, save];
      };
      const enterLabel = form.focus === 5 ? "Save to library" : form.focus === 1 ? "Newline" : form.focus === 0 || form.focus === 4 ? "Next field"
        : form.focus === 3 ? "Change type" : form.kind === "library" ? "Scope fixed" : "Change scope";
      hints = [[["Enter", enterLabel], ["Tab / Shift+Tab", "Fields"]], [["Esc", "Back"]]];
    } else {
      const entries = this.entries();
      this.index = Math.min(this.index, Math.max(0, entries.length - 1));
      const errors = Object.values(this.library.errors);
      const status = errors.length ? errors.join(" · ") : this.selectedOnly && !this.selected.length
        ? "No selections" : !this.library.entries.length && !this.selected.length
          ? "Library is empty" : !entries.length ? "No matches" : "";
      renderBody = (h) => {
        const splitCandidate = w >= 76;
        const toolbarWidth = splitCandidate ? Math.floor(w * 0.43) : w;
        const toolbar: string[] = [];
        let actionRow = 0;
        if (managing) {
          const separator = this.theme.fg("muted", " · ");
          for (const [i, action] of ACTIONS.entries()) {
            const active = this.focus === 2 && i === this.actionIndex;
            const hint = (active ? "› " : "") + formatKeyHint([this.focus === 0 ? "" : action.key, action.label], this.theme);
            const cell = truncateToWidth(hint, toolbarWidth, "…");
            const styled = active ? this.theme.bg("selectedBg", cell) : cell;
            const last = toolbar.at(-1);
            if (last && visibleWidth(last + separator + styled) <= toolbarWidth) toolbar[toolbar.length - 1] = last + separator + styled;
            else toolbar.push(styled);
            if (active) actionRow = toolbar.length - 1;
          }
        }
        const room = h >= toolbar.length + 3;
        const available = Math.max(1, room ? h - toolbar.length - 2 : h);
        const split = room && splitCandidate;
        const leftWidth = split ? toolbarWidth : w;
        const search = this.focus === 0 && this.hasFocus ? this.search.render(leftWidth) : [truncateToWidth(this.theme.fg("muted", "Search: ")
          + this.theme.fg("text", clean(this.search.getValue()).replace(/\n/g, " ")), leftWidth, "…")];
        const window = selectionWindow(entries.length, this.index, available, this.top,
          this.selectedOnly ? undefined : (index) => preferenceGroup(entries[index]!), available >= 10 ? 1 : 0, this.navigationDirection);
        this.top = window.start;
        const rows = window.rows;
        this.viewport = Math.max(1, rows.filter((row) => typeof row === "number").length);
        const list = rows.map((row) => {
          if (typeof row === "string") return this.theme.fg("text", this.theme.bold(truncateToWidth(row, leftWidth, "…")));
          const entry = entries[row]!;
          const current = row === this.index;
          const active = this.focus === 1 && current;
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
        if (!entries.length) list.push(...wrap(status, leftWidth).map((line) => this.theme.fg(errors.length ? "error" : "muted", line)));
        if (!room) {
          return this.focus === 0 ? search : this.focus === 2
            ? toolbar.slice(Math.min(actionRow, Math.max(0, toolbar.length - h))) : list;
        }
        const rightWidth = split ? w - leftWidth - 3 : w;
        const detail = split && entries[this.index] ? this.document(this.description(entries[this.index]!, true), rightWidth) : [];
        const headingText = this.theme.fg("text", this.theme.bold(`${audit ? "Adopted" : this.selectedOnly ? "Selected only" : "Library"} ${entries.length ? this.index + 1 : 0}/${entries.length}`));
        const count = subtitleColor !== "muted" || this.notice || this.busy || layout.headerHeight < 2
          ? this.theme.fg("muted", ` · ${selectionLabel}${!selectable && !this.busy ? selectionScope : ""}`) : "";
        const heading = truncateToWidth(headingText + (visibleWidth(headingText + count) <= leftWidth ? count : ""), leftWidth, "");
        const left = [...search, heading, ...toolbar, ...list];
        if (!split) return left;
        const divider = this.theme.fg("borderMuted", " │ ");
        return Array.from({ length: h }, (_, i) => {
          const line = left[i] ?? "";
          return line + " ".repeat(Math.max(0, leftWidth - visibleWidth(line))) + divider + (detail[i] ?? "");
        });
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
      subtitle = page.kind === "list" && subtitleColor === "muted" ? `Focus: ${["Search", "Library", "Actions"][this.focus]} · ${this.notice}` : this.notice;
    }
    if (w < 30) {
      const labels: Record<string, string> = { "Keep editing": "Keep", "Next field": "Next",
        "Save to library": "Save", "Change scope": "Scope", "Scope fixed": "Fixed" };
      hints = hints.map((row) => row.map(([key, label]) => [key === "n / Esc" ? "Esc" : key.split(" / ")[0]!, labels[label] ?? label]));
    }
    const footer = page.kind === "read"
      ? [fittingKeyHints([hints[1]![0]!, ...hints[0]!], w, this.theme)]
      : w < 30 || page.kind === "list"
      ? hints.map((row) => fittingKeyHints(row, w, this.theme))
      : alignedKeyHints(hints, w, this.theme);
    if (page.kind === "list" && selectionActions.length) {
      const [back, ...secondary] = hints[1]!;
      const short = ([key, label]: KeyHint): KeyHint => [key, key === "g" ? "Default" : key === "Esc" && label === "To selection" ? "Back" : label];
      const required = layout.footerHeight === 1 ? [back!, ...selectionActions] : selectionActions;
      const variants = [required, required.map(short), required.map((hint): KeyHint => hint[0] === "Space" ? ["Space", ""] : short(hint)),
        required.map(([key]): KeyHint => [key, ""])];
      const separator = w < 30 ? " " : " · ";
      const primary = variants.find((variant) => visibleWidth(fittingKeyHints(variant, Infinity, this.theme, separator)) <= w) ?? variants.at(-1)!;
      const extra = hints[0]!.filter(([key]) => !selectionActions.some(([action]) => key === action));
      footer[0] = fittingKeyHints([...primary, ...extra, ...(layout.footerHeight === 1 ? secondary : [])], w, this.theme, separator);
    } else if (layout.footerHeight === 1) {
      footer[0] = fittingKeyHints([hints[1]![0]!, ...hints[0]!], w, this.theme);
    }
    const severe = subtitleColor !== "muted";
    const feedback = this.theme.fg(subtitleColor, clean(`${severe ? "⚠ " : ""}${subtitle}`));
    const heading = this.theme.fg("text", this.theme.bold(clean(title)));
    const foregroundFeedback = severe || this.busy;
    const chrome = panelHeader(layout, [foregroundFeedback && layout.headerHeight === 1 ? feedback : heading, feedback], [], footer);
    const body = renderBody(chrome.layout.bodyHeight);
    if (foregroundFeedback && layout.headerHeight === 0) body.unshift(feedback);
    return chrome.render(body, (text) => this.theme.fg("borderMuted", text));
  }
}
