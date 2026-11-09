// ABOUTME: The tab strip (P2a-6, FR-ED-3) — one keyboard-reachable tab per open document, a dirty
// ABOUTME: indicator, a persistent `Missing on disk` status that reopens J2's recovery actions
// ABOUTME: (#933), and a close button that hands off to the caller's guard.
import { X } from "lucide-react";
import type { KeyboardEvent } from "react";
import { isRecoveredTab, tabLabel, type TabRecord } from "../stores/tabs";
import { isMac, tabListNavigation } from "./keymap";

/** Which platform's tab shape the strip draws — Windows folder tabs, macOS pills
 * (`docs/design/specs/platform-variants.md`, "Document tabs"). */
export type TabBarPlatform = "win" | "mac";

export interface TabBarProps {
  tabs: TabRecord[];
  activePath: string | null;
  onSelect: (path: string) => void;
  onRequestClose: (path: string) => void;
  /**
   * Which open documents a completed generation proved have no file at their path (J2 Missing on
   * disk, #933). Each gets a persistent `Missing on disk` status on its tab that outlives the
   * banner's `[Keep editing]` dismissal — the tab is where a document's own state belongs, and the
   * user must be able to tell at a glance which of several open documents is the missing one.
   */
  missingPaths?: ReadonlySet<string>;
  /** Activating that status: reopens the recovery actions for the named document (ux-design). */
  onActivateMissing?: (path: string) => void;
  /** Untitled tabs whose live bytes exceed the session cap in this process. */
  liveOverCapPaths?: ReadonlySet<string>;
  /** Defaults to the running platform; injectable so a test can render either chrome without
   * faking `navigator` (same shape as `ProjectRail.platform`). */
  platform?: TabBarPlatform;
}

/**
 * A tab's visible label. Hi-fi `3a`/`3b` label each tab with the filename, not the path — the path
 * stays on the tab as its tooltip so a truncated label is still identifiable. Splits on either
 * separator: a project-relative path is normalized to `/` (`stores/menu.ts`), but a path that
 * reached the strip straight from a Windows enumeration is not.
 */
function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/**
 * What the tab face reads. A recovery document has no filename to shorten to — its identity is
 * machinery `stores/tabs` mints, so it keeps the whole description `tabLabel` gives it rather than
 * being split on a separator that belongs to the displaced path.
 */
function accessibleTabLabel(
  tab: TabRecord,
  tabs: readonly TabRecord[],
  liveOverCap = false,
): string {
  if (!isRecoveredTab(tab)) return `${tabLabel(tab, tabs)}${
    tab.recoveryContentOmitted ? " — earlier unsaved work was not preserved" : ""
  }`;
  const facts = [
    ...(liveOverCap ? ["current work is present but not kept in the session"] : []),
    ...(tab.recoveryContentOmitted ? ["earlier unsaved work was not preserved"] : []),
  ];
  return `${tabLabel(tab, tabs)}, editable${
    facts.length > 0 ? ` — ${facts.join("; ")}` : ""
  }`;
}

export function TabBar({
  tabs,
  activePath,
  onSelect,
  onRequestClose,
  missingPaths,
  onActivateMissing,
  liveOverCapPaths,
  platform = isMac ? "mac" : "win",
}: TabBarProps) {
  // WAI-ARIA `tablist` roving-tabindex keyboard contract (T2): arrows/Home/End move selection
  // (selection follows focus), Enter/Space activate the focused tab. Without this a keyboard-only
  // user has no path to switch tabs — the strip would be mouse-only. The key→target-index mapping
  // itself lives in `editor/keymap.ts` (P2b-9b, #362) — the single place this app's keybindings,
  // tab switching included, are defined.
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>, index: number) => {
    const target = tabListNavigation(event.key, index, tabs.length);
    if (target === undefined) return;
    event.preventDefault();
    onSelect(tabs[target].path);
    // Move focus to follow the selection so subsequent arrow presses continue from the new tab.
    const strip = event.currentTarget.parentElement;
    strip?.querySelectorAll<HTMLElement>('[role="tab"]')[target]?.focus();
  };

  return (
    <div className="tab-bar" role="tablist" data-platform={platform}>
      {tabs.map((tab, index) => (
        <div
          key={tab.path}
          role="tab"
          aria-selected={tab.path === activePath}
          tabIndex={tab.path === activePath ? 0 : -1}
          data-dirty={tab.dirty}
          data-recovery-content-omitted={tab.recoveryContentOmitted || undefined}
          data-live-over-cap={liveOverCapPaths?.has(tab.path) || undefined}
          className="tab-bar__tab"
          // The label shows (and truncates) the filename, so the full project-relative path is
          // carried as the tab's own name and tooltip — otherwise two same-named documents in
          // different folders are indistinguishable to a screen reader and on hover. Same
          // `aria-label` + `title` pairing `ProjectRail` uses for its own truncated rows, and the
          // visible label stays a substring of the announced name (WCAG 2.5.3 label-in-name) — for
          // a recovery document, whose name is a description rather than a path, they are equal.
          aria-label={accessibleTabLabel(tab, tabs, liveOverCapPaths?.has(tab.path))}
          title={accessibleTabLabel(tab, tabs, liveOverCapPaths?.has(tab.path))}
          onClick={() => onSelect(tab.path)}
          onKeyDown={(event) => handleKeyDown(event, index)}
        >
          {tab.dirty && <span className="tab-bar__dot" aria-hidden="true" />}
          {isRecoveredTab(tab) ? (
            <span className="tab-bar__label tab-bar__recovered-label">
              {(tab.recoveryContentOmitted || liveOverCapPaths?.has(tab.path)) && (
                <span className="tab-bar__recovery-dot" aria-hidden="true" />
              )}
              <span className="tab-bar__recovered-qualifier">UNTITLED</span>
              <span className="tab-bar__recovered-path">{tab.recoveredFrom}</span>
              {tabs.filter((candidate) => candidate.recoveredFrom === tab.recoveredFrom).length > 1 &&
                tab.displacedLabelOrdinal !== undefined && (
                  <span className="tab-bar__recovered-ordinal">
                    ({tab.displacedLabelOrdinal})
                  </span>
                )}
            </span>
          ) : (
            <>
              {tab.recoveryContentOmitted && (
                <span className="tab-bar__recovery-dot" aria-hidden="true" />
              )}
              <span className="tab-bar__label">{fileName(tab.path)}</span>
            </>
          )}
          {missingPaths?.has(tab.path) && (
            <button
              type="button"
              className="tab-bar__status"
              // Named with its document for the same reason the tab itself is: several tabs can be
              // missing at once, and "Missing on disk" alone would be ambiguous to a screen reader.
              aria-label={`Missing on disk: ${tabLabel(tab, tabs)}. Show recovery actions`}
              onClick={(event) => {
                event.stopPropagation();
                onActivateMissing?.(tab.path);
              }}
            >
              Missing on disk
            </button>
          )}
          <button
            type="button"
            className="tab-bar__close"
            aria-label={`Close ${accessibleTabLabel(tab, tabs, liveOverCapPaths?.has(tab.path))}`}
            onClick={(event) => {
              // A tab is also its close button's click target — without this, closing bubbles
              // into onSelect and briefly (re)activates a tab that's about to disappear.
              event.stopPropagation();
              onRequestClose(tab.path);
            }}
          >
            <X aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
