import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatKeyHint } from "../../src/key-hints.js";
import { composeRevision, selectPreference } from "../../src/revision-preferences.js";
import { workspaceHeight, workspaceLayout, workspaceViewport } from "../../src/workspace-overlay.js";
import { a, altP, b, backTab, bringBack, ctrlS, down, enter, esc, left, loaded, right, save, tab, text, unsentWorkspaceSetup, workspaceSetup } from "../support/preference-panel.js";

afterEach(() => vi.restoreAllMocks());

describe("Unsent preference selection", () => {
  it.each(["dark", "light"])("selects inline with one Tab and optimizes directly with Enter (%s)", async (theme) => {
    const f = unsentWorkspaceSetup(null, false, theme); const w = f.workspace;
    text(w); await vi.waitFor(() => expect(text(w)).toContain(`[ ] ${a.name}`));
    w.handleInput(tab);
    expect(text(w)).toContain("Focus: Preferences");
    expect(text(w)).not.toContain("Bring back");
    w.handleInput(" "); w.handleInput(down); w.handleInput("\x1b[32u");
    expect(f.controller.getRecord(f.originals[0]!.id)!.input.preferences).toEqual([selectPreference(a), selectPreference(b)]);
    expect(text(w)).toContain("2 selected");
    const styled = w.render(100).join("\n");
    expect(styled).toContain(f.theme.fg("text", f.theme.bold(b.name)));
    expect(styled).toContain(formatKeyHint(["Space", "Toggle"], f.theme));
    expect(styled).toContain(f.theme.fg("muted", "Project"));
    w.handleInput("o"); expect(text(w)).toContain(b.body);
    for (const key of [" ", "i", "f", "n", ctrlS, bringBack, enter]) w.handleInput(key);
    expect(f.run).not.toHaveBeenCalled(); expect(f.complete).not.toHaveBeenCalled();
    expect(f.repo.save).not.toHaveBeenCalled();
    w.handleInput(esc); // Close reading, keeping preference selection focused.
    expect(text(w)).toContain("Focus: Preferences");
    expect(f.controller.getRecord(f.originals[0]!.id)!.input.draft).toBe(f.originals[0]!.input.draft);
    w.handleInput(theme === "dark" ? enter : "\x1b[13u");
    expect(f.run).toHaveBeenCalledExactlyOnceWith(f.originals[0]!.id);
    expect(f.complete.mock.calls[0]![0]).toMatchObject({ editingInstruction: composeRevision([selectPreference(a), selectPreference(b)], "") });
    await Promise.resolve(); w.dispose();
  });

  it.each(["dark", "light"])("aligns source columns in both Tab's inline list and p's child without merging their save boundaries (%s)", async (theme) => {
    const f = unsentWorkspaceSetup(null, false, theme); const w = f.workspace;
    f.library.entries[0]!.name = "Long 中文😀\x1b[31m " + "名称".repeat(30);
    f.library.entries[1]!.name = "Short 中文😀";
    text(w); await vi.waitFor(() => expect(text(w)).toContain("Short 中文😀"));
    w.handleInput(tab);
    for (const width of [24, 40, 100, 160, 40]) {
      const layout = workspaceLayout(width, f.terminal.rows);
      const shell = workspaceViewport(width, f.terminal.rows).framed ? 1 : 0;
      for (const child of [false, true]) {
        if (child) { w.handleInput("p"); await loaded(w); }
        const paneWidth = child ? layout.innerWidth >= 76 ? Math.floor(layout.innerWidth * 0.43) : layout.innerWidth
          : layout.innerWidth >= 72 ? Math.min(48, Math.floor(layout.innerWidth / 3)) : layout.innerWidth;
        const labels = paneWidth >= 28 ? [" Global", "Project"] : ["G", "P"];
        const frame = w.render(width);
        const rows = frame.filter((line) => labels.some((label) => line.includes(f.theme.fg("muted", label))));
        expect(rows, JSON.stringify({ width, child, paneWidth })).toHaveLength(2);
        for (const [index, row] of rows.entries()) {
          const label = labels[index]!;
          const source = f.theme.fg("muted", label);
          expect(visibleWidth(row.slice(0, row.indexOf(source))) + visibleWidth(label)).toBe(shell + layout.inset + paneWidth);
          expect(row).not.toContain("\x1b[31m");
        }
        expect(frame.every((line) => visibleWidth(line) <= width)).toBe(true);
        expect(w.render(width)).toEqual(frame);
        if (child) {
          w.handleInput(" ");
          expect(f.controller.getRecord(f.originals[0]!.id)!.input.preferences ?? []).toEqual([]);
          w.handleInput(esc);
          await vi.waitFor(() => expect(text(w)).toContain("Short 中文😀"));
        }
      }
    }
    w.handleInput(" ");
    expect(f.controller.getRecord(f.originals[0]!.id)!.input.preferences).toHaveLength(1);
    expect(f.run).not.toHaveBeenCalled(); expect(f.complete).not.toHaveBeenCalled();
    expect(f.repo.save).not.toHaveBeenCalled(); w.dispose();
  });

  it.each([{ name: "Esc", key: esc }, { name: "Tab", key: tab }, { name: "Shift+Tab", key: backTab }])("returns to tasks with $name without toggling, submitting or discarding selections", async ({ key }) => {
    const f = unsentWorkspaceSetup(); const w = f.workspace;
    text(w); await vi.waitFor(() => expect(text(w)).toContain(a.name));
    const before = structuredClone(f.position);
    w.handleInput(tab); w.handleInput(" "); w.handleInput(down);
    w.handleInput(key);
    expect(text(w)).not.toContain("Focus: Preferences");
    expect(f.position).toEqual(before);
    expect(f.controller.getRecord(f.originals[0]!.id)!.input.preferences).toEqual([selectPreference(a)]);
    expect(f.run).not.toHaveBeenCalled();
    expect(f.complete).not.toHaveBeenCalled();
    w.handleInput(tab);
    expect(text(w)).toContain(`› [ ] ${b.name}`);
    expect(text(w)).toContain(`Selected · 1`);
    w.handleInput(" "); w.handleInput(enter);
    expect(f.run).toHaveBeenCalledExactlyOnceWith(f.originals[0]!.id);
    expect(f.complete.mock.calls[0]![0]).toMatchObject({ editingInstruction: composeRevision([selectPreference(a), selectPreference(b)], "") });
    await Promise.resolve(); w.dispose();
  });

  it("isolates inline searches and choices by original, caches browsing, and preserves the full panel transaction", async () => {
    const f = unsentWorkspaceSetup(); const w = f.workspace;
    text(w); await vi.waitFor(() => expect(text(w)).toContain(a.name));
    const loads = f.repo.load.mock.calls.length;
    w.handleInput(backTab); w.handleInput("/"); w.handleInput("Literal");
    // Search owns all text and arrows; it cannot open another view or invoke task actions.
    for (const key of [left, right, ctrlS]) w.handleInput(key);
    expect(text(w)).toContain("Focus: Preferences · Search");
    expect(f.run).not.toHaveBeenCalled();
    w.handleInput(enter); w.handleInput(" ");
    expect(f.controller.getRecord(f.originals[0]!.id)!.input.preferences).toEqual([selectPreference(b)]);
    w.handleInput(esc); w.handleInput(tab);
    expect(text(w)).toContain("Search: Literal");
    expect(f.repo.load).toHaveBeenCalledTimes(loads);
    w.handleInput(esc);
    f.position.selectedTaskId = f.originals[1]!.taskId;
    text(w); w.handleInput(backTab);
    expect(text(w)).not.toContain("Search: Literal");
    w.handleInput(" ");
    expect(f.controller.getRecord(f.originals[1]!.id)!.input.preferences).toEqual([selectPreference(a)]);
    w.handleInput("p"); await loaded(w); w.handleInput(" "); w.handleInput(esc);
    expect(f.controller.getRecord(f.originals[1]!.id)!.input.preferences).toEqual([selectPreference(a)]);
    expect(text(w)).toContain("Focus: Preferences");
    w.handleInput("p"); await loaded(w); w.handleInput(" "); w.handleInput(bringBack);
    expect(f.controller.getRecord(f.originals[1]!.id)!.input.preferences).toEqual([]);
    expect(f.controller.getRecord(f.originals[0]!.id)!.input.preferences).toEqual([selectPreference(b)]);
    expect(f.complete).not.toHaveBeenCalled(); w.dispose();
  });

  it("rejects an over-limit inline addition without discarding the valid selection", async () => {
    const f = unsentWorkspaceSetup(null, false, "light", 90); const w = f.workspace;
    text(w); await vi.waitFor(() => expect(text(w)).toContain(a.name));
    w.handleInput(backTab); w.handleInput(" "); w.handleInput(down); w.handleInput(" ");
    expect(f.controller.getRecord(f.originals[0]!.id)!.input.preferences).toEqual([selectPreference(a)]);
    expect(text(w)).toContain("Editing requirements exceed 90");
    for (const [width, rows] of [[100, 40], [40, 16], [20, 8], [12, 6], [100, 40]]) {
      f.terminal.rows = rows!;
      const lines = w.render(width!);
      expect(lines).toHaveLength(workspaceHeight(rows!));
      expect(w.render(width!)).toHaveLength(lines.length);
      expect(lines.every((line) => visibleWidth(line) <= width!)).toBe(true);
      expect(lines.join("\n")).toContain(f.theme.fg("warning", "⚠").split("⚠")[0] + "⚠");
    }
    expect(f.complete).not.toHaveBeenCalled(); w.dispose();
  });

  it.each(["generating", "queued"])("follows a directly submitted %s run without resubmitting on the next Enter", async (status) => {
    const f = unsentWorkspaceSetup(null, false, "dark", 16000, 1); const w = f.workspace;
    f.complete.mockImplementation(() => new Promise(() => {}));
    if (status === "queued") f.controller.startRecord(f.originals[1]!.id);
    text(w); await vi.waitFor(() => expect(text(w)).toContain(a.name));
    w.handleInput(tab); w.handleInput(" "); w.handleInput(enter);
    expect(f.controller.getRecord(f.originals[0]!.id)!.status).toBe(status);
    expect(f.position.selectedTaskId).toBeUndefined();
    expect(text(w)).not.toContain("Focus: Preferences");
    w.handleInput(enter);
    expect(f.run).toHaveBeenCalledExactlyOnceWith(f.originals[0]!.id);
    w.dispose(); f.controller.setSession("other");
  });

  it("retains checked preferences and focus after a rejected start, then follows only the explicitly started run", async () => {
    const f = unsentWorkspaceSetup(); const w = f.workspace;
    text(w); await vi.waitFor(() => expect(text(w)).toContain(a.name));
    w.handleInput(tab); w.handleInput(" ");
    f.run.mockImplementationOnce(() => {});
    w.handleInput(enter);
    expect(text(w)).toContain("Focus: Preferences");
    expect(text(w)).toContain(`[x] ${a.name}`);
    expect(f.position.selectedTaskId).toBe(f.originals[0]!.taskId);
    expect(f.complete).not.toHaveBeenCalled();
    w.handleInput(enter);
    expect(f.run).toHaveBeenCalledTimes(2);
    expect(text(w)).not.toContain("Focus: Preferences");
    expect(f.position.selectedTaskId).toBeUndefined();
    w.handleInput(enter); // The submitted run is inspected, never submitted twice.
    expect(f.run).toHaveBeenCalledTimes(2);
    expect(f.complete).toHaveBeenCalledTimes(1);
    await Promise.resolve(); w.dispose();
  });

  it("consumes Enter after archival without running a new current target", async () => {
    const f = unsentWorkspaceSetup(); const w = f.workspace;
    text(w); await vi.waitFor(() => expect(text(w)).toContain(a.name));
    w.handleInput(tab); w.handleInput(" ");
    f.controller.onMessageStarted("Another Pi task");
    f.controller.createDraft({ ...f.originals[0]!.input, draft: "New current target" });
    text(w); w.handleInput(enter);
    expect(text(w)).toContain("Original changed or already started");
    expect(f.run).not.toHaveBeenCalled(); expect(f.complete).not.toHaveBeenCalled();
    expect(f.position.selectedTaskId).toBe(f.originals[0]!.taskId);
    w.dispose();
  });

  it("keeps search and full text isolated from submission and preserves explicit child bring-back", async () => {
    const f = unsentWorkspaceSetup(); const w = f.workspace;
    text(w); await vi.waitFor(() => expect(text(w)).toContain(a.name));
    w.handleInput("o"); expect(text(w)).toContain("Original prompt");
    w.handleInput(tab); w.handleInput("/"); w.handleInput(a.name);
    for (const key of [tab, backTab, ctrlS]) w.handleInput(key);
    expect(text(w)).toContain("Focus: Preferences · Search");
    w.handleInput(enter);
    expect(f.run).not.toHaveBeenCalled();
    w.handleInput("o");
    for (const key of [tab, backTab, enter, enter, ctrlS, bringBack]) w.handleInput(key);
    expect(text(w)).toContain("Focus: Preferences · Read-only");
    expect(f.run).not.toHaveBeenCalled();
    w.handleInput(esc); w.handleInput("p"); await loaded(w);
    w.handleInput(" "); w.handleInput(enter); w.handleInput(enter);
    expect(f.run).not.toHaveBeenCalled();
    w.handleInput(esc); w.handleInput(bringBack);
    expect(f.run).not.toHaveBeenCalled();
    expect(text(w)).toContain("Focus: Preferences");
    w.handleInput(enter);
    expect(f.run).toHaveBeenCalledExactlyOnceWith(f.originals[0]!.id);
    await Promise.resolve(); w.dispose();
  });

  it("consumes the focused Enter if its Unsent starts elsewhere, rather than inspecting or running another item", async () => {
    const f = unsentWorkspaceSetup(); const w = f.workspace;
    text(w); await vi.waitFor(() => expect(text(w)).toContain(a.name));
    w.handleInput(backTab);
    f.complete.mockImplementationOnce(() => new Promise(() => {}));
    f.controller.startRecord(f.originals[0]!.id);
    text(w); w.handleInput(enter);
    expect(text(w)).toContain("Original changed or already started");
    expect(text(w)).not.toContain("Prompt details");
    expect(f.run).not.toHaveBeenCalled();
    expect(f.controller.getRecord(f.originals[0]!.id)!.input.preferences).toBeUndefined();
    w.dispose(); f.controller.setSession("other");
  });

  it.each(["dark", "light"])("uses p independently of optional keys, freezes snapshots, and requests only on parent Enter (%s)", async (theme) => {
    const f = unsentWorkspaceSetup(null, false, theme); const w = f.workspace;
    expect(text(w)).toContain("Preferences · 0 selected");
    w.handleInput("p"); await loaded(w);
    expect(text(w)).toContain("Preferences · Unsent original");
    w.handleInput(" "); w.handleInput(ctrlS);
    expect(text(w)).toContain("press Enter on the Unsent original");
    expect(text(w)).not.toContain("Return to Revise");
    w.handleInput(enter); expect(text(w)).toContain("Full editing instruction");
    w.handleInput(ctrlS); expect(f.complete).not.toHaveBeenCalled();
    w.handleInput(esc); w.handleInput(bringBack);
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.repo.save).not.toHaveBeenCalled();
    expect(text(w)).toContain("Preferences · 1 selected");
    expect(text(w)).toContain(`[x] ${a.name}`);
    expect(f.controller.getRecord(f.originals[0]!.id)!.input.draft).toBe(f.originals[0]!.input.draft);
    f.library.entries[0]!.body = "Changed library text";
    w.handleInput(enter);
    expect(f.run).toHaveBeenCalledExactlyOnceWith(f.originals[0]!.id);
    expect(f.complete.mock.calls[0]![0]).toMatchObject({ editingInstruction: composeRevision([selectPreference(a)], ""), draft: f.originals[0]!.input.draft });
    await Promise.resolve(); w.dispose();
  });

  it("keeps p available when the configured modifier conflicts and does not leak child input", async () => {
    const f = unsentWorkspaceSetup("alt+p", true); const w = f.workspace;
    w.handleInput(altP); expect(text(w)).not.toContain("Bring back");
    w.handleInput("p"); await loaded(w);
    w.handleInput("n"); w.handleInput("New entry"); w.handleInput(tab);
    // Add must not prefill the original task as a reusable editing requirement.
    expect(text(w)).not.toContain(f.originals[0]!.input.draft);
    for (const key of ["p", "i", "f", enter, ctrlS]) w.handleInput(key);
    expect(f.run).not.toHaveBeenCalled(); expect(f.complete).not.toHaveBeenCalled();
    w.handleInput(esc); w.handleInput("y"); w.handleInput(esc);
    w.handleInput("p"); await loaded(w); w.handleInput(" "); w.handleInput(esc);
    expect(f.controller.getRecord(f.originals[0]!.id)!.input.preferences).toBeUndefined();
    w.dispose();
  });

  it("isolates selections by original, preserves deleted-source snapshots, and explicitly clears them", async () => {
    const f = unsentWorkspaceSetup(); const w = f.workspace;
    w.handleInput(altP); await loaded(w); w.handleInput(" "); w.handleInput(bringBack);
    f.position.selectedTaskId = f.originals[1]!.taskId;
    expect(text(w)).toContain("Preferences · 0 selected");
    expect(text(w).split("\n")[2]).not.toContain(a.name);
    w.handleInput("p"); await loaded(w); expect(text(w)).toContain("0 selected");
    w.handleInput(esc);
    f.position.selectedTaskId = f.originals[0]!.taskId;
    f.library.entries = f.library.entries.filter((entry) => entry.id !== a.id);
    w.handleInput("p"); await loaded(w);
    expect(text(w)).toContain("1 selected");
    expect(text(w)).toContain(a.name);
    // Filter to the retained deleted snapshot and remove it explicitly.
    w.handleInput("/"); w.handleInput(a.name); w.handleInput(enter); w.handleInput(" "); w.handleInput(bringBack);
    expect(f.controller.getRecord(f.originals[0]!.id)!.input.editingInstruction).toBeUndefined();
    expect(f.controller.getRecord(f.originals[1]!.id)!.input.preferences).toBeUndefined();
    expect(f.complete).not.toHaveBeenCalled(); w.dispose();
  });

  it("retains over-limit working selections and shows semantic warnings through resize", async () => {
    const f = unsentWorkspaceSetup(null, false, "light", 90); const w = f.workspace;
    w.handleInput("p"); await loaded(w);
    w.handleInput(" "); w.handleInput(down); w.handleInput(" "); w.handleInput(bringBack);
    expect(text(w)).toContain("Editing requirements exceed 90");
    expect(w.render(100).join("\n")).toContain(f.theme.fg("warning", "⚠ Editing requirements exceed 90 characters; reduce the selection."));
    for (const [width, rows] of [[100, 40], [40, 16], [20, 8], [12, 6], [80, 30]]) {
      f.terminal.rows = rows!;
      const lines = w.render(width!);
      expect(lines).toHaveLength(workspaceHeight(rows!));
      expect(w.render(width!)).toHaveLength(lines.length);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width!);
    }
    expect(f.controller.getRecord(f.originals[0]!.id)!.input.preferences).toBeUndefined();
    w.handleInput(" "); w.handleInput(bringBack);
    expect(f.controller.getRecord(f.originals[0]!.id)!.input.preferences).toHaveLength(1);
    expect(f.complete).not.toHaveBeenCalled(); w.dispose();
  });

  it("preserves selection through Usage for archived Unsent originals with intact background", async () => {
    const f = unsentWorkspaceSetup(); const w = f.workspace;
    f.controller.onMessageStarted("Another Pi task");
    w.openUsage({ id: f.originals[0]!.id, original: true });
    w.handleInput("p"); await loaded(w);
    expect(text(w)).toContain("Preferences · Unsent original");
    w.handleInput(" "); w.handleInput(bringBack);
    expect(f.controller.getRecord(f.originals[0]!.id)!.input.preferences).toEqual([selectPreference(a)]);
    expect(f.complete).not.toHaveBeenCalled();
    w.handleInput(enter);
    expect(f.run).toHaveBeenCalledExactlyOnceWith(f.originals[0]!.id);
    expect(f.complete.mock.calls[0]![0]).toMatchObject({ roundId: f.originals[0]!.input.roundId });
    await Promise.resolve(); w.dispose();
  });

  it("rejects bring-back if an editable original starts while the child is open", async () => {
    const f = unsentWorkspaceSetup(); const w = f.workspace;
    f.complete.mockImplementationOnce(() => new Promise(() => {}));
    w.handleInput("p"); await loaded(w); w.handleInput(" ");
    f.controller.startRecord(f.originals[0]!.id);
    w.handleInput(bringBack);
    expect(text(w)).toContain("already started");
    expect(f.controller.getRecord(f.originals[0]!.id)!.input.preferences).toBeUndefined();
    w.handleInput(esc); w.handleInput("p"); await loaded(w);
    expect(text(w)).not.toContain("Bring back");
    w.dispose(); f.controller.setSession("other");
  });

  it("keeps working snapshots in the child if the original changes before bring-back", async () => {
    const f = unsentWorkspaceSetup(); const w = f.workspace;
    w.handleInput("p"); await loaded(w); w.handleInput(" ");
    const source = f.originals[0]!;
    f.controller.updateDraft(source.id, source.input.draft, "Changed outside child");
    w.handleInput(bringBack);
    expect(text(w)).toContain("Cancel and reopen Preferences");
    w.handleInput(enter); expect(text(w)).toContain("Saved snapshot");
    expect(f.controller.getRecord(source.id)!.input.preferences).toBeUndefined();
    expect(f.complete).not.toHaveBeenCalled();
    w.handleInput(esc); w.handleInput(esc); w.dispose();
  });
});

