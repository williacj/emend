// ABOUTME: The agent's prose reply for one turn (J2 "normal chat", Principle 5 one-timeline) —
// ABOUTME: a pure mapping from a terminal provider stream event to the text the user asked for.

//! `agent::activity` derives the J1 *Working* feed (verb + file lines) from a stream event; this
//! module derives the other half of the same stream — the agent's actual answer. Both are pure
//! json-shaped mappings over one already-parsed Claude Code stream-json event, kept apart because
//! they answer different questions and land in different timeline cards: an activity line renders
//! inside the agent-working card, a reply renders as its own agent `chat-message` card.
//!
//! Only the terminal `result` event carries a whole turn's answer (`docs/spikes/spike1-provider-contract.md`
//! §5.2: `{"type":"result","subtype":"success","result":"ok",…}`); the intermediate `assistant`
//! text blocks are in-progress prose, already represented in the feed as "Drafting…". `agent::session`
//! folds this over the stream the same way it folds `session_id`, and `agent::run_queue` carries
//! the captured text out on the run's terminal `Completed` phase.

use serde_json::Value;

/// The agent's reply text for a turn, if `event` is the terminal `result` event of a *successful*
/// one.
///
/// `None` for every other event, for a non-`success` `subtype` or an `is_error: true` result (that
/// text is a provider error string, not an answer — the run's own phase is what reports failure,
/// `agent::run_queue::RunPhase`), and for a blank answer, which would otherwise mint an empty chat
/// card saying nothing. Trailing/leading whitespace is trimmed; the answer's interior — including
/// its markdown — rides through verbatim.
pub fn reply_text(event: &Value) -> Option<String> {
    if !successful_result(event) {
        return None;
    }
    let text = event.get("result").and_then(Value::as_str)?.trim();
    if text.is_empty() {
        return None;
    }
    Some(text.to_string())
}

/// Whether `event` is the provider's positive successful terminal result for the turn.
pub fn successful_result(event: &Value) -> bool {
    event.get("type").and_then(Value::as_str) == Some("result")
        && event.get("subtype").and_then(Value::as_str) == Some("success")
        && event.get("is_error").and_then(Value::as_bool) != Some(true)
}

