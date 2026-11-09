// ABOUTME: Pure tab-state logic (P2a-6, FR-ED-3) — open/switch/close/dirty-tracking transitions
// ABOUTME: and the dirty-close guard predicate, plus session-shape <-> tab-state mapping.
import { describe, expect, it } from "vitest";
import {
  adoptUntitledTab,
  closeTab,
  dirtyTabsRequiringGuard,
  EMPTY_TABS,
  exceedsSessionContentCap,
  isRecoveredTab,
  missingTabPaths,
  openTab,
  recoveredTabPaths,
  rekeyTabPaths,
  restoreFromSession,
  SESSION_UNSAVED_CONTENT_CAP_BYTES,
  setActiveTab,
  setRecoveryNoticeCollapsed,
  setTabDirty,
  setUntitledDocId,
  tabLabel,
  tabsRequiringCloseGuard,
  toSessionPayload,
  type TabRecord,
  type TabsState,
} from "./tabs";

describe("stores/tabs — session content cap", () => {
  it("measures the 2 MiB boundary in UTF-8 bytes", () => {
    expect(exceedsSessionContentCap("a".repeat(SESSION_UNSAVED_CONTENT_CAP_BYTES))).toBe(false);
    expect(exceedsSessionContentCap("a".repeat(SESSION_UNSAVED_CONTENT_CAP_BYTES + 1))).toBe(true);
    expect(exceedsSessionContentCap("é".repeat(SESSION_UNSAVED_CONTENT_CAP_BYTES / 2))).toBe(false);
    expect(exceedsSessionContentCap(`é${"a".repeat(SESSION_UNSAVED_CONTENT_CAP_BYTES - 1)}`)).toBe(
      true,
    );
  });
});

describe("stores/tabs — opening", () => {
  it("opening a fresh path adds it as a clean tab and activates it", () => {
    const state = openTab(EMPTY_TABS, "a.md");
    expect(state.tabs).toEqual([{ path: "a.md", dirty: false }]);
    expect(state.activePath).toBe("a.md");
  });

  it("opening a second path adds a second tab without touching the first", () => {
    let state = openTab(EMPTY_TABS, "a.md");
    state = openTab(state, "b.md");
    expect(state.tabs.map((t) => t.path)).toEqual(["a.md", "b.md"]);
    expect(state.activePath).toBe("b.md");
  });

  it("opening an already-open path just focuses it — never duplicates the tab", () => {
    let state = openTab(EMPTY_TABS, "a.md");
    state = openTab(state, "b.md");
    state = openTab(state, "a.md");
    expect(state.tabs.map((t) => t.path)).toEqual(["a.md", "b.md"]);
    expect(state.activePath).toBe("a.md");
  });

  it("opening an already-open path never resets its dirty flag", () => {
    let state = openTab(EMPTY_TABS, "a.md");
    state = setTabDirty(state, "a.md", true);
    state = openTab(state, "a.md");
    expect(state.tabs[0].dirty).toBe(true);
  });
});

describe("stores/tabs — switching", () => {
  it("setActiveTab focuses an already-open tab", () => {
    let state = openTab(EMPTY_TABS, "a.md");
    state = openTab(state, "b.md");
    state = setActiveTab(state, "a.md");
    expect(state.activePath).toBe("a.md");
  });

  it("setActiveTab is a no-op for a path that is not open", () => {
    const state = openTab(EMPTY_TABS, "a.md");
    expect(setActiveTab(state, "nowhere.md")).toEqual(state);
  });
});

describe("stores/tabs — dirty tracking", () => {
  it("setTabDirty marks a tab dirty without affecting other tabs", () => {
    let state = openTab(EMPTY_TABS, "a.md");
    state = openTab(state, "b.md");
    state = setTabDirty(state, "a.md", true);
    expect(state.tabs).toEqual([
      { path: "a.md", dirty: true },
      { path: "b.md", dirty: false },
    ]);
  });

  it("setTabDirty back to false clears the flag", () => {
    let state = openTab(EMPTY_TABS, "a.md");
    state = setTabDirty(state, "a.md", true);
    state = setTabDirty(state, "a.md", false);
    expect(state.tabs[0].dirty).toBe(false);
  });
});

