// ABOUTME: Scenario format — an ordered list of steps the fake agent replays.
// ABOUTME: `Step` is an open, externally-tagged enum; P0-7/P0-8 add variants (MCP calls, misbehaviors).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

/// A scripted fake-agent run: a name, optional prose description, and an ordered
/// list of steps replayed top-to-bottom. The steps are the contract that P0-7
/// (MCP-call scenarios) and P0-8 (misbehavior repertoire) extend — see `Step`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Scenario {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub steps: Vec<Step>,
}

/// One replay step. Externally tagged: a step with a payload is a single-key
/// object whose key names the variant, e.g. `{"emit": { ...event... }}`; a
/// payload-less step (`Hang`) is the bare variant string, e.g. `"hang"`. The shape
/// is open for extension — P0-7 added `McpCall`, P0-8 the misbehavior primitives
/// (`EmitRaw`, `EmitOversized`, `WriteFile`, `Hang`, `Exit`) — without touching
/// existing variants.
///
/// Unknown keys are a hard parse error (fail fast): a scenario naming a step this
/// build does not know about is an authoring/version mismatch, not something to skip.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Step {
    /// Emit one stream-JSON event as a single line of output. The value is the
    /// event object verbatim (fidelity lives in the scenario file, validated
    /// against the stream-json schema — see `crate::schema`).
    Emit(Value),
    /// Call one Cowrite MCP tool against the tool server (P0-7). The call is
    /// validated against `provider_contract::Schema::McpToolCall` before dispatch
    /// (when playback validation is on); the server's response, if `expect` is
    /// set, must equal it. MCP is a side channel — this step writes nothing to the
    /// stdout event stream (in production the calls ride loopback HTTP, TD-1 §3.2).
    McpCall {
        /// Tool name — one of the TD-1 §3.2 surface (`get_document_state`, …).
        tool: String,
        /// Tool arguments (the `arguments` half of the `{name, arguments}` call).
        /// Defaults to an empty object so a no-arg tool (`list_documents`) still
        /// forms a schema-valid `{name, arguments}` call when omitted.
        #[serde(default = "empty_object")]
        arguments: Value,
        /// Optional expected response; when present, the server's **whole**
        /// response must equal it or playback fails (a round-trip assertion).
        /// This is exact, not subset, matching — an `expect` for a multi-field
        /// tool like `get_document_state` must name every field of the response,
        /// not a subset.
        #[serde(default)]
        expect: Option<Value>,
    },
    /// Emit arbitrary bytes to the output stream **verbatim** — no JSON parsing,
    /// no schema validation, no framing, no trailing newline added (the author
    /// writes the exact bytes). P0-8's malformed/interleaved-output primitive: a
    /// garbage line the consumer's parser must survive, or a partial fragment
    /// jammed against the next step's bytes to model byte-level interleaving.
    EmitRaw(String),
    /// Emit a single, valid-shaped but enormous stream event as one line
    /// (≥ `bytes` long, filler text). P0-8's oversized-output primitive: it
    /// exercises the consumer's line-size guard without shipping a multi-megabyte
    /// scenario file. Only the line *length* is anomalous (the envelope is a
    /// well-formed assistant/text event), and it is never schema-validated.
    EmitOversized {
        /// Lower bound on the filler length; the emitted line is this plus a small
        /// fixed JSON envelope, so `line.len() >= bytes`.
        bytes: usize,
    },
    /// Write `contents` to `path` (relative to the process cwd, or absolute) via a
    /// direct filesystem write — **bypassing** the MCP `propose_changes` contract.
    /// P0-8's protected-doc raw-write primitive: paired with correlated `emit`
    /// events (a `Write` tool_use naming the same file) it exercises attribution
    /// precedence (test-plan §1/§3) — a positively-attributed raw write must
    /// convert to a tracked change, not land as an untracked external edit. The
    /// fake is a *misbehaving* agent: it does no path confinement (that is the
    /// consumer's job, test-plan §3.5).
    WriteFile {
        path: String,
        #[serde(default)]
        contents: String,
    },
    /// Block forever without emitting or exiting — a never-terminating stream.
    /// P0-8's watchdog primitive: in `All` pace the agent goes silent on its own
    /// (a faithful hang, unlike "stop advancing" which is the *consumer* declining
    /// to drive), leaving stdout open with no terminal `result`; the consumer's
    /// watchdog must fire and kill the process. Terminal — steps after a `Hang`
    /// never run.
    Hang,
    /// Stop playback and report exit `code` (default 1) — models mid-delivery
    /// death. P0-8's crash primitive: placed mid-scenario (after a partial
    /// delivery, before the terminal `result`) the process dies abnormally and the
    /// FR-AGENT-6 atomicity invariant must still hold on the doc. Terminal — steps
    /// after an `Exit` never run.
    Exit {
        #[serde(default = "default_exit_code")]
        code: u8,
    },
}

