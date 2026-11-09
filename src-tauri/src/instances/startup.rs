// ABOUTME: Total startup-argument parsing and hidden-window routing completion for TD-20(7).
// ABOUTME: Routed adoption reuses the one resolver and answers only after the project is bound.

use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Path, PathBuf};

use uuid::Uuid;

use super::{resolve, Action, AnswerStatus, InstanceRegistry, RouteSuccess, SelfState};
use crate::agent::project::{ProjectObservers, SharedOpenProject};
use crate::commands::project::{adopt_project_with_ownership_on, current_project_on};
use crate::store::lock::{self, RendezvousOutcome};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StartupIntent {
    Cold,
    DirectProject { root: PathBuf },
    Routed { root: PathBuf, request_id: Uuid },
    Invalid { reason: &'static str },
}

/// The single setup exit: every path either makes the configured window visible or terminates the
/// routed process. Keeping this exhaustive is the structural AC3 guard against hidden stranding.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StartupCompletion {
    Show,
    Exit,
}

/// Parses arguments after argv[0]. Unknown, duplicate, missing-value, and partial routed forms are
/// explicit invalid starts, never panics or accidental project opens.
pub fn parse_startup_intent(args: impl IntoIterator<Item = OsString>) -> StartupIntent {
    let mut project: Option<PathBuf> = None;
    let mut request: Option<Uuid> = None;
    let mut saw_request = false;
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        if arg == OsStr::new("--project") {
            if project.is_some() {
                return StartupIntent::Invalid {
                    reason: "duplicate --project",
                };
            }
            let Some(value) = args.next() else {
                return StartupIntent::Invalid {
                    reason: "--project requires a value",
                };
            };
            if value.is_empty() {
                return StartupIntent::Invalid {
                    reason: "--project requires a value",
                };
            }
            project = Some(PathBuf::from(value));
        } else if arg == OsStr::new("--open-request") {
            if saw_request {
                return StartupIntent::Invalid {
                    reason: "duplicate --open-request",
                };
            }
            saw_request = true;
            let Some(value) = args.next() else {
                return StartupIntent::Invalid {
                    reason: "--open-request requires a value",
                };
            };
            let Some(value) = value.to_str() else {
                return StartupIntent::Invalid {
                    reason: "--open-request must be a UUID",
                };
            };
            let Ok(id) = Uuid::parse_str(value) else {
                return StartupIntent::Invalid {
                    reason: "--open-request must be a UUID",
                };
            };
            request = Some(id);
        } else {
            return StartupIntent::Invalid {
                reason: "unrecognized startup argument",
            };
        }
    }

    match (project, request, saw_request) {
        (None, None, false) => StartupIntent::Cold,
        (Some(root), None, false) => StartupIntent::DirectProject { root },
        (Some(root), Some(request_id), true) => StartupIntent::Routed { root, request_id },
        (None, Some(_), _) | (None, None, true) => StartupIntent::Invalid {
            reason: "--open-request requires --project",
        },
        (Some(_), None, true) => StartupIntent::Invalid {
            reason: "--open-request must be a UUID",
        },
        (Some(_), Some(_), false) => StartupIntent::Invalid {
            reason: "invalid startup arguments",
        },
    }
}

/// Runs the startup intent against TD-20's one resolver. The ratified routed-non-adoption rule is
/// isolated to `routed_non_adoption_completion`; no other startup or adoption behavior depends on
/// that terminal-action policy.
pub fn route_startup_intent(
    intent: StartupIntent,
    registry: &InstanceRegistry,
    session: &SharedOpenProject,
    app_local_data_dir: &Path,
    observers: ProjectObservers,
) -> StartupCompletion {
    match intent {
        StartupIntent::Cold => StartupCompletion::Show,
        StartupIntent::Invalid { reason } => {
            eprintln!("Cowrite ignored invalid startup arguments: {reason}");
            StartupCompletion::Show
        }
        StartupIntent::DirectProject { root } => {
            route_direct_project(&root, registry, session, app_local_data_dir, observers)
        }
        StartupIntent::Routed { root, request_id } => route_routed_project(
            &root,
            request_id,
            registry,
            session,
            app_local_data_dir,
            observers,
        ),
    }
}

fn self_state_root(session: &SharedOpenProject) -> Option<PathBuf> {
    current_project_on(session).map(PathBuf::from)
}

