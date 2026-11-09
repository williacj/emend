// ABOUTME: Real parent and routed-child process used to prove launcher detachment on shipped OSes.
// ABOUTME: File handshakes make survival observable without inheriting child handles or stdio.

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use emend_lib::instances::{parse_startup_intent, DetachedLauncher, Launcher, StartupIntent};
use uuid::Uuid;

fn main() {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    match args.first().and_then(|arg| arg.to_str()) {
        Some("parent") | Some("parent-wait") | Some("parent-gated") => run_parent(&args),
        Some("--project") => run_child(args),
        _ => panic!("unknown detached-launcher helper mode"),
    }
}

fn run_parent(args: &[std::ffi::OsString]) {
    let root = PathBuf::from(args.get(1).expect("parent project root"));
    if args[0] == "parent-gated" {
        println!("PARENT_READY");
        std::io::stdout().flush().unwrap();
        let gate = root.join("parent.go");
        while !gate.exists() {
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    let request_id = Uuid::new_v4();
    match DetachedLauncher::for_executable(std::env::current_exe().unwrap())
        .launch(&root, request_id)
    {
        Ok(()) => println!("{request_id}"),
        Err(error) => {
            println!("UNAVAILABLE:{}", error.raw_os_error().unwrap_or(-1));
            std::io::stdout().flush().unwrap();
            return;
        }
    }
    std::io::stdout().flush().unwrap();
    if args[0] == "parent-wait" {
        loop {
            std::thread::park_timeout(Duration::from_secs(60));
        }
    }
}

fn run_child(args: Vec<std::ffi::OsString>) {
    let StartupIntent::Routed { root, request_id } = parse_startup_intent(args) else {
        panic!("launcher did not pass one exact routed startup intent")
    };
    fs::write(
        root.join(format!("{request_id}.ready")),
        std::process::id().to_string(),
    )
    .unwrap();
    let release = root.join(format!("{request_id}.release"));
    let deadline = Instant::now() + Duration::from_secs(120);
    while !release.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    if release.exists() {
        fs::write(root.join(format!("{request_id}.done")), b"done").unwrap();
    }
}
