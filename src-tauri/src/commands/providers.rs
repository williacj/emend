// ABOUTME: Thin IPC command (§3.1) over `agent::providers` (FR-X-7) — the Writing partners panel's
// ABOUTME: one call for both providers' chip states; no args, no authority beyond the read itself.

use serde::Serialize;

use crate::agent::providers::{detect_all, ProviderId, ProviderStatus};

/// One provider's detected state, ready for the frontend chip (`{provider, state, account?}` on
/// the wire via `#[serde(flatten)]`).
#[derive(Debug, Serialize)]
pub struct ProviderStatusPayload {
    pub provider: ProviderId,
    #[serde(flatten)]
    pub status: ProviderStatus,
}

/// Detects both providers (Claude Code, Copilot) in `ProviderId::ALL` order and maps each to its
/// wire payload. Infallible: a probe that can't run degrades to `NotInstalled`/`InstalledSignedOut`
/// rather than erroring (FR-X-5). Synchronous and self-contained so the D23 test driver — which
/// runs off the Tauri main thread and has no async runtime — can call it directly, and so the async
/// command below can hand it to the blocking pool.
pub fn detect_provider_payloads() -> Vec<ProviderStatusPayload> {
    detect_all()
        .into_iter()
        .map(|(provider, status)| ProviderStatusPayload { provider, status })
        .collect()
}

/// The Writing partners panel's one call for both chip states (FR-X-7).
///
/// `async` + `spawn_blocking` (not a plain sync command): `detect_all` spawns each provider CLI and
/// blocks up to `PROBE_TIMEOUT` (3s) per probe. A sync `#[tauri::command]` runs on the Tauri main
/// thread, so a slow or hung CLI would freeze the whole webview for that long — and this is invoked
/// on mount *and on every window focus* (`useProviderStatuses`). Offloading the blocking probe to
/// the runtime's blocking pool keeps the UI thread free (FR-X-4: slow work must not freeze the UI);
/// `run_bounded`'s subprocess timeout only bounds the *probe*, not the thread waiting on it.
#[tauri::command]
pub async fn detect_providers() -> Vec<ProviderStatusPayload> {
    tauri::async_runtime::spawn_blocking(detect_provider_payloads)
        .await
        .unwrap_or_else(|_| {
            // A join failure means the blocking task itself panicked — not a normal degrade path
            // (the probe is infallible), but the command's contract is infallible, so fall back to
            // "not installed for both" rather than dropping the chips entirely.
            ProviderId::ALL
                .iter()
                .map(|&provider| ProviderStatusPayload {
                    provider,
                    status: ProviderStatus::NotInstalled,
                })
                .collect()
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_both_providers_exactly_once_each_regardless_of_host_state() {
        // Exercises the sync helper both the async command and the D23 driver delegate to — the
        // async wrapper is a thin `spawn_blocking` offload whose only added behavior (keeping the
        // Tauri main thread unblocked) is a runtime property, verifiable only in the real app.
        let payloads = detect_provider_payloads();
        let providers: Vec<ProviderId> = payloads.iter().map(|p| p.provider).collect();
        assert_eq!(providers, vec![ProviderId::ClaudeCode, ProviderId::Copilot]);
    }
}
