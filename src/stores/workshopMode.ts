// ABOUTME: Workshop-mode layout state (P2b-6b, ux-design §4 "Workshop mode", J2 Phase A/B) — the
// ABOUTME: one boolean ("is any document tab open") that decides whether the conversation is
// ABOUTME: centre-stage (workshop) or the right rail (authoring); no duplicated timeline mounts.

/** Workshop mode is exactly "no document tab is open" — the single layout state this card adds,
 * driven by `hasOpenTabs` rather than two independently-tracked booleans. `App` derives
 * `hasOpenTabs` itself from two sources (an optimistic seed on a new `request`, corrected by
 * `TabbedEditor.onTabsChange`'s authoritative report) — neither is a transition that needs this
 * module's help, so this is the only function it exports. */
export function isWorkshopMode(hasOpenTabs: boolean): boolean {
  return !hasOpenTabs;
}
