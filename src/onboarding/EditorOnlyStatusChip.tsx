// ABOUTME: The one quiet status chip a zero-provider project shows once open (J8, FR-X-7): "the
// ABOUTME: app proceeds into full editor-only mode with exactly one quiet status chip — no
// ABOUTME: modal, no blocking nag." Renders nothing once any provider is detected, and nothing
// ABOUTME: while the first detection round is still in flight (never flashes a false chip).
import { isZeroProviders } from "./types";
import type { ProviderStatuses } from "./types";
import { useProviderStatuses } from "./useProviderStatuses";

export function EditorOnlyStatusChip() {
  const entries = useProviderStatuses();
  return <EditorOnlyStatusChipView entries={entries} />;
}

/** Pure projection used when the app shell already owns the one shared live provider probe. */
export function EditorOnlyStatusChipView({
  entries,
}: {
  entries: ProviderStatuses;
}) {
  if (!isZeroProviders(entries)) return null;

  return (
    <span className="editor-only-chip" role="status">
      Editor-only — no AI writing partner connected
    </span>
  );
}
