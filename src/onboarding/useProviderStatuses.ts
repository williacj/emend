// ABOUTME: Shared detection hook (FR-X-7) — one place for "call detectProviders on mount and
// ABOUTME: re-check on window focus" so `WritingPartnersPanel` and `EditorOnlyStatusChip` don't
// ABOUTME: each re-implement the same fetch+listener mechanism (CLAUDE.md: never copy-paste).
import { useEffect, useState } from "react";
import { detectProviders } from "./ipc";
import type { ProviderStatuses } from "./types";

/**
 * `null` while the first detection round is still in flight. Re-checks on window focus (FR-X-7:
 * "status re-checks live... without an app restart" — a login finished in an external terminal
 * updates the result the next time the user comes back to Emend).
 */
export function useProviderStatuses(): ProviderStatuses {
  const [entries, setEntries] = useState<ProviderStatuses>(null);

  useEffect(() => {
    let cancelled = false;
    let generation = 0;
    const refresh = () => {
      const requestedGeneration = ++generation;
      detectProviders()
        .then((result) => {
          if (!cancelled && requestedGeneration === generation) setEntries(result);
        })
        .catch(() => {
          // The backend command degrades successful per-provider probes to `NotInstalled`; a
          // rejected command is therefore a distinct transport failure, never evidence that no
          // provider is installed. Generation ownership keeps an older completion from replacing
          // the newer focus refresh.
          if (!cancelled && requestedGeneration === generation) setEntries("unavailable");
        });
    };

    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refresh);
    };
  }, []);

  return entries;
}
