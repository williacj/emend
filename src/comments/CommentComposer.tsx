// ABOUTME: The comment composer (P2a-18, FR-CMT-1, ux-design.md J4) — creates an anchored or
// ABOUTME: document-level thread; the caller resolves the live selection, this component only submits.
import { type FormEvent } from "react";
import { SharedDictationMic, retireVoiceDictationOrigin } from "../voice/SharedDictationMic";
import { useComposerDictationDraft } from "../voice/useComposerDictationDraft";

export interface CommentComposerSelection {
  offset: number;
  length: number;
  /** The selected text, shown so the author can confirm what they're commenting on — captured by
   * the caller (the editor's own selection surface), never recomputed here. */
  preview: string;
}

export interface CommentComposerProps {
  /** The live document selection at composer-open time, or `null` for a document-level comment
   * (FR-CMT-1's "no selection" case). Wiring a real selection in from `EditorShell` is a
   * follow-up — P2a-1's text-selection surface doesn't exist yet, so this component takes an
   * already-resolved selection rather than reading one itself. */
  selection: CommentComposerSelection | null;
  onSubmit: (body: string) => void;
  onCancel?: () => void;
}

export function CommentComposer({ selection, onSubmit, onCancel }: CommentComposerProps) {
  const dictation = useComposerDictationDraft();

  const trySubmit = () => {
    const trimmed = dictation.value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    retireVoiceDictationOrigin(dictation.onDictationEvent);
    dictation.setDraft("");
    dictation.clearPartial();
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    trySubmit();
  };

  return (
    <form className="comment-composer" onSubmit={handleSubmit}>
      <p className="comment-composer__target">
        {selection ? <>Commenting on: “{selection.preview}”</> : "Document-level comment"}
      </p>
      <textarea
        ref={dictation.textareaRef}
        className="comment-composer__body"
        value={dictation.value}
        onChange={(event) => {
          if (!dictation.handleInput(event.target.value, (event.nativeEvent as InputEvent).inputType))
            retireVoiceDictationOrigin(dictation.onDictationEvent);
        }}
        placeholder="Add a comment…"
        aria-label="Comment"
        rows={3}
      />
      <span className="composer-dictation-partial" data-provisional={Boolean(dictation.partial)} data-error={Boolean(dictation.errorEcho)}
        aria-live={dictation.errorEcho ? "assertive" : "polite"} aria-atomic="true">
        {dictation.errorEcho ? <><span className="sr-only">Dictation error: </span>{dictation.errorEcho}</>
          : dictation.partial && <><span className="sr-only">Provisional dictation: </span>{dictation.partial}</>}
      </span>
      <div className="comment-composer__actions">
        <SharedDictationMic onDictationEvent={dictation.onDictationEvent} onDictationStart={dictation.captureTarget} onDictationRetire={dictation.clearPartial} />
        {onCancel && (
          <button type="button" className="comment-composer__cancel" onClick={() => {
            retireVoiceDictationOrigin(dictation.onDictationEvent);
            dictation.clearPartial();
            onCancel();
          }}>
            Cancel
          </button>
        )}
        <button type="submit" className="comment-composer__submit" disabled={!dictation.value.trim()}>
          Comment
        </button>
      </div>
    </form>
  );
}
