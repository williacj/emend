// ABOUTME: Cross-platform detached process launcher for TD-20 project-open routing.
// ABOUTME: LaunchServices owns packaged macOS starts; direct starts detach from the caller.

use std::ffi::OsStr;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use uuid::Uuid;

/// The app-scoped launch seam from TD-20 ruling (10). Implementations receive the exact routed
/// project and rendezvous id; neither is converted through UTF-8 on the production path.
pub trait Launcher: Send + Sync {
    fn launch(&self, project_root: &Path, request_id: Uuid) -> io::Result<()>;
}

/// Production launcher. `executable` is captured once so a caller cannot change the process-wide
/// executable lookup between a LaunchServices failure and its one direct fallback.
pub struct DetachedLauncher {
    executable: PathBuf,
}

/// `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB` (TD-20(7)).
#[cfg(any(windows, test))]
pub const WINDOWS_ROUTED_INSTANCE_FLAGS: u32 = 0x0100_0208;

impl DetachedLauncher {
    pub fn current() -> io::Result<DetachedLauncher> {
        Ok(DetachedLauncher {
            executable: std::env::current_exe()?,
        })
    }

    /// Explicit executable injection for the real-process platform tests.
    #[doc(hidden)]
    pub fn for_executable(executable: impl Into<PathBuf>) -> DetachedLauncher {
        DetachedLauncher {
            executable: executable.into(),
        }
    }

    fn direct_command(&self, project_root: &Path, request_id: Uuid) -> Command {
        let mut command = Command::new(&self.executable);
        append_routing_args(&mut command, project_root, request_id);
        detach_command(&mut command);
        command
    }

    #[cfg(target_os = "macos")]
    fn launch_macos(&self, project_root: &Path, request_id: Uuid) -> io::Result<()> {
        launch_macos_with(
            &self.executable,
            |bundle| {
                let mut broker = Command::new("/usr/bin/open");
                broker.arg("-n").arg("-a").arg(bundle).arg("--args");
                append_routing_args(&mut broker, project_root, request_id);
                broker
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null());
                broker.status().map(|status| status.success())
            },
            || {
                self.direct_command(project_root, request_id)
                    .spawn()
                    .map(|_| ())
            },
        )
    }
}

impl Launcher for DetachedLauncher {
    fn launch(&self, project_root: &Path, request_id: Uuid) -> io::Result<()> {
        #[cfg(target_os = "macos")]
        {
            self.launch_macos(project_root, request_id)
        }
        #[cfg(not(target_os = "macos"))]
        {
            self.direct_command(project_root, request_id)
                .spawn()
                .map(|_| ())
        }
    }
}

fn append_routing_args(command: &mut Command, project_root: &Path, request_id: Uuid) {
    command
        .arg(OsStr::new("--project"))
        .arg(project_root.as_os_str())
        .arg(OsStr::new("--open-request"))
        .arg(request_id.to_string());
}

fn detach_command(command: &mut Command) {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // TD-20(7): breakaway is part of the one attempt. Retrying without it would turn a routed
        // instance back into a job-owned child and violate FR-X-12 precisely on managed hosts.
        command.creation_flags(WINDOWS_ROUTED_INSTANCE_FLAGS);
    }

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: `setsid` is async-signal-safe and touches no memory shared with another thread.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    Err(io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
    }
}

/// Recognizes only the executable layout Tauri ships: `<name>.app/Contents/MacOS/<binary>`.
/// Merely having an `.app` ancestor is insufficient (a dev binary may live under fixtures).
#[cfg(any(target_os = "macos", test))]
fn containing_app_bundle(executable: &Path) -> Option<&Path> {
    let macos = executable.parent()?;
    (macos.file_name()? == OsStr::new("MacOS"))
        .then_some(())
        .and_then(|()| macos.parent())
        .filter(|contents| contents.file_name() == Some(OsStr::new("Contents")))
        .and_then(Path::parent)
        .filter(|bundle| bundle.extension() == Some(OsStr::new("app")))
}

#[cfg(any(target_os = "macos", test))]
fn launch_macos_with(
    executable: &Path,
    broker: impl FnOnce(&Path) -> io::Result<bool>,
    direct: impl FnOnce() -> io::Result<()>,
) -> io::Result<()> {
    let Some(bundle) = containing_app_bundle(executable) else {
        return direct();
    };
    match broker(bundle) {
        Ok(true) => Ok(()),
        Ok(false) | Err(_) => direct(),
    }
}

#[cfg(test)]
mod tests {
    use super::{containing_app_bundle, launch_macos_with, WINDOWS_ROUTED_INSTANCE_FLAGS};
    use std::cell::Cell;
    use std::io;
    use std::path::Path;

    #[test]
    fn macos_bundle_detection_requires_the_structural_contents_macos_layout() {
        assert_eq!(
            containing_app_bundle(Path::new(
                "/Applications/Emend.app/Contents/MacOS/Emend"
            )),
            Some(Path::new("/Applications/Emend.app"))
        );
        assert_eq!(
            containing_app_bundle(Path::new("/tmp/Emend.app/dev/Emend")),
            None
        );
        assert_eq!(containing_app_bundle(Path::new("/tmp/Emend")), None);
    }

    #[test]
    fn windows_flags_include_detach_new_group_and_breakaway_in_one_attempt() {
        assert_eq!(WINDOWS_ROUTED_INSTANCE_FLAGS, 0x0100_0208);
    }

    #[test]
    fn successful_launchservices_broker_never_also_direct_launches() {
        let brokers = Cell::new(0);
        let directs = Cell::new(0);
        launch_macos_with(
            Path::new("/Applications/Emend.app/Contents/MacOS/Emend"),
            |bundle| {
                assert_eq!(bundle, Path::new("/Applications/Emend.app"));
                brokers.set(brokers.get() + 1);
                Ok(true)
            },
            || {
                directs.set(directs.get() + 1);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!((brokers.get(), directs.get()), (1, 0));
    }

    #[test]
    fn failed_launchservices_broker_falls_back_direct_exactly_once() {
        let directs = Cell::new(0);
        launch_macos_with(
            Path::new("/Applications/Emend.app/Contents/MacOS/Emend"),
            |_| Ok(false),
            || {
                directs.set(directs.get() + 1);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(directs.get(), 1);
    }

    #[test]
    fn unavailable_launchservices_broker_falls_back_direct_exactly_once() {
        let directs = Cell::new(0);
        launch_macos_with(
            Path::new("/Applications/Emend.app/Contents/MacOS/Emend"),
            |_| Err(io::Error::other("open unavailable")),
            || {
                directs.set(directs.get() + 1);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(directs.get(), 1);
    }

    #[test]
    fn non_bundle_macos_build_uses_only_the_direct_setsid_path() {
        let brokers = Cell::new(0);
        let directs = Cell::new(0);
        launch_macos_with(
            Path::new("/tmp/target/debug/cowrite"),
            |_| {
                brokers.set(brokers.get() + 1);
                Ok(true)
            },
            || {
                directs.set(directs.get() + 1);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!((brokers.get(), directs.get()), (0, 1));
    }
}
