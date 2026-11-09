// ABOUTME: Moves an existing toolbar control between its inline row and the measured overflow popover.
// ABOUTME: Each original action and callback stays available in exactly one location at a time.
import { createContext, useCallback, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface ToolbarOverflowContextValue {
  hidden: ReadonlySet<string>;
  menuHost: HTMLElement | null;
  registerInline: (id: string, element: HTMLElement | null) => void;
  focusOverflowTrigger: () => boolean;
  getOverflowTrigger?: () => HTMLButtonElement | null;
  setChooserOpen?: (open: boolean) => void;
}

export const ToolbarOverflowContext = createContext<ToolbarOverflowContextValue | null>(null);

export function useToolbarOverflow(): ToolbarOverflowContextValue | null {
  return useContext(ToolbarOverflowContext);
}

export function ToolbarOverflowSlot({
  id,
  children,
  enabled = true,
}: {
  id: string;
  children: ReactNode;
  enabled?: boolean;
}) {
  const context = useToolbarOverflow();
  const register = useCallback(
    (element: HTMLSpanElement | null) => context?.registerInline(id, element),
    [context, id],
  );
  if (!enabled || !context) return <>{children}</>;
  const moved = context.hidden.has(id) && context.menuHost !== null;
  const content = (
    <span
      ref={moved ? undefined : register}
      className="view-mode-toolbar__control-slot"
      data-toolbar-control={id}
      data-overflowed={moved || undefined}
    >
      {children}
    </span>
  );
  return moved ? createPortal(content, context.menuHost!) : content;
}
