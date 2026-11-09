// ABOUTME: J1 activity-feed line derivation (ux-design.md "Working: live activity feed, verb +
// ABOUTME: file") — maps Claude stream events to display lines plus normalized read identities.

//! Turns one already-parsed Claude Code stream-json event (`agent::claude`) into the ux-design.md
//! "Working" state's activity feed: a small ordered list of `verb + file` lines ("Reading
//! claude.md", "Editing draft.md") plus a generic "Drafting…" line while the assistant is
//! composing prose, matching the P2a-15 issue's own examples ("read claude.md", "drafting
//! revision…", tool-use lines). It resolves read targets against the session's project root so
//! display spelling and count identity remain separate; `agent::session` is the only caller.

use std::path::Path;

use serde::Serialize;
use serde_json::Value;

use crate::commands::path_confine::{confine, identity_relative};

/// One activity-feed entry: a verb ("Reading", "Drafting", …) plus an optional detail (typically
/// a file path, command, or other tool target). Read lines also carry a normalized project-relative
/// identity for counting while preserving the provider's original detail for display. `label()`
/// renders the two ux-design.md shapes:
/// `"{verb} {detail}"` when there is a target, `"{verb}…"` (an in-progress ellipsis) when there
/// isn't. `Serialize` (P2a integration #345): this is what rides `agent::run_queue::RunStatus`
/// over the wire, both `run_state`'s poll and the `agent://activity` push.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
// @anchor:activity-line-shape
pub struct ActivityLine {
    pub verb: String,
    pub detail: Option<String>,
    #[serde(rename = "pathIdentity", skip_serializing_if = "Option::is_none")]
    pub path_identity: Option<String>,
}

impl ActivityLine {
    fn new(verb: impl Into<String>, detail: Option<String>) -> ActivityLine {
        ActivityLine {
            verb: verb.into(),
            detail,
            path_identity: None,
        }
    }

    fn read(detail: Option<String>, root: &Path) -> ActivityLine {
        let path_identity = detail
            .as_deref()
            .and_then(|path| project_relative_identity(root, path));
        ActivityLine {
            verb: "Reading".into(),
            detail,
            path_identity,
        }
    }

    /// The rendered feed line: `"Reading claude.md"` or, with no detail, `"Drafting…"`.
    pub fn label(&self) -> String {
        match &self.detail {
            Some(detail) => format!("{} {}", self.verb, detail),
            None => format!("{}…", self.verb),
        }
    }
}

/// Every activity line a single stream-json event carries. Only `assistant` message envelopes
/// produce lines today (tool-use and in-progress text) — bootstrap/telemetry events (`system`,
/// `rate_limit_event`) and the terminal `result` carry none; a delivered change set surfaces as
/// its own timeline card (ux-design.md "Delivering"), not an activity-feed line.
pub fn activity_lines(event: &Value, root: &Path) -> Vec<ActivityLine> {
    if event.get("type").and_then(Value::as_str) != Some("assistant") {
        return Vec::new();
    }
    event["message"]["content"]
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|block| line_for_block(block, root))
                .collect()
        })
        .unwrap_or_default()
}

fn line_for_block(block: &Value, root: &Path) -> Option<ActivityLine> {
    match block.get("type").and_then(Value::as_str) {
        Some("tool_use") => Some(line_for_tool_use(block, root)),
        Some("text") => {
            let text = block.get("text").and_then(Value::as_str).unwrap_or("");
            if text.trim().is_empty() {
                None
            } else {
                Some(ActivityLine::new("Drafting", None))
            }
        }
        // "thinking" content and tool_result blocks (which arrive on `user` events, not
        // `assistant`, but a malformed/interleaved stream could still hand us one) carry no
        // user-facing activity line.
        _ => None,
    }
}

fn line_for_tool_use(block: &Value, root: &Path) -> ActivityLine {
    let name = block.get("name").and_then(Value::as_str).unwrap_or("tool");
    let input = &block["input"];

    if let Some(mcp_tool) = name.strip_prefix("mcp__cowrite__") {
        return line_for_mcp_tool(mcp_tool, input, root);
    }

    match name {
        "Read" => ActivityLine::read(string_field(input, "file_path"), root),
        "Write" => file_line("Writing", input),
        "Edit" | "MultiEdit" => file_line("Editing", input),
        "Bash" => ActivityLine::new("Running", string_field(input, "command")),
        "Grep" | "Glob" => ActivityLine::new("Searching", string_field(input, "pattern")),
        "WebFetch" => ActivityLine::new("Fetching", string_field(input, "url")),
        "Task" => ActivityLine::new("Delegating", string_field(input, "description")),
        "TodoWrite" => ActivityLine::new("Planning", None),
        other => ActivityLine::new(humanize(other), None),
    }
}

