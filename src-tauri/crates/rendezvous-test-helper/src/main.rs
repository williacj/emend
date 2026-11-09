// ABOUTME: Minimal real-process owner used by the project-routing rendezvous integration test.
// ABOUTME: Takes the OS lock, receives one native-notified request, answers it, and exits.

use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;

use cowrite_lib::instances::{answer_request, RequestReceiver, RouteSuccess, SystemClock};
use cowrite_lib::store::lock::{self, LockOutcome, LockOwner};

fn main() {
    let mut args = std::env::args_os().skip(1);
    let registry_dir = PathBuf::from(args.next().expect("registry directory argument"));
    let project_root = PathBuf::from(args.next().expect("project root argument"));
    assert!(args.next().is_none(), "unexpected helper argument");

    let ownership = match lock::probe(
        &registry_dir,
        &LockOwner::new("cross-process-owner", &project_root),
    )
    .expect("take the real OS project lock")
    {
        LockOutcome::Acquired(guard) => guard,
        LockOutcome::HeldByAnotherInstance { .. } => panic!("test project was already held"),
    };
    let receiver = RequestReceiver::watch(&registry_dir).expect("watch requests natively");
    println!("RENDEZVOUS_HELPER_READY");
    std::io::stdout().flush().expect("publish readiness");

    let clock = SystemClock;
    let request = receiver
        .recv_timeout(&registry_dir, &clock, Duration::from_secs(30))
        .expect("receive request")
        .expect("request arrived before helper bound");
    let answer = answer_request(
        &registry_dir,
        request.request_id,
        RouteSuccess::Opened,
        &clock,
        || Ok(()),
    )
    .expect("answer request");
    assert!(
        matches!(answer, cowrite_lib::instances::AnswerStatus::Answered),
        "helper must publish the first and only answer"
    );
    drop(ownership);
}
