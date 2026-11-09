// ABOUTME: D23 headless test driver binary — binds a loopback HTTP port and serves the app's
// ABOUTME: backend commands for e2e scripting. `test-driver [port]` (default 4711); dev/test only.

use std::net::TcpListener;

fn main() {
    let port: u16 = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(4711);
    let listener = TcpListener::bind(("127.0.0.1", port)).expect("bind test-driver loopback port");
    // The *actual* bound address, not the requested `port` arg: identical output for every fixed
    // port a caller names (Playwright always does), but also correct for `port 0` (OS-assigned
    // ephemeral), which `crates/test-driver/tests/http.rs`'s `ChildDriver` relies on to find this
    // process's real port without a bind-then-guess race (#1149 PR review, round 2).
    let addr = listener.local_addr().expect("listener has a local address");
    eprintln!("test-driver: listening on http://{addr}");
    test_driver::serve(listener);
}