/// The Emend MCP tool surface (TD-1 §3.2), named on the wire as `mcp__cowrite__<tool>` per
/// Claude Code's MCP tool-naming convention.
fn line_for_mcp_tool(tool: &str, input: &Value, root: &Path) -> ActivityLine {
    let doc = string_field(input, "doc");
    match tool {
        "propose_changes" => ActivityLine::new("Delivering", doc),
        "add_comments" => ActivityLine::new("Commenting on", doc),
        "reply_to_comment" => ActivityLine::new("Replying", None),
        "get_document_state" => ActivityLine::read(doc, root),
        "list_documents" => ActivityLine::new("Checking documents", None),
        "create_document" => ActivityLine::new("Drafting", doc),
        "permission_request" => ActivityLine::new("Requesting permission", None),
        other => ActivityLine::new(humanize(other), None),
    }
}

fn file_line(verb: &str, input: &Value) -> ActivityLine {
    ActivityLine::new(verb, string_field(input, "file_path"))
}

fn string_field(input: &Value, key: &str) -> Option<String> {
    input.get(key).and_then(Value::as_str).map(str::to_string)
}

fn project_relative_identity(root: &Path, raw: &str) -> Option<String> {
    let raw_path = Path::new(raw);
    let confined = if raw_path.is_absolute() {
        raw_path.to_path_buf()
    } else {
        confine(root, raw).ok()?
    };
    identity_relative(root, &confined).ok()
}

