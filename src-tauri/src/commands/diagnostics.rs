// ABOUTME: Fixed-shape process-local diagnostics for frontend failures that must remain visible.
// ABOUTME: Accepts only a closed phase; event identity and JSON record bytes are backend-owned.

use std::io::{self, Write};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

static NEXT_RENDER_FAILURE_EVENT_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RenderFailurePhase {
    Initial,
    Remount,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RenderFailureDiagnosticInput {
    pub phase: RenderFailurePhase,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RenderFailureRecord {
    pub kind: &'static str,
    pub event_id: u64,
    pub phase: RenderFailurePhase,
}

pub fn report_render_failure_to(
    input: RenderFailureDiagnosticInput,
    mut output: impl Write,
) -> io::Result<RenderFailureRecord> {
    let record = RenderFailureRecord {
        kind: "react-render-failure",
        event_id: NEXT_RENDER_FAILURE_EVENT_ID.fetch_add(1, Ordering::Relaxed),
        phase: input.phase,
    };
    serde_json::to_writer(&mut output, &record)?;
    output.write_all(b"\n")?;
    Ok(record)
}

pub fn report_render_failure_on(input: RenderFailureDiagnosticInput) -> Result<(), String> {
    report_render_failure_to(input, io::stderr())
        .map(|_| ())
        .map_err(|_| "render diagnostic unavailable".to_string())
}

#[tauri::command]
pub fn report_render_failure(input: RenderFailureDiagnosticInput) -> Result<(), String> {
    report_render_failure_on(input)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rejection(body: &str) -> String {
        serde_json::from_str::<RenderFailureDiagnosticInput>(body)
            .unwrap_err()
            .to_string()
    }

    #[test]
    fn diagnostic_input_rejects_every_caller_selected_field_without_echoing_it() {
        for body in [
            r#"{"phase":"initial","message":"ghp_abc123"}"#,
            r#"{"phase":"remount","detail":"AcquisitionPlan"}"#,
            r#"{"phase":"initial","event_id":42}"#,
            r#"{"phase":"later"}"#,
            r#"{"phase":"initial-but-with-caller-extension"}"#,
            r#"{"phase":{"nested":"initial"}}"#,
        ] {
            let rendered = rejection(body);
            assert!(!rendered.contains("ghp_abc123"));
            assert!(!rendered.contains("AcquisitionPlan"));
        }
    }

    #[test]
    fn diagnostic_input_has_no_caller_selected_string_slot() {
        let rendered = rejection(r#"{"phase":"initial","message":"ghp_abc123"}"#);
        assert!(!rendered.contains("ghp_abc123"));
    }

    #[test]
    fn diagnostic_input_rejects_a_caller_selected_event_id() {
        rejection(r#"{"phase":"initial","event_id":42}"#);
    }

    #[test]
    fn valid_records_use_only_backend_owned_fixed_fields_and_ids() {
        let mut output = Vec::new();
        let first = report_render_failure_to(
            RenderFailureDiagnosticInput {
                phase: RenderFailurePhase::Initial,
            },
            &mut output,
        )
        .unwrap();
        let second = report_render_failure_to(
            RenderFailureDiagnosticInput {
                phase: RenderFailurePhase::Remount,
            },
            &mut output,
        )
        .unwrap();

        assert_eq!(first.kind, "react-render-failure");
        assert!(second.event_id > first.event_id);
        assert_eq!(String::from_utf8(output).unwrap().lines().count(), 2);
    }
}
