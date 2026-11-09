// ABOUTME: Pins the ratified staged-close payload, delta, and affected-untitled derivations.
// ABOUTME: Keeps failure copy honest without requiring a native window in unit tests.

import { describe, expect, it } from "vitest";
import type { SessionPayload } from "./sessionPersistence";
import { affectedUntitledTabs, composeProposedSession, materiallyEqualSession } from "./sessionClose";

const baseline: SessionPayload = {
  tabs: [
    { path: "a.md", unsavedContent: null, recoveredFrom: null },
    {
      path: "untitled:1:b.md",
      unsavedContent: null,
      recoveredFrom: "b.md",
      unsavedContentOmitted: true,
      lossNoticeCollapsed: true,
    },
  ],
  activePath: "untitled:1:b.md",
};

describe("staged session close", () => {
  it("composes staged removals without mutating live state and chooses a surviving active tab", () => {
    const proposed = composeProposedSession(baseline, new Map([["untitled:1:b.md", "discard-recorded"]]));

    expect(proposed).toEqual({
      tabs: [{ path: "a.md", unsavedContent: null, recoveredFrom: null }],
      activePath: "a.md",
    });
    expect(baseline.tabs).toHaveLength(2);
  });

  it("materially compares the canonical payload including omission and collapsed state", () => {
    expect(materiallyEqualSession(baseline, structuredClone(baseline))).toBe(true);
    expect(
      materiallyEqualSession(baseline, {
        ...baseline,
        tabs: [{ ...baseline.tabs[0] }, { ...baseline.tabs[1], lossNoticeCollapsed: false }],
      }),
    ).toBe(false);
  });

  it("attributes only discard-recorded removals and changed live untitled state", () => {
    const staged = new Map<string, "saved" | "discard-recorded">([
      ["untitled:1:b.md", "discard-recorded"],
    ]);
    const proposed = composeProposedSession(baseline, staged);

    expect(affectedUntitledTabs(baseline, proposed, staged)).toEqual(["b.md"]);
    expect(affectedUntitledTabs(baseline, proposed, new Map())).toEqual([]);
  });

  it("does not attribute a project-tab-only index shift to an untouched untitled document", () => {
    const proposed = {
      tabs: [structuredClone(baseline.tabs[1])],
      activePath: baseline.activePath,
    };

    expect(affectedUntitledTabs(baseline, proposed, new Map())).toEqual([]);
  });

  it("attributes a changed relative order within the untitled subsequence", () => {
    const second = {
      path: "untitled:2:c.md",
      unsavedContent: "c",
      recoveredFrom: "c.md",
    };
    const withTwo = {
      tabs: [...baseline.tabs, second],
      activePath: baseline.activePath,
    };
    const proposed = {
      tabs: [baseline.tabs[0], second, baseline.tabs[1]],
      activePath: baseline.activePath,
    };

    expect(affectedUntitledTabs(withTwo, proposed, new Map())).toEqual(["b.md", "c.md"]);
  });

  it("uses stable collision ordinals in the affected-documents list", () => {
    const first = {
      ...baseline.tabs[1],
      displacedLabelOrdinal: 1,
    };
    const second = {
      ...baseline.tabs[1],
      path: "untitled:2:b.md",
      displacedLabelOrdinal: 2,
    };
    const withDuplicates = {
      tabs: [baseline.tabs[0], first, second],
      activePath: first.path,
    };
    const staged = new Map<string, "discard-recorded">([
      [first.path, "discard-recorded"],
      [second.path, "discard-recorded"],
    ]);

    expect(affectedUntitledTabs(withDuplicates, composeProposedSession(withDuplicates, staged), staged))
      .toEqual(["Untitled — recovered from b.md (1)", "Untitled — recovered from b.md (2)"]);
  });
});
