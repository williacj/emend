// ABOUTME: Cooperative requester grant and owner-side window activation for TD-20(6).
// ABOUTME: Durable intent and verified owner acknowledgement make focus an answered rendezvous only.

//! The requester may establish an OS foreground entitlement, but it never raises another
//! process's window and never infers success from an OS return. The owner retains both effects
//! that matter to the user (restore/show and focus) and writes `Focused` only after observing the
//! window state. This module intentionally exposes no general "raise window" operation: its owner
//! entry point requires the held [`ProjectLockGuard`] and an armed rendezvous request.

use std::io;
use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread;
use std::time::Duration;

use uuid::Uuid;

use super::{
    answer_request, request_and_wait_after_arm, AnswerStatus, Clock, RequestReceiver, RouteFailure,
    RouteSuccess, SystemClock, TerminalDisposition,
};
use crate::store::lock::{self, LockOwner, ProjectLockGuard};

/// The shipped requester-side platform adapter. Unsupported build hosts fail closed; Emend only
/// ships Windows and macOS, where the platform implementations below are deliberately explicit.
pub struct SystemRequesterActivation;

impl RequesterActivation for SystemRequesterActivation {
    fn platform(&self) -> RequesterPlatform {
        #[cfg(target_os = "macos")]
        {
            RequesterPlatform::MacOs
        }
        #[cfg(not(target_os = "macos"))]
        {
            RequesterPlatform::Windows
        }
    }

    fn owner_is_live_cowrite(&self, owner: &LockOwner) -> bool {
        #[cfg(windows)]
        {
            windows_owner_is_live_cowrite(owner)
        }
        #[cfg(target_os = "macos")]
        {
            macos_owner_is_live_cowrite(owner)
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            let _ = owner;
            false
        }
    }

    fn establish_entitlement(&self, owner: &LockOwner) -> io::Result<()> {
        #[cfg(windows)]
        {
            windows_grant_foreground(owner.pid)
        }
        #[cfg(target_os = "macos")]
        {
            macos_activate(owner.pid)
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            let _ = owner;
            Err(io::Error::other(
                "cooperative activation is unsupported on this host",
            ))
        }
    }
}

#[cfg(windows)]
fn same_executable(expected: &std::path::Path, observed: &std::path::Path) -> bool {
    let Ok(expected) = expected.canonicalize() else {
        return false;
    };
    let Ok(observed) = observed.canonicalize() else {
        return false;
    };
    expected == observed
}

#[cfg(windows)]
fn windows_owner_is_live_cowrite(owner: &LockOwner) -> bool {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, QueryFullProcessImageNameW,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    if owner.pid == 0 {
        return false;
    }
    let Some(recorded) = owner.executable.as_deref() else {
        return false;
    };
    let Ok(self_exe) = std::env::current_exe() else {
        return false;
    };
    // A record that does not name this build is not an activation address, even if a process with
    // that PID happens to be alive. This defeats both stale records and recycled PIDs.
    if !same_executable(recorded, &self_exe) {
        return false;
    }
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, owner.pid);
        if process.is_null() {
            return false;
        }
        let mut exit_code = 0;
        let live =
            GetExitCodeProcess(process, &mut exit_code) != 0 && exit_code == STILL_ACTIVE as u32;
        let mut path = vec![0u16; 32_768];
        let mut length = path.len() as u32;
        let image_ok = QueryFullProcessImageNameW(process, 0, path.as_mut_ptr(), &mut length) != 0;
        let _ = CloseHandle(process);
        live && image_ok
            && same_executable(
                recorded,
                std::path::Path::new(&std::ffi::OsString::from_wide(&path[..length as usize])),
            )
    }
}

