// ABOUTME: One provider's onboarding chip (J8, FR-X-7) — renders the three auth states with a
// ABOUTME: visibly and textually distinct remediation affordance for each (FR-X-9: install link
// ABOUTME: for not-installed, a pointer at the CLI's own sign-in command for signed-out/expired).
import { useState } from "react";
import { PROVIDER_META } from "./providerMeta";
import type { ProviderStatusEntry } from "./types";

export function ProviderChip({ entry }: { entry: ProviderStatusEntry }) {
  const meta = PROVIDER_META[entry.provider];
  const [showSignInHelp, setShowSignInHelp] = useState(false);

  return (
    <li className="provider-chip" data-state={entry.state}>
      <div className="provider-chip__row">
        <span className="provider-chip__dot" aria-hidden="true">
          {entry.state === "signed_in" ? "●" : "○"}
        </span>
        <span className="provider-chip__label">
          {meta.displayName}
          {entry.state === "not_installed" && " — not installed"}
          {entry.state === "installed_signed_out" && " — installed, not signed in"}
          {entry.state === "signed_in" &&
            (entry.account ? ` — signed in as ${entry.account}` : " — signed in")}
        </span>
        {entry.state === "signed_in" && (
          <span className="provider-chip__check" aria-hidden="true">
            ✓
          </span>
        )}
      </div>
      {entry.state === "not_installed" && (
        <a
          className="provider-chip__action"
          href={meta.installUrl}
          target="_blank"
          rel="noreferrer"
        >
          Get {meta.displayName}
        </a>
      )}
      {entry.state === "installed_signed_out" && (
        <SignInHelp
          command={meta.signInCommand}
          expanded={showSignInHelp}
          onToggle={() => setShowSignInHelp((v) => !v)}
        />
      )}
    </li>
  );
}

function SignInHelp({
  command,
  expanded,
  onToggle,
}: {
  command: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copyCommand() {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    }
  }

  return (
    <div className="provider-chip__signin-help">
      <button type="button" className="provider-chip__action" onClick={onToggle}>
        Guide me through sign-in
      </button>
      {expanded && (
        <div className="provider-chip__signin-detail">
          <p>Run this in a terminal, then come back — we&apos;ll pick it up automatically:</p>
          <code>{command}</code>
          <button type="button" onClick={copyCommand}>
            {copied ? "Copied" : "Copy command"}
          </button>
        </div>
      )}
    </div>
  );
}
