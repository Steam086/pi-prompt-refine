import { Input, parseKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type KeybindingsManager } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { sanitizeTerminalText } from "./presentation.js";
import { preferenceContentKey, preferenceKey, searchPreferences, selectPreference, PREFERENCE_SELECTION_LIMIT,
  type PreferenceLibrary, type PreferenceRepository, type RevisionPreference, type SelectedPreference } from "./revision-preferences.js";

export interface InlinePreferenceTarget {
  selected: SelectedPreference[];
  save?(selected: SelectedPreference[]): string | undefined;
}
interface Document { text: string; scroll: number; width?: number; lines?: string[] }
interface Position { search: Input; searching: boolean; key?: string; index: number; top: number; reading?: boolean; document?: Document }

/** Direct, per-Unsent selection. Library editing remains a transactional child page. */
export class InlinePreferences {
  private library: PreferenceLibrary = { entries: [], errors: {} };
  private loaded = false;
  private loading = false;
  private disposed = false;
  private epoch = 0;
  private id?: number;
  private active = false;
  private hostFocused = false;
  private positions = new Map<number, Position>();
  private notice = "";
  private get document(): Document | undefined {
    const position = this.id === undefined ? undefined : this.positions.get(this.id);
    return position?.reading ? position.document : undefined;
  }
  private set document(value: Document | undefined) {
    const position = this.id === undefined ? undefined : this.positions.get(this.id);
    if (position) { if (value) position.document = value; position.reading = !!value; }
  }
  private viewport = 1;
  private cache?: { selected: SelectedPreference[]; query: string; library: PreferenceLibrary; entries: RevisionPreference[] };

  constructor(private readonly repository: PreferenceRepository,
    private readonly target: (id: number) => InlinePreferenceTarget | undefined,
    private readonly theme: Theme, private readonly keys: KeybindingsManager, private readonly redraw: () => void) {}

