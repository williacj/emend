// ABOUTME: The timeline panel's message input (§3.1 `timeline/`, UX §4) — text entry + submit;
// ABOUTME: Shares the Rust-owned dictation control with the editor and comment composer.
import { useLayoutEffect, type FormEvent, type KeyboardEvent } from "react";
import { SharedDictationMic, retireVoiceDictationOrigin } from "../voice/SharedDictationMic";
import { useComposerDictationDraft } from "../voice/useComposerDictationDraft";

export interface MessageInputProps {
  /** Called with the trimmed, non-empty text on submit (Enter without Shift, or the Send button). */
  onSubmit: (text: string) => void;
  placeholder?: string;
  dictationActive?: boolean;
  /** Active document key; changing tabs retires a captured speech destination. */
  dictationIdentity?: string;
}

export function MessageInput({ onSubmit, placeholder = "Message…", dictationActive = true, dictationIdentity }: MessageInputProps) {
  const dictation = useComposerDictationDraft();
  useLayoutEffect(() => {
    if (!dictationActive) {
      retireVoiceDictationOrigin(dictation.onDictationEvent);
      dictation.clearPartial();
    }
  }, [dictationActive, dictation.onDictationEvent, dictation.clearPartial]);
  useLayoutEffect(() => {
    retireVoiceDictationOrigin(dictation.onDictationEvent);
    dictation.clearPartial();
  }, [dictationIdentity, dictation.onDictationEvent, dictation.clearPartial]);

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

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      trySubmit();
    }
  };

  return (
    <form className="message-input" onSubmit={handleSubmit}>
      <div className="message-input__field-wrap">
        <textarea
          ref={dictation.textareaRef}
          className="message-input__field"
          value={dictation.value}
          onChange={(event) => {
            if (!dictation.handleInput(event.target.value, (event.nativeEvent as InputEvent).inputType))
              retireVoiceDictationOrigin(dictation.onDictationEvent);
          }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={1}
          aria-label="Message"
        />
        <SharedDictationMic onDictationEvent={dictation.onDictationEvent} onDictationStart={dictation.captureTarget} onDictationRetire={dictation.clearPartial} />
        <span className="composer-dictation-partial" data-provisional={Boolean(dictation.partial)} data-error={Boolean(dictation.errorEcho)}
          aria-live={dictation.errorEcho ? "assertive" : "polite"} aria-atomic="true">
          {dictation.errorEcho ? <><span className="sr-only">Dictation error: </span>{dictation.errorEcho}</>
            : dictation.partial && <><span className="sr-only">Provisional dictation: </span>{dictation.partial}</>}
        </span>
      </div>
      <button type="submit" className="message-input__send">
        Send
      </button>
    </form>
  );
}
