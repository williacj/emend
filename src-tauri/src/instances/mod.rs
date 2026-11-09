// ABOUTME: App-scoped instance identity and the pure project-open routing resolver (TD-20).
// ABOUTME: Strict root canonicalization precedes any injected ownership-registry probe.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use uuid::Uuid;

use crate::store::lock::{self, LockOutcome, LockOwner, ProjectLockGuard};
use crate::store::project_identity;

pub mod activator;
mod launcher;
mod rendezvous;
mod router;
mod startup;
pub use launcher::{DetachedLauncher, Launcher};
pub use rendezvous::{
    answer_request, request_and_wait, request_and_wait_after_arm, request_and_wait_after_publish,
    AnswerStatus, Clock, RequestReceiver, RouteFailure, RouteRequest, RouteSuccess, SystemClock,
    TerminalDisposition,
};
pub use router::{
    ProjectRouteOutcome, ProjectRouter, ProjectRoutingNotice, ProjectRoutingObserver,
    PROJECT_ROUTE_LAUNCH_BUDGET, PROJECT_ROUTE_RAISE_BUDGET,
};
pub use startup::{
    finalize_startup, parse_startup_intent, route_startup_intent, StartupCompletion, StartupIntent,
};

/// This process's stable identity for its app lifetime.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstanceIdentity(String);

impl InstanceIdentity {
    fn new() -> InstanceIdentity {
        InstanceIdentity(Uuid::new_v4().to_string())
    }

