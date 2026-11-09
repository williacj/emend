// ABOUTME: Pure state derivation for J2's staged, receipt-proven project-window close attempt.
// ABOUTME: Composes proposed sessions and honest affected-untitled labels without mutating live tabs.

import type { SessionPayload, TabSnapshotPayload } from "./sessionPersistence";

export type StagedDecision = "saved" | "discard-recorded";

export function composeProposedSession(
  live: SessionPayload,
  staged: ReadonlyMap<string, StagedDecision>,
): SessionPayload {
  const tabs = live.tabs.filter((tab) => staged.get(tab.path) !== "discard-recorded");
  const activePath = tabs.some((tab) => tab.path === live.activePath)
    ? live.activePath
    : tabs[0]?.path ?? null;
  return { tabs, activePath };
}

function normalized(tab: TabSnapshotPayload): Required<TabSnapshotPayload> {
  return {
    ...tab,
    docId: tab.docId ?? "",
    displacedLabelOrdinal: tab.displacedLabelOrdinal ?? 0,
    unsavedContentOmitted: tab.unsavedContentOmitted === true,
    lossNoticeCollapsed: tab.lossNoticeCollapsed === true,
  };
}

export function materiallyEqualSession(a: SessionPayload, b: SessionPayload): boolean {
  if (a.activePath !== b.activePath || a.tabs.length !== b.tabs.length) return false;
  return a.tabs.every((tab, index) => {
    const other = b.tabs[index];
    return other !== undefined && JSON.stringify(normalized(tab)) === JSON.stringify(normalized(other));
  });
}

function displayLabel(tab: TabSnapshotPayload, siblings: readonly TabSnapshotPayload[]): string {
  if (tab.recoveredFrom === null) return tab.path;
  const collides = siblings.filter((candidate) => candidate.recoveredFrom === tab.recoveredFrom).length > 1;
  return collides && tab.displacedLabelOrdinal !== undefined
    ? `Untitled — recovered from ${tab.recoveredFrom} (${tab.displacedLabelOrdinal})`
    : tab.recoveredFrom;
}

export function affectedUntitledTabs(
  baseline: SessionPayload,
  proposed: SessionPayload,
  staged: ReadonlyMap<string, StagedDecision>,
): string[] {
  const beforeUntitled = baseline.tabs.filter((tab) => tab.recoveredFrom !== null);
  const afterUntitled = proposed.tabs.filter((tab) => tab.recoveredFrom !== null);
  const before = new Map(beforeUntitled.map((tab) => [tab.path, tab]));
  const after = new Map(afterUntitled.map((tab) => [tab.path, tab]));
  const labels: string[] = [];
  for (const [path, tab] of before) {
    const next = after.get(path);
    if (next === undefined) {
      if (staged.get(path) === "discard-recorded") labels.push(displayLabel(tab, beforeUntitled));
      continue;
    }
    // Only relative order among untitled documents is attributable to them. Opening or closing a
    // project tab can shift every later mixed-array index without changing any untitled document.
    const beforeIndex = beforeUntitled.findIndex((item) => item.path === path);
    const afterIndex = afterUntitled.findIndex((item) => item.path === path);
    const activeChanged = (baseline.activePath === path) !== (proposed.activePath === path);
    if (
      JSON.stringify(normalized(tab)) !== JSON.stringify(normalized(next)) ||
      beforeIndex !== afterIndex ||
      activeChanged
    ) {
      labels.push(displayLabel(next, afterUntitled));
    }
  }
  for (const [path, tab] of after) {
    if (!before.has(path)) labels.push(displayLabel(tab, afterUntitled));
  }
  return labels;
}