  available(id: number): boolean { return !this.disposed && !!this.target(id)?.save; }
  set focused(value: boolean) { this.hostFocused = value; this.updateFocus(); }
  private updateFocus(): void {
    for (const [id, position] of this.positions) position.search.focused = this.hostFocused && this.active && id === this.id && position.searching && !this.document;
  }
  setTarget(id: number | undefined, active: boolean): void {
    if (this.disposed) return;
    if (id !== this.id) this.notice = "";
    this.id = id; this.active = active;
    if (id !== undefined && !this.positions.has(id)) {
      if (this.positions.size >= 100) this.positions.delete(this.positions.keys().next().value!);
      this.positions.set(id, { search: new Input({ prompt: "Search: " }), searching: false, index: 0, top: 0 });
    }
    this.updateFocus();
    if (id !== undefined && !this.loaded && !this.loading) void this.refresh();
  }
  dispose(): void { this.disposed = true; this.focused = false; this.epoch++; }
  invalidate(): void {
    for (const position of this.positions.values()) {
      position.search.invalidate();
      if (position.document) position.document.lines = undefined;
    }
  }
  async refresh(): Promise<void> {
    if (this.disposed) return;
    const epoch = ++this.epoch;
    this.loading = true; this.cache = undefined;
    // A cached comparison must not keep advertising old source text as the current library.
    for (const position of this.positions.values()) position.reading = false;
    this.updateFocus(); this.redraw();
    try {
      const library = await this.repository.load();
      if (this.disposed || epoch !== this.epoch) return;
      // Never present stale entries from an unavailable scope as current library content.
      this.library = { ...library, entries: library.entries.filter((entry) => !library.errors[entry.scope]) };
    } catch (error) {
      if (this.disposed || epoch !== this.epoch) return;
      const message = error instanceof Error ? error.message : "Could not load preference library.";
      this.library = { entries: [], errors: { project: message, global: message } };
    } finally {
      if (!this.disposed && epoch === this.epoch) {
        this.loaded = true; this.loading = false; this.cache = undefined; this.redraw();
      }
    }
  }
  private entries(selected: SelectedPreference[], position: Position): RevisionPreference[] {
    const query = position.search.getValue();
    if (this.cache && (this.cache.selected === selected || (!selected.length && !this.cache.selected.length)) && this.cache.query === query && this.cache.library === this.library) return this.cache.entries;
    const libraryEntries = this.loading ? [] : this.library.entries;
    const keys = new Set(libraryEntries.map(preferenceKey));
    const snapshots = new Map(selected.map((entry) => [preferenceKey(entry), entry]));
    const candidates = [...libraryEntries.map((entry) => snapshots.get(preferenceKey(entry)) ?? entry),
      ...selected.filter((entry) => !keys.has(preferenceKey(entry)))];
    const rank = (entry: RevisionPreference) => entry.metadata?.kind === "task" ? 0 : entry.metadata?.kind === "rewrite" ? 1 : 2;
    const entries = searchPreferences(candidates, query).sort((a, b) => rank(a) - rank(b));
    this.cache = { selected, query, library: this.library, entries };
    return entries;
  }
  private highlighted(selected: SelectedPreference[], position: Position): RevisionPreference | undefined {
    const entries = this.entries(selected, position);
    const index = entries.findIndex((entry) => preferenceKey(entry) === position.key);
    position.index = index >= 0 ? index : Math.max(0, Math.min(position.index, entries.length - 1));
    const entry = entries[position.index];
    position.key = entry && preferenceKey(entry);
    return entry;
  }
  private snapshotWarning(entry: SelectedPreference): string | undefined {
    if (this.loading) return undefined;
    if (this.library.errors[entry.scope]) return "Library unavailable; selected snapshot retained.";
    const source = this.library.entries.find((item) => preferenceKey(item) === preferenceKey(entry));
    if (!source) return "Source deleted; selected snapshot retained.";
    if (source.version !== entry.version || source.body !== entry.sourceBody || source.name !== entry.name || JSON.stringify(source.metadata) !== JSON.stringify(entry.metadata)) {
      return "Source changed; selected snapshot retained. Deselect and reselect to use the current entry.";
    }
    return undefined;
  }
  /** All keys are consumed while selecting, searching or reading; Enter never starts a request. */
  handleInput(data: string): "back" | "manage" | undefined {
    if (this.disposed) return "back";
    const position = this.id === undefined ? undefined : this.positions.get(this.id);
    const target = this.id === undefined ? undefined : this.target(this.id);
    if (!position || !target?.save) { this.notice = "Original changed or already started; no selection applied."; return "back"; }
    const key = parseKey(data)?.toLowerCase();
    const cancel = this.keys.matches(data, "tui.select.cancel") || key === "ctrl+\\";
    if (this.document) {
      if (cancel || key === "q") this.document = undefined;
      else if (key === "up" || key === "pageup") this.document.scroll = Math.max(0, this.document.scroll - (key === "up" ? 1 : this.viewport));
      else if (key === "down" || key === "pagedown") this.document.scroll += key === "down" ? 1 : this.viewport;
      else if (key === "home") this.document.scroll = 0;
      else if (key === "end") this.document.scroll = Number.MAX_SAFE_INTEGER;
    } else if (position.searching) {
      if (cancel || this.keys.matches(data, "tui.input.submit") || key === "down") position.searching = false;
      else { position.search.handleInput(data); position.index = 0; position.key = undefined; position.top = 0; }
    } else if (cancel || key === "q") return "back";
    else if (key === "p") return "manage";
    else if (key === "/") position.searching = true;
    else {
      const entry = this.highlighted(target.selected, position);
      const entries = this.entries(target.selected, position);
      const delta = key === "up" ? -1 : key === "down" ? 1 : key === "pageup" ? -this.viewport : key === "pagedown" ? this.viewport : 0;
      if (delta || key === "home" || key === "end") {
        position.index = key === "home" ? 0 : key === "end" ? Math.max(0, entries.length - 1) : Math.max(0, Math.min(entries.length - 1, position.index + delta));
        position.key = entries[position.index] && preferenceKey(entries[position.index]!);
      } else if (entry && key === "space") {
        this.notice = "";
        const selected = target.selected;
        const existing = selected.find((item) => preferenceKey(item) === preferenceKey(entry));
        if (!existing && selected.some((item) => preferenceContentKey(item) === preferenceContentKey(entry))) this.notice = "Same requirements already selected.";
        else if (!existing && selected.length >= PREFERENCE_SELECTION_LIMIT) this.notice = `Select at most ${PREFERENCE_SELECTION_LIMIT} preferences.`;
        else {
          const next = existing ? selected.filter((item) => preferenceKey(item) !== preferenceKey(entry)) : [...selected, selectPreference(entry)];
          this.notice = target.save(structuredClone(next)) ?? "";
        }
      } else if (entry && this.keys.matches(data, "tui.input.submit")) {
        const local = target.selected.find((item) => preferenceKey(item) === preferenceKey(entry));
        const warning = local && this.snapshotWarning(local);
        const parts = [entry.name, ...(warning ? [warning] : []), local ? "Selected snapshot" : "Library entry", (local ?? entry).body];
        const source = this.library.entries.find((item) => preferenceKey(item) === preferenceKey(entry));
        if (local && warning && source) parts.push("Current library entry", source.body);
        const text = parts.join("\n\n");
        this.document = position.document?.text === text ? position.document : { text, scroll: 0 };
      }
    }
    this.updateFocus();
    return undefined;
  }
  get hints(): "search" | "read" | "select" {
    return this.document ? "read" : this.id !== undefined && this.positions.get(this.id)?.searching ? "search" : "select";
  }
  render(width: number, height: number): string[] {
    if (this.disposed || width < 1 || height < 1 || this.id === undefined) return [];
    const target = this.target(this.id), position = this.positions.get(this.id);
    if (!target || !position) return [];
    const clean = sanitizeTerminalText;
    const muted = (text: string) => this.theme.fg("muted", clean(text));
    const heading = this.theme.fg("text", this.theme.bold(`${this.active ? "› " : ""}Preferences`));
    const result = [truncateToWidth(heading + muted(` · ${target.selected.length} selected${this.loading && target.selected.length ? " · Loading…" : ""}`), width, "…")];
    const errors = [...new Set(Object.values(this.library.errors))];
    const warning = this.notice || (errors.length ? `Library unavailable: ${errors.join(" · ")}` : "");
    if (warning && result.length < height) result.push(truncateToWidth(this.theme.fg("warning", `⚠ ${clean(warning)}`), width, "…"));
    else if (warning) result[0] = truncateToWidth(this.theme.fg("warning", `⚠ ${clean(warning)}`), width, "…");
    if (this.document && this.active) {
      const doc = this.document;
      if (!doc.lines || doc.width !== width) { doc.lines = wrapTextWithAnsi(this.theme.fg("text", clean(doc.text)), width); doc.width = width; }
      this.viewport = Math.max(1, height - result.length);
      doc.scroll = Math.min(doc.scroll, Math.max(0, doc.lines.length - this.viewport));
      return [...result, ...doc.lines.slice(doc.scroll, doc.scroll + this.viewport)].slice(0, height);
    }
    if ((position.searching || position.search.getValue()) && result.length < height) result.push(...position.search.render(width).slice(0, 1));
    const entry = this.highlighted(target.selected, position);
    const entries = this.entries(target.selected, position);
    if (!entry) {
      if (result.length < height) result.push(muted(this.loading ? "Loading preferences…" : position.search.getValue() ? "No matches · / Search" : errors.length ? "Selected snapshots remain available." : "No preferences · p Add / manage"));
      return result;
    }
    const group = (item: RevisionPreference) => item.metadata?.kind === "task" ? "Task requirements" : item.metadata?.kind === "rewrite" ? "Prompt rewriting" : "Unclassified";
    const available = height - result.length;
    const description = entry.metadata?.description;
    const showDescription = this.active && !!description && available >= 4;
    const count = Math.max(0, available - (showDescription ? 1 : 0));
    const rows: { group: string; entry?: RevisionPreference }[] = [];
    for (const item of entries) {
      if (rows.at(-1)?.group !== group(item)) rows.push({ group: group(item) });
      rows.push({ group: group(item), entry: item });
    }
    const selectedRow = rows.findIndex((row) => row.entry && preferenceKey(row.entry) === position.key);
    position.top = Math.max(0, Math.min(position.top, selectedRow, Math.max(0, rows.length - count)));
    const context = () => count >= 2 && rows[position.top]?.entry ? 1 : 0;
    while (count > 0 && selectedRow >= position.top + count - context()) position.top++;
    this.viewport = Math.max(1, count - 1);
    const groupHeading = (label: string) => this.theme.fg("text", this.theme.bold(clean(label)));
    const contextRows = context();
    if (contextRows) result.push(groupHeading(rows[position.top]!.group));
    for (const row of rows.slice(position.top, position.top + Math.max(0, count - contextRows))) {
      const item = row.entry;
      if (!item) { result.push(groupHeading(row.group)); continue; }
      const local = target.selected.find((selected) => preferenceKey(selected) === preferenceKey(item));
      const active = this.active && preferenceKey(item) === position.key;
      const warning = local && this.snapshotWarning(local);
      const prefix = this.theme.fg("text", `${active ? "›" : " "} [${local ? "x" : " "}] `) + (warning ? this.theme.fg("warning", "! ") : "");
      const label = clean(local?.name ?? item.name);
      const source = muted(` · ${item.scope === "project" ? "P" : "G"}`);
      const name = this.theme.fg("text", active ? this.theme.bold(label) : label);
      const line = truncateToWidth(prefix + name + (visibleWidth(prefix + name + source) <= width ? source : ""), width, "…");
      result.push(active ? this.theme.bg("selectedBg", line + " ".repeat(Math.max(0, width - visibleWidth(line)))) : line);
    }
    if (showDescription) result.push(truncateToWidth(muted(description!), width, "…"));
    return result.slice(0, height);
  }
}
