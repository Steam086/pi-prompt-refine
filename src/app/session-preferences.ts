import { composeRevision, PREFERENCE_SELECTION_LIMIT, preferenceKey, resolvePreferenceSelection,
  type PreferenceLibrary, type SelectedPreference } from "../revision-preferences.js";

export type SessionPreferenceChange = { kind: "set"; key: string; enabled: boolean } | { kind: "inherit"; key: string } | { kind: "clear" };
export interface SessionPreferenceTarget {
  read(library: PreferenceLibrary): SelectedPreference[];
  override(key: string): boolean | undefined;
  change(library: PreferenceLibrary, change: SessionPreferenceChange): string | undefined;
}

/** Runtime-only, independent of the current round, overlay, and request journal. */
export class SessionPreferences {
  private selections = new Map<string, ReadonlyMap<string, boolean>>();

  overrides(sessionId: string): ReadonlyMap<string, boolean> | undefined { return this.selections.get(sessionId); }

  target(sessionId: string, isCurrent: () => boolean, maxChars: () => number): SessionPreferenceTarget {
    const read = (library: PreferenceLibrary) => resolvePreferenceSelection(library, this.overrides(sessionId));
    return {
      read,
      override: (key) => this.overrides(sessionId)?.get(key),
      change: (library, change) => {
        if (!isCurrent()) return "Session changed; no selection applied.";
        const next = new Map(this.overrides(sessionId));
        if (change.kind === "clear") {
          for (const key of library.projectDefaults ?? []) next.set(key, false);
          for (const [key, enabled] of next) if (enabled) next.set(key, false);
        } else if (change.kind === "inherit") next.delete(change.key);
        else {
          if (change.enabled && !library.entries.some((entry) => preferenceKey(entry) === change.key && !library.errors[entry.scope])) {
            return "Library entry unavailable or deleted; no selection applied.";
          }
          next.set(change.key, change.enabled);
        }
        if (change.kind !== "clear") {
          const before = read(library);
          const after = resolvePreferenceSelection(library, next);
          const length = composeRevision(after, "").length;
          if (after.length > PREFERENCE_SELECTION_LIMIT && after.length > before.length) return `Select at most ${PREFERENCE_SELECTION_LIMIT} preferences for this session.`;
          if (length > maxChars() && length > composeRevision(before, "").length) return `Editing requirements exceed ${maxChars()} characters; reduce the selection.`;
        }
        if (next.size) this.selections.set(sessionId, next);
        else this.selections.delete(sessionId);
        return undefined;
      },
    };
  }
}