describe("stores/tabs — closing", () => {
  it("closeTab removes the tab from the set", () => {
    let state = openTab(EMPTY_TABS, "a.md");
    state = openTab(state, "b.md");
    state = closeTab(state, "a.md");
    expect(state.tabs.map((t) => t.path)).toEqual(["b.md"]);
  });

  it("closing the active tab activates its right neighbor", () => {
    let state = openTab(EMPTY_TABS, "a.md");
    state = openTab(state, "b.md");
    state = openTab(state, "c.md");
    state = setActiveTab(state, "b.md");

    state = closeTab(state, "b.md");

    expect(state.activePath).toBe("c.md");
  });

  it("closing the active last tab activates its left neighbor", () => {
    let state = openTab(EMPTY_TABS, "a.md");
    state = openTab(state, "b.md");

    state = closeTab(state, "b.md");

    expect(state.activePath).toBe("a.md");
  });

  it("closing the only open tab leaves no active tab", () => {
    let state = openTab(EMPTY_TABS, "a.md");
    state = closeTab(state, "a.md");
    expect(state.tabs).toEqual([]);
    expect(state.activePath).toBeNull();
  });

  it("closing an inactive tab leaves the active tab untouched", () => {
    let state = openTab(EMPTY_TABS, "a.md");
    state = openTab(state, "b.md");
    state = closeTab(state, "a.md");
    expect(state.activePath).toBe("b.md");
  });

  it("closing an unopened path is a quiet no-op", () => {
    const state = openTab(EMPTY_TABS, "a.md");
    expect(closeTab(state, "nowhere.md")).toEqual(state);
  });
});

describe("stores/tabs — dirty-close guard predicate", () => {
  it("a clean tab needs no guard", () => {
    const state = openTab(EMPTY_TABS, "a.md");
    expect(dirtyTabsRequiringGuard(state, ["a.md"])).toEqual([]);
  });

  it("a dirty tab needs a guard decision", () => {
    let state = openTab(EMPTY_TABS, "a.md");
    state = setTabDirty(state, "a.md", true);
    expect(dirtyTabsRequiringGuard(state, ["a.md"])).toEqual(["a.md"]);
  });

  it("with no paths given checks every open tab (the quit-with-dirty-tabs case)", () => {
    let state = openTab(EMPTY_TABS, "a.md");
    state = openTab(state, "b.md");
    state = setTabDirty(state, "b.md", true);
    expect(dirtyTabsRequiringGuard(state)).toEqual(["b.md"]);
  });

  it("closing an untitled recovery document needs a guard even though it is never dirty", () => {
    // The ✕ is the one action that destroys this buffer: there is no second copy anywhere, and no
    // ● on the strip to warn with, because the tab is deliberately clean (CJ, 2026-08-12).
    const state: TabsState = {
      tabs: [{ path: "untitled:1:b.md", dirty: false, recoveredFrom: "b.md" }],
      activePath: "untitled:1:b.md",
    };

    expect(tabsRequiringCloseGuard(state, ["untitled:1:b.md"])).toEqual(["untitled:1:b.md"]);
  });

  it("quitting is not guarded on a recovery document — the session carries it out and back", () => {
    // The proof-aware quit coordinator is Architect-owned; this predicate remains the dirty
    // project-document queue and must not manufacture `dirty` for an untitled document.
    const state: TabsState = {
      tabs: [{ path: "untitled:1:b.md", dirty: false, recoveredFrom: "b.md" }],
      activePath: "untitled:1:b.md",
    };

    expect(dirtyTabsRequiringGuard(state)).toEqual([]);
  });

  it("closing a clean project document is still unguarded", () => {
    let state = openTab(EMPTY_TABS, "a.md");
    state = setTabDirty(state, "a.md", true);
    state = openTab(state, "b.md");

    expect(tabsRequiringCloseGuard(state, ["b.md"])).toEqual([]);
    expect(tabsRequiringCloseGuard(state, ["a.md"])).toEqual(["a.md"]);
  });
});

