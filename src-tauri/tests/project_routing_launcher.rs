// ABOUTME: Real-process survival proofs for TD-20's detached project-routing launcher.
// ABOUTME: The routed process remains usable after its launcher exits normally or is killed.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use uuid::Uuid;
use wait_timeout::ChildExt;

fn helper_bin() -> &'static Path {
    static BIN: OnceLock<PathBuf> = OnceLock::new();
    BIN.get_or_init(|| {
        let status = Command::new(env!("CARGO"))
            .args([
                "build",
                "--package",
                "detached-launcher-test-helper",
                "--bin",
                "detached-launcher-test-helper",
            ])
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .status()
            .expect("build detached launcher helper");
        assert!(status.success());
        let mut target = std::env::current_exe().unwrap();
        target.pop();
        if target.ends_with("deps") {
            target.pop();
        }
        target.join(if cfg!(windows) {
            "detached-launcher-test-helper.exe"
        } else {
            "detached-launcher-test-helper"
        })
    })
}

fn wait_for(path: &Path) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while !path.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(path.exists(), "timed out waiting for {}", path.display());
}

fn spawn_parent(root: &Path, waits: bool) -> Result<(Child, Uuid), i32> {
    let mut parent = Command::new(helper_bin())
        .arg(if waits { "parent-wait" } else { "parent" })
        .arg(root)
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut line = String::new();
    BufReader::new(parent.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    if let Some(code) = line.trim().strip_prefix("UNAVAILABLE:") {
        let _ = parent.wait();
        return Err(code.parse().unwrap());
    }
    Ok((parent, Uuid::parse_str(line.trim()).unwrap()))
}

fn permitted(result: Result<(Child, Uuid), i32>) -> Option<(Child, Uuid)> {
    match result {
        Ok(value) => Some(value),
        Err(code) if cfg!(windows) && code == 5 => {
            eprintln!(
                "Windows host job forbids CREATE_BREAKAWAY_FROM_JOB; production correctly did not retry without it"
            );
            None
        }
        Err(code) => panic!("unexpected detached launch error {code}"),
    }
}

fn release_and_observe_exit(root: &Path, id: Uuid) {
    std::fs::write(root.join(format!("{id}.release")), b"release").unwrap();
    wait_for(&root.join(format!("{id}.done")));
}

#[cfg(windows)]
fn windows_tortured_root(fixture: &tempfile::TempDir) -> PathBuf {
    use std::os::windows::ffi::OsStrExt;

    let mut root = fixture
        .path()
        .join("Project With Spaces Ω")
        .join("MixedCase");
    while root.as_os_str().encode_wide().count() < 220 {
        root.push("x".repeat(24));
    }
    std::fs::create_dir_all(&root).unwrap();
    root
}

#[test]
fn a_routed_process_survives_its_launcher_exiting_normally() {
    let root = tempfile::TempDir::new().unwrap();
    let Some((mut parent, id)) = permitted(spawn_parent(root.path(), false)) else {
        return;
    };
    assert!(parent
        .wait_timeout(Duration::from_secs(30))
        .unwrap()
        .is_some());
    wait_for(&root.path().join(format!("{id}.ready")));
    release_and_observe_exit(root.path(), id);
}

#[test]
fn a_routed_process_survives_its_launcher_being_killed() {
    let root = tempfile::TempDir::new().unwrap();
    let Some((mut parent, id)) = permitted(spawn_parent(root.path(), true)) else {
        return;
    };
    wait_for(&root.path().join(format!("{id}.ready")));
    parent.kill().unwrap();
    parent.wait().unwrap();
    assert!(!root.path().join(format!("{id}.done")).exists());
    release_and_observe_exit(root.path(), id);
}

#[cfg(windows)]
#[test]
fn a_breakaway_routed_process_preserves_a_tortured_path_and_survives_its_launchers_kill_on_close_job(
) {
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::os::windows::io::AsRawHandle;
    use std::ptr::null;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    let fixture = tempfile::TempDir::new().unwrap();
    let root = windows_tortured_root(&fixture);
    let mut parent = Command::new(helper_bin())
        .arg("parent-gated")
        .arg(&root)
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(parent.stdout.take().unwrap());
    let mut line = String::new();
    lines.read_line(&mut line).unwrap();
    assert_eq!(line.trim(), "PARENT_READY");

    // SAFETY: every handle and pointer below comes from the documented Windows API. The job is
    // closed exactly once after the child readiness handshake, while the parent handle stays live.
    let job = unsafe { CreateJobObjectW(null(), null()) };
    assert!(
        !job.is_null(),
        "create kill-on-close job: {}",
        std::io::Error::last_os_error()
    );
    let mut information = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    information.BasicLimitInformation.LimitFlags =
        JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    assert_ne!(
        unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &information as *const _ as *const c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        },
        0,
        "configure kill-on-close job: {}",
        std::io::Error::last_os_error()
    );
    assert_ne!(
        unsafe { AssignProcessToJobObject(job, parent.as_raw_handle()) },
        0,
        "assign launcher parent to job: {}",
        std::io::Error::last_os_error()
    );

    std::fs::write(root.join("parent.go"), b"go").unwrap();
    line.clear();
    lines.read_line(&mut line).unwrap();
    if let Some(code) = line.trim().strip_prefix("UNAVAILABLE:") {
        unsafe { CloseHandle(job) };
        let _ = parent.wait();
        if code == "5" {
            eprintln!(
                "Windows outer host job forbids nested breakaway; production correctly did not retry without it"
            );
            return;
        }
        panic!("unexpected detached launch error {code}");
    }
    let request_id = Uuid::parse_str(line.trim()).unwrap();
    wait_for(&root.join(format!("{request_id}.ready")));

    assert_ne!(unsafe { CloseHandle(job) }, 0);
    assert!(parent
        .wait_timeout(Duration::from_secs(30))
        .unwrap()
        .is_some());
    release_and_observe_exit(&root, request_id);
}

#[cfg(windows)]
#[test]
fn windows_launcher_preserves_spaces_unicode_and_a_long_native_project_path() {
    let fixture = tempfile::TempDir::new().unwrap();
    let root = windows_tortured_root(&fixture);
    let Some((mut parent, id)) = permitted(spawn_parent(&root, false)) else {
        return;
    };
    assert!(parent
        .wait_timeout(Duration::from_secs(30))
        .unwrap()
        .is_some());
    wait_for(&root.join(format!("{id}.ready")));
    release_and_observe_exit(&root, id);
}
