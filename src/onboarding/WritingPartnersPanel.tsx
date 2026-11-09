// ABOUTME: J8 "Writing partners" panel — detects both providers on mount and re-checks on window
// ABOUTME: focus (FR-X-7: "status re-checks live... without an app restart" — a login finished in
// ABOUTME: an external terminal updates the chip the next time the user comes back to Emend).
import { ProviderChip } from "./ProviderChip";
import { isZeroProviders } from "./types";
import type { ProviderStatuses } from "./types";
import { useProviderStatuses } from "./useProviderStatuses";

export function WritingPartnersPanel() {
  const entries = useProviderStatuses();
  return <WritingPartnersPanelView entries={entries} />;
}

/** Pure projection used when the app shell already owns the one shared live provider probe. */
export function WritingPartnersPanelView({
  entries,
}: {
  entries: ProviderStatuses;
}) {
  const zeroProviders = isZeroProviders(entries);

  return (
    <section className="writing-partners" aria-label="Writing partners">
      <h2>Writing partners</h2>
      {entries === null ? (
        <p className="writing-partners__loading">Checking…</p>
      ) : entries === "unavailable" ? (
        <p className="writing-partners__loading">Couldn’t check writing partners.</p>
      ) : (
        <ul className="provider-chip-list">
          {entries.map((entry) => (
            <ProviderChip key={entry.provider} entry={entry} />
          ))}
        </ul>
      )}
      {zeroProviders && (
        <p className="writing-partners__zero-state">
          No writing partner installed yet — the editor works fully; AI lights up when a partner
          is ready.
        </p>
      )}
    </section>
  );
}