describe("stores/tabs — session restore", () => {
  it("restoreFromSession opens each tab — dirty iff it carried unsaved content", () => {
    const state = restoreFromSession({
      tabs: [
        { path: "a.md", unsavedContent: null, recoveredFrom: null },
        { path: "b.md", unsavedContent: "in-flight edit", recoveredFrom: null },
      ],
      activePath: "b.md",
    });

    expect(state.tabs).toEqual([
      { path: "a.md", dirty: false },
      { path: "b.md", dirty: true },
    ]);
    expect(state.activePath).toBe("b.md");
  });

  it("restoreFromSession brings an untitled recovery document back, still not dirty", () => {
    const state = restoreFromSession({
      tabs: [
        {
          path: "untitled:1:b.md",
          unsavedContent: "displaced unsaved work",
          recoveredFrom: "b.md",
        },
      ],
      activePath: "untitled:1:b.md",
    });

    // Its content is the whole document, not a divergence from a file — restoring it as `dirty`
    // would hand it to FR-ED-3's save guard, which has nowhere to save it to. What identifies it
    // across the relaunch is the persisted `recoveredFrom`, so the pane, the strip label, and the
    // protected-set filter all resolve from the record rather than re-sniffing the path.
    expect(state.tabs).toEqual([
      { path: "untitled:1:b.md", dirty: false, recoveredFrom: "b.md", displacedLabelOrdinal: 1 },
    ]);
    expect(isRecoveredTab(state.tabs[0])).toBe(true);
  });

  it("restores an untitled document's path-independent sidecar identity", () => {
    const state = restoreFromSession({
      tabs: [{
        path: "untitled:1:b.md",
        docId: "4c7be32a-45f8-476f-a175-8fd48cab51d3",
        unsavedContent: "draft",
        recoveredFrom: "b.md",
      }],
      activePath: "untitled:1:b.md",
    });

    expect(state.tabs[0].docId).toBe("4c7be32a-45f8-476f-a175-8fd48cab51d3");
  });

  it("uses the explicit persisted cap outcome as the authoritative recovery state", () => {
    const state = restoreFromSession({
      tabs: [
        {
          path: "untitled:1:b.md",
          unsavedContent: "new work after omission",
          recoveredFrom: "b.md",
          unsavedContentOmitted: true,
        },
      ],
      activePath: "untitled:1:b.md",
    });

    expect(state.tabs).toEqual([
      {
        path: "untitled:1:b.md",
        dirty: false,
        recoveredFrom: "b.md",
        displacedLabelOrdinal: 1,
        recoveryContentOmitted: true,
      },
    ]);
  });

  it("does not re-infer omission from recovered-from plus null after the Rust migration boundary", () => {
    const state = restoreFromSession({
      tabs: [{ path: "untitled:1:b.md", unsavedContent: null, recoveredFrom: "b.md" }],
      activePath: "untitled:1:b.md",
    });

    expect(state.tabs[0]).not.toHaveProperty("recoveryContentOmitted");
  });

  it("does not flag an ordinary recovery document restored within the cap", () => {
    const state = restoreFromSession({
      tabs: [
        { path: "untitled:1:b.md", unsavedContent: "displaced unsaved work", recoveredFrom: "b.md" },
      ],
      activePath: "untitled:1:b.md",
    });

    expect(state.tabs[0]).not.toHaveProperty("recoveryContentOmitted");
  });

  it("restores a project document that merely looks like a recovery identity as itself", () => {
    // `untitled:1:notes.md` is a legal project-relative path on macOS and Linux, and §3.5
    // confinement accepts it (CJ, 2026-08-12). Classifying by prefix dropped such a document out
    // of D21's protected set; classifying by the record restores it as the real document it is —
    // dirty, with its unsaved content, and with nothing marking it recovered.
    const state = restoreFromSession({
      tabs: [
        { path: "untitled:1:notes.md", unsavedContent: "a real in-flight edit", recoveredFrom: null },
      ],
      activePath: "untitled:1:notes.md",
    });

    expect(state.tabs).toEqual([{ path: "untitled:1:notes.md", dirty: true }]);
    expect(isRecoveredTab(state.tabs[0])).toBe(false);
  });

  it("restoreFromSession with no tabs restores to the empty state", () => {
    expect(restoreFromSession({ tabs: [], activePath: null })).toEqual(EMPTY_TABS);
  });

  it("restoreFromSession falls back to the first tab when the saved active path is stale", () => {
    const state = restoreFromSession({
      tabs: [{ path: "a.md", unsavedContent: null, recoveredFrom: null }],
      activePath: "no-longer-open.md",
    });
    expect(state.activePath).toBe("a.md");
  });
});

