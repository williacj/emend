// ABOUTME: Resolves the window-lifecycle IPC the quit path calls against Tauri's real runtime
// ABOUTME: authority, so a capability the app depends on cannot go ungranted unnoticed (#2327).

use tauri::ipc::Origin;

/// `closeWindow` (`src/stores/appLifecycle.ts`) ends every quit with `getCurrentWindow().destroy()`.
/// That command is deliberately absent from `core:window:default`, so `capabilities/default.json`
/// has to grant it by name; without the grant the ACL refuses the IPC and the window can never be
/// closed from inside the app. Every frontend test mocks `destroy`, so the grant is exercised
/// nowhere else.
#[test]
fn the_main_window_may_destroy_itself() {
    let mut context: tauri::Context<tauri::Wry> = tauri::generate_context!();
    let authority = context.runtime_authority_mut();

    assert!(
        authority
            .resolve_access("plugin:window|destroy", "main", "main", &Origin::Local)
            .is_some(),
        "the main window may not destroy itself — quitting Cowrite is impossible without this grant"
    );
    // The same resolver denies a command no capability grants, so the assertion above is a real
    // question about `destroy` and not a lookup that answers `Some` for anything.
    assert!(
        authority
            .resolve_access(
                "plugin:window|not_a_real_command",
                "main",
                "main",
                &Origin::Local
            )
            .is_none(),
        "the ACL resolver allowed a command no capability grants"
    );
}
