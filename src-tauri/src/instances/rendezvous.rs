// ABOUTME: Answered cross-process project-routing rendezvous with deadlines measured from the ask.
// ABOUTME: Native notifications bound every wait; expired and corrupt artifacts fail soft.

//! TD-20 ruling (5)'s request/outcome handshake. The request carries the absolute deadline minted
//! from the user's ask, so time spent before its write or behind a later routing queue cannot reset
//! the budget. Requesters arm the native outcome watcher before publishing, and responders re-read
//! the request immediately before performing focus/open work.
//!
//! **Corrupt-file fail-soft:** a malformed, truncated, mismatched-id, or unknown-schema request is
//! removed and never performed. A malformed outcome is never accepted as an answer; the requester
//! continues only to its original deadline and then removes both paths. Thus corrupt JSON can lose
//! a request honestly, but it cannot fabricate success or extend the wait. Acquirer sweeps apply
//! the same rule to orphaned records and to every unsanctioned artifact in the keyed directory.

use std::fs;
use std::io;
use std::path::Path;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use uuid::Uuid;

use crate::store::lock::{
    self, ProjectLockGuard, RendezvousOutcome, RendezvousRead, RendezvousWatcher,
};

pub use crate::store::lock::{
    RendezvousRequest as RouteRequest, RendezvousSuccess as RouteSuccess,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
// @anchor:route-failure-reasons
pub enum RouteFailure {
    ProjectUnavailable,
    OpenFailed,
    DeadlineExpired,
    RegistryUnavailable,
    LaunchFailed,
    /// The recorded owner could not be positively addressed as a live Cowrite process.
    OwnerUnavailable,
    /// The OS refused the requester-side foreground/activation operation.
    ActivationRefused,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerminalDisposition {
    Focused,
    Opened,
    Failed(RouteFailure),
}

pub trait Clock: Send + Sync {
    fn now_ms(&self) -> i64;
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
            .unwrap_or(0)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AnswerStatus {
    Answered,
    AlreadyAnswered,
    Expired,
    MissingOrCorrupt,
}

pub fn request_and_wait(
    registry_dir: &Path,
    requester_instance_id: &str,
    asked_at_ms: i64,
    budget: Duration,
    clock: &dyn Clock,
) -> TerminalDisposition {
    request_and_wait_after_publish(
        registry_dir,
        requester_instance_id,
        asked_at_ms,
        budget,
        clock,
        |_| Ok(()),
    )
}

/// Arms the native outcome watch, publishes the exact request, then hands that request to the
/// caller's dispatcher (the detached launcher in P2a-11e). The id passed to the new process is
/// therefore the id actually on disk, and a fast answer cannot race watcher startup.
pub fn request_and_wait_after_publish(
    registry_dir: &Path,
    requester_instance_id: &str,
    asked_at_ms: i64,
    budget: Duration,
    clock: &dyn Clock,
    dispatch: impl FnOnce(&RouteRequest) -> io::Result<()>,
) -> TerminalDisposition {
    request_and_wait_after_arm(
        registry_dir,
        requester_instance_id,
        asked_at_ms,
        budget,
        clock,
        |request| {
            lock::write_rendezvous_request(registry_dir, request)
                .map_err(|_| RouteFailure::RegistryUnavailable)?;
            dispatch(request).map_err(|_| RouteFailure::LaunchFailed)
        },
    )
}

/// Arms the outcome watcher before a caller performs its exact durable-publication sequence.
///
/// This is deliberately narrower than a general purpose work dispatch: TD-20(6)'s requester
/// needs a single seam that can prepare an unarmed record, perform the one platform operation that
/// belongs between preparation and arm, then make that exact record observable. The owner sees
/// only an armed request and still supplies the only success acknowledgement.
pub fn request_and_wait_after_arm(
    registry_dir: &Path,
    requester_instance_id: &str,
    asked_at_ms: i64,
    budget: Duration,
    clock: &dyn Clock,
    arm: impl FnOnce(&RouteRequest) -> Result<(), RouteFailure>,
) -> TerminalDisposition {
    let deadline_at_ms = deadline_from_ask(asked_at_ms, budget);
    if clock.now_ms() >= deadline_at_ms {
        return TerminalDisposition::Failed(RouteFailure::DeadlineExpired);
    }
    let watcher = match RendezvousWatcher::watch_outcomes(registry_dir) {
        Ok(watcher) => watcher,
        Err(_) => return TerminalDisposition::Failed(RouteFailure::RegistryUnavailable),
    };
    request_and_wait_with_arm(
        registry_dir,
        requester_instance_id,
        asked_at_ms,
        budget,
        clock,
        arm,
        |_, remaining| watcher.recv_timeout(remaining).map(|_| ()),
    )
}

fn deadline_from_ask(asked_at_ms: i64, budget: Duration) -> i64 {
    let budget_ms = budget.as_millis().min(i64::MAX as u128) as i64;
    asked_at_ms.saturating_add(budget_ms)
}

fn disposition_from_outcome(
    outcome: &RendezvousOutcome,
    deadline_at_ms: i64,
) -> Option<TerminalDisposition> {
    if outcome.completed_at_ms > deadline_at_ms || outcome.deadline_at_ms != deadline_at_ms {
        return None;
    }
    Some(match outcome.outcome {
        RouteSuccess::Focused => TerminalDisposition::Focused,
        RouteSuccess::Opened => TerminalDisposition::Opened,
    })
}

fn finish(
    registry_dir: &Path,
    request_id: Uuid,
    terminal: TerminalDisposition,
) -> TerminalDisposition {
    lock::remove_rendezvous_request(registry_dir, request_id);
    lock::remove_rendezvous_outcome(registry_dir, request_id);
    terminal
}

#[cfg(test)]
fn request_and_wait_with(
    registry_dir: &Path,
    requester_instance_id: &str,
    asked_at_ms: i64,
    budget: Duration,
    clock: &dyn Clock,
    wait: impl FnMut(&RouteRequest, Duration) -> io::Result<()>,
) -> TerminalDisposition {
    request_and_wait_with_arm(
        registry_dir,
        requester_instance_id,
        asked_at_ms,
        budget,
        clock,
        |request| {
            lock::write_rendezvous_request(registry_dir, request)
                .map_err(|_| RouteFailure::RegistryUnavailable)
        },
        wait,
    )
}

#[cfg(test)]
fn request_and_wait_with_dispatch(
    registry_dir: &Path,
    requester_instance_id: &str,
    asked_at_ms: i64,
    budget: Duration,
    clock: &dyn Clock,
    dispatch: impl FnOnce(&RouteRequest) -> io::Result<()>,
    wait: impl FnMut(&RouteRequest, Duration) -> io::Result<()>,
) -> TerminalDisposition {
    request_and_wait_with_arm(
        registry_dir,
        requester_instance_id,
        asked_at_ms,
        budget,
        clock,
        |request| {
            lock::write_rendezvous_request(registry_dir, request)
                .map_err(|_| RouteFailure::RegistryUnavailable)?;
            dispatch(request).map_err(|_| RouteFailure::LaunchFailed)
        },
        wait,
    )
}

fn request_and_wait_with_arm(
    registry_dir: &Path,
    requester_instance_id: &str,
    asked_at_ms: i64,
    budget: Duration,
    clock: &dyn Clock,
    arm: impl FnOnce(&RouteRequest) -> Result<(), RouteFailure>,
    mut wait: impl FnMut(&RouteRequest, Duration) -> io::Result<()>,
) -> TerminalDisposition {
    let deadline_at_ms = deadline_from_ask(asked_at_ms, budget);
    if clock.now_ms() >= deadline_at_ms {
        return TerminalDisposition::Failed(RouteFailure::DeadlineExpired);
    }

    let request = RouteRequest {
        schema_version: lock::RENDEZVOUS_SCHEMA_VERSION,
        request_id: Uuid::new_v4(),
        requester_instance_id: requester_instance_id.to_string(),
        asked_at_ms,
        deadline_at_ms,
    };
    if let Err(failure) = arm(&request) {
        return finish(
            registry_dir,
            request.request_id,
            TerminalDisposition::Failed(failure),
        );
    }

    loop {
        if let RendezvousRead::Valid(outcome) =
            lock::read_rendezvous_outcome(registry_dir, request.request_id)
        {
            if let Some(terminal) = disposition_from_outcome(&outcome, deadline_at_ms) {
                return finish(registry_dir, request.request_id, terminal);
            }
        }

        let now_ms = clock.now_ms();
        if now_ms >= deadline_at_ms {
            // TD-20's deliberate tolerance: after expiry, read once more so an on-time ack whose
            // native notification was delayed still wins. A late timestamp never does.
            if let RendezvousRead::Valid(outcome) =
                lock::read_rendezvous_outcome(registry_dir, request.request_id)
            {
                if let Some(terminal) = disposition_from_outcome(&outcome, deadline_at_ms) {
                    return finish(registry_dir, request.request_id, terminal);
                }
            }
            return finish(
                registry_dir,
                request.request_id,
                TerminalDisposition::Failed(RouteFailure::DeadlineExpired),
            );
        }

        let remaining = Duration::from_millis((deadline_at_ms - now_ms) as u64);
        if wait(&request, remaining).is_err() {
            return finish(
                registry_dir,
                request.request_id,
                TerminalDisposition::Failed(RouteFailure::RegistryUnavailable),
            );
        }
    }
}

pub fn answer_request(
    registry_dir: &Path,
    request_id: Uuid,
    outcome: RouteSuccess,
    clock: &dyn Clock,
    perform: impl FnOnce() -> io::Result<()>,
) -> io::Result<AnswerStatus> {
    let request = match read_answerable_request(registry_dir, request_id, clock) {
        Ok(request) => request,
        Err(status) => return Ok(status),
    };

    perform()?;
    let record = RendezvousOutcome {
        schema_version: lock::RENDEZVOUS_SCHEMA_VERSION,
        request_id,
        completed_at_ms: clock.now_ms(),
        deadline_at_ms: request.deadline_at_ms,
        outcome,
    };
    let wrote = lock::write_rendezvous_outcome_once(registry_dir, &record)?;
    lock::remove_rendezvous_request(registry_dir, request_id);
    Ok(if wrote {
        AnswerStatus::Answered
    } else {
        AnswerStatus::AlreadyAnswered
    })
}

fn read_answerable_request(
    registry_dir: &Path,
    request_id: Uuid,
    clock: &dyn Clock,
) -> Result<RouteRequest, AnswerStatus> {
    match lock::read_rendezvous_outcome(registry_dir, request_id) {
        RendezvousRead::Valid(_) => {
            lock::remove_rendezvous_request(registry_dir, request_id);
            return Err(AnswerStatus::AlreadyAnswered);
        }
        RendezvousRead::Corrupt => lock::remove_rendezvous_outcome(registry_dir, request_id),
        RendezvousRead::Missing => {}
    }

    let request = match lock::read_rendezvous_request(registry_dir, request_id) {
        RendezvousRead::Valid(request) => request,
        RendezvousRead::Corrupt => {
            lock::remove_rendezvous_request(registry_dir, request_id);
            return Err(AnswerStatus::MissingOrCorrupt);
        }
        RendezvousRead::Missing => return Err(AnswerStatus::MissingOrCorrupt),
    };
    if clock.now_ms() >= request.deadline_at_ms {
        lock::remove_rendezvous_request(registry_dir, request_id);
        lock::remove_rendezvous_outcome(registry_dir, request_id);
        return Err(AnswerStatus::Expired);
    }
    Ok(request)
}

/// Runs a reversible operation, revalidates its deadline, and retains it only after the terminal
/// outcome is durably published. `rollback` must undo every effect of a successful `perform`.
pub(super) fn answer_request_transactionally_with_writer(
    registry_dir: &Path,
    request_id: Uuid,
    outcome: RouteSuccess,
    clock: &dyn Clock,
    perform: impl FnOnce() -> io::Result<()>,
    rollback: impl FnOnce(),
    write_outcome: impl FnOnce(&Path, &RendezvousOutcome) -> io::Result<bool>,
) -> io::Result<AnswerStatus> {
    let request = match read_answerable_request(registry_dir, request_id, clock) {
        Ok(request) => request,
        Err(status) => return Ok(status),
    };
    perform()?;
    let completed_at_ms = clock.now_ms();
    if completed_at_ms >= request.deadline_at_ms {
        rollback();
        lock::remove_rendezvous_request(registry_dir, request_id);
        lock::remove_rendezvous_outcome(registry_dir, request_id);
        return Ok(AnswerStatus::Expired);
    }
    let record = RendezvousOutcome {
        schema_version: lock::RENDEZVOUS_SCHEMA_VERSION,
        request_id,
        completed_at_ms,
        deadline_at_ms: request.deadline_at_ms,
        outcome,
    };
    let wrote = match write_outcome(registry_dir, &record) {
        Ok(wrote) => wrote,
        Err(error) => {
            rollback();
            lock::remove_rendezvous_request(registry_dir, request_id);
            lock::remove_rendezvous_outcome(registry_dir, request_id);
            return Err(error);
        }
    };
    if !wrote {
        rollback();
        lock::remove_rendezvous_request(registry_dir, request_id);
        return Ok(AnswerStatus::AlreadyAnswered);
    }
    lock::remove_rendezvous_request(registry_dir, request_id);
    Ok(AnswerStatus::Answered)
}

pub struct RequestReceiver {
    watcher: RendezvousWatcher,
}

fn request_id_from_path(path: &Path) -> Option<Uuid> {
    let file_name = path.file_name()?.to_str()?;
    let request_id = Uuid::parse_str(file_name.strip_suffix(".json")?).ok()?;
    (file_name == format!("{request_id}.json")).then_some(request_id)
}

fn pending_requests(registry_dir: &Path, now_ms: i64) -> io::Result<Vec<RouteRequest>> {
    let mut pending = Vec::new();
    for path in lock::rendezvous_request_files(registry_dir)? {
        let Some(request_id) = request_id_from_path(&path) else {
            lock::remove_rendezvous_artifact(&path);
            continue;
        };
        match lock::read_rendezvous_request(registry_dir, request_id) {
            RendezvousRead::Valid(request) if request.deadline_at_ms > now_ms => {
                pending.push(request)
            }
            RendezvousRead::Valid(_) | RendezvousRead::Corrupt => {
                lock::remove_rendezvous_artifact(&path)
            }
            RendezvousRead::Missing => {}
        }
    }
    pending.sort_by_key(|request| (request.asked_at_ms, request.request_id));
    Ok(pending)
}

/// Acquirer housekeeping. The policy lives in `instances/`; `store::lock` exposes only the layout
/// and primitive file operations. This is a positive allowlist, so an unknown runtime spelling
/// cannot accumulate merely because no test happened to forbid its name.
pub(crate) fn sweep_acquired_registry(ownership: &ProjectLockGuard, now_ms: i64) -> io::Result<()> {
    let registry_dir = ownership.registry_dir();
    lock::ensure_rendezvous_dirs(registry_dir)?;
    for entry in fs::read_dir(registry_dir)? {
        let entry = entry?;
        let sanctioned = matches!(
            entry.file_name().to_str(),
            Some(
                lock::LOCK_FILE_NAME
                    | lock::OWNER_FILE_NAME
                    | lock::REQUESTS_DIR_NAME
                    | lock::OUTCOMES_DIR_NAME
                    | lock::REQUEST_STAGING_DIR_NAME
            )
        );
        if !sanctioned {
            lock::remove_rendezvous_artifact(&entry.path());
        }
    }

    if let Ok(Some(_staging_lock)) = lock::try_lock_rendezvous_request_staging(registry_dir) {
        for path in lock::rendezvous_request_staging_files(registry_dir)? {
            let is_staging_lock = path.file_name()
                == Some(std::ffi::OsStr::new(lock::REQUEST_STAGING_LOCK_FILE_NAME));
            if !is_staging_lock {
                lock::remove_rendezvous_artifact(&path);
            }
        }
    }
    let _ = pending_requests(registry_dir, now_ms)?;
    for path in lock::rendezvous_outcome_files(registry_dir)? {
        let keep = request_id_from_path(&path).is_some_and(|request_id| {
            matches!(
                lock::read_rendezvous_outcome(registry_dir, request_id),
                RendezvousRead::Valid(ref outcome) if outcome.deadline_at_ms > now_ms
            )
        });
        if !keep {
            lock::remove_rendezvous_artifact(&path);
        }
    }
    Ok(())
}

impl RequestReceiver {
    pub fn watch(registry_dir: &Path) -> io::Result<RequestReceiver> {
        Ok(RequestReceiver {
            watcher: RendezvousWatcher::watch_requests(registry_dir)?,
        })
    }

    pub fn recv_timeout(
        &self,
        registry_dir: &Path,
        clock: &dyn Clock,
        timeout: Duration,
    ) -> io::Result<Option<RouteRequest>> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(request) = pending_requests(registry_dir, clock.now_ms())?
                .into_iter()
                .next()
            {
                return Ok(Some(request));
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Ok(None);
            }
            let _ = self.watcher.recv_timeout(remaining)?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::lock;
    use crate::test_support::tree;
    use std::fs;
    use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};

    struct ManualClock(AtomicI64);

    impl ManualClock {
        fn at(now_ms: i64) -> ManualClock {
            ManualClock(AtomicI64::new(now_ms))
        }

        fn set(&self, now_ms: i64) {
            self.0.store(now_ms, Ordering::SeqCst);
        }
    }

    impl Clock for ManualClock {
        fn now_ms(&self) -> i64 {
            self.0.load(Ordering::SeqCst)
        }
    }

    #[test]
    fn publish_then_dispatch_receives_the_exact_armed_request_and_catches_a_fast_answer() {
        let registry = tempfile::TempDir::new().unwrap();
        let clock = ManualClock::at(1_000);
        let dispatched = AtomicUsize::new(0);
        let terminal = request_and_wait_with_dispatch(
            registry.path(),
            "requester-a",
            1_000,
            Duration::from_secs(1),
            &clock,
            |request| {
                assert!(matches!(
                    lock::read_rendezvous_request(registry.path(), request.request_id),
                    RendezvousRead::Valid(ref published) if published == request
                ));
                dispatched.fetch_add(1, Ordering::SeqCst);
                lock::write_rendezvous_outcome_once(
                    registry.path(),
                    &RendezvousOutcome {
                        schema_version: lock::RENDEZVOUS_SCHEMA_VERSION,
                        request_id: request.request_id,
                        completed_at_ms: 1_001,
                        deadline_at_ms: request.deadline_at_ms,
                        outcome: RouteSuccess::Opened,
                    },
                )?;
                Ok(())
            },
            |_, _| panic!("the fast outcome must be read before waiting"),
        );
        assert_eq!(terminal, TerminalDisposition::Opened);
        assert_eq!(dispatched.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn dispatch_failure_removes_the_published_request_without_waiting() {
        let registry = tempfile::TempDir::new().unwrap();
        let clock = ManualClock::at(1_000);
        let dispatched_id = std::cell::Cell::new(None);
        let terminal = request_and_wait_with_dispatch(
            registry.path(),
            "requester-a",
            1_000,
            Duration::from_secs(1),
            &clock,
            |request| {
                dispatched_id.set(Some(request.request_id));
                Err(io::Error::other("launcher refused"))
            },
            |_, _| panic!("a failed dispatch must never wait"),
        );
        assert_eq!(
            terminal,
            TerminalDisposition::Failed(RouteFailure::LaunchFailed)
        );
        let request_id = dispatched_id.get().unwrap();
        assert!(matches!(
            lock::read_rendezvous_request(registry.path(), request_id),
            RendezvousRead::Missing
        ));
    }

    #[test]
    fn one_request_is_answered_exactly_once() {
        let registry = tempfile::TempDir::new().unwrap();
        let clock = ManualClock::at(1_000);
        let actions = AtomicUsize::new(0);

        let terminal = request_and_wait_with(
            registry.path(),
            "requester-a",
            1_000,
            Duration::from_millis(100),
            &clock,
            |request, _| {
                assert_eq!(
                    answer_request(
                        registry.path(),
                        request.request_id,
                        RouteSuccess::Focused,
                        &clock,
                        || {
                            actions.fetch_add(1, Ordering::SeqCst);
                            Ok(())
                        },
                    )?,
                    AnswerStatus::Answered
                );
                assert_eq!(
                    answer_request(
                        registry.path(),
                        request.request_id,
                        RouteSuccess::Focused,
                        &clock,
                        || {
                            actions.fetch_add(1, Ordering::SeqCst);
                            Ok(())
                        },
                    )?,
                    AnswerStatus::AlreadyAnswered
                );
                Ok(())
            },
        );

        assert_eq!(terminal, TerminalDisposition::Focused);
        assert_eq!(actions.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_receiver_scan_cannot_remove_an_in_progress_request_publication() {
        let registry = tempfile::TempDir::new().unwrap();
        let project = tempfile::TempDir::new().unwrap();
        let ownership = match lock::probe(
            registry.path(),
            &lock::LockOwner::new("sweeper", project.path()),
        )
        .unwrap()
        {
            lock::LockOutcome::Acquired(ownership) => ownership,
            lock::LockOutcome::HeldByAnotherInstance { .. } => {
                panic!("the fixture should acquire its registry")
            }
        };
        let request = RouteRequest {
            schema_version: lock::RENDEZVOUS_SCHEMA_VERSION,
            request_id: Uuid::new_v4(),
            requester_instance_id: "requester-a".to_string(),
            asked_at_ms: 1_000,
            deadline_at_ms: 2_000,
        };
        let (staged_tx, staged_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();

        let (
            stage_survived_receiver_scan,
            stage_survived_acquirer_sweep,
            unknown_removed,
            wrong_extension_removed,
            write_result,
        ) = std::thread::scope(|scope| {
            let registry_path = registry.path();
            let request_ref = &request;
            let writer = scope.spawn(move || {
                lock::write_rendezvous_request_with_stage_hook(
                    registry_path,
                    request_ref,
                    |stage_path| {
                        staged_tx.send(stage_path.to_path_buf()).unwrap();
                        release_rx.recv().unwrap();
                    },
                )
            });
            let stage_path = staged_rx.recv().unwrap();
            let unknown = registry.path().join("requests/unrecognized.tmp");
            fs::write(&unknown, b"not a sanctioned request").unwrap();
            let wrong_extension = registry
                .path()
                .join("requests")
                .join(format!("{}.tmp", request.request_id));
            fs::write(&wrong_extension, b"not a sanctioned request").unwrap();

            assert!(pending_requests(registry.path(), 1_100).unwrap().is_empty());
            let stage_survived_receiver_scan = stage_path.exists();
            sweep_acquired_registry(&ownership, 1_100).unwrap();
            let stage_survived_acquirer_sweep = stage_path.exists();
            let unknown_removed = !unknown.exists();
            let wrong_extension_removed = !wrong_extension.exists();

            release_tx.send(()).unwrap();
            (
                stage_survived_receiver_scan,
                stage_survived_acquirer_sweep,
                unknown_removed,
                wrong_extension_removed,
                writer.join().unwrap(),
            )
        });

        assert!(
            stage_survived_receiver_scan,
            "a receiver scan must not delete a writer's staged request"
        );
        assert!(
            stage_survived_acquirer_sweep,
            "an acquirer sweep must not delete a live writer's staged request"
        );
        assert!(
            unknown_removed,
            "an unrecognized artifact inside the watched lane must still fail soft"
        );
        assert!(
            wrong_extension_removed,
            "a UUID-valid stem with a non-JSON extension must still fail soft"
        );
        write_result.unwrap();

        assert_eq!(
            pending_requests(registry.path(), 1_100).unwrap(),
            vec![request]
        );
    }

    #[test]
    fn a_wedged_owner_fails_at_the_deadline_without_leaving_a_request() {
        let registry = tempfile::TempDir::new().unwrap();
        let clock = ManualClock::at(2_000);

        let terminal = request_and_wait_with(
            registry.path(),
            "requester-a",
            2_000,
            Duration::from_millis(100),
            &clock,
            |_, remaining| {
                assert_eq!(remaining, Duration::from_millis(100));
                clock.set(2_100);
                Ok(())
            },
        );

        assert_eq!(
            terminal,
            TerminalDisposition::Failed(RouteFailure::DeadlineExpired)
        );
        assert!(tree(registry.path())
            .iter()
            .all(|path| !path.ends_with(".json")));
    }

    #[test]
    fn the_wait_budget_is_measured_from_the_users_ask() {
        let registry = tempfile::TempDir::new().unwrap();
        let clock = ManualClock::at(3_090);
        let mut observed = None;

        let terminal = request_and_wait_with(
            registry.path(),
            "requester-a",
            3_000,
            Duration::from_millis(100),
            &clock,
            |_, remaining| {
                observed = Some(remaining);
                clock.set(3_100);
                Ok(())
            },
        );

        assert_eq!(observed, Some(Duration::from_millis(10)));
        assert!(matches!(terminal, TerminalDisposition::Failed(_)));
    }

    #[test]
    fn an_already_expired_request_is_never_published_or_performed() {
        let registry = tempfile::TempDir::new().unwrap();
        let clock = ManualClock::at(4_101);
        let mut waited = false;

        let terminal = request_and_wait_with(
            registry.path(),
            "requester-a",
            4_000,
            Duration::from_millis(100),
            &clock,
            |_, _| {
                waited = true;
                Ok(())
            },
        );

        assert_eq!(
            terminal,
            TerminalDisposition::Failed(RouteFailure::DeadlineExpired)
        );
        assert!(!waited);
        assert!(tree(registry.path()).is_empty());
    }

    #[test]
    fn an_owner_that_reads_an_expired_request_performs_nothing() {
        let registry = tempfile::TempDir::new().unwrap();
        let clock = ManualClock::at(5_000);
        let mut action_ran = false;

        let terminal = request_and_wait_with(
            registry.path(),
            "requester-a",
            5_000,
            Duration::from_millis(100),
            &clock,
            |request, _| {
                clock.set(5_101);
                assert_eq!(
                    answer_request(
                        registry.path(),
                        request.request_id,
                        RouteSuccess::Opened,
                        &clock,
                        || {
                            action_ran = true;
                            Ok(())
                        },
                    )?,
                    AnswerStatus::Expired
                );
                Ok(())
            },
        );

        assert!(matches!(terminal, TerminalDisposition::Failed(_)));
        assert!(!action_ran);
    }

    #[test]
    fn the_final_read_accepts_an_on_time_ack_even_when_its_notification_arrives_after_expiry() {
        let registry = tempfile::TempDir::new().unwrap();
        let clock = ManualClock::at(6_000);

        let terminal = request_and_wait_with(
            registry.path(),
            "requester-a",
            6_000,
            Duration::from_millis(100),
            &clock,
            |request, _| {
                clock.set(6_099);
                answer_request(
                    registry.path(),
                    request.request_id,
                    RouteSuccess::Opened,
                    &clock,
                    || Ok(()),
                )?;
                clock.set(6_101);
                Ok(())
            },
        );

        assert_eq!(terminal, TerminalDisposition::Opened);
    }

    #[test]
    fn a_late_ack_is_not_mistaken_for_fulfilment() {
        let registry = tempfile::TempDir::new().unwrap();
        let clock = ManualClock::at(7_000);

        let terminal = request_and_wait_with(
            registry.path(),
            "requester-a",
            7_000,
            Duration::from_millis(100),
            &clock,
            |request, _| {
                answer_request(
                    registry.path(),
                    request.request_id,
                    RouteSuccess::Focused,
                    &clock,
                    || {
                        clock.set(7_101);
                        Ok(())
                    },
                )?;
                Ok(())
            },
        );

        assert_eq!(
            terminal,
            TerminalDisposition::Failed(RouteFailure::DeadlineExpired)
        );
    }

    #[test]
    fn corrupt_request_and_outcome_json_fail_soft_without_extending_the_deadline() {
        let registry = tempfile::TempDir::new().unwrap();
        let clock = ManualClock::at(8_000);

        let terminal = request_and_wait_with(
            registry.path(),
            "requester-a",
            8_000,
            Duration::from_millis(100),
            &clock,
            |request, _| {
                fs::write(
                    registry
                        .path()
                        .join("outcomes")
                        .join(format!("{}.json", request.request_id)),
                    b"{truncated",
                )?;
                clock.set(8_100);
                Ok(())
            },
        );

        assert_eq!(
            terminal,
            TerminalDisposition::Failed(RouteFailure::DeadlineExpired)
        );

        fs::create_dir_all(registry.path().join("requests")).unwrap();
        fs::write(registry.path().join("requests/corrupt.json"), b"nope").unwrap();
        let receiver = RequestReceiver::watch(registry.path()).unwrap();
        assert_eq!(
            receiver
                .recv_timeout(registry.path(), &clock, Duration::ZERO)
                .unwrap(),
            None
        );
        assert!(!registry.path().join("requests/corrupt.json").exists());
    }

    #[test]
    fn an_acquirer_sweep_leaves_only_sanctioned_registry_artifacts() {
        let registry_root = tempfile::TempDir::new().unwrap();
        let project = tempfile::TempDir::new().unwrap();
        let registry = lock::registry_dir(registry_root.path(), project.path());
        fs::create_dir_all(registry.join("requests")).unwrap();
        fs::create_dir_all(registry.join("outcomes")).unwrap();
        fs::create_dir_all(registry.join(lock::REQUEST_STAGING_DIR_NAME)).unwrap();
        fs::write(registry.join("lock"), b"").unwrap();
        fs::write(registry.join("requests/orphan.tmp"), b"partial").unwrap();
        fs::write(registry.join("outcomes/corrupt.json"), b"nope").unwrap();
        fs::write(registry.join("unknown-runtime-file"), b"stale").unwrap();
        let crash_left_stage = registry
            .join(lock::REQUEST_STAGING_DIR_NAME)
            .join("00000000-0000-0000-0000-000000000001.json.tmp");
        fs::write(&crash_left_stage, b"crash-left request publication").unwrap();
        let unrecognized_stage = registry
            .join(lock::REQUEST_STAGING_DIR_NAME)
            .join("unrecognized.tmp");
        fs::write(&unrecognized_stage, b"unsanctioned inner-lane artifact").unwrap();
        fs::create_dir_all(
            registry
                .join(lock::REQUEST_STAGING_DIR_NAME)
                .join("abandoned-directory/nested"),
        )
        .unwrap();
        let expired_id = Uuid::new_v4();
        lock::write_rendezvous_request(
            &registry,
            &RouteRequest {
                schema_version: lock::RENDEZVOUS_SCHEMA_VERSION,
                request_id: expired_id,
                requester_instance_id: "gone".to_string(),
                asked_at_ms: 8_000,
                deadline_at_ms: 8_500,
            },
        )
        .unwrap();
        lock::write_rendezvous_outcome_once(
            &registry,
            &RendezvousOutcome {
                schema_version: lock::RENDEZVOUS_SCHEMA_VERSION,
                request_id: expired_id,
                completed_at_ms: 8_100,
                deadline_at_ms: 8_500,
                outcome: RouteSuccess::Opened,
            },
        )
        .unwrap();

        let instance_registry = super::super::InstanceRegistry::with_identity_and_clock(
            registry_root.path(),
            "next-acquirer",
            std::sync::Arc::new(ManualClock::at(9_000)),
        );
        let action = super::super::resolve(
            project.path(),
            super::super::SelfState::Empty,
            &instance_registry,
        )
        .unwrap();
        let super::super::Action::AdoptHere { ownership, .. } = action else {
            panic!("the next process should acquire the free registry");
        };

        assert!(
            !crash_left_stage.exists(),
            "an abandoned canonical staging request must be reclaimed"
        );
        assert!(
            !unrecognized_stage.exists(),
            "an unrecognized inner-lane staging artifact must be reclaimed"
        );
        assert_eq!(
            tree(&registry),
            vec![
                ".request-staging".to_string(),
                ".request-staging/publication.lock".to_string(),
                "lock".to_string(),
                "outcomes".to_string(),
                "owner.json".to_string(),
                "requests".to_string(),
            ]
        );
        drop(ownership);
    }

    #[test]
    fn dead_project_registry_sweep_uses_the_recorded_root_and_respects_a_live_lock() {
        let app_data = tempfile::TempDir::new().unwrap();
        let dead_project = tempfile::TempDir::new().unwrap();
        let dead_root = dead_project.path().to_path_buf();
        let dead_registry = lock::registry_dir(app_data.path(), &dead_root);
        fs::create_dir_all(&dead_registry).unwrap();
        fs::write(dead_registry.join("lock"), b"").unwrap();
        fs::write(
            dead_registry.join("owner.json"),
            serde_json::to_vec(&lock::LockOwner::new("dead", &dead_root)).unwrap(),
        )
        .unwrap();
        drop(dead_project);

        let live_project = tempfile::TempDir::new().unwrap();
        let live_root = live_project.path().to_path_buf();
        let live_registry = lock::registry_dir(app_data.path(), &live_root);
        let live_guard =
            match lock::probe(&live_registry, &lock::LockOwner::new("live", &live_root)).unwrap() {
                lock::LockOutcome::Acquired(guard) => guard,
                _ => panic!("fixture should acquire"),
            };
        fs::remove_dir_all(&live_root).unwrap();

        let registry = super::super::InstanceRegistry::with_identity_and_clock(
            app_data.path(),
            "sweeper",
            std::sync::Arc::new(ManualClock::at(10_000)),
        );
        assert_eq!(registry.sweep_dead_project_registries().unwrap(), 1);
        assert!(!dead_registry.exists());
        assert!(live_registry.exists(), "a held registry is never reclaimed");

        drop(live_guard);
    }
}
