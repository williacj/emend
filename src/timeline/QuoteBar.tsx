// ABOUTME: The composer's pending-quote bar (P2b-7, UX Principle 6 "quote-bar", §3.1 `timeline/`
// ABOUTME: "quote-bar selection flow") — shows the quoted editor excerpt above the message input,
// ABOUTME: dismissible without sending. Purely presentational; `MessageComposer` owns the state.

export interface QuoteBarProps {
  text: string;
  onDismiss: () => void;
}

export function QuoteBar({ text, onDismiss }: QuoteBarProps) {
  return (
    <div className="quote-bar" role="note" aria-label="Quoted selection">
      <span className="quote-bar__text">“{text}”</span>
      <button
        type="button"
        className="quote-bar__dismiss"
        aria-label="Remove quote"
        onClick={onDismiss}
      >
        ✕
      </button>
    </div>
  );
}
