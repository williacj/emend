// ABOUTME: The CRLF-on-open integrity banner (P2a-21, FR-ED-2, ux-design "Document integrity &
// ABOUTME: lifecycle moments") — a non-modal bar across the editor top, never a dialog; fires once
// ABOUTME: per open from EditorShell's P2a-7 detection and offers the LF-normalization opt-out.
export interface CrlfBannerProps {
  onOk: () => void;
  onDontConvert: () => void;
}

/** `"Line endings will be normalized to LF on save — [OK] [Don't convert this file]"` (ux-design.md
 * line 418, verbatim copy). `role="status"` (not `dialog`/`alertdialog`) — announced, never blocks
 * input, exactly the vocabulary the external-change banner shares. */
export function CrlfBanner({ onOk, onDontConvert }: CrlfBannerProps) {
  return (
    <div className="integrity-banner" role="status">
      <p className="integrity-banner__message">Line endings will be normalized to LF on save</p>
      <div className="integrity-banner__actions">
        <button type="button" className="integrity-banner__action" onClick={onOk}>
          OK
        </button>
        <button type="button" className="integrity-banner__action" onClick={onDontConvert}>
          Don&apos;t convert this file
        </button>
      </div>
    </div>
  );
}
