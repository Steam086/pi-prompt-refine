/** Instance-local invalidation, never a global bus or a clock. */
export function createApplicationEvents() {
  let revision = 0;
  let scheduled = false;
  const listeners = new Set<(revision: number) => void>();
  const immediate = new Set<(revision: number) => void>();
  return {
    get revision() { return revision; },
    changed(notifyImmediate = false) {
      revision++;
      if (notifyImmediate) for (const listener of [...immediate]) {
        try { listener(revision); } catch { /* Native presentation must not suppress remote invalidation. */ }
      }
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        for (const listener of [...listeners]) {
          try { listener(revision); } catch { /* Presentation cannot undo a commit. */ }
        }
      });
    },
    subscribe(listener: (revision: number) => void, synchronous = false): () => void {
      if (listeners.size + immediate.size >= 64) throw new Error("Subscription capacity reached");
      const target = synchronous ? immediate : listeners;
      target.add(listener);
      return () => { target.delete(listener); };
    },
    clear() { listeners.clear(); immediate.clear(); },
  };
}
