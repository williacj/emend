// ABOUTME: Run-local permission decisions for the TD-1 provider callback and J7 run card.
// ABOUTME: A callback waits for an ordered human decision; cancellation and exit never grant.

use super::permission_adapter::{script_identity, ScriptIdentity};
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

/// Canonical TD-1 service request. Provider-specific fields are adapted before admission.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PermissionAction {
    pub action: String,
    pub detail: String,
    pub why: String,
}

/// TD-1 decisions are provider-independent; the Claude edge maps them to its native JSON.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionOutcome {
    Allow,
    AllowAlways,
    Deny { reason: String },
}

/// Display-only fields; provider input and decision authority stay in the backend.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequest {
    pub id: String,
    pub action: String,
    pub detail: String,
    pub why: String,
    pub requested_at_ms: u64,
    pub allow_exact_command: bool,
    pub allow_script: bool,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionState {
    pub project_id: Option<String>,
    pub run_id: Option<String>,
    pub revision: u64,
    pub requests: Vec<PermissionRequest>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PermissionDecision {
    AllowOnce,
    AllowExactCommand,
    AllowScript,
    Deny { reason: String },
}

pub trait PermissionObserver: Send + Sync {
    fn changed(&self, state: &PermissionState);
    /// Arrival-only attention; decisions, automatic grants and completion do not call this.
    fn requested(&self) {}
}

impl<F: Fn(&PermissionState) + Send + Sync> PermissionObserver for F {
    fn changed(&self, state: &PermissionState) {
        self(state);
    }
}

struct Pending {
    rpc_id: Option<Value>,
    display: PermissionRequest,
    execution_key: Value,
    script: Option<ScriptIdentity>,
    reply: mpsc::Sender<PermissionOutcome>,
}

#[derive(Default)]
struct Inner {
    project_id: String,
    run_id: Option<String>,
    pending: Vec<Pending>,
    revision: u64,
    exact_grants: Vec<(String, Value)>,
    script_grants: Vec<ScriptIdentity>,
}

/// One broker belongs to one open project. A run ending revokes admission before waking waiters.
pub struct PermissionBroker {
    root: PathBuf,
    inner: Mutex<Inner>,
    observer: Mutex<Option<Arc<dyn PermissionObserver>>>,
}

impl PermissionBroker {
    pub fn new(root: impl Into<PathBuf>, observer: Option<Arc<dyn PermissionObserver>>) -> Self {
        Self {
            root: root.into(),
            inner: Mutex::new(Inner {
                project_id: Uuid::new_v4().to_string(),
                ..Inner::default()
            }),
            observer: Mutex::new(observer),
        }
    }

    pub fn set_observer(&self, observer: Option<Arc<dyn PermissionObserver>>) {
        *self
            .observer
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = observer;
    }

    pub fn begin(&self, run_id: &str) {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        Self::close(&mut inner);
        inner.run_id = Some(run_id.to_owned());
    }

    pub fn end(&self, run_id: &str) {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if inner.run_id.as_deref() != Some(run_id) {
            return;
        }
        Self::close(&mut inner);
        let state = Self::snapshot(&inner);
        drop(inner);
        self.publish(&state);
    }

    fn close(inner: &mut Inner) {
        inner.run_id = None;
        inner.revision += 1;
        inner.exact_grants.clear();
        inner.script_grants.clear();
        for pending in inner.pending.drain(..) {
            let _ = pending
                .reply
                .send(deny("The agent run ended before permission was granted."));
        }
    }

    fn snapshot(inner: &Inner) -> PermissionState {
        PermissionState {
            project_id: Some(inner.project_id.clone()),
            run_id: inner.run_id.clone(),
            revision: inner.revision,
            requests: inner
                .pending
                .iter()
                .map(|pending| pending.display.clone())
                .collect(),
        }
    }

    pub fn state(&self) -> PermissionState {
        Self::snapshot(
            &self
                .inner
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        )
    }

    fn publish(&self, state: &PermissionState) {
        let observer = self
            .observer
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        if let Some(observer) = observer {
            observer.changed(state);
        }
    }

    pub fn close_all(&self) {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        Self::close(&mut inner);
    }

    /// Claude's MCP callback carries tool_name/input/tool_use_id, not Cowrite's display fields.
    /// See the official CLI permission-prompt-tool reference and Agent SDK user-input contract.
    #[cfg(test)]
    fn request(&self, arguments: &Value) -> Result<Value, String> {
        let run_id = self.state().run_id;
        self.request_for(run_id.as_deref(), arguments)
    }

    pub fn request_for(&self, run_id: Option<&str>, arguments: &Value) -> Result<Value, String> {
        self.request_for_rpc(run_id, None, arguments)
    }

    pub fn cancel(&self, run_id: Option<&str>, rpc_id: &Value) {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if run_id.is_none() || inner.run_id.as_deref() != run_id {
            return;
        }
        let Some(index) = inner
            .pending
            .iter()
            .position(|pending| pending.rpc_id.as_ref() == Some(rpc_id))
        else {
            return;
        };
        let pending = inner.pending.remove(index);
        inner.revision += 1;
        let _ = pending
            .reply
            .send(deny("The provider cancelled this permission request."));
        let state = Self::snapshot(&inner);
        drop(inner);
        self.publish(&state);
    }

    pub fn request_for_rpc(
        &self,
        run_id: Option<&str>,
        rpc_id: Option<Value>,
        arguments: &Value,
    ) -> Result<Value, String> {
        super::permission_adapter::claude_request(self, run_id, rpc_id, arguments)
    }

    pub fn request_canonical(
        &self,
        run_id: Option<&str>,
        rpc_id: Option<Value>,
        arguments: &Value,
    ) -> Result<Value, String> {
        let action: PermissionAction =
            serde_json::from_value(arguments.clone()).map_err(|e| e.to_string())?;
        let key = json!({"command": action.detail});
        let outcome = self.request_action(run_id, rpc_id, action, key);
        serde_json::to_value(outcome).map_err(|e| e.to_string())
    }

    pub(super) fn request_action(
        &self,
        run_id: Option<&str>,
        rpc_id: Option<Value>,
        request: PermissionAction,
        execution_key: Value,
    ) -> PermissionOutcome {
        let PermissionAction {
            action,
            detail,
            why,
        } = request;
        let (reply, receiver) = mpsc::channel();
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if run_id.is_none() || inner.run_id.as_deref() != run_id {
            return deny("This callback does not belong to the active agent run.");
        }
        if inner
            .exact_grants
            .iter()
            .any(|(tool, granted)| tool == &action && granted == &execution_key)
        {
            return PermissionOutcome::AllowAlways;
        }
        let script = script_identity(&self.root, &action, &execution_key);
        if script
            .as_ref()
            .is_some_and(|identity| inner.script_grants.contains(identity))
        {
            return PermissionOutcome::AllowAlways;
        }
        inner.revision += 1;
        let requested_at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let allow_exact_command = action == "Bash"
            && execution_key
                .get("command")
                .and_then(Value::as_str)
                .is_some_and(|command| !command.is_empty());
        inner.pending.push(Pending {
            rpc_id,
            display: PermissionRequest {
                id: Uuid::new_v4().to_string(),
                action,
                detail,
                why,
                requested_at_ms,
                allow_exact_command,
                allow_script: script.is_some(),
            },
            execution_key,
            script,
            reply,
        });
        let state = Self::snapshot(&inner);
        drop(inner);
        self.publish(&state);
        let observer = self
            .observer
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        if let Some(observer) = observer {
            observer.requested();
        }
        // No approval timeout: a decision, request cancellation, or terminal cleanup replies.
        receiver
            .recv()
            .unwrap_or_else(|_| deny("Permission request was cancelled."))
    }

    pub fn decide(
        &self,
        run_id: &str,
        request_id: &str,
        decision: PermissionDecision,
    ) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if inner.run_id.as_deref() != Some(run_id)
            || !inner
                .pending
                .first()
                .is_some_and(|pending| pending.display.id == request_id)
        {
            return Err(
                "This permission request is no longer the first waiting request for this run."
                    .into(),
            );
        }
        if matches!(decision, PermissionDecision::AllowScript) {
            let pending = &inner.pending[0];
            let current =
                script_identity(&self.root, &pending.display.action, &pending.execution_key);
            if pending.script.is_none() || current != pending.script {
                return Err("This script could not be verified or changed while waiting. Deny this request and ask the agent to try again.".into());
            }
        }
        if matches!(decision, PermissionDecision::AllowExactCommand)
            && !inner.pending[0].display.allow_exact_command
        {
            return Err("This request cannot be allowed as an exact command.".into());
        }
        inner.revision += 1;
        let pending = inner.pending.remove(0);
        let result = match decision {
            PermissionDecision::AllowExactCommand => {
                inner.exact_grants.push((
                    pending.display.action.clone(),
                    pending.execution_key.clone(),
                ));
                PermissionOutcome::AllowAlways
            }
            PermissionDecision::AllowScript => {
                inner
                    .script_grants
                    .push(pending.script.expect("verified above"));
                PermissionOutcome::AllowAlways
            }
            PermissionDecision::AllowOnce => PermissionOutcome::Allow,
            PermissionDecision::Deny { reason } => deny(if reason.trim().is_empty() {
                "The user denied this action."
            } else {
                &reason
            }),
        };
        let _ = pending.reply.send(result);
        let state = Self::snapshot(&inner);
        drop(inner);
        self.publish(&state);
        Ok(())
    }
}

