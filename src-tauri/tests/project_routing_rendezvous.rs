// ABOUTME: Real-OS cross-process proof for the TD-20 request/outcome rendezvous.
// ABOUTME: A separate helper owns the lock and answers through native-notified registry files.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, OnceLock};
use std::time::Duration;

#[cfg(windows)]
use std::fs;
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;

use emend_lib::instances::{request_and_wait, Clock, SystemClock, TerminalDisposition};
use emend_lib::store::lock;
use wait_timeout::ChildExt;

fn helper_bin() -> &'static Path {
    static BIN: OnceLock<PathBuf> = OnceLock::new();
    BIN.get_or_init(|| {
        let status = Command::new(env!("CARGO"))
            .args([
                "build",
                "--package",
                "rendezvous-test-helper",
                "--bin",
                "rendezvous-test-helper",
            ])
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .status()
            .expect("build the minimal rendezvous helper");
        assert!(status.success(), "rendezvous helper build failed");

        let mut target_dir = std::env::current_exe().expect("integration test path");
        target_dir.pop();
        if target_dir.ends_with("deps") {
            target_dir.pop();
        }
        target_dir.join(if cfg!(windows) {
            "rendezvous-test-helper.exe"
        } else {
            "rendezvous-test-helper"
        })
    })
}

struct TestChild(Child);

impl Drop for TestChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn run_real_owner(
    registry_dir: &Path,
    owner_project_spelling: &Path,
    requester_instance_id: &str,
) -> TerminalDisposition {
    let mut child = TestChild(
        Command::new(helper_bin())
            .arg(registry_dir)
            .arg(owner_project_spelling)
            .stdout(Stdio::piped())
            .spawn()
            .expect("spawn rendezvous owner process"),
    );

    let stdout = child.0.stdout.take().expect("helper stdout");
    let (ready_tx, ready_rx) = mpsc::channel();
    std::thread::spawn(move || {
        let ready = BufReader::new(stdout)
            .lines()
            .map_while(Result::ok)
            .any(|line| line.contains("RENDEZVOUS_HELPER_READY"));
        let _ = ready_tx.send(ready);
    });
    assert_eq!(
        ready_rx.recv_timeout(Duration::from_secs(30)),
        Ok(true),
        "the helper must take the lock and arm its native watcher"
    );
    assert_eq!(
        lock::current_owner(registry_dir).map(|owner| owner.project_root),
        Some(owner_project_spelling.canonicalize().unwrap()),
        "the helper must preserve the transported project root through canonical ownership"
    );

    let clock = SystemClock;
    let terminal = request_and_wait(
        registry_dir,
        requester_instance_id,
        clock.now_ms(),
        Duration::from_secs(5),
        &clock,
    );

    assert_eq!(terminal, TerminalDisposition::Opened);
    assert!(
        child
            .0
            .wait_timeout(Duration::from_secs(30))
            .expect("wait for helper")
            .is_some(),
        "the answering helper did not exit"
    );
    terminal
}

#[test]
fn a_real_owner_process_takes_the_os_lock_and_answers_the_request() {
    let app_data = tempfile::TempDir::new().unwrap();
    let project = tempfile::TempDir::new().unwrap();
    let registry_dir = lock::registry_dir(app_data.path(), project.path());

    assert_eq!(
        run_real_owner(&registry_dir, project.path(), "cross-process-requester"),
        TerminalDisposition::Opened
    );
}

#[cfg(windows)]
fn near_260_project_root(base: &Path) -> PathBuf {
    let mut root = base.join("Project With Spaces Ω").join("MixedCase");
    while root.as_os_str().encode_wide().count() < 248 {
        let remaining = 248 - root.as_os_str().encode_wide().count();
        root.push("x".repeat(remaining.clamp(1, 32)));
    }
    let len = root.as_os_str().encode_wide().count();
    assert!(
        (248..=260).contains(&len),
        "constructed path length was {len}"
    );
    root
}

#[cfg(windows)]
#[test]
fn a_real_windows_owner_routes_spaces_unicode_near_limit_and_case_equivalent_spelling() {
    let fixture = tempfile::TempDir::new().unwrap();
    let app_data = fixture.path().join("App Data Ω");
    fs::create_dir_all(&app_data).unwrap();
    let project = near_260_project_root(fixture.path());
    fs::create_dir_all(&project).unwrap();
    let differently_cased =
        PathBuf::from(project.to_string_lossy().replace("MixedCase", "mixedcase"));
    assert_ne!(project, differently_cased);
    assert_eq!(
        project.canonicalize().unwrap(),
        differently_cased.canonicalize().unwrap(),
        "case-equivalent spellings must resolve to one Windows root"
    );
    let registry_dir = lock::registry_dir(&app_data, &project);
    assert_eq!(
        registry_dir,
        lock::registry_dir(&app_data, &differently_cased),
        "case-equivalent project spellings must share one registry"
    );

    assert_eq!(
        run_real_owner(&registry_dir, &differently_cased, "requester with spaces Ω"),
        TerminalDisposition::Opened
    );
}