describe("stores/tabs — session persistence mapping", () => {
  it("toSessionPayload pairs each tab with its content getter's current value", () => {
    let state = openTab(EMPTY_TABS, "a.md");
    state = openTab(state, "b.md");
    state = setTabDirty(state, "b.md", true);
    const contentOf: Record<string, string> = { a: "clean a", b: "dirty b" };

    const payload = toSessionPayload(state, (path) => (path === "a.md" ? contentOf.a : contentOf.b));

    expect(payload).toEqual({
      tabs: [
        { path: "a.md", unsavedContent: null, recoveredFrom: null },
        { path: "b.md", unsavedContent: "dirty b", recoveredFrom: null },
      ],
      activePath: "b.md",
    });
  });

  it("toSessionPayload persists an untitled recovery document's whole buffer and its origin", () => {
    const state: TabsState = {
      tabs: [{ path: "untitled:1:b.md", dirty: false, recoveredFrom: "b.md" }],
      activePath: "untitled:1:b.md",
    };

    // A clean *file* tab restores from disk, so its content is collapsed to null. A recovery
    // document has no disk to restore from: the session is the only durable copy of it, which is
    // what keeps quitting the app from discarding the displaced work (CJ, 2026-08-11). The origin
    // rides along because it is what re-identifies the tab on the way back in.
    expect(toSessionPayload(state, () => "displaced unsaved work")).toEqual({
      tabs: [
        {
          path: "untitled:1:b.md",
          unsavedContent: "displaced unsaved work",
          recoveredFrom: "b.md",
        },
      ],
      activePath: "untitled:1:b.md",
    });
  });

  it("checkpoints the same untitled document id that sidecar commands target", () => {
    const state = setUntitledDocId(
      {
        tabs: [{ path: "untitled:1:b.md", dirty: false, recoveredFrom: "b.md" }],
        activePath: "untitled:1:b.md",
      },
      "untitled:1:b.md",
      "4c7be32a-45f8-476f-a175-8fd48cab51d3",
    );

    expect(toSessionPayload(state, () => "draft").tabs[0]).toMatchObject({
      docId: "4c7be32a-45f8-476f-a175-8fd48cab51d3",
      unsavedContent: "draft",
    });
  });

  it("toSessionPayload preserves an over-cap omission instead of replacing it with an empty buffer", () => {
    const state: TabsState = {
      tabs: [
        {
          path: "untitled:1:b.md",
          dirty: false,
          recoveredFrom: "b.md",
          recoveryContentOmitted: true,
        },
      ],
      activePath: "untitled:1:b.md",
    };

    expect(toSessionPayload(state, () => "")).toEqual({
      tabs: [
        {
          path: "untitled:1:b.md",
          unsavedContent: null,
          recoveredFrom: "b.md",
          unsavedContentOmitted: true,
        },
      ],
      activePath: "untitled:1:b.md",
    });
  });

  it("persists new edits without clearing the standing omission outcome", () => {
    const state: TabsState = {
      tabs: [
        {
          path: "untitled:1:b.md",
          dirty: false,
          recoveredFrom: "b.md",
          recoveryContentOmitted: true,
          lossNoticeCollapsed: true,
        },
      ],
      activePath: "untitled:1:b.md",
    };

    expect(toSessionPayload(state, () => "new work after omission").tabs[0]).toEqual({
      path: "untitled:1:b.md",
      unsavedContent: "new work after omission",
      recoveredFrom: "b.md",
      unsavedContentOmitted: true,
      lossNoticeCollapsed: true,
    });
  });

  it("persists collapse only on an over-cap recovery document", () => {
    const recovery: TabsState = {
      tabs: [
        {
          path: "untitled:1:b.md",
          dirty: false,
          recoveredFrom: "b.md",
          recoveryContentOmitted: true,
        },
      ],
      activePath: "untitled:1:b.md",
    };

    const collapsed = setRecoveryNoticeCollapsed(recovery, "untitled:1:b.md", true);
    expect(collapsed.tabs[0].lossNoticeCollapsed).toBe(true);
    expect(toSessionPayload(collapsed, () => "").tabs[0]).toMatchObject({
      unsavedContent: null,
      unsavedContentOmitted: true,
      lossNoticeCollapsed: true,
    });
    expect(setRecoveryNoticeCollapsed(collapsed, "untitled:1:b.md", false).tabs[0]).not.toHaveProperty(
      "lossNoticeCollapsed",
    );

    const ordinary = openTab(EMPTY_TABS, "b.md");
    expect(setRecoveryNoticeCollapsed(ordinary, "b.md", true)).toBe(ordinary);
  });
});

