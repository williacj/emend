// ABOUTME: J7's Timeline-label permission cue, shared by the expanded rail and collapsed toolbar chip.
// ABOUTME: Owns the nonnumeric Pause badge, host accessibility, and clear-time focus.
import { ChevronsRight, Pause } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState, type MouseEvent, type RefCallback, type RefObject } from "react";

export type TimelineHostMode = "expanded" | "collapsed";

export interface TimelineHostActionProps {
  mode: TimelineHostMode;
  pending: boolean;
  onActivate: (origin: HTMLElement | null, input: "pointer" | "keyboard") => void;
  /** Programmatic focus seam for project-replacement recovery. */
  hostRef?: RefCallback<HTMLElement>;
  /** TimelinePanel supplies its adjacent collapse button as the focus target when a pending
   * permission clears while the expanded host is focused. */
  clearedFocusTargetRef?: RefObject<HTMLButtonElement | null>;
}

function PermissionBadge() {
  return (
    <span className="timeline-host__permission-badge">
      <Pause aria-hidden="true" />
    </span>
  );
}

export function TimelineHostAction({
  mode,
  pending,
  onActivate,
  hostRef,
  clearedFocusTargetRef,
}: TimelineHostActionProps) {
  const restoreFocusAfterClear = useRef(false);
  const pointerActivationOrigin = useRef<HTMLElement | null>(null);
  const expandedHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const [showProgrammaticFocus, setShowProgrammaticFocus] = useState(false);
  const setExpandedHeadingRef = useCallback((node: HTMLHeadingElement | null) => {
    expandedHeadingRef.current = node;
    hostRef?.(node);
  }, [hostRef]);

  useLayoutEffect(() => {
    if (mode === "expanded" && !pending && restoreFocusAfterClear.current) {
      restoreFocusAfterClear.current = false;
      const collapseToggle = clearedFocusTargetRef?.current;
      if (
        collapseToggle?.isConnected &&
        !collapseToggle.disabled &&
        !collapseToggle.hidden &&
        collapseToggle.getAttribute("aria-hidden") !== "true"
      ) {
        collapseToggle.focus({ preventScroll: true });
        if (document.activeElement === collapseToggle) return;
      }
      const heading = expandedHeadingRef.current;
      if (!heading) return;
      setShowProgrammaticFocus(true);
      heading.focus({ preventScroll: true });
    }
  }, [clearedFocusTargetRef, mode, pending]);

  const trackFocus = () => {
    restoreFocusAfterClear.current = mode === "expanded" && pending;
  };
  const trackBlur = () => {
    // DOM removal itself does not dispatch blur. Any blur received here therefore means the action
    // stopped owning focus before it cleared, including an explicit move to no named destination.
    restoreFocusAfterClear.current = false;
  };
  const trackPointerOrigin = (button: number, currentTarget: HTMLElement) => {
    if (button !== 0) return;
    const active = document.activeElement;
    pointerActivationOrigin.current =
      active instanceof HTMLElement && active !== currentTarget ? active : null;
  };
  const activate = (event: MouseEvent<HTMLButtonElement>) => {
    const origin = pointerActivationOrigin.current;
    pointerActivationOrigin.current = null;
    onActivate(origin, event.detail > 0 ? "pointer" : "keyboard");
  };

  if (mode === "collapsed") {
    return (
      <button
        ref={hostRef}
        type="button"
        className="timeline-host__collapsed-action"
        aria-label={pending ? "Show permission request in Timeline" : "Show Timeline"}
        onClick={activate}
        onMouseDown={(event) => event.preventDefault()}
        onPointerDown={(event) => trackPointerOrigin(event.button, event.currentTarget)}
        onPointerCancel={() => {
          pointerActivationOrigin.current = null;
        }}
        onFocus={trackFocus}
        onBlur={trackBlur}
      >
        <span>Timeline</span>
        <ChevronsRight aria-hidden="true" />
        <span className="timeline-host__permission-space" aria-hidden="true">
          {pending && <PermissionBadge />}
        </span>
      </button>
    );
  }

  return (
    <h2
      ref={setExpandedHeadingRef}
      className={
        showProgrammaticFocus
          ? "timeline-host__label timeline-host__label--programmatic-focus"
          : "timeline-host__label"
      }
      aria-label="Timeline"
      tabIndex={-1}
      onBlur={() => setShowProgrammaticFocus(false)}
    >
      {pending ? (
        <button
          type="button"
          className="timeline-host__attention-action"
          aria-label="Show permission request in Timeline"
          onClick={activate}
          onPointerDown={(event) => trackPointerOrigin(event.button, event.currentTarget)}
          onPointerCancel={() => {
            pointerActivationOrigin.current = null;
          }}
          onFocus={trackFocus}
          onBlur={trackBlur}
        >
          <span>TIMELINE</span>
          <PermissionBadge />
        </button>
      ) : "TIMELINE"}
    </h2>
  );
}
