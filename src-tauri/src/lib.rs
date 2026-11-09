// ABOUTME: Tauri application setup for the Cowrite shell — installs the native menu, registers the
// ABOUTME: IPC commands, and runs the app. The backend holds all authority (TD-2).
pub mod agent;
pub mod commands;
pub mod gitops;
pub mod instances;
mod menu;
pub use menu::{OPEN_DOCUMENT_EVENT, SAVE_DOCUMENT_AS_EVENT};
pub mod project_files;
pub mod skills;
pub mod store;
#[cfg(test)]
pub mod test_support;
pub mod voice;

pub fn run() {
    use tauri::Manager;

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .menu(menu::build)
        // Routes each native File action through its pure, unit-tested id predicate. Dialogs stay
        // on the frontend (`stores/menu.ts`), so this handler only announces which action fired.
        .on_menu_event(|app, event| {
            if menu::is_open_document_event(&event) {
                menu::notify_open_document_requested(app);
            } else if menu::is_save_document_as_event(&event) {
                menu::notify_save_document_as_requested(app);
            }
        })
        // Built in `.setup()`, not `.manage()` directly: the FR-X-3 live push
        // (`commands::agent::TauriActivityEmitter`) needs a real `AppHandle` to emit through, and
        // that only exists once the app is this far along (P2a integration #345 — this app's
        // first event-emission pattern; see the P2a-21 journal entry).
        .setup(|app| {
            let handle = app.handle().clone();
            let settings_path = store::settings::settings_file(&app.path().app_config_dir()?);
            let settings_observer: std::sync::Arc<dyn store::settings::SettingsObserver> =
                std::sync::Arc::new(commands::settings::TauriSettingsEmitter(handle.clone()));
            let settings = store::settings::SettingsService::watch(
                &settings_path,
                std::sync::Arc::clone(&settings_observer),
            )
            .unwrap_or_else(|error| {
                eprintln!(
                    "Cowrite could not watch settings; continuing without live settings updates: {error}"
                );
                store::settings::SettingsService::degraded(&settings_path, settings_observer)
            });
            app.manage(settings);
            // This app instance's one open project (TD-17, M7: one per instance) — `None` until
            // `commands::project::open_project` binds one. It is managed state *and* captured by
            // the run spawner below, so every spawned CLI is auto-wired to that project's Cowrite
            // tool surface with no user configuration step (TD-1), and the per-session bearer token
            // lives exactly as long as the project session (FR-X-2).
            let session = commands::project::new_session();
            let spawn_session = std::sync::Arc::clone(&session);
            let queue = agent::run_queue::RunQueue::with_observers(
                move |request: &agent::run_queue::RunRequest| {
                    commands::agent::spawn_claude_run(&spawn_session, request)
                },
                std::sync::Arc::new(commands::agent::TauriActivityEmitter(handle)),
                std::sync::Arc::new(agent::project::OpenProjectRunObserver::new(
                    std::sync::Arc::clone(&session),
                )),
            );
            let app_local_data_dir = app.path().app_local_data_dir()?;
            app.manage(std::sync::Arc::new(voice::settings::production_runtime(&app_local_data_dir)));
            let registry = std::sync::Arc::new(instances::InstanceRegistry::new(&app_local_data_dir));
            let intent = instances::parse_startup_intent(std::env::args_os().skip(1));
            let completion = instances::route_startup_intent(
                intent,
                registry.as_ref(),
                &session,
                &app_local_data_dir,
                commands::project::tauri_observers(app.handle()),
            );
            app.manage(std::sync::Arc::clone(&registry));
            app.manage(std::sync::Arc::clone(&session));
            app.manage(queue);
            app.manage(commands::comments::ReconciledDocs::default());
            app.manage(commands::tabs::TabSessionCoordinator::new(
                app.path().app_local_data_dir()?,
            ));
            app.manage(commands::adoption::AdoptionCoordinator::new(
                app.path().app_local_data_dir()?,
            ));
            // One exhaustive finalizer after every routing branch (AC3): setup cannot return with
            // the configured window both alive and permanently hidden. State is managed before a
            // Show completion so the first frontend hydration request cannot race setup.
            instances::finalize_startup(
                completion,
                || {
                    app.get_webview_window("main")
                        .ok_or_else(|| std::io::Error::other("main window was not created"))?
                        .show()
                        .map_err(std::io::Error::other)
                },
                || app.handle().exit(0),
            )?;
            if completion == instances::StartupCompletion::Show {
                if let Some(window) = app.get_webview_window("main") {
                    let owner_window =
                        std::sync::Arc::new(instances::activator::TauriOwnerWindow(window));
                    if let Err(error) = commands::project::install_owner_activation_on(
                        &session,
                        &app_local_data_dir,
                        owner_window,
                    ) {
                        // The current owner stays usable; a requester receives the normal bounded
                        // rendezvous failure rather than an invented focused result.
                        eprintln!(
                            "Cowrite could not start the project activation listener: {error:?}"
                        );
                    }
                }
            }
            let owner_window = app
                .get_webview_window("main")
                .ok_or_else(|| std::io::Error::other("main window was not created"))?;
            let router = instances::ProjectRouter::production(
                registry,
                agent::project::ProjectRoutingSession::new(std::sync::Arc::clone(&session)),
                app_local_data_dir,
                commands::project::tauri_observers(app.handle()),
                std::sync::Arc::new(commands::project::TauriProjectRoutingEmitter(
                    app.handle().clone(),
                )),
                std::sync::Arc::new(instances::activator::TauriOwnerWindow(owner_window)),
            )?;
            app.manage(std::sync::Arc::new(router));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::agent::start_run,
            commands::agent::stop_run,
            commands::agent::run_state,
            commands::agent::permission_state,
            commands::agent::decide_permission,
            commands::adoption::prepare_adoption,
            commands::adoption::land_adoption,
            commands::adoption::commit_adoption,
            commands::adoption::cancel_adoption,
            commands::adoption::reconcile_adoptions,
            commands::adoption::mint_untitled_doc_id,
            commands::project::open_project,
            commands::project::route_project_open,
            commands::project::close_project,
            commands::project::current_project,
            commands::project::refresh_project_files,
            commands::project::project_path_is_enumerable,
            commands::comments::load_comment_threads,
            commands::comments::create_comment,
            commands::comments::reply_comment,
            commands::comments::reply_comment_for_run,
            commands::comments::revise_own_comment,
            commands::comments::withdraw_own_comment,
            commands::comments::resolve_comment,
            commands::comments::reopen_comment,
            commands::comments::re_anchor_comment,
            commands::comments::start_address_run,
            commands::comments::conclude_address_run,
            commands::comments::link_changes,
            commands::comments::link_changes_for_run,
            commands::comments::decide_linked_changes,
            commands::comments::load_comment_threads_by_id,
            commands::comments::create_comment_by_id,
            commands::comments::reply_comment_by_id,
            commands::comments::revise_own_comment_by_id,
            commands::comments::withdraw_own_comment_by_id,
            commands::comments::resolve_comment_by_id,
            commands::comments::reopen_comment_by_id,
            commands::comments::re_anchor_comment_by_id,
            commands::comments::decide_linked_changes_by_id,
            commands::diagnostics::report_render_failure,
            commands::changes::parse_changes,
            commands::changes::parse_changes_by_id,
            commands::document::open_document,
            commands::document::save_document,
            commands::document::save_document_as,
            commands::document::recreate_missing_document_capability,
            commands::document::recreate_missing_document,
            commands::document::capture_anchor,
            commands::document::resolve_anchor,
            commands::providers::detect_providers,
            commands::skills::discover_grounding,
            commands::settings::get_settings,
            commands::settings::patch_settings,
            commands::voice::get_voice_status,
            commands::voice::set_voice_enabled,
            commands::voice::select_voice_input_device,
            commands::voice::download_voice_model,
            commands::voice::cancel_voice_download,
            commands::voice::remove_voice_model,
            commands::voice::start_voice_dictation,
            commands::voice::stop_voice_dictation,
            commands::voice::cancel_voice_dictation,
            commands::transcript::append_transcript_event,
            commands::transcript::load_transcript,
            commands::tabs::begin_tab_session,
            commands::tabs::save_tab_session,
            commands::tabs::prove_tab_session,
            commands::tabs::end_tab_session,
            commands::tabs::load_tab_session,
            commands::tabs::set_open_tabs,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