fn route_direct_project(
    root: &Path,
    registry: &InstanceRegistry,
    session: &SharedOpenProject,
    app_local_data_dir: &Path,
    observers: ProjectObservers,
) -> StartupCompletion {
    let held = self_state_root(session);
    let state = held
        .as_deref()
        .map(SelfState::Holding)
        .unwrap_or(SelfState::Empty);
    match resolve(root, state, registry) {
        Ok(Action::AdoptHere { root, ownership }) => {
            if let Err(error) = adopt_project_with_ownership_on(
                session,
                &root,
                ownership,
                observers,
                app_local_data_dir,
            ) {
                eprintln!("Cowrite could not open the startup project: {error:?}");
            }
            StartupCompletion::Show
        }
        Ok(Action::AlreadyOpenHere { .. } | Action::Raise { .. } | Action::Launch { .. }) => {
            // P2a-11f/11g own cross-process activation/serialized routing. This card must still
            // terminate total argument handling without flashing a wrongly adopted project.
            StartupCompletion::Show
        }
        Err(error) => {
            eprintln!("Cowrite could not resolve the startup project: {error}");
            StartupCompletion::Show
        }
    }
}

fn route_routed_project(
    root: &Path,
    request_id: Uuid,
    registry: &InstanceRegistry,
    session: &SharedOpenProject,
    app_local_data_dir: &Path,
    observers: ProjectObservers,
) -> StartupCompletion {
    route_routed_project_with_writer(
        root,
        request_id,
        registry,
        session,
        app_local_data_dir,
        observers,
        lock::write_rendezvous_outcome_once,
    )
}

fn route_routed_project_with_writer(
    root: &Path,
    request_id: Uuid,
    registry: &InstanceRegistry,
    session: &SharedOpenProject,
    app_local_data_dir: &Path,
    observers: ProjectObservers,
    write_outcome: impl FnOnce(&Path, &RendezvousOutcome) -> io::Result<bool>,
) -> StartupCompletion {
    let held = self_state_root(session);
    let state = held
        .as_deref()
        .map(SelfState::Holding)
        .unwrap_or(SelfState::Empty);
    let action = match resolve(root, state, registry) {
        Ok(action) => action,
        Err(error) => {
            eprintln!("Cowrite could not resolve the routed startup project: {error}");
            return routed_non_adoption_completion();
        }
    };

    let Action::AdoptHere { root, ownership } = action else {
        // The probe-race loser answers nothing and leaves the request for the true owner (AC5).
        return routed_non_adoption_completion();
    };
    let registry_dir = ownership.registry_dir().to_path_buf();
    let rollback_root = root.clone();
    let result = super::rendezvous::answer_request_transactionally_with_writer(
        &registry_dir,
        request_id,
        RouteSuccess::Opened,
        registry.clock.as_ref(),
        || {
            adopt_project_with_ownership_on(
                session,
                &root,
                ownership,
                observers,
                app_local_data_dir,
            )
            .map_err(|error| io::Error::other(format!("{error:?}")))
        },
        || rollback_routed_adoption(session, &rollback_root),
        write_outcome,
    );

    match result {
        Ok(AnswerStatus::Answered) => StartupCompletion::Show,
        Ok(
            AnswerStatus::AlreadyAnswered | AnswerStatus::Expired | AnswerStatus::MissingOrCorrupt,
        ) => routed_non_adoption_completion(),
        Err(error) => {
            eprintln!("Cowrite could not complete routed startup: {error}");
            routed_non_adoption_completion()
        }
    }
}

fn rollback_routed_adoption(session: &SharedOpenProject, root: &Path) {
    let adopted = {
        let mut guard = session
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if guard.as_ref().is_some_and(|project| project.root() == root) {
            guard.take()
        } else {
            None
        }
    };
    // OpenProject's ordered Drop unbinds the server/watchers before releasing ownership. Keeping
    // that bounded teardown outside the session mutex prevents a frontend command from deadlocking.
    drop(adopted);
}

/// A valid routed launch that does not adopt exits hidden (TD-20(7), CJ 2026-09-06).
fn routed_non_adoption_completion() -> StartupCompletion {
    StartupCompletion::Exit
}