/// The provider's honest terminal failure reason. Only an unsuccessful `result` qualifies; a
/// successful reply or intermediate event can never be reclassified as a failure.
pub fn provider_error_text(event: &Value) -> Option<String> {
    if event.get("type").and_then(Value::as_str) != Some("result") {
        return None;
    }
    let unsuccessful = event.get("subtype").and_then(Value::as_str) != Some("success")
        || event.get("is_error").and_then(Value::as_bool) == Some(true);
    if !unsuccessful {
        return None;
    }
    let text = event.get("result").and_then(Value::as_str)?.trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// Whether an unsuccessful result positively identifies the resumed provider session as unusable.
/// The error must name a session/conversation and an unavailable-identity condition; an arbitrary
/// execution failure on a resumed turn is not recovery evidence and must not be retried.
pub fn unusable_resumed_session(event: &Value) -> bool {
    if event.get("type").and_then(Value::as_str) != Some("result")
        || event.get("subtype").and_then(Value::as_str) != Some("error_during_execution")
    {
        return false;
    }
    let Some(message) = provider_error_text(event) else {
        return false;
    };
    let message = message.to_ascii_lowercase();
    let names_identity = message.contains("session") || message.contains("conversation");
    let says_unusable = [
        "not found",
        "no conversation",
        "does not exist",
        "invalid session",
    ]
    .iter()
    .any(|phrase| message.contains(phrase));
    names_identity && says_unusable
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The exact recorded shape from SPIKE-1 §5.2 line 6 — the one event a real turn's answer
    /// arrives on.
    #[test]
    fn a_successful_result_event_carries_the_turns_reply_text() {
        let event = json!({
            "type": "result",
            "subtype": "success",
            "is_error": false,
            "result": "This sermon argues that grace precedes obedience.",
            "session_id": "e6639704-0d4d-497d-8898-ef5a938ef849"
        });
        assert_eq!(
            reply_text(&event).as_deref(),
            Some("This sermon argues that grace precedes obedience.")
        );
    }

    #[test]
    fn markdown_and_newlines_in_the_answer_ride_through_verbatim() {
        let event = json!({
            "type": "result",
            "subtype": "success",
            "result": "## Overview\n\n- **grace** first\n- obedience follows\n",
            "session_id": "s"
        });
        assert_eq!(
            reply_text(&event).as_deref(),
            Some("## Overview\n\n- **grace** first\n- obedience follows")
        );
    }

    #[test]
    fn no_other_stream_event_carries_a_reply() {
        for event in [
            json!({ "type": "system", "subtype": "init", "session_id": "s", "model": "m", "claude_code_version": "2.1.200" }),
            json!({ "type": "rate_limit_event", "rate_limit_info": {} }),
            json!({ "type": "assistant", "message": { "content": [ { "type": "text", "text": "Let me look." } ] } }),
            json!({ "type": "user", "message": { "content": [] } }),
            // The case that makes the `type` check load-bearing rather than merely implied by the
            // `subtype` one: a non-terminal event carrying *both* a `success` subtype and a
            // `result` string. Nothing in the 2.1.200 grammar emits this, which is the point — a
            // future event reusing those field names is drift, not the turn's answer.
            json!({ "type": "system", "subtype": "success", "result": "a system summary", "session_id": "s" }),
        ] {
            assert_eq!(reply_text(&event), None, "unexpected reply for {event}");
        }
    }

    /// The near-match that must be rejected: a terminal event of the right *type* whose turn did
    /// not succeed. Its `result` text is a provider error string, and the run's phase already
    /// reports the outcome — surfacing it as the agent's answer would put a diagnostic in the
    /// chat stream dressed as prose.
    #[test]
    fn an_unsuccessful_result_event_carries_no_reply() {
        let max_turns = json!({
            "type": "result",
            "subtype": "error_max_turns",
            "is_error": true,
            "result": "Reached maximum turns",
            "session_id": "s"
        });
        assert_eq!(reply_text(&max_turns), None);

        // The same refusal on the `subtype` alone. `is_error` is deliberately absent here: with it
        // present the case above proves only that *one* of the two guards fires, and the subtype
        // check — the one that names which turns actually succeeded — would go unproven.
        let unflagged = json!({
            "type": "result",
            "subtype": "error_during_execution",
            "result": "the tool call could not complete",
            "session_id": "s"
        });
        assert_eq!(reply_text(&unflagged), None);

        // `subtype` says success but the provider flagged the turn as an error — the stricter of
        // the two signals wins.
        let flagged = json!({
            "type": "result",
            "subtype": "success",
            "is_error": true,
            "result": "something went wrong",
            "session_id": "s"
        });
        assert_eq!(reply_text(&flagged), None);
    }

    #[test]
    fn a_blank_or_missing_answer_mints_no_reply() {
        let blank =
            json!({ "type": "result", "subtype": "success", "result": "   \n", "session_id": "s" });
        assert_eq!(reply_text(&blank), None);

        let missing = json!({ "type": "result", "subtype": "success", "session_id": "s" });
        assert_eq!(reply_text(&missing), None);

        let not_a_string =
            json!({ "type": "result", "subtype": "success", "result": 7, "session_id": "s" });
        assert_eq!(reply_text(&not_a_string), None);
    }

    #[test]
    fn an_unsuccessful_terminal_result_carries_its_honest_failure_reason() {
        let event = json!({
            "type": "result",
            "subtype": "error_during_execution",
            "is_error": true,
            "result": "No conversation found with session ID deadbeef"
        });
        assert_eq!(
            provider_error_text(&event).as_deref(),
            Some("No conversation found with session ID deadbeef")
        );
        assert_eq!(provider_error_text(&json!({ "type": "assistant" })), None);
        assert_eq!(
            provider_error_text(&json!({
                "type": "result", "subtype": "success", "is_error": false,
                "result": "ordinary reply"
            })),
            None
        );
    }

    #[test]
    fn only_a_result_that_positively_names_an_unusable_session_arms_recovery() {
        let stale = json!({
            "type": "result", "subtype": "error_during_execution", "is_error": true,
            "result": "No conversation found with session ID deadbeef"
        });
        assert!(unusable_resumed_session(&stale));
        assert!(!unusable_resumed_session(&json!({
            "type": "result", "subtype": "error_during_execution", "is_error": true,
            "result": "The network request timed out"
        })));
        assert!(!unusable_resumed_session(&json!({
            "type": "assistant", "result": "No conversation found with session ID deadbeef"
        })));
    }
}