describe("stores/tabs — external path transitions", () => {
  const move = (oldPath: string, newPath: string, kind: "file" | "directory" = "file") => ({
    old_path: oldPath,
    new_path: newPath,
    kind,
  });

  it("carries a moved document's tab, dirty flag, and position to its new path", () => {
    let state = openTab(EMPTY_TABS, "a.md");
    state = openTab(state, "drafts/b.md");
    state = setTabDirty(state, "drafts/b.md", true);

    const next = rekeyTabPaths(state, [move("drafts/b.md", "archive/b.md")]);

    expect(next.tabs).toEqual([
      { path: "a.md", dirty: false },
      { path: "archive/b.md", dirty: true },
    ]);
    expect(next.activePath).toBe("archive/b.md");
  });

  it("carries the active marker only when the active tab is the one that moved", () => {
    let state = openTab(EMPTY_TABS, "a.md");
    state = openTab(state, "b.md");

    const next = rekeyTabPaths(state, [move("a.md", "renamed.md")]);

    expect(next.tabs.map((t) => t.path)).toEqual(["renamed.md", "b.md"]);
    expect(next.activePath).toBe("b.md");
  });

  it("leaves a tab whose own move was never proven exactly where it was", () => {
    let state = openTab(EMPTY_TABS, "drafts/proven.md");
    state = openTab(state, "drafts/ambiguous.md");

    // TD-18 emits the directory's move plus a move per independently proven descendant; the
    // ambiguous one has none, so its identity did not follow and its tab must not either — that
    // degrade belongs to the dependent Missing-on-disk lifecycle.
    const next = rekeyTabPaths(state, [
      move("drafts", "archive", "directory"),
      move("drafts/proven.md", "archive/proven.md"),
    ]);

    expect(next.tabs.map((t) => t.path)).toEqual(["archive/proven.md", "drafts/ambiguous.md"]);
    expect(next.activePath).toBe("drafts/ambiguous.md");
  });

  it("is the same state back when no open tab moved", () => {
    const state = openTab(EMPTY_TABS, "a.md");

    expect(rekeyTabPaths(state, [])).toBe(state);
    expect(rekeyTabPaths(state, [move("elsewhere.md", "moved.md")])).toBe(state);
  });

  it("never leaves two tabs on one path when a move lands on an open one", () => {
    let state = openTab(EMPTY_TABS, "a.md");
    state = openTab(state, "b.md");

    const next = rekeyTabPaths(state, [move("a.md", "b.md")]);

    expect(next.tabs).toEqual([{ path: "b.md", dirty: false }]);
    expect(next.activePath).toBe("b.md");
  });

  // CJ, 2026-08-11 (J2): the moved document becomes the sole document at the destination path. A
  // clean displaced tab may close; a dirty one's buffer becomes an untitled recovery document.
  it("keeps a displaced dirty tab's buffer as an untitled recovery document", () => {
    let state = openTab(EMPTY_TABS, "b.md");
    state = setTabDirty(state, "b.md", true);
    state = openTab(state, "a.md");

    const next = rekeyTabPaths(state, [move("a.md", "b.md")]);

    // The displaced tab keeps its strip position; the moved document holds `b.md` alone. The
    // recovery document is not `dirty`: it has no file to differ from, and nothing to save it to.
    expect(next.tabs).toEqual([
      { path: "untitled:1:b.md", dirty: false, recoveredFrom: "b.md", displacedLabelOrdinal: 1 },
      { path: "b.md", dirty: false },
    ]);
    expect(isRecoveredTab(next.tabs[0])).toBe(true);
    expect(isRecoveredTab(next.tabs[1])).toBe(false);
  });

  it("closes a displaced tab that had nothing unsaved to preserve", () => {
    let state = openTab(EMPTY_TABS, "b.md");
    state = openTab(state, "a.md");

    const next = rekeyTabPaths(state, [move("a.md", "b.md")]);

    expect(next.tabs.map((t) => t.path)).toEqual(["b.md"]);
    expect(next.tabs.every((t) => !isRecoveredTab(t))).toBe(true);
  });

  it("keeps the author on their own unsaved work when the displaced tab was the active one", () => {
    let state = openTab(EMPTY_TABS, "a.md");
    state = openTab(state, "b.md");
    state = setTabDirty(state, "b.md", true);

    const next = rekeyTabPaths(state, [move("a.md", "b.md")]);

    // `b.md` now names the moved document, so leaving the marker on that path would silently swap
    // which document the author is looking at. The recovery document *is* the continuation of what
    // they had open, so the marker follows it there.
    expect(next.activePath).toBe("untitled:1:b.md");
  });

  it("gives a second displacement of one path its own recovery identity", () => {
    let state: TabsState = {
      tabs: [{ path: "untitled:1:b.md", dirty: false, recoveredFrom: "b.md", displacedLabelOrdinal: 1 }],
      activePath: null,
    };
    state = openTab(state, "b.md");
    state = setTabDirty(state, "b.md", true);
    state = openTab(state, "a.md");

    const next = rekeyTabPaths(state, [move("a.md", "b.md")]);

    expect(next.tabs).toEqual([
      { path: "untitled:1:b.md", dirty: false, recoveredFrom: "b.md", displacedLabelOrdinal: 1 },
      { path: "untitled:2:b.md", dirty: false, recoveredFrom: "b.md", displacedLabelOrdinal: 2 },
      { path: "b.md", dirty: false },
    ]);
  });

  it("names the recovery identities the rekey will mint, and only for dirty displaced tabs", () => {
    let state = openTab(EMPTY_TABS, "b.md");
    state = setTabDirty(state, "b.md", true);
    state = openTab(state, "c.md");
    state = openTab(state, "a.md");

    // The tab layer carries the displaced buffers to exactly these identities, so the plan the
    // rekey follows has to be readable on its own.
    expect(recoveredTabPaths(state, [move("a.md", "b.md")])).toEqual([
      { from: "b.md", to: "untitled:1:b.md", displacedLabelOrdinal: 1 },
    ]);
    expect(recoveredTabPaths(state, [move("a.md", "c.md")])).toEqual([]);
    expect(recoveredTabPaths(state, [])).toEqual([]);
  });

  it("labels a recovery document by the document it was displaced from", () => {
    expect(tabLabel({ path: "drafts/b.md", dirty: false })).toBe("drafts/b.md");
    expect(
      tabLabel({ path: "untitled:1:drafts/b.md", dirty: false, recoveredFrom: "drafts/b.md" }),
    ).toBe("Untitled — recovered from drafts/b.md");
    // A project document whose own name looks like an identity is labelled by its path, not
    // described as recovered — the label reads the record, never the spelling (CJ, 2026-08-12).
    expect(tabLabel({ path: "untitled:1:notes.md", dirty: false })).toBe("untitled:1:notes.md");
  });

  it("keeps a displaced-label ordinal stable instead of renumbering after a sibling closes", () => {
    const survivor: TabRecord = {
      path: "untitled:2:b.md",
      dirty: false,
      recoveredFrom: "b.md",
      displacedLabelOrdinal: 2,
    };
    expect(tabLabel(survivor, [survivor])).toBe("Untitled — recovered from b.md");

    const first: TabRecord = {
      path: "untitled:1:b.md",
      dirty: false,
      recoveredFrom: "b.md",
      displacedLabelOrdinal: 1,
    };
    expect(tabLabel(first, [first, survivor])).toBe("Untitled — recovered from b.md (1)");
    expect(tabLabel(survivor, [first, survivor])).toBe("Untitled — recovered from b.md (2)");
  });
});