/// The `arguments` default for an `McpCall` step with no `arguments` key: an
/// empty JSON object (a schema-valid payload for no-arg tools).
fn empty_object() -> Value {
    Value::Object(serde_json::Map::new())
}

/// The exit code for an `Exit` step with no `code`: 1 (abnormal termination —
/// mid-delivery death is a crash, not a clean shutdown).
fn default_exit_code() -> u8 {
    1
}

/// Error loading or parsing a scenario.
#[derive(Debug)]
pub enum ScenarioError {
    Io(std::io::Error),
    Parse(serde_json::Error),
}

impl std::fmt::Display for ScenarioError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ScenarioError::Io(e) => write!(f, "reading scenario: {e}"),
            ScenarioError::Parse(e) => write!(f, "parsing scenario: {e}"),
        }
    }
}

impl std::error::Error for ScenarioError {}

impl Scenario {
    /// Parse a scenario from a JSON string.
    pub fn from_json_str(s: &str) -> Result<Self, ScenarioError> {
        serde_json::from_str(s).map_err(ScenarioError::Parse)
    }

    /// Load and parse a scenario from a file path.
    pub fn from_path(path: impl AsRef<Path>) -> Result<Self, ScenarioError> {
        let text = std::fs::read_to_string(path).map_err(ScenarioError::Io)?;
        Self::from_json_str(&text)
    }

    /// Replace `${PROJECT_ROOT}` placeholders in emitted provider events with the canonical
    /// process working directory. Real provider events name write targets as canonical absolute
    /// paths; this keeps fixtures deterministic while exercising that same boundary shape.
    pub fn materialize_project_root(&mut self, root: &Path) {
        let root = root
            .canonicalize()
            .unwrap_or_else(|_| root.to_path_buf())
            .to_string_lossy()
            .into_owned();
        for step in &mut self.steps {
            if let Step::Emit(event) = step {
                materialize_value(event, &root);
            }
        }
    }
}

