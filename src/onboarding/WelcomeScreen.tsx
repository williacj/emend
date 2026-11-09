// ABOUTME: J8 Screen 1 — "a door, not a wizard" (ux-design.md lines 381-409). Folder open action,
// ABOUTME: a Recent list (empty-state acceptable — no persistence lands in this card), and the
// ABOUTME: Writing partners panel. The GitHub row stays in its deferred stub state (D12) — first
// ABOUTME: mention here, first *demand* only at J5; Clone-from-GitHub is out of scope for this unit.
import type { ProviderStatuses } from "./types";
import { WritingPartnersPanel, WritingPartnersPanelView } from "./WritingPartnersPanel";

export function WelcomeScreen({
  onOpenFolder,
  providerStatuses,
  platform = "win",
}: {
  onOpenFolder: () => void;
  /** When supplied, reuse the app shell's live provider probe instead of starting a second one. */
  providerStatuses?: ProviderStatuses;
  platform?: "win" | "mac";
}) {
  return (
    <div className="welcome-screen" data-platform={platform}>
      <h1>Welcome to Emend</h1>
      <button type="button" className="welcome-screen__open-folder" onClick={onOpenFolder}>
        Open a folder…
      </button>
      <div className="welcome-screen__content">
        <section aria-label="Recent projects" className="welcome-screen__recent">
          <h2>Recent</h2>
          <p className="welcome-screen__recent-empty">(none yet)</p>
        </section>
        {providerStatuses === undefined ? (
          <WritingPartnersPanel />
        ) : (
          <WritingPartnersPanelView entries={providerStatuses} />
        )}
        <section aria-label="GitHub" className="welcome-screen__github">
          <p>GitHub: not connected — needed only when you share or review.</p>
          <button type="button" disabled aria-disabled="true" title="Coming soon">
            Connect now
          </button>
        </section>
      </div>
    </div>
  );
}