describe("stores/tabs — untitled document adoption (D12, FR-ED-8, #1379)", () => {
  it("turns an untitled recovery tab into an ordinary project tab at the saved path", () => {
    let state = openTab(EMPTY_TABS, "b.md");
    state = setTabDirty(state, "b.md", true);
    state = openTab(state, "a.md");
    state = rekeyTabPaths(state, [{ old_path: "a.md", new_path: "b.md", kind: "file" }]);
    expect(isRecoveredTab(state.tabs[0])).toBe(true); // sanity: untitled:1:b.md

    const next = adoptUntitledTab(state, "untitled:1:b.md", "drafts/kenosis-daily.md");

    expect(next.tabs).toEqual([
      {
        path: "drafts/kenosis-daily.md",
        dirty: false,
        docId: undefined,
        surfaceIdentity: "untitled:1:b.md",
        adoptedDisplacedPath: "b.md",
      },
      { path: "b.md", dirty: false },
    ]);
    expect(isRecoveredTab(next.tabs[0])).toBe(false);
  });

  it("moves the active marker with it when the adopted tab was active", () => {
    let state: TabsState = {
      tabs: [{ path: "untitled:1:b.md", dirty: false, recoveredFrom: "b.md" }],
      activePath: "untitled:1:b.md",
    };

    const next = adoptUntitledTab(state, "untitled:1:b.md", "kenosis-daily.md");

    expect(next.activePath).toBe("kenosis-daily.md");
  });

  it("leaves the active marker alone when a background untitled tab was adopted", () => {
    let state: TabsState = {
      tabs: [
        { path: "untitled:1:b.md", dirty: false, recoveredFrom: "b.md" },
        { path: "c.md", dirty: false },
      ],
      activePath: "c.md",
    };

    const next = adoptUntitledTab(state, "untitled:1:b.md", "kenosis-daily.md");

    expect(next.activePath).toBe("c.md");
  });

  it("is the same state back for a path that names no open untitled tab", () => {
    const state = openTab(EMPTY_TABS, "a.md");

    expect(adoptUntitledTab(state, "untitled:1:a.md", "elsewhere.md")).toBe(state);
    // An ordinary project tab is never "adopted" — that would let a plain Save As on a real
    // document masquerade as scratch-doc adoption and silently drop its `recoveredFrom` check.
    expect(adoptUntitledTab(state, "a.md", "elsewhere.md")).toBe(state);
  });

  it("refuses to adopt onto a path another open tab already claims", () => {
    const state: TabsState = {
      tabs: [
        { path: "untitled:1:b.md", dirty: false, recoveredFrom: "b.md" },
        { path: "drafts/kenosis-daily.md", dirty: false },
      ],
      activePath: "untitled:1:b.md",
    };

    // Adopting onto the second tab's own path would give both tabs the same `path` — the same
    // `paneKeyFor` key, so the second tab could never be selected, closed, or marked dirty again.
    const next = adoptUntitledTab(state, "untitled:1:b.md", "drafts/kenosis-daily.md");

    expect(next).toBe(state);
  });
});