impl Drop for PermissionBroker {
    fn drop(&mut self) {
        Self::close(
            self.inner
                .get_mut()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        );
    }
}

fn deny(reason: &str) -> PermissionOutcome {
    PermissionOutcome::Deny {
        reason: reason.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{mpsc, Arc};
    use std::time::Duration;

    fn callback(command: &str) -> serde_json::Value {
        json!({"tool_name":"Bash","input":{"command":command,"description":"Fixture command"},"tool_use_id":"tool-fixture"})
    }

    #[test]
    fn a_real_provider_callback_waits_until_allow_and_returns_original_input() {
        let (tx, rx) = mpsc::channel();
        let broker = Arc::new(PermissionBroker::new(
            ".",
            Some(Arc::new(move |state: &PermissionState| {
                tx.send(state.clone()).unwrap();
            })),
        ));
        broker.begin("run-a");
        let payload = callback("python3 check.py");
        let original = payload["input"].clone();
        let worker = Arc::clone(&broker);
        let (done_tx, done_rx) = mpsc::channel();
        let thread = std::thread::spawn(move || {
            done_tx.send(worker.request(&payload).unwrap()).unwrap();
        });
        let pending = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(pending.requests.len(), 1);
        assert!(
            matches!(
                done_rx.recv_timeout(Duration::from_millis(50)),
                Err(mpsc::RecvTimeoutError::Timeout)
            ),
            "an undecided callback must stay pending"
        );
        broker
            .decide(
                "run-a",
                &pending.requests[0].id,
                PermissionDecision::AllowOnce,
            )
            .unwrap();
        assert_eq!(
            done_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            json!({"behavior":"allow","updatedInput":original})
        );
        thread.join().unwrap();
    }

    #[test]
    fn denial_guidance_reaches_the_provider_and_terminal_cleanup_never_allows() {
        for guidance in [Some("Use the existing report instead"), None] {
            let (tx, rx) = mpsc::channel();
            let broker = Arc::new(PermissionBroker::new(
                ".",
                Some(Arc::new(move |state: &PermissionState| {
                    tx.send(state.clone()).unwrap();
                })),
            ));
            broker.begin("run-a");
            let worker = Arc::clone(&broker);
            let thread =
                std::thread::spawn(move || worker.request(&callback("python3 check.py")).unwrap());
            let pending = rx.recv_timeout(Duration::from_secs(2)).unwrap();
            if let Some(reason) = guidance {
                broker
                    .decide(
                        "run-a",
                        &pending.requests[0].id,
                        PermissionDecision::Deny {
                            reason: reason.into(),
                        },
                    )
                    .unwrap();
            } else {
                broker.end("run-a");
            }
            let result = thread.join().unwrap();
            assert_eq!(
                result["behavior"], "deny",
                "denial and terminal cleanup must never grant"
            );
            if let Some(reason) = guidance {
                assert_eq!(result["message"], reason);
            }
            assert!(
                broker
                    .decide(
                        "run-a",
                        &pending.requests[0].id,
                        PermissionDecision::AllowOnce
                    )
                    .is_err(),
                "a resolved request cannot be approved again"
            );
        }
    }

    #[test]
    fn callbacks_outside_a_run_and_malformed_provider_inputs_fail_closed() {
        let broker = PermissionBroker::new(".", None);
        assert_eq!(
            broker.request(&callback("python3 check.py")).unwrap()["behavior"],
            "deny"
        );
        for payload in [
            json!({"action":"Bash","detail":"python3 check.py","why":"test"}),
            json!({"tool_name":"Bash","input":null}),
            json!({"tool_name":"","input":{}}),
        ] {
            assert!(
                broker.request(&payload).is_err(),
                "non-provider callback shape must be rejected"
            );
        }
    }
    #[test]
    fn stale_run_identity_is_denied_before_publishing_a_request() {
        let broker = PermissionBroker::new(".", None);
        broker.begin("next-run");
        for run in [None, Some("previous-run")] {
            assert_eq!(
                broker
                    .request_for(run, &callback("python3 check.py"))
                    .unwrap()["behavior"],
                "deny",
                "an absent or previous run identity must never borrow the active run"
            );
        }
        assert!(
            broker.state().requests.is_empty(),
            "stale callbacks must not create user controls"
        );
    }

    #[test]
    fn exact_command_grants_do_not_survive_a_run_or_match_changed_input() {
        let (tx, rx) = mpsc::channel();
        let broker = Arc::new(PermissionBroker::new(
            ".",
            Some(Arc::new(move |state: &PermissionState| {
                let _ = tx.send(state.clone());
            })),
        ));
        broker.begin("run-a");
        let worker = Arc::clone(&broker);
        let thread = std::thread::spawn(move || {
            worker
                .request_for(Some("run-a"), &callback("python3 check.py"))
                .unwrap()
        });
        let pending = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        broker
            .decide(
                "run-a",
                &pending.requests[0].id,
                PermissionDecision::AllowExactCommand,
            )
            .unwrap();
        assert_eq!(thread.join().unwrap()["behavior"], "allow");
        assert_eq!(
            broker
                .request_for(Some("run-a"), &callback("python3 check.py"))
                .unwrap()["behavior"],
            "allow"
        );
        let worker = Arc::clone(&broker);
        let thread = std::thread::spawn(move || {
            worker
                .request_for(Some("run-a"), &callback("python3 check.py extra"))
                .unwrap()
        });
        let mut pending = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        while pending.requests.is_empty() {
            pending = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        }
        assert_eq!(
            pending.requests[0].detail, "python3 check.py extra",
            "changed command input must ask again"
        );
        broker.end("run-a");
        assert_eq!(thread.join().unwrap()["behavior"], "deny");
        broker.begin("run-b");
        let worker = Arc::clone(&broker);
        let thread = std::thread::spawn(move || {
            worker
                .request_for(Some("run-b"), &callback("python3 check.py"))
                .unwrap()
        });
        let mut pending = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        while pending.requests.is_empty() {
            pending = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        }
        assert_eq!(
            pending.run_id.as_deref(),
            Some("run-b"),
            "a new run must ask again for a formerly allowed command"
        );
        broker.end("run-b");
        assert_eq!(thread.join().unwrap()["behavior"], "deny");
    }

    #[test]
    fn queued_requests_are_decided_in_order_and_a_duplicate_decision_fails() {
        let (tx, rx) = mpsc::channel();
        let broker = Arc::new(PermissionBroker::new(
            ".",
            Some(Arc::new(move |state: &PermissionState| {
                let _ = tx.send(state.clone());
            })),
        ));
        broker.begin("run-a");
        let first = Arc::clone(&broker);
        let first = std::thread::spawn(move || {
            first
                .request_for(Some("run-a"), &callback("first"))
                .unwrap()
        });
        let pending = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let first_id = pending.requests[0].id.clone();
        let second = Arc::clone(&broker);
        let second = std::thread::spawn(move || {
            second
                .request_for(Some("run-a"), &callback("second"))
                .unwrap()
        });
        let pending = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let second_id = pending.requests[1].id.clone();
        assert!(
            broker
                .decide("run-a", &second_id, PermissionDecision::AllowOnce)
                .is_err(),
            "a later queued request cannot be approved first"
        );
        broker
            .decide(
                "run-a",
                &first_id,
                PermissionDecision::Deny {
                    reason: "No".into(),
                },
            )
            .unwrap();
        assert!(
            broker
                .decide("run-a", &first_id, PermissionDecision::AllowOnce)
                .is_err(),
            "duplicate approval must be rejected"
        );
        broker
            .decide("run-a", &second_id, PermissionDecision::AllowOnce)
            .unwrap();
        assert_eq!(first.join().unwrap()["behavior"], "deny");
        assert_eq!(second.join().unwrap()["behavior"], "allow");
    }
    #[test]
    fn only_new_human_decisions_request_attention_not_resolution_or_exact_grants() {
        struct Observer {
            states: mpsc::Sender<PermissionState>,
            attention: mpsc::Sender<()>,
        }
        impl PermissionObserver for Observer {
            fn changed(&self, state: &PermissionState) {
                let _ = self.states.send(state.clone());
            }
            fn requested(&self) {
                self.attention.send(()).unwrap();
            }
        }
        let (tx, rx) = mpsc::channel();
        let (attention_tx, attention_rx) = mpsc::channel();
        let broker = Arc::new(PermissionBroker::new(
            ".",
            Some(Arc::new(Observer {
                states: tx,
                attention: attention_tx,
            })),
        ));
        broker.begin("run-a");
        assert!(
            attention_rx.try_recv().is_err(),
            "starting a run must not raise a permission notification"
        );
        let worker = Arc::clone(&broker);
        let thread = std::thread::spawn(move || {
            worker
                .request_for(Some("run-a"), &callback("python3 check.py"))
                .unwrap()
        });
        let pending = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        attention_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("a new permission request must request OS attention");
        broker
            .decide(
                "run-a",
                &pending.requests[0].id,
                PermissionDecision::AllowExactCommand,
            )
            .unwrap();
        assert_eq!(thread.join().unwrap()["behavior"], "allow");
        assert_eq!(
            broker
                .request_for(Some("run-a"), &callback("python3 check.py"))
                .unwrap()["behavior"],
            "allow"
        );
        broker.end("run-a");
        assert!(attention_rx.try_recv().is_err(), "resolution, allowlisted calls and termination must not repeat permission notifications");
    }
    #[test]
    fn exact_command_ignores_description_but_binds_execution_controls() {
        let broker = Arc::new(PermissionBroker::new(".", None));
        broker.begin("run");
        let first = Arc::clone(&broker);
        let worker = std::thread::spawn(move || {
            first.request_for(Some("run"), &callback("python3 check.py"))
        });
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        let id = loop {
            if let Some(request) = broker.state().requests.first() {
                break request.id.clone();
            }
            assert!(std::time::Instant::now() < deadline);
            std::thread::yield_now();
        };
        broker
            .decide("run", &id, PermissionDecision::AllowExactCommand)
            .unwrap();
        worker.join().unwrap().unwrap();
        for description in [Some("Different explanation"), None] {
            let mut payload = callback("python3 check.py");
            payload["input"]
                .as_object_mut()
                .unwrap()
                .remove("description");
            if let Some(description) = description {
                payload["input"]["description"] = json!(description);
            }
            let original = payload["input"].clone();
            let (tx, rx) = mpsc::channel();
            let changed = Arc::clone(&broker);
            let worker = std::thread::spawn(move || {
                tx.send(changed.request_for(Some("run"), &payload)).unwrap()
            });
            let result = rx.recv_timeout(Duration::from_secs(2));
            if result.is_err() {
                broker.end("run");
            }
            worker.join().unwrap();
            assert_eq!(
                result
                    .expect("display-only description changes must reuse an exact-command grant")
                    .unwrap(),
                json!({"behavior":"allow","updatedInput":original})
            );
        }
        let mut payload = callback("python3 check.py");
        payload["input"]["dangerouslyDisableSandbox"] = json!(true);
        let changed = Arc::clone(&broker);
        let worker = std::thread::spawn(move || changed.request_for(Some("run"), &payload));
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while broker.state().requests.is_empty()
            && !worker.is_finished()
            && std::time::Instant::now() < deadline
        {
            std::thread::yield_now();
        }
        let requested = !broker.state().requests.is_empty();
        broker.end("run");
        let response = worker.join().unwrap().unwrap();
        assert!(
            requested,
            "changed execution controls must ask even for identical command text"
        );
        assert_eq!(response["behavior"], "deny");
    }

    #[test]
    fn canonical_td1_service_preserves_action_detail_why_and_decision_vocabulary() {
        let (tx, rx) = mpsc::channel();
        let broker = Arc::new(PermissionBroker::new(
            ".",
            Some(Arc::new(move |state: &PermissionState| {
                let _ = tx.send(state.clone());
            })),
        ));
        for (decision, expected) in [
            (PermissionDecision::AllowOnce, json!("allow")),
            (PermissionDecision::AllowExactCommand, json!("allow_always")),
            (
                PermissionDecision::Deny {
                    reason: "Use existing notes".into(),
                },
                json!({"deny":{"reason":"Use existing notes"}}),
            ),
        ] {
            broker.begin("run");
            let request = Arc::clone(&broker);
            let worker = std::thread::spawn(move || {
                request.request_canonical(
                    Some("run"),
                    None,
                    &json!({"action":"Bash","detail":"python3 check.py","why":"Check references"}),
                )
            });
            let mut pending = rx.recv_timeout(Duration::from_secs(2)).unwrap();
            while pending.requests.is_empty() {
                pending = rx.recv_timeout(Duration::from_secs(2)).unwrap();
            }
            assert_eq!(pending.requests[0].action, "Bash");
            assert_eq!(pending.requests[0].detail, "python3 check.py");
            assert_eq!(pending.requests[0].why, "Check references");
            broker
                .decide("run", &pending.requests[0].id, decision)
                .unwrap();
            assert_eq!(worker.join().unwrap().unwrap(), expected);
            broker.end("run");
        }
    }
    #[test]
    fn replacement_project_identity_distinguishes_later_old_project_cleanup() {
        let previous = PermissionBroker::new(".", None);
        previous.begin("old-run");
        // Production open_project_after_fast_path constructs the replacement before dropping
        // the old project. Thus old cleanup may have a greater revision than the new snapshot.
        let replacement = PermissionBroker::new(".", None);
        let current = replacement.state();
        previous.end("old-run");
        let delayed = previous.state();
        assert!(delayed.revision > current.revision);
        assert_ne!(
            current.project_id, delayed.project_id,
            "project identity must distinguish old cleanup even when its revision is greater"
        );
        replacement.begin("new-run");
        assert_eq!(replacement.state().project_id, current.project_id);
    }
}
