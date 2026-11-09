// ABOUTME: TD-18 automatic-refresh integration tests — coalescing, event-during-refresh queueing,
// ABOUTME: retained snapshots on failure, and the started/completed/failed observer, without sleeps.

//! Every test here drives the **shipped** [`QuietWindowScheduler`] and [`AutomaticRefresh`]; only
//! the scheduler's settle barrier and the scanner are injected, so what is proven is the production
//! coalescing rule rather than a fake's. Barriers are channels the test releases explicitly, which
//! is what lets burst coalescing and "an event arrived mid-refresh" be pinned deterministically
//! instead of by sleeping and hoping (test-plan: no sleeps).

use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use emend_lib::agent::watchdog::{DocWatcher, Watchdog};
use emend_lib::project_files::{
    AutomaticRefresh, NativeEventSink, NativeRenameMode, NormalizedEvent, NormalizedEventKind,
    PlatformFileId, ProjectFileEntry, ProjectFiles, ProjectFilesError, ProjectFilesObserver,
    ProjectFilesScanner, ProjectFilesSnapshot, QuietWindowScheduler, RefreshScheduler,
};

/// A settle barrier the test opens by hand: one `release()` admits exactly one coalesced run, so
/// every event queued before that call belongs to that run and every event queued after it does not.
///
/// It also counts the windows that actually elapsed, which is what makes the *cost* of a burst
/// observable: coalescing the batch alone still leaves one surplus run per notification, and each
/// of those pays a full quiet window before finding the batch already taken.
struct SettleGate {
    open: Sender<()>,
    admit: Mutex<Receiver<()>>,
    settled: AtomicUsize,
}

impl SettleGate {
    fn new() -> (Arc<SettleGate>, Arc<dyn Fn() + Send + Sync>) {
        let (open, admit) = mpsc::channel();
        let gate = Arc::new(SettleGate {
            open,
            admit: Mutex::new(admit),
            settled: AtomicUsize::new(0),
        });
        let settle = Arc::clone(&gate);
        (gate, Arc::new(move || settle.wait()))
    }

