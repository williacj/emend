// ABOUTME: The composer's quote state (P2b-7, UX Principle 6) — wraps `MessageInput` with the
// ABOUTME: pending quote-bar: a newly quoted selection attaches, travels into the next sent
// ABOUTME: message, and is dismissible (without sending) or cleared automatically once sent.
import { useState, type Ref } from "react";
import { MessageInput, type MessageInputProps } from "./MessageInput";
import { QuoteBar } from "./QuoteBar";
import type { QuotedExcerpt } from "./types";

export interface MessageComposerProps {
  /**
   * A newly quoted selection to attach (e.g. `EditorShell`'s quote affordance, via whatever owner
   * eventually wires the two together — #409). Attaching happens once per distinct incoming quote
   * object (tracked by identity, not deep equality — every real quote click produces a fresh
   * object), so dismissing an already-attached quote does not immediately reattach it from a
   * stable prop the owner hasn't changed. `null`/omitted means no incoming quote right now; it
   * never clears an already-attached one — dismissing that is this composer's own job
   * (`QuoteBar`'s ×), not the owner's.
   */
  incomingQuote?: QuotedExcerpt | null;
  /** Called with the trimmed, non-empty text and whatever quote was attached at send time (`null`
   * if none) — mirrors `MessageInput.onSubmit` plus the quote. The pending quote clears after
   * send, the same as a dismiss. */
  onSubmit: (text: string, quote: QuotedExcerpt | null) => void;
  placeholder?: MessageInputProps["placeholder"];
  dictationActive?: boolean;
  dictationIdentity?: MessageInputProps["dictationIdentity"];
  containerRef?: Ref<HTMLDivElement>;
}

export function MessageComposer({ incomingQuote, onSubmit, placeholder, dictationActive, dictationIdentity, containerRef }: MessageComposerProps) {
  const [quote, setQuote] = useState<QuotedExcerpt | null>(incomingQuote ?? null);
  // Adjusts state during render rather than in a `useEffect` (React's own recommended pattern for
  // deriving state from a prop change): attaching a genuinely new incoming quote this way lands in
  // the same commit instead of flashing the old quote bar for one render before the effect fires.
  const [lastIncoming, setLastIncoming] = useState(incomingQuote);
  if (incomingQuote && incomingQuote !== lastIncoming) {
    setLastIncoming(incomingQuote);
    setQuote(incomingQuote);
  }

  const handleSubmit = (text: string) => {
    onSubmit(text, quote);
    setQuote(null);
  };

  return (
    <div ref={containerRef} className="message-composer">
      {quote && <QuoteBar text={quote.text} onDismiss={() => setQuote(null)} />}
      <MessageInput onSubmit={handleSubmit} placeholder={placeholder} dictationActive={dictationActive} dictationIdentity={dictationIdentity} />
    </div>
  );
}