#[cfg(windows)]
fn windows_grant_foreground(pid: u32) -> io::Result<()> {
    use windows_sys::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow;
    if unsafe { AllowSetForegroundWindow(pid) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
mod macos_appkit {
    use std::ffi::{c_char, c_void};

    #[link(name = "AppKit", kind = "framework")]
    extern "C" {}
    #[link(name = "objc")]
    extern "C" {
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn sel_registerName(name: *const c_char) -> *const c_void;
        fn objc_msgSend();
    }

    unsafe fn selector(name: &'static [u8]) -> *const c_void {
        sel_registerName(name.as_ptr().cast())
    }
    unsafe fn message_id(receiver: *mut c_void, selector: *const c_void) -> *mut c_void {
        let call: unsafe extern "C" fn(*mut c_void, *const c_void) -> *mut c_void =
            std::mem::transmute(objc_msgSend as *const ());
        call(receiver, selector)
    }
    unsafe fn message_pid(receiver: *mut c_void, selector: *const c_void, pid: i32) -> *mut c_void {
        let call: unsafe extern "C" fn(*mut c_void, *const c_void, i32) -> *mut c_void =
            std::mem::transmute(objc_msgSend as *const ());
        call(receiver, selector, pid)
    }
    unsafe fn message_bool(receiver: *mut c_void, selector: *const c_void) -> bool {
        let call: unsafe extern "C" fn(*mut c_void, *const c_void) -> bool =
            std::mem::transmute(objc_msgSend as *const ());
        call(receiver, selector)
    }
    unsafe fn message_options(
        receiver: *mut c_void,
        selector: *const c_void,
        options: usize,
    ) -> bool {
        let call: unsafe extern "C" fn(*mut c_void, *const c_void, usize) -> bool =
            std::mem::transmute(objc_msgSend as *const ());
        call(receiver, selector, options)
    }

    pub unsafe fn application_for_pid(pid: u32) -> *mut c_void {
        let class = objc_getClass(c"NSRunningApplication".as_ptr());
        if class.is_null() || pid > i32::MAX as u32 {
            return std::ptr::null_mut();
        }
        message_pid(
            class,
            selector(b"runningApplicationWithProcessIdentifier:\0"),
            pid as i32,
        )
    }
    pub unsafe fn current_application() -> *mut c_void {
        let class = objc_getClass(c"NSRunningApplication".as_ptr());
        if class.is_null() {
            return std::ptr::null_mut();
        }
        message_id(class, selector(b"currentApplication\0"))
    }
    pub unsafe fn is_terminated(app: *mut c_void) -> bool {
        message_bool(app, selector(b"isTerminated\0"))
    }
    pub unsafe fn bundle_identifier(app: *mut c_void) -> *mut c_void {
        message_id(app, selector(b"bundleIdentifier\0"))
    }
    pub unsafe fn is_equal(left: *mut c_void, right: *mut c_void) -> bool {
        let call: unsafe extern "C" fn(*mut c_void, *const c_void, *mut c_void) -> bool =
            std::mem::transmute(objc_msgSend as *const ());
        call(left, selector(b"isEqual:\0"), right)
    }
    pub unsafe fn activate(app: *mut c_void) -> bool {
        message_options(app, selector(b"activateWithOptions:\0"), 0)
    }
}

#[cfg(target_os = "macos")]
fn macos_owner_is_live_cowrite(owner: &LockOwner) -> bool {
    // NSRunningApplication makes both the liveness and bundle-identity check against the live OS
    // process, rather than trusting `owner.json`. `bundleIdentifier` is the shipped app identity.
    unsafe {
        let owner_app = macos_appkit::application_for_pid(owner.pid);
        let current = macos_appkit::current_application();
        !owner_app.is_null()
            && !current.is_null()
            && !macos_appkit::is_terminated(owner_app)
            && macos_appkit::is_equal(
                macos_appkit::bundle_identifier(owner_app),
                macos_appkit::bundle_identifier(current),
            )
    }
}

#[cfg(target_os = "macos")]
fn macos_activate(pid: u32) -> io::Result<()> {
    unsafe {
        let app = macos_appkit::application_for_pid(pid);
        if app.is_null() || !macos_appkit::activate(app) {
            return Err(io::Error::other(
                "NSRunningApplication.activate refused the owner",
            ));
        }
    }
    Ok(())
}

/// The one requester-side platform operation permitted by TD-20(6).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RequesterPlatform {
    Windows,
    MacOs,
}

/// Platform seam kept deliberately small for deterministic ordering tests. Implementations must
/// verify a live PID and this-app executable/bundle identity before returning `true`.
pub trait RequesterActivation {
    fn platform(&self) -> RequesterPlatform;
    fn owner_is_live_cowrite(&self, owner: &LockOwner) -> bool;
    fn establish_entitlement(&self, owner: &LockOwner) -> io::Result<()>;
}

/// The owner-side native window surface. It is private to the process holding the lock; a
/// requester only gains the platform entitlement and cannot call these operations on the owner.
pub trait OwnerWindow {
    fn unminimize(&self) -> io::Result<()>;
    fn show_if_needed(&self) -> io::Result<()>;
    fn set_focus(&self) -> io::Result<()>;
    fn is_minimized(&self) -> io::Result<bool>;
    fn is_focused(&self) -> io::Result<bool>;
}

/// A watcher owned by the same `OpenProject` lifetime as the OS lock. It scans before each bounded
/// native-notification wait, and its drop joins before the lock is released, so a former holder can
/// never answer a request after another process has acquired the project.
pub(crate) struct OwnerActivationService {
    stopped: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl OwnerActivationService {
    pub(crate) fn start(
        registry_dir: std::path::PathBuf,
        window: Arc<dyn OwnerWindow + Send + Sync>,
    ) -> io::Result<Self> {
        let receiver = RequestReceiver::watch(&registry_dir)?;
        let stopped = Arc::new(AtomicBool::new(false));
        let worker_stopped = Arc::clone(&stopped);
        let worker = thread::Builder::new()
            .name("cowrite-owner-activation".to_string())
            .spawn(move || {
                let mut attempted = std::collections::HashSet::new();
                let clock = SystemClock;
                while !worker_stopped.load(Ordering::Acquire) {
                    match receiver.recv_timeout(&registry_dir, &clock, Duration::from_millis(100)) {
                        Ok(Some(request)) if attempted.insert(request.request_id) => {
                            // A window/publication failure remains an absent acknowledgement. The
                            // requester owns the deadline and will report its bounded failure; a
                            // retry needs a fresh user request, not repeated hidden foreground
                            // attempts from this one watcher scan.
                            let _ = answer_focus_request_at(
                                &registry_dir,
                                request.request_id,
                                &clock,
                                window.as_ref(),
                            );
                        }
                        Ok(Some(_)) | Ok(None) | Err(_) => {}
                    }
                }
            })
            .map_err(io::Error::other)?;
        Ok(Self {
            stopped,
            worker: Some(worker),
        })
    }
}

impl Drop for OwnerActivationService {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

/// The app-layer adapter for the owner window. It is intentionally crate-private: other app
/// subsystems cannot gain a public foreground capability, and the only construction site that
/// invokes it is the rendezvous-answering owner service.
pub(crate) struct TauriOwnerWindow<R: tauri::Runtime>(pub tauri::WebviewWindow<R>);

impl<R: tauri::Runtime> OwnerWindow for TauriOwnerWindow<R> {
    fn unminimize(&self) -> io::Result<()> {
        self.0.unminimize().map_err(io::Error::other)
    }

    fn show_if_needed(&self) -> io::Result<()> {
        // SPIKE-6's macOS hidden-target cell requires show before focus. Windows' measured
        // sequence is exactly unminimize → focus, so this is deliberately a no-op there.
        #[cfg(target_os = "macos")]
        {
            self.0.show().map_err(io::Error::other)
        }
        #[cfg(not(target_os = "macos"))]
        {
            Ok(())
        }
    }

    fn set_focus(&self) -> io::Result<()> {
        self.0.set_focus().map_err(io::Error::other)
    }

    fn is_minimized(&self) -> io::Result<bool> {
        self.0.is_minimized().map_err(io::Error::other)
    }

    fn is_focused(&self) -> io::Result<bool> {
        self.0.is_focused().map_err(io::Error::other)
    }
}

/// Requests focus from the holder named by `owner`. A failed validation or refused OS operation is
/// an ordinary bounded route failure; it never probes, releases, or changes the ownership lock.
pub fn request_owner_focus(
    registry_dir: &Path,
    requester_instance_id: &str,
    owner: &LockOwner,
    asked_at_ms: i64,
    budget: Duration,
    clock: &dyn Clock,
    activation: &dyn RequesterActivation,
) -> TerminalDisposition {
    if !activation.owner_is_live_cowrite(owner) {
        return TerminalDisposition::Failed(RouteFailure::OwnerUnavailable);
    }

    match activation.platform() {
        // Windows requires the foreground permission before the owner can observe its request.
        RequesterPlatform::Windows => {
            if activation.establish_entitlement(owner).is_err() {
                return TerminalDisposition::Failed(RouteFailure::ActivationRefused);
            }
            request_and_wait_after_arm(
                registry_dir,
                requester_instance_id,
                asked_at_ms,
                budget,
                clock,
                |request| {
                    lock::prepare_rendezvous_request(registry_dir, request)
                        .and_then(|prepared| prepared.arm())
                        .map_err(|_| RouteFailure::RegistryUnavailable)
                },
            )
        }
        // macOS must retain the staging lock across activation and the arm rename. Publishing
        // directly first would allow the owner watcher to race ahead of activation.
        RequesterPlatform::MacOs => request_and_wait_after_arm(
            registry_dir,
            requester_instance_id,
            asked_at_ms,
            budget,
            clock,
            |request| {
                let prepared = lock::prepare_rendezvous_request(registry_dir, request)
                    .map_err(|_| RouteFailure::RegistryUnavailable)?;
                activation
                    .establish_entitlement(owner)
                    .map_err(|_| RouteFailure::ActivationRefused)?;
                prepared
                    .arm()
                    .map_err(|_| RouteFailure::RegistryUnavailable)
            },
        ),
    }
}

/// Performs the owner-only half of a cooperative raise. `answer_request` deliberately does not
/// roll this back after the window is visibly raised: a publication error leaves the target as it
/// is and the requester reaches its ordinary deadline failure, never a fabricated `Focused`.
pub fn answer_focus_request(
    ownership: &ProjectLockGuard,
    request_id: Uuid,
    clock: &dyn Clock,
    window: &dyn OwnerWindow,
) -> io::Result<AnswerStatus> {
    answer_focus_request_at(ownership.registry_dir(), request_id, clock, window)
}

fn answer_focus_request_at(
    registry_dir: &Path,
    request_id: Uuid,
    clock: &dyn Clock,
    window: &dyn OwnerWindow,
) -> io::Result<AnswerStatus> {
    answer_request(
        registry_dir,
        request_id,
        RouteSuccess::Focused,
        clock,
        || {
            window.unminimize()?;
            // `show` is a no-op for an already visible native window and closes the hidden macOS
            // case measured by SPIKE-6. It remains owner-side, after the armed observation.
            window.show_if_needed()?;
            window.set_focus()?;
            if window.is_minimized()? || !window.is_focused()? {
                return Err(io::Error::other(
                    "window did not become visible and focused",
                ));
            }
            Ok(())
        },
    )
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};
    use std::sync::atomic::{AtomicI64, Ordering};

    use super::*;
    use crate::store::lock::{self, RendezvousRead, RendezvousRequest};

    struct ManualClock(AtomicI64);
    impl ManualClock {
        fn at(now: i64) -> Self {
            Self(AtomicI64::new(now))
        }
    }
    impl Clock for ManualClock {
        fn now_ms(&self) -> i64 {
            self.0.load(Ordering::SeqCst)
        }
    }

    struct FakeRequester {
        platform: RequesterPlatform,
        valid: bool,
        grant: io::Result<()>,
        events: RefCell<Vec<&'static str>>,
        staged_registry: Option<std::path::PathBuf>,
    }
    impl RequesterActivation for FakeRequester {
        fn platform(&self) -> RequesterPlatform {
            self.platform
        }
        fn owner_is_live_cowrite(&self, _: &LockOwner) -> bool {
            self.events.borrow_mut().push("validate");
            self.valid
        }
        fn establish_entitlement(&self, _: &LockOwner) -> io::Result<()> {
            self.events.borrow_mut().push("activate");
            if let Some(registry) = &self.staged_registry {
                assert!(
                    lock::rendezvous_request_staging_files(registry)
                        .unwrap()
                        .iter()
                        .any(|path| path.extension().is_some_and(|extension| extension == "tmp")),
                    "macOS activation must happen only after a synced, unarmed staging file exists"
                );
                assert!(
                    lock::rendezvous_request_files(registry).unwrap().is_empty(),
                    "the owner-visible request lane must still be empty during macOS activation"
                );
            }
            match &self.grant {
                Ok(()) => Ok(()),
                Err(error) => Err(io::Error::new(error.kind(), error.to_string())),
            }
        }
    }

    fn owner(project: &Path) -> LockOwner {
        LockOwner::new("owner", project)
    }

    #[test]
    fn an_unverified_or_recycled_owner_never_receives_a_grant_or_request() {
        let registry = tempfile::TempDir::new().unwrap();
        let project = tempfile::TempDir::new().unwrap();
        let activation = FakeRequester {
            platform: RequesterPlatform::Windows,
            valid: false,
            grant: Ok(()),
            events: RefCell::new(Vec::new()),
            staged_registry: None,
        };
        assert_eq!(
            request_owner_focus(
                registry.path(),
                "requester",
                &owner(project.path()),
                0,
                Duration::from_secs(1),
                &ManualClock::at(0),
                &activation
            ),
            TerminalDisposition::Failed(RouteFailure::OwnerUnavailable)
        );
        assert_eq!(&*activation.events.borrow(), &["validate"]);
        assert!(!lock::requests_dir(registry.path()).exists());
    }

    #[test]
    fn windows_grants_before_it_arms_the_owner_visible_request() {
        let registry = tempfile::TempDir::new().unwrap();
        let project = tempfile::TempDir::new().unwrap();
        let activation = FakeRequester {
            platform: RequesterPlatform::Windows,
            valid: true,
            grant: Ok(()),
            events: RefCell::new(Vec::new()),
            staged_registry: None,
        };
        let disposition = request_owner_focus(
            registry.path(),
            "requester",
            &owner(project.path()),
            0,
            Duration::from_secs(1),
            &ManualClock::at(1_000),
            &activation,
        );
        assert_eq!(
            disposition,
            TerminalDisposition::Failed(RouteFailure::DeadlineExpired)
        );
        assert_eq!(&*activation.events.borrow(), &["validate", "activate"]);
    }

    #[test]
    fn a_refused_windows_grant_never_arms_a_request() {
        let registry = tempfile::TempDir::new().unwrap();
        let project = tempfile::TempDir::new().unwrap();
        let activation = FakeRequester {
            platform: RequesterPlatform::Windows,
            valid: true,
            grant: Err(io::Error::new(io::ErrorKind::PermissionDenied, "denied")),
            events: RefCell::new(Vec::new()),
            staged_registry: None,
        };
        assert_eq!(
            request_owner_focus(
                registry.path(),
                "requester",
                &owner(project.path()),
                0,
                Duration::from_secs(1),
                &ManualClock::at(0),
                &activation
            ),
            TerminalDisposition::Failed(RouteFailure::ActivationRefused)
        );
        assert!(!lock::requests_dir(registry.path()).exists());
    }

    #[test]
    fn macos_stages_before_activation_and_arms_only_afterward() {
        let registry = tempfile::TempDir::new().unwrap();
        let project = tempfile::TempDir::new().unwrap();
        let activation = FakeRequester {
            platform: RequesterPlatform::MacOs,
            valid: true,
            grant: Err(io::Error::other("activation refused after durable prepare")),
            events: RefCell::new(Vec::new()),
            staged_registry: Some(registry.path().to_path_buf()),
        };
        assert_eq!(
            request_owner_focus(
                registry.path(),
                "requester",
                &owner(project.path()),
                0,
                Duration::from_secs(1),
                &ManualClock::at(0),
                &activation
            ),
            TerminalDisposition::Failed(RouteFailure::ActivationRefused)
        );
        assert_eq!(&*activation.events.borrow(), &["validate", "activate"]);
        assert!(lock::rendezvous_request_files(registry.path())
            .unwrap()
            .is_empty());
        assert!(lock::rendezvous_request_staging_files(registry.path())
            .unwrap()
            .iter()
            .all(|path| path
                .file_name()
                .is_some_and(|name| name == lock::REQUEST_STAGING_LOCK_FILE_NAME)));
    }

    struct FakeWindow {
        minimized: Cell<bool>,
        focused: Cell<bool>,
        events: RefCell<Vec<&'static str>>,
    }
    impl OwnerWindow for FakeWindow {
        fn unminimize(&self) -> io::Result<()> {
            self.events.borrow_mut().push("unminimize");
            self.minimized.set(false);
            Ok(())
        }
        fn show_if_needed(&self) -> io::Result<()> {
            self.events.borrow_mut().push("show");
            Ok(())
        }
        fn set_focus(&self) -> io::Result<()> {
            self.events.borrow_mut().push("focus");
            Ok(())
        }
        fn is_minimized(&self) -> io::Result<bool> {
            Ok(self.minimized.get())
        }
        fn is_focused(&self) -> io::Result<bool> {
            Ok(self.focused.get())
        }
    }

    fn armed_request(registry: &Path, id: Uuid) {
        let asked_at_ms = SystemClock.now_ms();
        lock::write_rendezvous_request(
            registry,
            &RendezvousRequest {
                schema_version: lock::RENDEZVOUS_SCHEMA_VERSION,
                request_id: id,
                requester_instance_id: "requester".to_string(),
                asked_at_ms,
                deadline_at_ms: asked_at_ms + 10_000,
            },
        )
        .unwrap();
    }

    #[test]
    fn a_minimized_owner_that_does_not_verify_focus_never_acknowledges_success() {
        let registry = tempfile::TempDir::new().unwrap();
        let project = tempfile::TempDir::new().unwrap();
        let ownership = lock::test_support::take(registry.path(), project.path(), "owner");
        let id = Uuid::new_v4();
        armed_request(registry.path(), id);
        let window = FakeWindow {
            minimized: Cell::new(true),
            focused: Cell::new(false),
            events: RefCell::new(Vec::new()),
        };
        assert!(answer_focus_request(&ownership, id, &ManualClock::at(1), &window).is_err());
        assert!(matches!(
            lock::read_rendezvous_outcome(registry.path(), id),
            RendezvousRead::Missing
        ));
        assert_eq!(&*window.events.borrow(), &["unminimize", "show", "focus"]);
    }

    #[test]
    fn a_post_raise_outcome_write_failure_leaves_the_visible_raise_without_a_false_ack() {
        let registry = tempfile::TempDir::new().unwrap();
        let project = tempfile::TempDir::new().unwrap();
        let ownership = lock::test_support::take(registry.path(), project.path(), "owner");
        let id = Uuid::new_v4();
        armed_request(registry.path(), id);
        std::fs::remove_dir(lock::outcomes_dir(registry.path())).unwrap();
        std::fs::write(lock::outcomes_dir(registry.path()), b"not a directory").unwrap();
        let window = FakeWindow {
            minimized: Cell::new(true),
            focused: Cell::new(true),
            events: RefCell::new(Vec::new()),
        };

        assert!(answer_focus_request(&ownership, id, &ManualClock::at(1), &window).is_err());
        assert_eq!(&*window.events.borrow(), &["unminimize", "show", "focus"]);
        assert!(matches!(
            lock::read_rendezvous_outcome(registry.path(), id),
            RendezvousRead::Missing | RendezvousRead::Corrupt
        ));
        assert!(matches!(
            lock::read_rendezvous_request(registry.path(), id),
            RendezvousRead::Valid(_)
        ));
    }

    struct ThreadWindow(std::sync::Mutex<(bool, bool, Vec<&'static str>)>);

    impl OwnerWindow for ThreadWindow {
        fn unminimize(&self) -> io::Result<()> {
            let mut state = self.0.lock().unwrap();
            state.0 = false;
            state.2.push("unminimize");
            Ok(())
        }

        fn show_if_needed(&self) -> io::Result<()> {
            self.0.lock().unwrap().2.push("show");
            Ok(())
        }

        fn set_focus(&self) -> io::Result<()> {
            let mut state = self.0.lock().unwrap();
            state.1 = true;
            state.2.push("focus");
            Ok(())
        }

        fn is_minimized(&self) -> io::Result<bool> {
            Ok(self.0.lock().unwrap().0)
        }

        fn is_focused(&self) -> io::Result<bool> {
            Ok(self.0.lock().unwrap().1)
        }
    }

    #[test]
    fn the_lock_owning_listener_observes_an_armed_request_and_is_the_only_focused_reporter() {
        let registry = tempfile::TempDir::new().unwrap();
        let project = tempfile::TempDir::new().unwrap();
        let ownership = lock::test_support::take(registry.path(), project.path(), "owner");
        let outcome_watcher = lock::RendezvousWatcher::watch_outcomes(registry.path()).unwrap();
        let window = Arc::new(ThreadWindow(std::sync::Mutex::new((
            true,
            false,
            Vec::new(),
        ))));
        let service =
            OwnerActivationService::start(registry.path().to_path_buf(), window.clone()).unwrap();
        let id = Uuid::new_v4();
        armed_request(registry.path(), id);

        // Windows signals the create before `write_all`/`sync_all` have necessarily completed.
        // The requester treats that event as a rescan hint, not as an acknowledgement; exercise
        // the same rule here and wait for the durable record rather than the first notification.
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            let _ = outcome_watcher
                .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
                .unwrap();
            if matches!(
                lock::read_rendezvous_outcome(registry.path(), id),
                RendezvousRead::Valid(ref outcome) if outcome.outcome == RouteSuccess::Focused
            ) {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "outcome never became durable"
            );
        }
        assert_eq!(
            window.0.lock().unwrap().2,
            vec!["unminimize", "show", "focus"]
        );
        drop(service);
        drop(ownership);
    }

    #[cfg(windows)]
    #[test]
    fn the_real_windows_owner_validator_accepts_this_live_test_process_and_rejects_a_recycled_address(
    ) {
        let project = tempfile::TempDir::new().unwrap();
        let live = LockOwner::new("this-test-process", project.path());
        assert!(SystemRequesterActivation.owner_is_live_cowrite(&live));

        let recycled = LockOwner {
            executable: Some(project.path().join("not-cowrite.exe")),
            ..live
        };
        assert!(!SystemRequesterActivation.owner_is_live_cowrite(&recycled));
    }
}