pub fn finalize_startup(
    completion: StartupCompletion,
    show: impl FnOnce() -> io::Result<()>,
    exit: impl FnOnce(),
) -> io::Result<()> {
    match completion {
        StartupCompletion::Show => show(),
        StartupCompletion::Exit => {
            exit();
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::collections::VecDeque;
    use std::fs;
    use std::sync::{Arc, Mutex};

    use crate::commands::project::new_session;
    use crate::store::lock::RendezvousRequest;

    fn args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn argument_handling_is_total_for_cold_direct_routed_partial_and_invalid_forms() {
        let id = Uuid::new_v4();
        assert_eq!(parse_startup_intent(Vec::new()), StartupIntent::Cold);
        assert_eq!(
            parse_startup_intent(args(&["--project", "C:/Project With Spaces"])),
            StartupIntent::DirectProject {
                root: PathBuf::from("C:/Project With Spaces")
            }
        );
        assert_eq!(
            parse_startup_intent(args(&[
                "--project",
                "C:/Project With Spaces",
                "--open-request",
                &id.to_string(),
            ])),
            StartupIntent::Routed {
                root: PathBuf::from("C:/Project With Spaces"),
                request_id: id,
            }
        );
        for invalid in [
            args(&["--open-request", &id.to_string()]),
            args(&["--project"]),
            args(&["--project", "root", "--open-request", "not-a-uuid"]),
            args(&["--unknown"]),
            args(&["--project", "one", "--project", "two"]),
        ] {
            assert!(matches!(
                parse_startup_intent(invalid),
                StartupIntent::Invalid { .. }
            ));
        }
    }

    #[test]
    fn every_completion_invokes_exactly_one_terminal_action() {
        for completion in [StartupCompletion::Show, StartupCompletion::Exit] {
            let shown = Cell::new(0);
            let exited = Cell::new(0);
            finalize_startup(
                completion,
                || {
                    shown.set(shown.get() + 1);
                    Ok(())
                },
                || exited.set(exited.get() + 1),
            )
            .unwrap();
            assert_eq!(shown.get() + exited.get(), 1);
            assert_eq!(
                shown.get(),
                usize::from(completion == StartupCompletion::Show)
            );
        }
    }

    fn publish_request(registry_dir: &Path, request_id: Uuid, deadline_at_ms: i64) {
        lock::write_rendezvous_request(
            registry_dir,
            &RendezvousRequest {
                schema_version: lock::RENDEZVOUS_SCHEMA_VERSION,
                request_id,
                requester_instance_id: "requester".to_string(),
                asked_at_ms: 1,
                deadline_at_ms,
            },
        )
        .unwrap();
    }

    struct SequenceClock(Mutex<VecDeque<i64>>);

    impl SequenceClock {
        fn new(values: impl IntoIterator<Item = i64>) -> SequenceClock {
            SequenceClock(Mutex::new(values.into_iter().collect()))
        }
    }

    impl super::super::Clock for SequenceClock {
        fn now_ms(&self) -> i64 {
            self.0
                .lock()
                .unwrap()
                .pop_front()
                .expect("fixture supplied one time for every clock read")
        }
    }

    fn assert_adoption_rolled_back(app_data: &Path, project: &Path, provider_session_id: &str) {
        let metadata = crate::store::transcript::provider_session_file(app_data, project);
        assert_eq!(
            crate::store::transcript::load_provider_session(&metadata).unwrap(),
            Some(provider_session_id.to_string())
        );
        drop(lock::test_support::take(
            &lock::registry_dir(app_data, project),
            project,
            "replacement",
        ));
    }

    #[test]
    fn routed_adoption_binds_then_answers_opened_and_shows_once() {
        let app_data = tempfile::TempDir::new().unwrap();
        let project = tempfile::TempDir::new().unwrap();
        let registry = InstanceRegistry::with_identity(app_data.path(), "arriving");
        let request_id = Uuid::new_v4();
        let registry_dir = lock::registry_dir(app_data.path(), project.path());
        publish_request(&registry_dir, request_id, i64::MAX);
        let session = new_session();

        let completion = route_startup_intent(
            StartupIntent::Routed {
                root: project.path().to_path_buf(),
                request_id,
            },
            &registry,
            &session,
            app_data.path(),
            ProjectObservers::default(),
        );

        assert_eq!(completion, StartupCompletion::Show);
        assert_eq!(
            current_project_on(&session),
            Some(
                crate::store::project_identity::require_canonical_root(project.path())
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            )
        );
        assert!(matches!(
            lock::read_rendezvous_outcome(&registry_dir, request_id),
            lock::RendezvousRead::Valid(outcome) if outcome.outcome == RouteSuccess::Opened
        ));
    }

    #[test]
    fn outcome_write_failure_rolls_back_project_provider_session_and_ownership() {
        let app_data = tempfile::TempDir::new().unwrap();
        let project = tempfile::TempDir::new().unwrap();
        let provider_session_id = Uuid::new_v4().to_string();
        let metadata =
            crate::store::transcript::provider_session_file(app_data.path(), project.path());
        crate::store::transcript::save_provider_session(&metadata, Some(&provider_session_id))
            .unwrap();
        let registry = InstanceRegistry::with_identity(app_data.path(), "arriving");
        let request_id = Uuid::new_v4();
        let registry_dir = lock::registry_dir(app_data.path(), project.path());
        publish_request(&registry_dir, request_id, i64::MAX);
        let session = new_session();

        let completion = route_routed_project_with_writer(
            project.path(),
            request_id,
            &registry,
            &session,
            app_data.path(),
            ProjectObservers::default(),
            |_, _| Err(io::Error::other("outcome store unavailable")),
        );

        assert_eq!(completion, StartupCompletion::Exit);
        assert_eq!(
            current_project_on(&session),
            None,
            "an outcome-write error must not leave the routed project adopted"
        );
        assert_adoption_rolled_back(app_data.path(), project.path(), &provider_session_id);
        assert!(matches!(
            lock::read_rendezvous_request(&registry_dir, request_id),
            lock::RendezvousRead::Missing
        ));
        assert!(matches!(
            lock::read_rendezvous_outcome(&registry_dir, request_id),
            lock::RendezvousRead::Missing
        ));
    }

    #[test]
    fn adoption_crossing_the_deadline_rolls_back_project_provider_session_and_ownership() {
        let app_data = tempfile::TempDir::new().unwrap();
        let project = tempfile::TempDir::new().unwrap();
        let provider_session_id = Uuid::new_v4().to_string();
        let metadata =
            crate::store::transcript::provider_session_file(app_data.path(), project.path());
        crate::store::transcript::save_provider_session(&metadata, Some(&provider_session_id))
            .unwrap();
        // resolve/sweep sees 0, the request re-read sees 1, and the post-bind revalidation sees the
        // exact deadline. No sleep or scheduler timing participates in the proof.
        let registry = InstanceRegistry::with_identity_and_clock(
            app_data.path(),
            "arriving",
            Arc::new(SequenceClock::new([0, 1, 10])),
        );
        let request_id = Uuid::new_v4();
        let registry_dir = lock::registry_dir(app_data.path(), project.path());
        publish_request(&registry_dir, request_id, 10);
        let session = new_session();

        let completion = route_startup_intent(
            StartupIntent::Routed {
                root: project.path().to_path_buf(),
                request_id,
            },
            &registry,
            &session,
            app_data.path(),
            ProjectObservers::default(),
        );

        assert_eq!(completion, StartupCompletion::Exit);
        assert_eq!(
            current_project_on(&session),
            None,
            "an adoption completing at the deadline must be rolled back"
        );
        assert_adoption_rolled_back(app_data.path(), project.path(), &provider_session_id);
        assert!(matches!(
            lock::read_rendezvous_outcome(&registry_dir, request_id),
            lock::RendezvousRead::Missing
        ));
    }

    #[test]
    fn expired_corrupt_missing_and_probe_race_loss_exit_without_showing_or_answering() {
        let app_data = tempfile::TempDir::new().unwrap();
        let project = tempfile::TempDir::new().unwrap();
        let registry = InstanceRegistry::with_identity(app_data.path(), "arriving");
        let registry_dir = lock::registry_dir(app_data.path(), project.path());

        let expired = Uuid::new_v4();
        publish_request(&registry_dir, expired, 0);
        let corrupt = Uuid::new_v4();
        fs::create_dir_all(registry_dir.join("requests")).unwrap();
        fs::write(
            registry_dir
                .join("requests")
                .join(format!("{corrupt}.json")),
            b"{",
        )
        .unwrap();
        let missing = Uuid::new_v4();
        for request_id in [expired, corrupt, missing] {
            assert_eq!(
                route_startup_intent(
                    StartupIntent::Routed {
                        root: project.path().to_path_buf(),
                        request_id,
                    },
                    &registry,
                    &new_session(),
                    app_data.path(),
                    ProjectObservers::default(),
                ),
                StartupCompletion::Exit
            );
        }

        let owner = lock::test_support::take(&registry_dir, project.path(), "winner");
        let pending = Uuid::new_v4();
        publish_request(&registry_dir, pending, i64::MAX);
        assert_eq!(
            route_startup_intent(
                StartupIntent::Routed {
                    root: project.path().to_path_buf(),
                    request_id: pending,
                },
                &registry,
                &new_session(),
                app_data.path(),
                ProjectObservers::default(),
            ),
            StartupCompletion::Exit
        );
        assert!(matches!(
            lock::read_rendezvous_request(&registry_dir, pending),
            lock::RendezvousRead::Valid(_)
        ));
        assert!(matches!(
            lock::read_rendezvous_outcome(&registry_dir, pending),
            lock::RendezvousRead::Missing
        ));
        drop(owner);
    }
}
