// ABOUTME: App-scoped project-open request serialization and observer announcements (TD-20(8)/(9)).
// ABOUTME: Same-root requests join; other roots retain FIFO order and ask-time deadlines.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::time::Duration;

use serde::Serialize;
use uuid::Uuid;

use super::activator::{
    request_owner_focus, OwnerActivationService, OwnerWindow, RequesterActivation,
    SystemRequesterActivation,
};
use super::{
    request_and_wait_after_publish, resolve, Action, Clock, DetachedLauncher, InstanceRegistry,
    Launcher, RouteFailure, SelfState, SystemClock, TerminalDisposition,
};
use crate::agent::project::{OpenProject, ProjectObservers, ProjectRoutingSession};
use crate::store::lock;
use crate::store::project_identity;

pub const PROJECT_ROUTE_RAISE_BUDGET: Duration = Duration::from_secs(3);
pub const PROJECT_ROUTE_LAUNCH_BUDGET: Duration = Duration::from_secs(20);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
// @anchor:project-failure-route-values
pub enum ProjectFailureRoute {
    Undetermined,
    Raise,
    Launch,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ProjectRouteOutcome {
    AdoptedHere {
        root: String,
    },
    AlreadyOpenHere {
        root: String,
    },
    FocusedOther {
        root: String,
    },
    OpenedNew {
        root: String,
    },
    Failed {
        root: String,
        reason: RouteFailure,
        #[serde(rename = "failureRoute")]
        failure_route: ProjectFailureRoute,
    },
}

impl ProjectRouteOutcome {
    /// Failures reached before a raise or launch is selected cannot truthfully name either route.
    pub fn failed_undetermined(root: String, reason: RouteFailure) -> Self {
        Self::Failed {
            root,
            reason,
            failure_route: ProjectFailureRoute::Undetermined,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ProjectRoutingNotice {
    Requesting {
        request_id: Uuid,
        root: String,
        queued: usize,
    },
    Finished {
        request_id: Uuid,
        outcome: ProjectRouteOutcome,
    },
}

pub trait ProjectRoutingObserver: Send + Sync {
    fn announce(&self, notice: ProjectRoutingNotice);
}

trait RouteOperation: Send + Sync {
    fn canonicalize(&self, chosen_root: &Path) -> Result<PathBuf, RouteFailure>;
    fn perform(
        &self,
        canonical_root: &Path,
        asked_at_ms: i64,
        clock: &dyn Clock,
    ) -> ProjectRouteOutcome;
}

pub struct ProjectRouter {
    operation: Arc<dyn RouteOperation>,
    observer: Arc<dyn ProjectRoutingObserver>,
    clock: Arc<dyn Clock>,
    launch_budget: Duration,
    state: Mutex<RouterState>,
    changed: Condvar,
}

#[derive(Default)]
struct RouterState {
    active: Option<Arc<RouteTask>>,
    queued: VecDeque<Arc<RouteTask>>,
}

struct RouteTask {
    request_id: Uuid,
    display_root: String,
    canonical_root: Result<PathBuf, RouteFailure>,
    asked_at_ms: i64,
    deadline_at_ms: i64,
    started: AtomicBool,
    followers: AtomicUsize,
    result: Mutex<Option<ProjectRouteOutcome>>,
}

impl RouteTask {
    fn matches(&self, canonical_root: &Result<PathBuf, RouteFailure>) -> bool {
        matches!((&self.canonical_root, canonical_root), (Ok(left), Ok(right)) if left == right)
    }
}

impl ProjectRouter {
    pub(crate) fn production(
        registry: Arc<InstanceRegistry>,
        session: ProjectRoutingSession,
        app_local_data_dir: PathBuf,
        project_observers: ProjectObservers,
        observer: Arc<dyn ProjectRoutingObserver>,
        owner_window: Arc<dyn OwnerWindow + Send + Sync>,
    ) -> std::io::Result<Self> {
        let operation = Arc::new(ProjectRouteOperation {
            registry,
            session,
            app_local_data_dir,
            project_observers,
            launcher: Arc::new(DetachedLauncher::current()?),
            activation: Arc::new(SystemRequesterActivation),
            owner_window,
            raise_budget: PROJECT_ROUTE_RAISE_BUDGET,
            launch_budget: PROJECT_ROUTE_LAUNCH_BUDGET,
        });
        Ok(Self {
            operation,
            observer,
            clock: Arc::new(SystemClock),
            launch_budget: PROJECT_ROUTE_LAUNCH_BUDGET,
            state: Mutex::new(RouterState::default()),
            changed: Condvar::new(),
        })
    }

    #[cfg(test)]
    fn with_operation(
        operation: Arc<dyn RouteOperation>,
        observer: Arc<dyn ProjectRoutingObserver>,
        clock: Arc<dyn Clock>,
        launch_budget: Duration,
    ) -> Self {
        Self {
            operation,
            observer,
            clock,
            launch_budget,
            state: Mutex::new(RouterState::default()),
            changed: Condvar::new(),
        }
    }

    pub fn route(&self, chosen_root: &Path) -> ProjectRouteOutcome {
        let asked_at_ms = self.clock.now_ms();
        let canonical_root = self.operation.canonicalize(chosen_root);
        // Canonical paths are routing identity, not presentation. In particular, Windows
        // `canonicalize` may add a `\\?\` namespace prefix that the chooser never supplied and the
        // web shell must not adopt as its project spelling.
        let display_root = chosen_root.to_string_lossy().into_owned();
        let (task, joined) = {
            let mut state = lock(&self.state);
            if let Some(task) = state
                .active
                .iter()
                .chain(state.queued.iter())
                .find(|task| task.matches(&canonical_root))
            {
                (Arc::clone(task), true)
            } else {
                let task = Arc::new(RouteTask {
                    request_id: Uuid::new_v4(),
                    display_root,
                    canonical_root,
                    asked_at_ms,
                    deadline_at_ms: deadline_from_ask(asked_at_ms, self.launch_budget),
                    started: AtomicBool::new(false),
                    followers: AtomicUsize::new(0),
                    result: Mutex::new(None),
                });
                if let Some(active) = state.active.as_ref().map(Arc::clone) {
                    state.queued.push_back(Arc::clone(&task));
                    self.announce_requesting(&active, state.queued.len());
                } else {
                    state.active = Some(Arc::clone(&task));
                    self.announce_requesting(&task, 0);
                }
                (task, false)
            }
        };

        if joined {
            task.followers.fetch_add(1, Ordering::AcqRel);
            self.changed.notify_all();
        }

        self.wait_or_run(task)
    }

    fn wait_or_run(&self, task: Arc<RouteTask>) -> ProjectRouteOutcome {
        loop {
            let mut state = lock(&self.state);
            if let Some(result) = lock(&task.result).clone() {
                return result;
            }
            let is_active = state
                .active
                .as_ref()
                .is_some_and(|active| active.request_id == task.request_id);
            if is_active && !task.started.swap(true, Ordering::AcqRel) {
                drop(state);
                let outcome = self.perform_task(&task);
                let mut state = lock(&self.state);
                *lock(&task.result) = Some(outcome.clone());
                self.observer.announce(ProjectRoutingNotice::Finished {
                    request_id: task.request_id,
                    outcome: outcome.clone(),
                });
                state.active = state.queued.pop_front();
                if let Some(active) = state.active.as_ref() {
                    self.announce_requesting(active, state.queued.len());
                }
                self.changed.notify_all();
                return outcome;
            }
            state = self
                .changed
                .wait(state)
                .unwrap_or_else(PoisonError::into_inner);
            drop(state);
        }
    }

    fn perform_task(&self, task: &RouteTask) -> ProjectRouteOutcome {
        let root = match &task.canonical_root {
            Ok(root) => root,
            Err(reason) => {
                return ProjectRouteOutcome::failed_undetermined(task.display_root.clone(), *reason)
            }
        };
        if self.clock.now_ms() >= task.deadline_at_ms {
            return ProjectRouteOutcome::failed_undetermined(
                task.display_root.clone(),
                RouteFailure::DeadlineExpired,
            );
        }
        with_display_root(
            self.operation
                .perform(root, task.asked_at_ms, self.clock.as_ref()),
            &task.display_root,
        )
    }

    /// Publishes the complete scalar J9 status: the operation that owns the status region now,
    /// plus how many distinct targets wait behind it. Enqueueing therefore re-announces the
    /// active task rather than presenting the queued target as though it had started; after a
    /// terminal outcome the successor receives its first active announcement before it can run.
    fn announce_requesting(&self, active: &RouteTask, queued: usize) {
        self.observer.announce(ProjectRoutingNotice::Requesting {
            request_id: active.request_id,
            root: active.display_root.clone(),
            queued,
        });
    }

    #[cfg(test)]
    fn wait_for_followers(&self, count: usize) {
        let mut state = lock(&self.state);
        while state
            .active
            .as_ref()
            .map_or(0, |task| task.followers.load(Ordering::Acquire))
            < count
        {
            state = self
                .changed
                .wait(state)
                .unwrap_or_else(PoisonError::into_inner);
        }
    }
}

fn with_display_root(outcome: ProjectRouteOutcome, root: &str) -> ProjectRouteOutcome {
    match outcome {
        ProjectRouteOutcome::AdoptedHere { .. } => ProjectRouteOutcome::AdoptedHere {
            root: root.to_string(),
        },
        ProjectRouteOutcome::AlreadyOpenHere { .. } => ProjectRouteOutcome::AlreadyOpenHere {
            root: root.to_string(),
        },
        ProjectRouteOutcome::FocusedOther { .. } => ProjectRouteOutcome::FocusedOther {
            root: root.to_string(),
        },
        ProjectRouteOutcome::OpenedNew { .. } => ProjectRouteOutcome::OpenedNew {
            root: root.to_string(),
        },
        ProjectRouteOutcome::Failed {
            reason,
            failure_route,
            ..
        } => ProjectRouteOutcome::Failed {
            root: root.to_string(),
            reason,
            failure_route,
        },
    }
}

fn deadline_from_ask(asked_at_ms: i64, budget: Duration) -> i64 {
    asked_at_ms.saturating_add(budget.as_millis().min(i64::MAX as u128) as i64)
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

struct ProjectRouteOperation {
    registry: Arc<InstanceRegistry>,
    session: ProjectRoutingSession,
    app_local_data_dir: PathBuf,
    project_observers: ProjectObservers,
    launcher: Arc<dyn Launcher>,
    activation: Arc<dyn RequesterActivation + Send + Sync>,
    owner_window: Arc<dyn OwnerWindow + Send + Sync>,
    raise_budget: Duration,
    launch_budget: Duration,
}

impl ProjectRouteOperation {
    fn outcome(
        root: &Path,
        disposition: TerminalDisposition,
        expected: TerminalDisposition,
        failure_route: ProjectFailureRoute,
    ) -> ProjectRouteOutcome {
        let root = root.to_string_lossy().into_owned();
        match (disposition, expected) {
            (TerminalDisposition::Focused, TerminalDisposition::Focused) => {
                ProjectRouteOutcome::FocusedOther { root }
            }
            (TerminalDisposition::Opened, TerminalDisposition::Opened) => {
                ProjectRouteOutcome::OpenedNew { root }
            }
            (TerminalDisposition::Failed(reason), _) => ProjectRouteOutcome::Failed {
                root,
                reason,
                failure_route,
            },
            _ => ProjectRouteOutcome::Failed {
                root,
                reason: RouteFailure::RegistryUnavailable,
                failure_route,
            },
        }
    }

    fn adopt(
        &self,
        root: &Path,
        ownership: crate::store::lock::ProjectLockGuard,
        asked_at_ms: i64,
        clock: &dyn Clock,
    ) -> ProjectRouteOutcome {
        let root_text = root.to_string_lossy().into_owned();
        let mut project = match OpenProject::open_owning_persisting_provider_session(
            root,
            ownership,
            &self.app_local_data_dir,
            self.project_observers.clone(),
        ) {
            Ok(project) => project,
            Err(_) => {
                return ProjectRouteOutcome::failed_undetermined(
                    root_text,
                    RouteFailure::OpenFailed,
                )
            }
        };
        if clock.now_ms() >= deadline_from_ask(asked_at_ms, self.launch_budget) {
            return ProjectRouteOutcome::failed_undetermined(
                root_text,
                RouteFailure::DeadlineExpired,
            );
        }
        let registry_dir = lock::registry_dir(&self.app_local_data_dir, root);
        let service =
            match OwnerActivationService::start(registry_dir, Arc::clone(&self.owner_window)) {
                Ok(service) => service,
                Err(_) => {
                    return ProjectRouteOutcome::failed_undetermined(
                        root_text,
                        RouteFailure::RegistryUnavailable,
                    )
                }
            };
        if !project.install_owner_activation(service) {
            return ProjectRouteOutcome::failed_undetermined(
                root_text,
                RouteFailure::RegistryUnavailable,
            );
        }
        if !self.session.adopt_if_empty(project) {
            return ProjectRouteOutcome::failed_undetermined(
                root_text,
                RouteFailure::RegistryUnavailable,
            );
        }
        ProjectRouteOutcome::AdoptedHere { root: root_text }
    }
}

impl RouteOperation for ProjectRouteOperation {
    fn canonicalize(&self, chosen_root: &Path) -> Result<PathBuf, RouteFailure> {
        project_identity::require_canonical_root(chosen_root)
            .map_err(|_| RouteFailure::ProjectUnavailable)
    }

    fn perform(
        &self,
        canonical_root: &Path,
        asked_at_ms: i64,
        clock: &dyn Clock,
    ) -> ProjectRouteOutcome {
        let current_root = self.session.current_root();
        let self_state = current_root
            .as_deref()
            .map(SelfState::Holding)
            .unwrap_or(SelfState::Empty);
        let action = match resolve(canonical_root, self_state, &self.registry) {
            Ok(action) => action,
            Err(_) => {
                return ProjectRouteOutcome::failed_undetermined(
                    canonical_root.to_string_lossy().into_owned(),
                    RouteFailure::RegistryUnavailable,
                )
            }
        };

        match action {
            Action::AlreadyOpenHere { root } => ProjectRouteOutcome::AlreadyOpenHere {
                root: root.to_string_lossy().into_owned(),
            },
            Action::AdoptHere { root, ownership } => {
                self.adopt(&root, ownership, asked_at_ms, clock)
            }
            Action::Raise { root, owner } => {
                let disposition = owner.map_or(
                    TerminalDisposition::Failed(RouteFailure::OwnerUnavailable),
                    |owner| {
                        request_owner_focus(
                            &lock::registry_dir(&self.app_local_data_dir, &root),
                            self.registry.identity().as_str(),
                            &owner,
                            asked_at_ms,
                            self.raise_budget,
                            clock,
                            self.activation.as_ref(),
                        )
                    },
                );
                Self::outcome(
                    &root,
                    disposition,
                    TerminalDisposition::Focused,
                    ProjectFailureRoute::Raise,
                )
            }
            Action::Launch { root } => {
                let disposition = request_and_wait_after_publish(
                    &lock::registry_dir(&self.app_local_data_dir, &root),
                    self.registry.identity().as_str(),
                    asked_at_ms,
                    self.launch_budget,
                    clock,
                    |request| self.launcher.launch(&root, request.request_id),
                );
                Self::outcome(
                    &root,
                    disposition,
                    TerminalDisposition::Opened,
                    ProjectFailureRoute::Launch,
                )
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::io;
    use std::sync::atomic::{AtomicI64, Ordering};
    use std::sync::{mpsc, Arc, Condvar, Mutex, PoisonError};
    use std::thread;

    use super::*;
    use crate::agent::project::SharedOpenProject;

    struct TestClock(AtomicI64);

    impl TestClock {
        fn new(now_ms: i64) -> Self {
            Self(AtomicI64::new(now_ms))
        }

        fn set(&self, now_ms: i64) {
            self.0.store(now_ms, Ordering::SeqCst);
        }
    }

    impl Clock for TestClock {
        fn now_ms(&self) -> i64 {
            self.0.load(Ordering::SeqCst)
        }
    }

    #[derive(Default)]
    struct RecordingObserver {
        notices: Mutex<Vec<ProjectRoutingNotice>>,
        changed: Condvar,
    }

    impl RecordingObserver {
        fn wait_for_count(&self, count: usize) {
            let mut notices = self.notices.lock().unwrap();
            while notices.len() < count {
                notices = self.changed.wait(notices).unwrap();
            }
        }
    }

    impl ProjectRoutingObserver for RecordingObserver {
        fn announce(&self, notice: ProjectRoutingNotice) {
            self.notices
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(notice);
            self.changed.notify_all();
        }
    }

    struct ControlledOperation {
        calls: Mutex<Vec<PathBuf>>,
        outcomes: Mutex<VecDeque<ProjectRouteOutcome>>,
        first_started: Mutex<Option<mpsc::Sender<()>>>,
        release_first: (Mutex<bool>, Condvar),
    }

    impl ControlledOperation {
        fn new(outcomes: Vec<ProjectRouteOutcome>, first_started: mpsc::Sender<()>) -> Self {
            Self {
                calls: Mutex::new(Vec::new()),
                outcomes: Mutex::new(outcomes.into()),
                first_started: Mutex::new(Some(first_started)),
                release_first: (Mutex::new(false), Condvar::new()),
            }
        }

        fn release_first(&self) {
            *self.release_first.0.lock().unwrap() = true;
            self.release_first.1.notify_all();
        }
    }

    impl RouteOperation for ControlledOperation {
        fn canonicalize(&self, chosen_root: &Path) -> Result<PathBuf, RouteFailure> {
            Ok(chosen_root
                .canonicalize()
                .unwrap_or_else(|_| chosen_root.to_path_buf()))
        }

        fn perform(
            &self,
            canonical_root: &Path,
            _asked_at_ms: i64,
            _clock: &dyn Clock,
        ) -> ProjectRouteOutcome {
            let call_index = {
                let mut calls = self.calls.lock().unwrap();
                calls.push(canonical_root.to_path_buf());
                calls.len()
            };
            if call_index == 1 {
                if let Some(started) = self.first_started.lock().unwrap().take() {
                    started.send(()).unwrap();
                }
                let (released, ready) = &self.release_first;
                let mut released = released.lock().unwrap();
                while !*released {
                    released = ready.wait(released).unwrap();
                }
            }
            self.outcomes.lock().unwrap().pop_front().unwrap()
        }
    }

    fn opened(root: &str) -> ProjectRouteOutcome {
        ProjectRouteOutcome::OpenedNew {
            root: root.to_string(),
        }
    }

    struct AnsweringLauncher {
        app_data: PathBuf,
        clock: Arc<dyn Clock>,
    }

    impl Launcher for AnsweringLauncher {
        fn launch(&self, project_root: &Path, request_id: Uuid) -> io::Result<()> {
            crate::instances::answer_request(
                &lock::registry_dir(&self.app_data, project_root),
                request_id,
                crate::instances::RouteSuccess::Opened,
                self.clock.as_ref(),
                || Ok(()),
            )?;
            Ok(())
        }
    }

    struct AllowingActivation;

    impl RequesterActivation for AllowingActivation {
        fn platform(&self) -> super::super::activator::RequesterPlatform {
            super::super::activator::RequesterPlatform::Windows
        }

        fn owner_is_live_cowrite(&self, _owner: &crate::store::lock::LockOwner) -> bool {
            true
        }

        fn establish_entitlement(&self, _owner: &crate::store::lock::LockOwner) -> io::Result<()> {
            Ok(())
        }
    }

    struct VisibleWindow;

    impl OwnerWindow for VisibleWindow {
        fn unminimize(&self) -> io::Result<()> {
            Ok(())
        }

        fn show_if_needed(&self) -> io::Result<()> {
            Ok(())
        }

        fn set_focus(&self) -> io::Result<()> {
            Ok(())
        }

        fn is_minimized(&self) -> io::Result<bool> {
            Ok(false)
        }

        fn is_focused(&self) -> io::Result<bool> {
            Ok(true)
        }
    }

    fn routed_test_service(
        app_data: &Path,
        identity: &str,
        session: SharedOpenProject,
        clock: Arc<dyn Clock>,
    ) -> ProjectRouter {
        let registry = Arc::new(InstanceRegistry::with_identity_and_clock(
            app_data,
            identity,
            clock.clone(),
        ));
        let operation = Arc::new(ProjectRouteOperation {
            registry,
            session: ProjectRoutingSession::new(session),
            app_local_data_dir: app_data.to_path_buf(),
            project_observers: ProjectObservers::default(),
            launcher: Arc::new(AnsweringLauncher {
                app_data: app_data.to_path_buf(),
                clock: clock.clone(),
            }),
            activation: Arc::new(AllowingActivation),
            owner_window: Arc::new(VisibleWindow),
            raise_budget: PROJECT_ROUTE_RAISE_BUDGET,
            launch_budget: PROJECT_ROUTE_LAUNCH_BUDGET,
        });
        ProjectRouter::with_operation(
            operation,
            Arc::new(RecordingObserver::default()),
            clock,
            PROJECT_ROUTE_LAUNCH_BUDGET,
        )
    }

    #[test]
    fn repeat_same_target_joins_one_operation_and_one_outcome() {
        let (started_tx, started_rx) = mpsc::channel();
        let operation = Arc::new(ControlledOperation::new(vec![opened("alpha")], started_tx));
        let observer = Arc::new(RecordingObserver::default());
        let clock = Arc::new(TestClock::new(1_000));
        let router = Arc::new(ProjectRouter::with_operation(
            operation.clone(),
            observer.clone(),
            clock,
            Duration::from_secs(20),
        ));

        let first = {
            let router = router.clone();
            thread::spawn(move || router.route(Path::new("alpha")))
        };
        started_rx.recv().unwrap();
        let second = {
            let router = router.clone();
            thread::spawn(move || router.route(Path::new("alpha")))
        };
        router.wait_for_followers(1);
        operation.release_first();

        assert_eq!(first.join().unwrap(), opened("alpha"));
        assert_eq!(second.join().unwrap(), opened("alpha"));
        assert_eq!(
            operation.calls.lock().unwrap().as_slice(),
            [PathBuf::from("alpha")]
        );
        assert_eq!(observer.notices.lock().unwrap().len(), 2);
    }

    #[test]
    fn identity_equivalent_target_spellings_join_before_routing() {
        let project = tempfile::TempDir::new().unwrap();
        std::fs::create_dir(project.path().join("sub")).unwrap();
        let alternate = project.path().join("sub").join("..");
        let canonical = project.path().canonicalize().unwrap();
        let operation_outcome = opened(&canonical.to_string_lossy());
        let expected = opened(&project.path().to_string_lossy());
        let (started_tx, started_rx) = mpsc::channel();
        let operation = Arc::new(ControlledOperation::new(
            vec![operation_outcome],
            started_tx,
        ));
        let observer = Arc::new(RecordingObserver::default());
        let router = Arc::new(ProjectRouter::with_operation(
            operation.clone(),
            observer,
            Arc::new(TestClock::new(1_000)),
            Duration::from_secs(20),
        ));

        let first = {
            let router = router.clone();
            let root = project.path().to_path_buf();
            thread::spawn(move || router.route(&root))
        };
        started_rx.recv().unwrap();
        let second = {
            let router = router.clone();
            thread::spawn(move || router.route(&alternate))
        };
        router.wait_for_followers(1);
        operation.release_first();

        assert_eq!(first.join().unwrap(), expected);
        assert_eq!(second.join().unwrap(), expected);
        assert_eq!(operation.calls.lock().unwrap().as_slice(), [canonical]);
    }

    #[test]
    fn different_targets_keep_fifo_order_and_expire_before_their_turn_without_an_effect() {
        let (started_tx, started_rx) = mpsc::channel();
        let operation = Arc::new(ControlledOperation::new(
            vec![opened("alpha"), opened("beta")],
            started_tx,
        ));
        let observer = Arc::new(RecordingObserver::default());
        let clock = Arc::new(TestClock::new(10_000));
        let router = Arc::new(ProjectRouter::with_operation(
            operation.clone(),
            observer.clone(),
            clock.clone(),
            Duration::from_millis(100),
        ));

        let first = {
            let router = router.clone();
            thread::spawn(move || router.route(Path::new("alpha")))
        };
        started_rx.recv().unwrap();
        let second = {
            let router = router.clone();
            thread::spawn(move || router.route(Path::new("beta")))
        };
        observer.wait_for_count(2);
        clock.set(10_101);
        operation.release_first();

        assert_eq!(first.join().unwrap(), opened("alpha"));
        assert_eq!(
            second.join().unwrap(),
            ProjectRouteOutcome::Failed {
                root: "beta".to_string(),
                reason: RouteFailure::DeadlineExpired,
                failure_route: ProjectFailureRoute::Undetermined,
            }
        );
        assert_eq!(
            operation.calls.lock().unwrap().as_slice(),
            [PathBuf::from("alpha")]
        );
        let notices = observer.notices.lock().unwrap();
        assert!(matches!(
            notices[0],
            ProjectRoutingNotice::Requesting {
                ref root,
                queued: 0,
                ..
            } if root == "alpha"
        ));
        assert!(matches!(
            notices[1],
            ProjectRoutingNotice::Requesting {
                ref root,
                queued: 1,
                ..
            } if root == "alpha"
        ));
        assert!(
            matches!(notices[2], ProjectRoutingNotice::Finished { ref outcome, .. } if *outcome == opened("alpha"))
        );
        assert!(matches!(
            notices[3],
            ProjectRoutingNotice::Requesting {
                ref root,
                queued: 0,
                ..
            } if root == "beta"
        ));
        assert!(
            matches!(notices[4], ProjectRoutingNotice::Finished { ref outcome, .. } if matches!(outcome, ProjectRouteOutcome::Failed { reason: RouteFailure::DeadlineExpired, .. }))
        );
    }

    #[test]
    fn three_interleaved_targets_finish_in_request_order() {
        let (started_tx, started_rx) = mpsc::channel();
        let operation = Arc::new(ControlledOperation::new(
            vec![opened("alpha"), opened("beta"), opened("gamma")],
            started_tx,
        ));
        let observer = Arc::new(RecordingObserver::default());
        let clock = Arc::new(TestClock::new(20_000));
        let router = Arc::new(ProjectRouter::with_operation(
            operation.clone(),
            observer.clone(),
            clock,
            Duration::from_secs(20),
        ));

        let first = {
            let router = router.clone();
            thread::spawn(move || router.route(Path::new("alpha")))
        };
        started_rx.recv().unwrap();
        let second = {
            let router = router.clone();
            thread::spawn(move || router.route(Path::new("beta")))
        };
        observer.wait_for_count(2);
        let third = {
            let router = router.clone();
            thread::spawn(move || router.route(Path::new("gamma")))
        };
        observer.wait_for_count(3);
        operation.release_first();

        assert_eq!(first.join().unwrap(), opened("alpha"));
        assert_eq!(second.join().unwrap(), opened("beta"));
        assert_eq!(third.join().unwrap(), opened("gamma"));
        assert_eq!(
            operation.calls.lock().unwrap().as_slice(),
            [
                PathBuf::from("alpha"),
                PathBuf::from("beta"),
                PathBuf::from("gamma")
            ]
        );
        let notices = observer.notices.lock().unwrap();
        let finished = notices
            .iter()
            .filter_map(|notice| match notice {
                ProjectRoutingNotice::Finished { outcome, .. } => Some(outcome.clone()),
                ProjectRoutingNotice::Requesting { .. } => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            finished,
            vec![opened("alpha"), opened("beta"), opened("gamma")]
        );
        assert_eq!(notices.len(), 8);
        let requesting = |index, expected_root: &str, expected_queued| match &notices[index] {
            ProjectRoutingNotice::Requesting {
                request_id,
                root,
                queued,
            } => {
                assert_eq!(root, expected_root);
                assert_eq!(*queued, expected_queued);
                *request_id
            }
            notice => panic!("expected requesting notice at {index}, got {notice:?}"),
        };
        let finished_id = |index| match &notices[index] {
            ProjectRoutingNotice::Finished { request_id, .. } => *request_id,
            notice => panic!("expected finished notice at {index}, got {notice:?}"),
        };
        let alpha_id = requesting(0, "alpha", 0);
        assert_eq!(requesting(1, "alpha", 1), alpha_id);
        assert_eq!(requesting(2, "alpha", 2), alpha_id);
        assert_eq!(finished_id(3), alpha_id);
        let beta_id = requesting(4, "beta", 1);
        assert_eq!(finished_id(5), beta_id);
        let gamma_id = requesting(6, "gamma", 0);
        assert_eq!(finished_id(7), gamma_id);
    }

    #[test]
    fn routing_notice_serialization_is_the_frontend_contract() {
        let request_id = Uuid::parse_str("eb9fa3bb-28f6-46b7-a403-dd5205fb7fe8").unwrap();
        assert_eq!(
            serde_json::to_value(ProjectRoutingNotice::Requesting {
                request_id,
                root: "C:/project".to_string(),
                queued: 2,
            })
            .unwrap(),
            serde_json::json!({
                "status": "requesting",
                "request_id": "eb9fa3bb-28f6-46b7-a403-dd5205fb7fe8",
                "root": "C:/project",
                "queued": 2
            })
        );
        assert_eq!(
            serde_json::to_value(ProjectRouteOutcome::Failed {
                root: "C:/project".to_string(),
                reason: RouteFailure::ActivationRefused,
                failure_route: ProjectFailureRoute::Raise,
            })
            .unwrap(),
            serde_json::json!({
                "status": "failed",
                "root": "C:/project",
                "reason": "activation_refused",
                "failureRoute": "raise"
            })
        );
        assert_eq!(
            serde_json::to_value([
                ProjectFailureRoute::Undetermined,
                ProjectFailureRoute::Raise,
                ProjectFailureRoute::Launch,
            ])
            .unwrap(),
            serde_json::json!(["undetermined", "raise", "launch"])
        );
    }

    #[test]
    fn display_root_replacement_preserves_the_failed_route() {
        assert_eq!(
            with_display_root(
                ProjectRouteOutcome::Failed {
                    root: "canonical".to_string(),
                    reason: RouteFailure::DeadlineExpired,
                    failure_route: ProjectFailureRoute::Launch,
                },
                "chosen",
            ),
            ProjectRouteOutcome::Failed {
                root: "chosen".to_string(),
                reason: RouteFailure::DeadlineExpired,
                failure_route: ProjectFailureRoute::Launch,
            }
        );
    }

    #[test]
    fn terminal_failures_keep_the_attempted_raise_or_launch_route() {
        for (failure_route, expected) in [
            (ProjectFailureRoute::Raise, TerminalDisposition::Focused),
            (ProjectFailureRoute::Launch, TerminalDisposition::Opened),
        ] {
            assert_eq!(
                ProjectRouteOperation::outcome(
                    Path::new("project"),
                    TerminalDisposition::Failed(RouteFailure::DeadlineExpired),
                    expected,
                    failure_route,
                ),
                ProjectRouteOutcome::Failed {
                    root: "project".to_string(),
                    reason: RouteFailure::DeadlineExpired,
                    failure_route,
                }
            );
        }
    }

    #[test]
    fn the_reachable_route_composes_adopt_stay_raise_launch_and_failure_without_run_state() {
        let app_data = tempfile::TempDir::new().unwrap();
        let owned = tempfile::TempDir::new().unwrap();
        let current = tempfile::TempDir::new().unwrap();
        let launched = tempfile::TempDir::new().unwrap();
        let missing = app_data.path().join("missing");
        let clock: Arc<dyn Clock> = Arc::new(SystemClock);
        let owner_session = crate::commands::project::new_session();
        let owner = routed_test_service(
            app_data.path(),
            "owner",
            owner_session.clone(),
            clock.clone(),
        );

        assert!(matches!(
            owner.route(owned.path()),
            ProjectRouteOutcome::AdoptedHere { .. }
        ));
        assert!(matches!(
            owner.route(owned.path()),
            ProjectRouteOutcome::AlreadyOpenHere { .. }
        ));

        let requester_session = crate::commands::project::new_session();
        *requester_session.lock().unwrap() =
            Some(OpenProject::open(current.path(), ProjectObservers::default()).unwrap());
        requester_session
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .watchdog_mut()
            .begin_run("still-running", &[]);
        let requester = routed_test_service(
            app_data.path(),
            "requester",
            requester_session.clone(),
            clock,
        );

        assert!(matches!(
            requester.route(owned.path()),
            ProjectRouteOutcome::FocusedOther { .. }
        ));
        assert!(matches!(
            requester.route(launched.path()),
            ProjectRouteOutcome::OpenedNew { .. }
        ));
        assert!(matches!(
            requester.route(&missing),
            ProjectRouteOutcome::Failed {
                reason: RouteFailure::ProjectUnavailable,
                failure_route: ProjectFailureRoute::Undetermined,
                ..
            }
        ));
        let mut session = requester_session.lock().unwrap();
        let project = session.as_mut().unwrap();
        assert!(project.is_root(current.path()));
        assert!(project.watchdog_mut().is_run_active("still-running"));
    }

    #[test]
    fn routing_reachable_sources_exclude_agent_execution_state() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let forbidden_type = ["Run", "Queue"].concat();
        let forbidden_module = ["run", "_queue"].concat();
        let forbidden_state = ["Active", "Run", "State"].concat();
        let forbidden_watchdog_mutation = ["watchdog", "_mut"].concat();
        for file in [
            "instances/router.rs",
            "instances/mod.rs",
            "instances/rendezvous.rs",
            "instances/launcher.rs",
            "instances/activator.rs",
        ] {
            let source = std::fs::read_to_string(root.join(file)).unwrap();
            let production = source.split("#[cfg(test)]").next().unwrap();
            assert!(
                !production.contains(&forbidden_type)
                    && !production.contains(&forbidden_module)
                    && !production.contains(&forbidden_state)
                    && !production.contains(&forbidden_watchdog_mutation),
                "{file} gained a run-state capability; TD-20(8) keeps the whole routing graph disjoint"
            );
        }
        let project = std::fs::read_to_string(root.join("agent/project.rs")).unwrap();
        let routing_session = project
            .split_once("pub(crate) struct ProjectRoutingSession")
            .unwrap()
            .1
            .split_once("/// The production run→watchdog edge")
            .unwrap()
            .0;
        assert!(
            !routing_session.contains(&forbidden_type)
                && !routing_session.contains(&forbidden_module)
                && !routing_session.contains(&forbidden_state)
                && !routing_session.contains(&forbidden_watchdog_mutation),
            "the shared-project routing view gained a run-state or watchdog-mutation capability"
        );
        let commands = std::fs::read_to_string(root.join("commands/project.rs")).unwrap();
        let route_command = commands
            .split_once("pub async fn route_project_open")
            .unwrap()
            .1
            .split_once("/// Closes the open project")
            .unwrap()
            .0;
        assert!(
            !route_command.contains(&forbidden_type) && !route_command.contains("run_if_idle"),
            "the thin route command gained access to run state"
        );
    }
}