/// A fallback verb for a tool name this mapping doesn't know: `"some_tool"` / `"SomeTool"` →
/// `"Some tool"` — never a raw identifier in the feed.
fn humanize(name: &str) -> String {
    let mut out = String::new();
    for (i, ch) in name.chars().enumerate() {
        if ch == '_' {
            out.push(' ');
            continue;
        }
        if i > 0 && ch.is_uppercase() && !out.ends_with(' ') {
            out.push(' ');
        }
        if i == 0 {
            out.extend(ch.to_uppercase());
        } else {
            out.extend(ch.to_lowercase());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn absolute_read_and_relative_document_state_share_one_project_identity() {
        let project = TempDir::new().unwrap();
        fs::write(project.path().join("sermon.md"), "text").unwrap();
        let absolute = project.path().join("sermon.md");
        let event = json!({
            "type": "assistant",
            "message": { "content": [
                { "type": "tool_use", "name": "Read", "input": { "file_path": absolute.to_string_lossy() } },
                { "type": "tool_use", "name": "mcp__cowrite__get_document_state", "input": { "doc": "sermon.md" } }
            ] }
        });

        let lines = activity_lines(&event, project.path());

        assert_ne!(lines[0].detail, lines[1].detail);
        assert_eq!(
            lines[0].path_identity.as_deref(),
            Some("sermon.md"),
            "absolute Read uses project-relative identity"
        );
        assert_eq!(
            lines[1].path_identity.as_deref(),
            Some("sermon.md"),
            "get_document_state uses the same project-relative identity"
        );
        assert_eq!(lines[0].label(), format!("Reading {}", absolute.display()));
        assert_eq!(
            serde_json::to_value(&lines[0]).unwrap()["pathIdentity"],
            "sermon.md"
        );
    }

    #[test]
    fn an_absolute_read_outside_the_project_mints_no_project_identity() {
        let project = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let absolute = outside.path().join("other.md");
        fs::write(&absolute, "text").unwrap();
        let event = json!({
            "type": "assistant",
            "message": { "content": [
                { "type": "tool_use", "name": "Read", "input": { "file_path": absolute.to_string_lossy() } }
            ] }
        });

        let line = activity_lines(&event, project.path()).remove(0);

        assert_eq!(line.detail.as_deref(), absolute.to_str());
        assert_eq!(
            line.path_identity, None,
            "outside-project Read has no project identity"
        );
    }

    #[test]
    fn a_read_tool_use_becomes_a_reading_line_with_the_file() {
        let event = json!({
            "type": "assistant",
            "message": { "content": [
                { "type": "tool_use", "name": "Read", "input": { "file_path": "claude.md" } }
            ] }
        });
        let lines = activity_lines(&event, Path::new("."));
        assert_eq!(lines[0].label(), "Reading claude.md");
        assert_eq!(lines[0].path_identity.as_deref(), Some("claude.md"));
    }

    #[test]
    fn write_and_edit_tools_map_to_writing_and_editing() {
        let write =
            json!({ "type": "tool_use", "name": "Write", "input": { "file_path": "draft.md" } });
        let edit =
            json!({ "type": "tool_use", "name": "Edit", "input": { "file_path": "draft.md" } });
        let multi = json!({ "type": "tool_use", "name": "MultiEdit", "input": { "file_path": "draft.md" } });
        assert_eq!(
            line_for_block(&write, Path::new(".")).unwrap().label(),
            "Writing draft.md"
        );
        assert_eq!(
            line_for_block(&edit, Path::new(".")).unwrap().label(),
            "Editing draft.md"
        );
        assert_eq!(
            line_for_block(&multi, Path::new(".")).unwrap().label(),
            "Editing draft.md"
        );
    }

    #[test]
    fn bash_grep_and_web_fetch_carry_their_own_target() {
        let bash = json!({ "type": "tool_use", "name": "Bash", "input": { "command": "ls -la" } });
        let grep = json!({ "type": "tool_use", "name": "Grep", "input": { "pattern": "TODO" } });
        let fetch = json!({ "type": "tool_use", "name": "WebFetch", "input": { "url": "https://example.com" } });
        assert_eq!(
            line_for_block(&bash, Path::new(".")).unwrap().label(),
            "Running ls -la"
        );
        assert_eq!(
            line_for_block(&grep, Path::new(".")).unwrap().label(),
            "Searching TODO"
        );
        assert_eq!(
            line_for_block(&fetch, Path::new(".")).unwrap().label(),
            "Fetching https://example.com"
        );
    }

    #[test]
    fn a_tool_with_no_recognized_target_field_falls_back_to_the_ellipsis_form() {
        let todo = json!({ "type": "tool_use", "name": "TodoWrite", "input": {} });
        assert_eq!(
            line_for_block(&todo, Path::new(".")).unwrap().label(),
            "Planning…"
        );
    }

    #[test]
    fn an_unmapped_tool_name_is_humanized_not_shown_raw() {
        let block = json!({ "type": "tool_use", "name": "some_custom_tool", "input": {} });
        assert_eq!(
            line_for_block(&block, Path::new(".")).unwrap().label(),
            "Some custom tool…"
        );
    }

    #[test]
    fn a_cowrite_mcp_tool_use_maps_to_a_friendly_verb_and_the_doc_argument() {
        let block = json!({
            "type": "tool_use",
            "name": "mcp__cowrite__propose_changes",
            "input": { "doc": "draft.md", "revision": "rev-1", "edits": [] }
        });
        assert_eq!(
            line_for_block(&block, Path::new(".")).unwrap().label(),
            "Delivering draft.md"
        );
    }

    #[test]
    fn an_unmapped_cowrite_mcp_tool_is_humanized_from_its_tool_name() {
        let block = json!({ "type": "tool_use", "name": "mcp__cowrite__future_tool", "input": {} });
        assert_eq!(
            line_for_block(&block, Path::new(".")).unwrap().label(),
            "Future tool…"
        );
    }

    #[test]
    fn non_empty_assistant_text_becomes_a_drafting_line() {
        let event = json!({
            "type": "assistant",
            "message": { "content": [ { "type": "text", "text": "Tightening the hook…" } ] }
        });
        assert_eq!(
            activity_lines(&event, Path::new(".")),
            vec![ActivityLine::new("Drafting", None)]
        );
        assert_eq!(
            activity_lines(&event, Path::new("."))[0].label(),
            "Drafting…"
        );
    }

    #[test]
    fn blank_assistant_text_produces_no_line() {
        let event = json!({
            "type": "assistant",
            "message": { "content": [ { "type": "text", "text": "   " } ] }
        });
        assert!(activity_lines(&event, Path::new(".")).is_empty());
    }

    #[test]
    fn thinking_content_blocks_produce_no_activity_line() {
        let event = json!({
            "type": "assistant",
            "message": { "content": [ { "type": "thinking", "thinking": "internal reasoning" } ] }
        });
        assert!(activity_lines(&event, Path::new(".")).is_empty());
    }

    #[test]
    fn a_multi_block_message_yields_one_line_per_block_in_order() {
        let event = json!({
            "type": "assistant",
            "message": { "content": [
                { "type": "text", "text": "Let me check the file first." },
                { "type": "tool_use", "name": "Read", "input": { "file_path": "notes.md" } }
            ] }
        });
        let lines: Vec<String> = activity_lines(&event, Path::new("."))
            .iter()
            .map(ActivityLine::label)
            .collect();
        assert_eq!(
            lines,
            vec!["Drafting…".to_string(), "Reading notes.md".to_string()]
        );
    }

    #[test]
    fn non_assistant_events_carry_no_activity_line() {
        for event in [
            json!({ "type": "system", "subtype": "init", "session_id": "s", "model": "m", "claude_code_version": "2.1.200" }),
            json!({ "type": "rate_limit_event", "rate_limit_info": {} }),
            json!({ "type": "result", "subtype": "success", "session_id": "s" }),
        ] {
            assert!(
                activity_lines(&event, Path::new(".")).is_empty(),
                "unexpected line for {event}"
            );
        }
    }
}