fn materialize_value(value: &mut Value, root: &str) {
    match value {
        Value::String(text) => {
            if text.contains("${PROJECT_ROOT}") {
                // Scenario JSON uses `/` after the placeholder so one fixture is readable on every
                // platform. Replace that pair first with the host separator: Windows canonicalize
                // returns a `\\?\` verbatim path, where a later `/` is not accepted as a separator.
                let rooted = if root.ends_with(std::path::MAIN_SEPARATOR) {
                    root.to_string()
                } else {
                    format!("{root}{}", std::path::MAIN_SEPARATOR)
                };
                *text = text
                    .replace("${PROJECT_ROOT}/", &rooted)
                    .replace("${PROJECT_ROOT}", root);
            }
        }
        Value::Array(items) => {
            for item in items {
                materialize_value(item, root);
            }
        }
        Value::Object(fields) => {
            for value in fields.values_mut() {
                materialize_value(value, root);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_an_emit_step_scenario() {
        let json = r#"{
            "name": "t",
            "description": "d",
            "steps": [{ "emit": { "type": "result", "subtype": "success" } }]
        }"#;
        let s = Scenario::from_json_str(json).expect("valid scenario");
        assert_eq!(s.name, "t");
        assert_eq!(s.description.as_deref(), Some("d"));
        assert_eq!(s.steps.len(), 1);
        let Step::Emit(v) = &s.steps[0] else {
            panic!("expected an emit step");
        };
        assert_eq!(v["type"], "result");
    }

    #[test]
    fn parses_an_mcp_call_step() {
        // `expect` names the tool's *whole* response (here propose_changes ->
        // {change_set_id}), so this step would also round-trip if played — exact
        // matching, not subset.
        let json = r#"{
            "name": "t",
            "steps": [{ "mcp_call": {
                "tool": "propose_changes",
                "arguments": {
                    "doc": "notes.md",
                    "revision": "rev-stub-0001",
                    "edits": [{ "range": { "offset": 0, "length": 0 }, "replacement": "x" }],
                    "summary": "s"
                },
                "expect": { "change_set_id": "cs-stub-0001" }
            } }]
        }"#;
        let s = Scenario::from_json_str(json).expect("valid scenario");
        let Step::McpCall {
            tool,
            arguments,
            expect,
        } = &s.steps[0]
        else {
            panic!("expected an mcp_call step");
        };
        assert_eq!(tool, "propose_changes");
        assert_eq!(arguments["doc"], "notes.md");
        assert_eq!(expect.as_ref().unwrap()["change_set_id"], "cs-stub-0001");
    }

    #[test]
    fn mcp_call_arguments_and_expect_default_when_omitted() {
        let json = r#"{ "name": "t", "steps": [{ "mcp_call": { "tool": "list_documents" } }] }"#;
        let s = Scenario::from_json_str(json).expect("valid scenario");
        let Step::McpCall {
            arguments, expect, ..
        } = &s.steps[0]
        else {
            panic!("expected an mcp_call step");
        };
        // Defaults to an empty object (schema-valid for a no-arg tool), not null.
        assert_eq!(arguments, &serde_json::json!({}));
        assert!(expect.is_none());
    }

    #[test]
    fn description_is_optional() {
        let json = r#"{ "name": "t", "steps": [] }"#;
        let s = Scenario::from_json_str(json).expect("valid scenario");
        assert!(s.description.is_none());
    }

    #[test]
    fn project_root_placeholder_uses_the_host_path_separator_for_children() {
        let mut value = serde_json::json!({
            "root": "${PROJECT_ROOT}",
            "child": "${PROJECT_ROOT}/protected-notes.md"
        });

        materialize_value(&mut value, "canonical-root");

        assert_eq!(value["root"], "canonical-root");
        assert_eq!(
            value["child"],
            format!(
                "canonical-root{}protected-notes.md",
                std::path::MAIN_SEPARATOR
            )
        );
    }

    #[test]
    fn parses_the_misbehavior_step_variants() {
        // P0-8 primitives, incl. `hang` as a bare variant string (payload-less)
        // and `exit` defaulting its code.
        let json = r#"{ "name": "t", "steps": [
            { "emit_raw": "{ not json\n" },
            { "emit_oversized": { "bytes": 1048576 } },
            { "write_file": { "path": "notes.md", "contents": "raw" } },
            "hang",
            { "exit": {} }
        ] }"#;
        let s = Scenario::from_json_str(json).expect("valid misbehavior scenario");
        assert!(matches!(&s.steps[0], Step::EmitRaw(b) if b == "{ not json\n"));
        assert!(matches!(
            &s.steps[1],
            Step::EmitOversized { bytes: 1_048_576 }
        ));
        assert!(matches!(&s.steps[2], Step::WriteFile { path, contents }
            if path == "notes.md" && contents == "raw"));
        assert!(matches!(&s.steps[3], Step::Hang));
        // Omitted `code` defaults to 1 (abnormal exit).
        assert!(matches!(&s.steps[4], Step::Exit { code: 1 }));
    }

    #[test]
    fn write_file_contents_default_to_empty() {
        let json = r#"{ "name": "t", "steps": [{ "write_file": { "path": "n.md" } }] }"#;
        let s = Scenario::from_json_str(json).expect("valid scenario");
        assert!(matches!(&s.steps[0], Step::WriteFile { contents, .. } if contents.is_empty()));
    }

    #[test]
    fn unknown_step_variant_is_a_parse_error() {
        // Forward-compat guard: a step key this build does not know fails fast
        // rather than silently doing nothing.
        let json = r#"{ "name": "t", "steps": [{ "teleport": {} }] }"#;
        assert!(Scenario::from_json_str(json).is_err());
    }
}
