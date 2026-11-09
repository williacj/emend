// ABOUTME: The external-change "Compare" view (P2a-21, FR-ED-7, ux-design.md line 417) — v1 is a
// ABOUTME: read-only side-by-side of the local (unsaved) text and the on-disk text, no three-way
// ABOUTME: merge editor (YAGNI, ux-design's explicit call). Closing returns to the integrity banner.
export interface ExternalChangeCompareProps {
  path: string;
  /** This tab's current (possibly unsaved) editor content. */
  localContent: string;
  /** The content now on disk, as read by the external-change check. */
  diskContent: string;
  onClose: () => void;
}

/** Read-only side-by-side comparison. Not a dialog — an inline panel the caller swaps in over (or
 * beside) the editor host, closable back to the banner without resolving Reload/Keep mine. */
export function ExternalChangeCompare({
  path,
  localContent,
  diskContent,
  onClose,
}: ExternalChangeCompareProps) {
  return (
    <div className="external-change-compare" role="region" aria-label={`Compare ${path}`}>
      <div className="external-change-compare__header">
        <p className="external-change-compare__title">Comparing {path}</p>
        <button type="button" className="external-change-compare__close" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="external-change-compare__panes">
        <section className="external-change-compare__pane">
          <h3 className="external-change-compare__pane-title">Your version</h3>
          <pre className="external-change-compare__content">{localContent}</pre>
        </section>
        <section className="external-change-compare__pane">
          <h3 className="external-change-compare__pane-title">On disk</h3>
          <pre className="external-change-compare__content">{diskContent}</pre>
        </section>
      </div>
    </div>
  );
}