describe("stores/tabs — missing on disk", () => {
  it("names every open document a generation did not enumerate", () => {
    let state = openTab(EMPTY_TABS, "a.md");
    state = openTab(state, "notes/b.md");
    state = setTabDirty(state, "notes/b.md", true);

    // Only `a.md` still has a file. `notes/b.md` is missing whether or not it is dirty — the buffer
    // is preserved either way, and being unsaved is not what makes a document missing.
    expect(missingTabPaths(state, new Set(["a.md", "notes/c.md"]), new Set())).toEqual([
      "notes/b.md",
    ]);
    expect(missingTabPaths(state, new Set(["a.md", "notes/b.md"]), new Set())).toEqual([]);
  });

  it("does not report a document beneath a row the generation never enumerated", () => {
    // A completed generation is not an exhaustive listing: a directory it could not read and a
    // symlink it never descended are published as present rows with no children. Absence under one
    // of those is ignorance, not proof, and J2 enters Missing on disk only on proof (#933) —
    // otherwise the banner claims a file is gone while it sits right there on disk.
    let state = openTab(EMPTY_TABS, "locked/hidden.md");
    state = openTab(state, "linked/deep/notes.md");
    state = openTab(state, "notes/gone.md");

    expect(
      missingTabPaths(state, new Set(["notes/other.md"]), new Set(["locked", "linked"])),
    ).toEqual(["notes/gone.md"]);
  });

  it("still reports a document whose whole folder was deleted", () => {
    // The case an "every ancestor must be listed" rule would wrongly excuse: a deleted directory is
    // absent from the generation entirely, so it names no undescended prefix, and the documents it
    // held really are missing.
    const state = openTab(EMPTY_TABS, "drafts/a.md");

    expect(missingTabPaths(state, new Set(["readme.md"]), new Set())).toEqual(["drafts/a.md"]);
  });

  it("reports a document at an undescended row's own path", () => {
    // The prefix excuses what is *beneath* an unenumerated row, not the row's own path: if the
    // document's path is now a symlink or an unreadable folder, its file is not there. (Such a row
    // is in `presentFilePaths` unless it is a directory, so this is the directory case.)
    const state = openTab(EMPTY_TABS, "locked");

    expect(missingTabPaths(state, new Set(), new Set(["locked"]))).toEqual(["locked"]);
  });

  it("never reports an untitled recovery document, which is at no project path at all", () => {
    // A displaced document already has its own recorded state (`recoveredFrom`); the project tree
    // can say nothing about an identity that was never a path in it, so an empty generation must
    // not sweep it into a lifecycle built around a file that once existed.
    const state = rekeyTabPaths(
      setTabDirty(openTab(openTab(EMPTY_TABS, "a.md"), "b.md"), "a.md", true),
      [{ old_path: "b.md", new_path: "a.md", kind: "file" }],
    );
    expect(state.tabs.some(isRecoveredTab)).toBe(true);

    expect(missingTabPaths(state, new Set(), new Set())).toEqual(["a.md"]);
  });

  it("reports a document whose own move was never proven, at the path it is still on", () => {
    // The degrade #932 deliberately leaves here: the tab stayed on its old path because the backend
    // could not prove the descendant moved, and that path is no longer in the tree.
    let state = openTab(EMPTY_TABS, "drafts/proven.md");
    state = openTab(state, "drafts/ambiguous.md");
    state = rekeyTabPaths(state, [
      { old_path: "drafts", new_path: "archive", kind: "directory" },
      { old_path: "drafts/proven.md", new_path: "archive/proven.md", kind: "file" },
    ]);

    expect(
      missingTabPaths(state, new Set(["archive/proven.md", "archive/ambiguous.md"]), new Set()),
    ).toEqual(["drafts/ambiguous.md"]);
  });
});