    fn wait(&self) {
        if self.admit.lock().unwrap().recv().is_ok() {
            self.settled.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn release(&self) {
        self.open.send(()).unwrap();
    }

    /// How many quiet windows the scheduler has actually waited out. Read only once a later run's
    /// completion has been observed and no task remains queued, where the worker is parked on its
    /// request channel and the count can no longer move.
    fn settled(&self) -> usize {
        self.settled.load(Ordering::SeqCst)
    }
}

/// Records the automatic-refresh lifecycle and lets the test *wait* for a transition rather than
/// poll for one.
struct RecordingObserver {
    transitions: Mutex<Vec<String>>,
    settled: Sender<Result<ProjectFilesSnapshot, ProjectFilesError>>,
}

impl RecordingObserver {
    fn new() -> (
        Arc<RecordingObserver>,
        Receiver<Result<ProjectFilesSnapshot, ProjectFilesError>>,
    ) {
        let (settled, outcomes) = mpsc::channel();
        (
            Arc::new(RecordingObserver {
                transitions: Mutex::new(Vec::new()),
                settled,
            }),
            outcomes,
        )
    }

    fn transitions(&self) -> Vec<String> {
        self.transitions.lock().unwrap().clone()
    }
}

impl ProjectFilesObserver for RecordingObserver {
    fn refresh_started(&self) {
        self.transitions.lock().unwrap().push("started".to_string());
    }

    fn refresh_completed(&self, snapshot: &ProjectFilesSnapshot) {
        self.transitions
            .lock()
            .unwrap()
            .push("completed".to_string());
        self.settled.send(Ok(snapshot.clone())).unwrap();
    }

    fn refresh_failed(&self, error: &ProjectFilesError) {
        self.transitions.lock().unwrap().push("failed".to_string());
        self.settled.send(Err(error.clone())).unwrap();
    }
}

/// Returns one scripted result per scan, and reports how many scans actually ran — the direct
/// measure of "a burst is one refresh, not one refresh per event".
struct CountingScanner {
    results: Mutex<Vec<Result<Vec<ProjectFileEntry>, ProjectFilesError>>>,
    scans: Mutex<usize>,
}

impl CountingScanner {
    fn new(results: Vec<Result<Vec<ProjectFileEntry>, ProjectFilesError>>) -> Arc<CountingScanner> {
        Arc::new(CountingScanner {
            results: Mutex::new(results.into_iter().rev().collect()),
            scans: Mutex::new(0),
        })
    }

    fn scans(&self) -> usize {
        *self.scans.lock().unwrap()
    }
}

impl ProjectFilesScanner for CountingScanner {
    fn scan(&self, _root: &Path) -> Result<Vec<ProjectFileEntry>, ProjectFilesError> {
        *self.scans.lock().unwrap() += 1;
        self.results
            .lock()
            .unwrap()
            .pop()
            .expect("the scanner was asked for more results than the test scripted")
    }
}

/// A scanner that parks inside the *refresh itself*, so the test can queue a native event while a
/// refresh is genuinely in flight.
struct ParkingScanner {
    results: Mutex<Vec<Result<Vec<ProjectFileEntry>, ProjectFilesError>>>,
    entered: Sender<()>,
    resume: Mutex<Receiver<()>>,
    park_scan: usize,
    scans: Mutex<usize>,
}

impl ProjectFilesScanner for ParkingScanner {
    fn scan(&self, _root: &Path) -> Result<Vec<ProjectFileEntry>, ProjectFilesError> {
        let scan = {
            let mut scans = self.scans.lock().unwrap();
            *scans += 1;
            *scans
        };
        if scan == self.park_scan {
            self.entered.send(()).unwrap();
            self.resume.lock().unwrap().recv().unwrap();
        }
        self.results
            .lock()
            .unwrap()
            .pop()
            .expect("the scanner was asked for more results than the test scripted")
    }
}

/// Admits one run on its own worker and, on drop, releases the parked scan **before** joining it.
/// That is precisely production's interleaving on a project close or replace: `AutomaticRefresh`'s
/// own [`Drop`] runs before its scheduler field is dropped, and `QuietWindowScheduler::drop` then
/// joins a scan that is already under way. Nothing a test can do from the outside reproduces that
/// ordering deterministically, because the moment the teardown becomes observable is inside `Drop`.
struct ReleaseOnDropScheduler {
    release: Mutex<Option<Sender<()>>>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl RefreshScheduler for ReleaseOnDropScheduler {
    fn request(&self, task: Arc<dyn Fn() + Send + Sync>) {
        let mut worker = self.worker.lock().unwrap();
        assert!(worker.is_none(), "this scheduler admits exactly one run");
        *worker = Some(std::thread::spawn(move || task()));
    }
}

impl Drop for ReleaseOnDropScheduler {
    fn drop(&mut self) {
        if let Some(release) = self.release.lock().unwrap().take() {
            release.send(()).unwrap();
        }
        if let Some(worker) = self.worker.lock().unwrap().take() {
            worker.join().unwrap();
        }
    }
}

fn identified_file(path: &str, id: u128) -> ProjectFileEntry {
    ProjectFileEntry {
        path: path.to_string(),
        name: path.rsplit('/').next().unwrap_or(path).to_string(),
        kind: emend_lib::project_files::EntryKind::File,
        platform_file_id: Some(PlatformFileId::opaque(0, id)),
        children: Vec::new(),
        warning: None,
    }
}

fn paths(entries: &[ProjectFileEntry]) -> Vec<&str> {
    entries.iter().map(|entry| entry.path.as_str()).collect()
}

fn content_event(path: &str) -> NormalizedEvent {
    NormalizedEvent {
        kind: NormalizedEventKind::Other,
        paths: vec![path.to_string()],
        tracker: None,
    }
}

fn rename_event(paths: &[&str]) -> NormalizedEvent {
    NormalizedEvent {
        kind: NormalizedEventKind::Rename(NativeRenameMode::Any),
        paths: paths.iter().map(|path| path.to_string()).collect(),
        tracker: None,
    }
}

fn automatic(
    root: &Path,
    scanner: Arc<dyn ProjectFilesScanner>,
    settle: Arc<dyn Fn() + Send + Sync>,
    observer: Arc<dyn ProjectFilesObserver>,
) -> (Arc<ProjectFiles>, AutomaticRefresh) {
    let project_files = Arc::new(ProjectFiles::with_scanner(root, scanner));
    let refresh = AutomaticRefresh::new(
        Arc::clone(&project_files),
        Arc::new(QuietWindowScheduler::settling(settle)),
        Some(observer),
    );
    (project_files, refresh)
}

/// One editor save emits several native notifications on both shipped platforms. The whole burst
/// must produce **one** completed generation, not one per notification.
#[test]
fn a_native_event_burst_coalesces_into_exactly_one_automatic_refresh() {
    let dir = tempfile::TempDir::new().unwrap();
    let scanner = CountingScanner::new(vec![
        Ok(vec![identified_file("draft.md", 1)]),
        Ok(vec![identified_file("draft.md", 1)]),
    ]);
    let (gate, settle) = SettleGate::new();
    let (observer, outcomes) = RecordingObserver::new();
    let (project_files, refresh) = automatic(
        dir.path(),
        Arc::clone(&scanner) as Arc<dyn ProjectFilesScanner>,
        settle,
        Arc::clone(&observer) as Arc<dyn ProjectFilesObserver>,
    );

    refresh.observe(content_event("draft.md"));
    refresh.observe(content_event("draft.md"));
    refresh.observe(content_event("notes/outline.md"));
    gate.release();

    let snapshot = outcomes
        .recv()
        .unwrap()
        .expect("the burst refresh completes");
    assert_eq!(snapshot.generation, 1);

    // Admit two further runs — one per notification the burst folded in. An uncoalesced scheduler
    // would scan and publish here; a coalesced one has nothing left to do. The sentinel burst below
    // is what makes that observable without sleeping: the worker is serial and the gate is FIFO, so
    // any spurious run would have completed *before* the sentinel's own completion arrives.
    gate.release();
    gate.release();
    refresh.observe(content_event("draft.md"));
    gate.release();
    let sentinel = outcomes
        .recv()
        .unwrap()
        .expect("the sentinel refresh completes");

    assert_eq!(
        sentinel.generation, 2,
        "three notifications must coalesce into one serialized refresh"
    );
    assert_eq!(scanner.scans(), 2);
    assert_eq!(
        observer.transitions(),
        vec!["started", "completed", "started", "completed"]
    );
    // Two windows for two refreshes. Scans alone cannot catch a scheduler that forgot to drain the
    // requests its burst folded in: those surplus runs find the batch already taken and scan
    // nothing, but each one has already waited out a full window first — on the shipped 150 ms
    // window that is the whole latency budget of the rail update, spent per notification.
    assert_eq!(
        gate.settled(),
        2,
        "a coalesced burst must cost one quiet window, not one per notification"
    );
    assert_eq!(
        project_files.latest_snapshot().unwrap().generation,
        2,
        "the automatic path publishes through the same service as first load and [Refresh]"
    );
}

/// The burst's evidence must reach reconciliation — an automatic refresh calls the service's
/// event-carrying operation, not the bare one, so a coalesced rename is still correlated.
#[test]
fn the_coalesced_batch_reaches_reconciliation_with_its_rename_evidence() {
    let dir = tempfile::TempDir::new().unwrap();
    let scanner = CountingScanner::new(vec![
        Ok(vec![identified_file("draft.md", 1)]),
        Ok(vec![identified_file("renamed.md", 1)]),
    ]);
    let (gate, settle) = SettleGate::new();
    let (observer, outcomes) = RecordingObserver::new();
    let (_project_files, refresh) = automatic(
        dir.path(),
        Arc::clone(&scanner) as Arc<dyn ProjectFilesScanner>,
        settle,
        Arc::clone(&observer) as Arc<dyn ProjectFilesObserver>,
    );

    refresh.observe(content_event("draft.md"));
    gate.release();
    let first = outcomes.recv().unwrap().unwrap();
    assert!(first.moves.is_empty());

    refresh.observe(rename_event(&["draft.md", "renamed.md"]));
    gate.release();
    let second = outcomes.recv().unwrap().unwrap();

    assert_eq!(second.generation, 2);
    assert_eq!(second.moves.len(), 1, "the rename evidence was carried in");
    assert_eq!(second.moves[0].old_path, "draft.md");
    assert_eq!(second.moves[0].new_path, "renamed.md");
}

/// An event that lands while a refresh is already scanning must not be folded into that run's
/// already-drained batch, nor dropped: it belongs to the next reconciliation.
#[test]
fn an_event_arriving_during_a_refresh_is_queued_for_a_subsequent_reconciliation() {
    let dir = tempfile::TempDir::new().unwrap();
    let (entered, scan_started) = mpsc::channel();
    let (release_scan, resume) = mpsc::channel();
    let scanner = Arc::new(ParkingScanner {
        results: Mutex::new(
            vec![
                Ok(vec![identified_file("draft.md", 1)]),
                Ok(vec![identified_file("renamed.md", 1)]),
            ]
            .into_iter()
            .rev()
            .collect(),
        ),
        entered,
        resume: Mutex::new(resume),
        park_scan: 1,
        scans: Mutex::new(0),
    });
    let (gate, settle) = SettleGate::new();
    let (observer, outcomes) = RecordingObserver::new();
    let (_project_files, refresh) = automatic(
        dir.path(),
        Arc::clone(&scanner) as Arc<dyn ProjectFilesScanner>,
        settle,
        Arc::clone(&observer) as Arc<dyn ProjectFilesObserver>,
    );

    refresh.observe(content_event("draft.md"));
    gate.release();
    scan_started.recv().unwrap();

    // The rename lands mid-scan. The first refresh has already taken its batch, so this evidence
    // must survive to the next one rather than being consumed by a run that cannot see it.
    refresh.observe(rename_event(&["draft.md", "renamed.md"]));
    release_scan.send(()).unwrap();

    let first = outcomes.recv().unwrap().unwrap();
    assert_eq!(first.generation, 1);
    // Deliberately no `first.moves.is_empty()` assertion: generation 1 has no previous snapshot to
    // reconcile against, so it could not carry a move however the batch had been handled — such an
    // assertion would pass at every head and prove nothing. The whole claim rides on `second` below:
    // had the in-flight refresh consumed the mid-scan rename, generation 2's scan would find the
    // renamed tree with no rename evidence left to correlate it, and report no move at all.
    assert_eq!(paths(&first.entries), vec!["draft.md"]);

    gate.release();
    let second = outcomes.recv().unwrap().unwrap();
    assert_eq!(second.generation, 2);
    assert_eq!(second.moves.len(), 1);
    assert_eq!(second.moves[0].new_path, "renamed.md");
}

/// A refresh that cannot produce a trustworthy result reports the typed failure and leaves the last
/// completed generation exactly where it was — J2 keeps showing a tree, and nothing takes focus.
#[test]
fn a_failed_automatic_refresh_retains_the_last_completed_snapshot_and_reports_the_typed_failure() {
    let dir = tempfile::TempDir::new().unwrap();
    let scanner = CountingScanner::new(vec![
        Ok(vec![identified_file("draft.md", 1)]),
        Err(ProjectFilesError::UpdateFailed(
            "enumeration could not complete".to_string(),
        )),
    ]);
    let (gate, settle) = SettleGate::new();
    let (observer, outcomes) = RecordingObserver::new();
    let (project_files, refresh) = automatic(
        dir.path(),
        Arc::clone(&scanner) as Arc<dyn ProjectFilesScanner>,
        settle,
        Arc::clone(&observer) as Arc<dyn ProjectFilesObserver>,
    );

    refresh.observe(content_event("draft.md"));
    gate.release();
    let completed = outcomes.recv().unwrap().unwrap();

    refresh.observe(content_event("draft.md"));
    gate.release();
    let failure = outcomes.recv().unwrap().unwrap_err();

    assert!(matches!(failure, ProjectFilesError::UpdateFailed(_)));
    assert_eq!(
        observer.transitions(),
        vec!["started", "completed", "started", "failed"]
    );
    let retained = project_files.latest_snapshot().unwrap();
    assert_eq!(retained.generation, completed.generation);
    assert_eq!(retained.entries, completed.entries);
}

/// The failed batch is retained by the service, not discarded by the automatic path: the next
/// coalesced refresh still correlates the rename the failed one carried.
#[test]
fn a_failed_automatic_refresh_does_not_consume_the_events_it_carried() {
    let dir = tempfile::TempDir::new().unwrap();
    let scanner = CountingScanner::new(vec![
        Ok(vec![identified_file("draft.md", 1)]),
        Err(ProjectFilesError::UpdateFailed(
            "enumeration could not complete".to_string(),
        )),
        Ok(vec![identified_file("renamed.md", 1)]),
    ]);
    let (gate, settle) = SettleGate::new();
    let (observer, outcomes) = RecordingObserver::new();
    let (_project_files, refresh) = automatic(
        dir.path(),
        Arc::clone(&scanner) as Arc<dyn ProjectFilesScanner>,
        settle,
        Arc::clone(&observer) as Arc<dyn ProjectFilesObserver>,
    );

    refresh.observe(content_event("draft.md"));
    gate.release();
    outcomes.recv().unwrap().unwrap();

    refresh.observe(rename_event(&["draft.md", "renamed.md"]));
    gate.release();
    outcomes.recv().unwrap().unwrap_err();

    // A later, evidence-free burst: the only rename evidence available is the retained batch.
    refresh.observe(content_event("renamed.md"));
    gate.release();
    let recovered = outcomes.recv().unwrap().unwrap();

    assert_eq!(recovered.generation, 2);
    assert_eq!(
        recovered.moves.len(),
        1,
        "the failed refresh's evidence must survive for the next one"
    );
    assert_eq!(recovered.moves[0].old_path, "draft.md");
}

/// The announcement channel carries no project identity — `started`/`completed`/`failed` and
/// nothing else — and `generation` is per-service, so it cannot order across projects either.
/// `commands::project::open_project_on` installs the incoming project *before* it drops the
/// outgoing one, so a completion announced from a scan that was already running when the project
/// closed would reach the frontend describing a project the user has already left, carrying a
/// higher generation than the new project's own first one: the rail would paint the outgoing
/// project's tree into the new project until something else refreshed it. A closing project
/// therefore announces nothing further. Its own service still finishes the generation — the run is
/// not aborted mid-scan, it simply has no audience left (#928 review note on PR #1314).
#[test]
fn a_refresh_still_running_when_the_project_closes_announces_nothing_further() {
    let dir = tempfile::TempDir::new().unwrap();
    let (entered, scan_started) = mpsc::channel();
    let (release_scan, resume) = mpsc::channel();
    let scanner = Arc::new(ParkingScanner {
        results: Mutex::new(vec![Ok(vec![identified_file("draft.md", 1)])]),
        entered,
        resume: Mutex::new(resume),
        park_scan: 1,
        scans: Mutex::new(0),
    });
    let (observer, _outcomes) = RecordingObserver::new();
    let project_files = Arc::new(ProjectFiles::with_scanner(
        dir.path(),
        Arc::clone(&scanner) as Arc<dyn ProjectFilesScanner>,
    ));
    let refresh = AutomaticRefresh::new(
        Arc::clone(&project_files),
        Arc::new(ReleaseOnDropScheduler {
            release: Mutex::new(Some(release_scan)),
            worker: Mutex::new(None),
        }),
        Some(Arc::clone(&observer) as Arc<dyn ProjectFilesObserver>),
    );

    refresh.observe(content_event("draft.md"));
    // The scan is genuinely in flight — past the point where abandoning an unstarted run could help.
    scan_started.recv().unwrap();

    drop(refresh);

    assert_eq!(
        observer.transitions(),
        vec!["started"],
        "a project that is closing must not announce the generation it was still computing"
    );
    assert_eq!(
        project_files.latest_snapshot().unwrap().generation,
        1,
        "the run completed against its own service; only the announcement was withheld"
    );
}

/// The silence above is hung on `AutomaticRefresh`'s own [`Drop`], so it is worth exactly as much
/// as the claim that closing a project reaches that drop. `OpenProject::open` hands the sole
/// `Arc<AutomaticRefresh>` to `DocWatcher::watch` and lists the watcher first among its fields so it
/// is dropped first; this drives that production composition — the shipped sink, the real watcher —
/// and asserts the link the test above cannot, because that one drops the sink by hand.
#[test]
fn closing_the_watch_releases_the_only_reference_to_the_automatic_refresh_sink() {
    let dir = tempfile::TempDir::new().unwrap();
    let watchdog = Arc::new(Mutex::new(Watchdog::new(dir.path())));
    let project_files = Arc::new(ProjectFiles::new(dir.path()));
    let sink = Arc::new(AutomaticRefresh::shipped(project_files, None));
    let released = Arc::downgrade(&sink);

    let watcher = DocWatcher::watch(dir.path(), watchdog, sink).unwrap();
    assert!(
        released.upgrade().is_some(),
        "the watcher holds the sink for as long as the project is open"
    );

    drop(watcher);

    assert!(
        released.upgrade().is_none(),
        "closing the project must drop its automatic-refresh sink — that drop is what silences it"
    );
}

/// Closing or switching a project drops the scheduler on the **synchronous** command thread the
/// webview is awaiting (`commands::project::close_project` / `open_project`), and any visible write
/// under the root — the user's own save — opens a quiet window. A run that has not started can only
/// describe a project that is no longer open, so the drop must release the window and abandon it
/// rather than wait it out and scan.
///
/// Drives the shipped [`QuietWindowScheduler`] with its real `sleep`-based window, deliberately set
/// far longer than any close should take: the elapsed bound and the un-run tasks both redden if the
/// drop waits the window out.
#[test]
fn dropping_the_scheduler_abandons_runs_that_have_not_started_instead_of_waiting_out_the_window() {
    let window = Duration::from_secs(30);
    let ran = Arc::new(AtomicUsize::new(0));
    let scheduler = QuietWindowScheduler::new(window);
    for _ in 0..3 {
        let ran = Arc::clone(&ran);
        scheduler.request(Arc::new(move || {
            ran.fetch_add(1, Ordering::SeqCst);
        }));
    }

    let closing = Instant::now();
    drop(scheduler);
    let closing = closing.elapsed();

    // Two independent claims, asserted in the order that lets each be proven on its own: releasing
    // the window (reddened by dropping the shutdown signal, which restores the full wait) and
    // abandoning the run (reddened by dropping the guard, which still closes fast but scans).
    assert!(
        closing < window / 10,
        "closing the project waited out the quiet window ({closing:?})"
    );
    assert_eq!(
        ran.load(Ordering::SeqCst),
        0,
        "a project that is closing must not start a refresh of the project it is closing"
    );
}