    fn from_string(identity: impl Into<String>) -> InstanceIdentity {
        InstanceIdentity(identity.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// The app-scoped registry seam. It exists independently of any open project and owns the
/// instance identity plus the injected app-local-data root (TD-20 rulings (2), (3), and (10)).
pub struct InstanceRegistry {
    app_local_data_dir: PathBuf,
    identity: InstanceIdentity,
    clock: Arc<dyn Clock>,
}

impl InstanceRegistry {
    pub fn new(app_local_data_dir: impl Into<PathBuf>) -> InstanceRegistry {
        InstanceRegistry {
            app_local_data_dir: app_local_data_dir.into(),
            identity: InstanceIdentity::new(),
            clock: Arc::new(SystemClock),
        }
    }

    /// Deterministic identity injection for tests and startup composition.
    pub fn with_identity(
        app_local_data_dir: impl Into<PathBuf>,
        identity: impl Into<String>,
    ) -> InstanceRegistry {
        InstanceRegistry {
            app_local_data_dir: app_local_data_dir.into(),
            identity: InstanceIdentity::from_string(identity),
            clock: Arc::new(SystemClock),
        }
    }

    pub fn with_identity_and_clock(
        app_local_data_dir: impl Into<PathBuf>,
        identity: impl Into<String>,
        clock: Arc<dyn Clock>,
    ) -> InstanceRegistry {
        InstanceRegistry {
            app_local_data_dir: app_local_data_dir.into(),
            identity: InstanceIdentity::from_string(identity),
            clock,
        }
    }

    pub fn identity(&self) -> &InstanceIdentity {
        &self.identity
    }

    fn canonicalize(&self, chosen_root: &Path) -> io::Result<PathBuf> {
        project_identity::require_canonical_root(chosen_root)
    }

    fn probe_ownership(&self, canonical_root: &Path) -> io::Result<LockOutcome> {
        let registry_dir = lock::registry_dir(&self.app_local_data_dir, canonical_root);
        let owner = LockOwner::new(self.identity.as_str(), canonical_root);
        let outcome = lock::probe(&registry_dir, &owner)?;
        if let LockOutcome::Acquired(ownership) = &outcome {
            rendezvous::sweep_acquired_registry(ownership, self.clock.now_ms())?;
        }
        Ok(outcome)
    }

    /// Reclaims keyed registry directories whose recorded canonical roots no longer exist. The
    /// owner record is the only reversible address for an opaque hash; a missing/corrupt record is
    /// left alone rather than guessed. A live OS lock also wins, even for a just-deleted root.
    pub fn sweep_dead_project_registries(&self) -> io::Result<usize> {
        let parent = lock::registries_root(&self.app_local_data_dir);
        let entries = match fs::read_dir(&parent) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
            Err(error) => return Err(error),
        };
        let mut reclaimed = 0;
        for entry in entries {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let registry_dir = entry.path();
            let Some(previous_owner) = lock::current_owner(&registry_dir) else {
                continue;
            };
            if previous_owner.project_root.exists() {
                continue;
            }
            let sweeper = LockOwner::new(self.identity.as_str(), &previous_owner.project_root);
            let LockOutcome::Acquired(ownership) = lock::probe(&registry_dir, &sweeper)? else {
                continue;
            };
            rendezvous::sweep_acquired_registry(&ownership, self.clock.now_ms())?;
            drop(ownership);
            fs::remove_dir_all(&registry_dir)?;
            reclaimed += 1;
        }
        Ok(reclaimed)
    }
}

/// What project, if any, this process already owns. `Holding` carries `OpenProject`'s canonical
/// root; the resolver never needs the aggregate itself and therefore also works on the welcome
/// screen (FR-X-10, TD-17).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SelfState<'a> {
    Empty,
    Holding(&'a Path),
}

/// The exhaustive successful routing outcomes from J9 / TD-20 ruling (4).
pub enum Action {
    AlreadyOpenHere {
        root: PathBuf,
    },
    AdoptHere {
        root: PathBuf,
        ownership: ProjectLockGuard,
    },
    Raise {
        root: PathBuf,
        owner: Option<LockOwner>,
    },
    Launch {
        root: PathBuf,
    },
}

/// Resolves one chosen project without consulting the open-project aggregate or performing any
/// filesystem work outside the injected registry seam. Canonicalization is strict and precedes
/// registry path construction, so a missing Recent root cannot create ownership artifacts.
pub fn resolve(
    chosen_root: &Path,
    self_state: SelfState<'_>,
    registry: &InstanceRegistry,
) -> io::Result<Action> {
    let canonical_root = registry.canonicalize(chosen_root)?;

    if matches!(self_state, SelfState::Holding(current) if current == canonical_root) {
        return Ok(Action::AlreadyOpenHere {
            root: canonical_root,
        });
    }

    match (self_state, registry.probe_ownership(&canonical_root)?) {
        (SelfState::Empty, LockOutcome::Acquired(ownership)) => Ok(Action::AdoptHere {
            root: canonical_root,
            ownership,
        }),
        (_, LockOutcome::HeldByAnotherInstance { owner }) => Ok(Action::Raise {
            root: canonical_root,
            owner,
        }),
        (SelfState::Holding(_), LockOutcome::Acquired(ownership)) => {
            drop(ownership);
            Ok(Action::Launch {
                root: canonical_root,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use crate::store::lock::{self, LockOutcome, LockOwner};
    use crate::store::project_identity;

    use super::{resolve, Action, InstanceRegistry, SelfState};

    fn registry(app_data: &Path, identity: &str) -> InstanceRegistry {
        InstanceRegistry::with_identity(app_data, identity)
    }

    #[test]
    fn this_process_already_holding_the_chosen_project_resolves_locally_without_registry_io() {
        let app_data = tempfile::TempDir::new().unwrap();
        let project = tempfile::TempDir::new().unwrap();
        let held_root = project_identity::require_canonical_root(project.path()).unwrap();

        let action = resolve(
            project.path(),
            SelfState::Holding(&held_root),
            &registry(app_data.path(), "instance-a"),
        )
        .unwrap();

        assert!(matches!(action, Action::AlreadyOpenHere { .. }));
        assert!(fs::read_dir(app_data.path()).unwrap().next().is_none());
    }

    #[test]
    fn an_empty_instance_adopts_a_free_project_and_keeps_the_ownership_guard() {
        let app_data = tempfile::TempDir::new().unwrap();
        let project = tempfile::TempDir::new().unwrap();
        let instance_registry = registry(app_data.path(), "instance-a");

        let action = resolve(project.path(), SelfState::Empty, &instance_registry).unwrap();
        let Action::AdoptHere { ownership, .. } = action else {
            panic!("a free project should be adopted by an empty instance");
        };

        let competing = lock::acquire(
            ownership.registry_dir(),
            &LockOwner::new("instance-b", project.path()),
        )
        .unwrap();
        assert!(matches!(
            competing,
            LockOutcome::HeldByAnotherInstance { .. }
        ));
    }

    #[test]
    fn a_project_held_by_another_instance_resolves_to_raise() {
        let app_data = tempfile::TempDir::new().unwrap();
        let project = tempfile::TempDir::new().unwrap();
        let registry_dir = lock::registry_dir(app_data.path(), project.path());
        let held =
            lock::acquire(&registry_dir, &LockOwner::new("instance-b", project.path())).unwrap();
        assert!(matches!(&held, LockOutcome::Acquired(_)));

        let action = resolve(
            project.path(),
            SelfState::Empty,
            &registry(app_data.path(), "instance-a"),
        )
        .unwrap();

        let Action::Raise { owner, .. } = action else {
            panic!("another instance's ownership should route to Raise");
        };
        assert_eq!(owner.unwrap().instance_id, "instance-b");
        assert!(!registry_dir.join("lock.focus-request").exists());
    }

    #[test]
    fn another_held_project_resolves_to_raise_even_when_this_instance_holds_a_project() {
        let app_data = tempfile::TempDir::new().unwrap();
        let current = tempfile::TempDir::new().unwrap();
        let chosen = tempfile::TempDir::new().unwrap();
        let registry_dir = lock::registry_dir(app_data.path(), chosen.path());
        let held =
            lock::acquire(&registry_dir, &LockOwner::new("instance-b", chosen.path())).unwrap();
        assert!(matches!(&held, LockOutcome::Acquired(_)));

        let action = resolve(
            chosen.path(),
            SelfState::Holding(current.path()),
            &registry(app_data.path(), "instance-a"),
        )
        .unwrap();

        assert!(matches!(action, Action::Raise { .. }));
        assert!(!registry_dir.join("lock.focus-request").exists());
    }

    #[test]
    fn an_instance_holding_another_project_launches_and_releases_its_probe_guard() {
        let app_data = tempfile::TempDir::new().unwrap();
        let current = tempfile::TempDir::new().unwrap();
        let chosen = tempfile::TempDir::new().unwrap();
        let instance_registry = registry(app_data.path(), "instance-a");

        let action = resolve(
            chosen.path(),
            SelfState::Holding(current.path()),
            &instance_registry,
        )
        .unwrap();
        assert!(matches!(action, Action::Launch { .. }));
        assert!(!lock::registry_dir(app_data.path(), chosen.path())
            .join("lock.focus-request")
            .exists());

        let after = lock::acquire(
            &lock::registry_dir(app_data.path(), chosen.path()),
            &LockOwner::new("launched-instance", chosen.path()),
        )
        .unwrap();
        assert!(matches!(after, LockOutcome::Acquired(_)));
    }

    #[test]
    fn a_missing_root_fails_before_the_registry_is_touched() {
        let app_data = tempfile::TempDir::new().unwrap();
        let missing = app_data.path().join("gone");

        let error = match resolve(
            &missing,
            SelfState::Empty,
            &registry(app_data.path(), "instance-a"),
        ) {
            Err(error) => error,
            Ok(_) => panic!("a missing project root should be refused"),
        };

        assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
        assert!(!app_data.path().join("instances").exists());
    }

    #[test]
    fn identity_collapsing_spellings_resolve_as_already_open_here() {
        let app_data = tempfile::TempDir::new().unwrap();
        let project = tempfile::TempDir::new().unwrap();
        fs::create_dir(project.path().join("sub")).unwrap();
        let alternate = project.path().join("sub").join("..");
        let held_root = project_identity::require_canonical_root(project.path()).unwrap();

        let action = resolve(
            &alternate,
            SelfState::Holding(&held_root),
            &registry(app_data.path(), "instance-a"),
        )
        .unwrap();

        assert!(matches!(action, Action::AlreadyOpenHere { .. }));
        assert!(!app_data.path().join("instances").exists());
    }

    #[test]
    fn the_registry_is_constructible_without_an_open_project() {
        let app_data = tempfile::TempDir::new().unwrap();
        let project = tempfile::TempDir::new().unwrap();
        let instance_registry = InstanceRegistry::new(app_data.path());

        let action = resolve(project.path(), SelfState::Empty, &instance_registry).unwrap();

        assert!(matches!(action, Action::AdoptHere { .. }));
        assert!(!instance_registry.identity().as_str().is_empty());
    }
}
