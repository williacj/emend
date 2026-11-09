// ABOUTME: Wire types for onboarding (FR-X-7, J8) — mirrors Rust `agent::providers`/
// ABOUTME: `commands::providers` (cross-boundary types defined in Rust, mirrored here per CLAUDE.md).

/** Mirrors Rust `agent::providers::ProviderId` (`#[serde(rename_all = "snake_case")]`). */
export type ProviderId = "claude_code" | "copilot";

/**
 * Mirrors Rust `agent::providers::ProviderStatus`
 * (`#[serde(tag = "state", rename_all = "snake_case")]`). `installed_signed_out` folds in
 * auth-expired — same remediation, "sign in again" — while staying visibly distinct from
 * `not_installed` (FR-X-7).
 */
export type ProviderStatus =
  | { state: "not_installed" }
  | { state: "installed_signed_out" }
  | { state: "signed_in"; account: string | null };

/** Mirrors Rust `commands::providers::ProviderStatusPayload` (flattened `status` on the wire). */
export type ProviderStatusEntry = { provider: ProviderId } & ProviderStatus;

/** One shared provider probe result; `unavailable` is a transport failure, not a provider fact. */
export type ProviderStatuses = readonly ProviderStatusEntry[] | null | "unavailable";

/**
 * FR-X-7's "zero providers" case — every detected provider reads `not_installed`. Neither `null`
 * (still loading) nor `unavailable` (transport failed) is evidence that zero providers exist.
 */
export function isZeroProviders(entries: ProviderStatuses): boolean {
  return entries !== null && entries !== "unavailable" && entries.every((e) => e.state === "not_installed");
}
