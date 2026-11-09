// ABOUTME: Display-only metadata for the two detected providers (FR-X-7) — names, install links,
// ABOUTME: and the CLI's own sign-in command (FR-X-9: Emend only ever names the command, never
// ABOUTME: runs or intercepts it — the login flow itself stays entirely inside the provider's CLI).
import type { ProviderId } from "./types";

export interface ProviderMeta {
  displayName: string;
  installUrl: string;
  signInCommand: string;
}

export const PROVIDER_META: Record<ProviderId, ProviderMeta> = {
  claude_code: {
    // @anchor:provider-display-name
    displayName: "Claude Code",
    installUrl: "https://code.claude.com/docs/en/quickstart",
    signInCommand: "claude auth login",
  },
  copilot: {
    displayName: "Copilot CLI",
    installUrl: "https://docs.github.com/copilot/how-tos/copilot-cli",
    signInCommand: "copilot login",
  },
};