describe("workspace preference integration", () => {
  it.each(["dark", "light"])("reviews exact snapshots without submitting, restores input, and fits resized %s views", async (theme) => {
    const f = workspaceSetup("alt+p", false, theme); const w = f.workspace;
    w.handleInput("f"); w.handleInput("补充 中文😀\x1b[2J");
    w.handleInput(altP); await loaded(w); w.handleInput(" "); w.handleInput(bringBack);
    expect(text(w)).toContain("Preferences: 1");
    w.handleInput("\t"); w.handleInput("\t"); w.handleInput(enter);
    expect(text(w)).toContain("Full revision requirements");
    expect(text(w)).toContain(a.body);
    w.handleInput(ctrlS); expect(f.submit).not.toHaveBeenCalled();
    for (const [width, rows] of [[100, 40], [36, 16], [12, 8], [80, 30]]) {
      f.terminal.rows = rows!;
      const lines = w.render(width!);
      expect(lines).toHaveLength(workspaceHeight(rows!));
      expect(w.render(width!)).toHaveLength(lines.length);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width!);
      expect(lines.join("\n")).not.toContain("\x1b[2J");
      w.handleInput("\x1b[6~"); w.handleInput("\x1b[5~");
    }
    f.terminal.rows = 40;
    expect(w.render(100).join("\n")).toContain(f.theme.fg("text", f.theme.bold("Full revision requirements")));
    w.handleInput(esc); w.handleInput("!"); w.handleInput(ctrlS);
    expect(f.submit.mock.calls.at(-1)![0]).toContain(`${a.body}\n\nCurrent user instructions:\n补充 中文😀`);
    expect(f.submit.mock.calls.at(-1)![0]).toContain("!");
    w.handleInput(esc); w.handleInput("f");
    expect(text(w)).toContain("Preferences: 1");
  });

  it("disables a local key that conflicts with Pi's resolved bindings", async () => {
    const f = workspaceSetup("alt+p", true); const w = f.workspace;
    w.handleInput("f"); expect(text(w)).toContain("Preferences key conflicts");
    w.handleInput(altP); expect(text(w)).toContain("Revise current result");
    w.handleInput("\t"); w.handleInput(enter); await loaded(w);
    expect(text(w)).toContain("Bring back");
  });
  it("does not let Undo restore another candidate's free input", () => {
    const f = workspaceSetup(); const w = f.workspace;
    w.handleInput("f"); w.handleInput("Private first feedback"); w.handleInput(esc);
    f.identity("two"); w.handleInput("f"); w.handleInput("Second feedback");
    w.handleInput("\x1b[45;5u"); w.handleInput(ctrlS);
    expect(f.submit).not.toHaveBeenCalled();
    expect(text(w)).toContain("Select preferences or enter additional requirements");
  });
  it("submits only on Revise Ctrl+S; preserves cursor, selection and candidate isolation", async () => {
    const f = workspaceSetup(); const w = f.workspace;
    w.handleInput("f"); w.handleInput("AB"); w.handleInput(left);
    w.handleInput(altP); await loaded(w);
    w.handleInput(" "); w.handleInput(ctrlS); w.handleInput(enter); w.handleInput(ctrlS); w.handleInput(esc);
    expect(f.submit).not.toHaveBeenCalled();
    w.handleInput(bringBack); w.handleInput("X");
    w.handleInput(ctrlS); expect(f.submit).toHaveBeenLastCalledWith(composeRevision([selectPreference(a)], "AXB"));
    w.handleInput(esc); f.identity("two"); w.handleInput("f"); w.handleInput("Other"); w.handleInput(ctrlS);
    expect(f.submit).toHaveBeenLastCalledWith("Other");
    w.handleInput(esc); f.identity("one"); w.handleInput("f"); w.handleInput(ctrlS);
    expect(f.submit).toHaveBeenLastCalledWith(composeRevision([selectPreference(a)], "AXB"));
  });
  it("cancels local selection changes and saves expanded paste instead of placeholders", async () => {
    const f = workspaceSetup(); const w = f.workspace;
    const pasted = "中文 😀 command --literal\n".repeat(100);
    w.handleInput("f"); w.handleInput(`\x1b[200~${pasted}\x1b[201~`);
    w.handleInput(altP); await loaded(w);
    w.handleInput("n"); w.handleInput("Paste"); save(w); await loaded(w);
    expect(f.repo.save.mock.calls[0]![1].body).toBe(pasted);
    w.handleInput(" "); w.handleInput(esc); w.handleInput(ctrlS);
    expect(f.submit).toHaveBeenLastCalledWith(pasted);
  });
  it("offers a focusable Preferences control without a binding and removes result p", async () => {
    const f = workspaceSetup(null); const w = f.workspace;
    w.openResult(); w.handleInput("p");
    expect(text(w)).toContain("Press f to revise");
    w.handleInput("f"); w.handleInput("\t"); w.handleInput(enter); await loaded(w);
    expect(text(w)).toContain("Bring back"); w.handleInput(esc);
    w.handleInput("\x1bOQ"); expect(text(w)).toContain("Revise current result");
    w.handleInput(ctrlS); expect(f.submit).not.toHaveBeenCalled();
  });
});
