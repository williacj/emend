// ABOUTME: Native application menu (FR-X-1) with File > Open… and Save As… routes using
// ABOUTME: platform-aware Cmd/Ctrl accelerators and frontend event bridges.
use tauri::menu::{Menu, MenuEvent, MenuItem, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};

const FILE_MENU_ID: &str = "file";
const SAVE_DOCUMENT_AS_LABEL: &str = "Save As…";
const SAVE_DOCUMENT_AS_ACCELERATOR: &str = "CmdOrCtrl+Shift+S";

/// The `File > Open…` item's id — `lib.rs`'s `on_menu_event` handler compares every fired event's
/// id against this constant ([`is_open_document_event`]) to decide whether to raise the picker.
pub const OPEN_DOCUMENT_MENU_ID: &str = "open_document";
/// The general `File > Save As…` item's id (#1519, FR-ED-2/FR-ED-8).
pub const SAVE_DOCUMENT_AS_MENU_ID: &str = "save_document_as";

/// The event `notify_open_document_requested` emits when `File > Open…` fires. The frontend's
/// `stores/menu.ts` `listenForOpenDocumentRequests` is this string's only consumer — change both
/// together (mirrors `commands::agent::ACTIVITY_EVENT`'s identical doc note). Carries no payload:
/// the native file picker itself runs on the frontend (`stores/menu.ts`'s `pickDocumentFile`,
/// mirroring `onboarding/ipc.ts`'s `pickProjectFolder` precedent) since only that side knows which
/// project root a chosen path should resolve against.
pub const OPEN_DOCUMENT_EVENT: &str = "emend://menu/open-document";
/// The frontend signal emitted when the native `File > Save As…` item fires.
pub const SAVE_DOCUMENT_AS_EVENT: &str = "emend://menu/save-document-as";

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;

    #[cfg(target_os = "macos")]
    {
        let app_menu = SubmenuBuilder::new(app, "Emend")
            .about(None)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;
        menu.append(&app_menu)?;
    }

    let file = {
        let open_document = MenuItemBuilder::with_id(OPEN_DOCUMENT_MENU_ID, "Open…")
            .accelerator("CmdOrCtrl+O")
            .build(app)?;
        // No saved document exists at launch. `commands::tabs::set_open_tabs` enables this when the
        // active tab names a member of the live ordinary-document set; untitled recovery buffers
        // remain #1379's lifecycle even when an ordinary document is open behind one.
        let save_document_as =
            MenuItemBuilder::with_id(SAVE_DOCUMENT_AS_MENU_ID, SAVE_DOCUMENT_AS_LABEL)
                .enabled(save_document_as_available(&[], None))
                .accelerator(SAVE_DOCUMENT_AS_ACCELERATOR)
                .build(app)?;
        let builder = SubmenuBuilder::with_id(app, FILE_MENU_ID, "File")
            .item(&open_document)
            .item(&save_document_as)
            .separator()
            .close_window();
        #[cfg(not(target_os = "macos"))]
        let builder = builder.separator().quit();
        builder.build()?
    };
    menu.append(&file)?;

    let edit = {
        let builder = SubmenuBuilder::new(app, "Edit");
        #[cfg(target_os = "macos")]
        let builder = builder.undo().redo().separator();
        builder.cut().copy().paste().select_all().build()?
    };
    menu.append(&edit)?;

    let help = SubmenuBuilder::new(app, "Help").about(None).build()?;
    menu.append(&help)?;

    Ok(menu)
}

/// Whether `event` is `File > Open…` firing — the pure routing decision `lib.rs`'s
/// `on_menu_event` handler acts on, factored out so it is unit-testable without a live window:
/// `tauri::menu::MenuEvent`'s `id` field is a plain `MenuId(String)`, constructible with no
/// `AppHandle`/`Menu` at all (see the tests below).
pub fn is_open_document_event(event: &MenuEvent) -> bool {
    event.id().as_ref() == OPEN_DOCUMENT_MENU_ID
}

/// Whether `event` is the general `File > Save As…` route firing.
pub fn is_save_document_as_event(event: &MenuEvent) -> bool {
    event.id().as_ref() == SAVE_DOCUMENT_AS_MENU_ID
}

/// The active saved project document makes the general Save As entry available. `paths` is the
/// same live ordinary-document set D21 receives; requiring `active_path` to name a member makes the
/// item fail closed when the active tab is an untitled recovery buffer (or no tab at all).
pub fn save_document_as_available(paths: &[String], active_path: Option<&str>) -> bool {
    active_path.is_some_and(|active| paths.iter().any(|path| path == active))
}

/// Retrieves the one native Save As item from the installed File submenu.
fn save_document_as_item<R: Runtime>(app: &AppHandle<R>) -> Option<MenuItem<R>> {
    app.menu()?
        .get(FILE_MENU_ID)?
        .as_submenu()?
        .get(SAVE_DOCUMENT_AS_MENU_ID)?
        .as_menuitem()
        .cloned()
}

/// Keeps the native item's enabled state aligned with whether the active tab is an ordinary
/// project document. Missing-on-disk documents remain ordinary project documents; untitled
/// recovery buffers stay outside #1519's scope even when an ordinary document is open behind one.
pub fn set_save_document_as_enabled<R: Runtime>(
    app: &AppHandle<R>,
    enabled: bool,
) -> tauri::Result<()> {
    if let Some(item) = save_document_as_item(app) {
        item.set_enabled(enabled)?;
    }
    Ok(())
}

/// Emits [`OPEN_DOCUMENT_EVENT`] so the frontend can raise the native file picker and route the
/// chosen path into the existing open-tab request (`App.tsx`'s `request` state, P2a-6) — the only
/// side effect `lib.rs`'s `on_menu_event` handler performs for this item. A send failure here
/// (e.g. no window has mounted a listener yet) is inert, mirroring `TauriActivityEmitter::emit`'s
/// identical best-effort push.
pub fn notify_open_document_requested<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.emit(OPEN_DOCUMENT_EVENT, ());
}

/// Announces a native Save As request to the mounted frontend. The frontend routes this into the
/// active `EditorShell.saveAs()` handle, so the Missing-on-disk and general entries share one seam.
pub fn notify_save_document_as_requested<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.emit(SAVE_DOCUMENT_AS_EVENT, ());
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::menu::MenuId;

    fn event_for(id: &str) -> MenuEvent {
        MenuEvent {
            id: MenuId::new(id),
        }
    }

    #[test]
    fn is_open_document_event_matches_the_open_document_id() {
        assert!(is_open_document_event(&event_for(OPEN_DOCUMENT_MENU_ID)));
    }

    #[test]
    fn is_open_document_event_ignores_every_other_id() {
        assert!(!is_open_document_event(&event_for("quit")));
        assert!(!is_open_document_event(&event_for("close_window")));
        assert!(!is_open_document_event(&event_for("")));
    }

    #[test]
    fn is_save_document_as_event_matches_only_the_save_as_id() {
        assert!(is_save_document_as_event(&event_for(
            SAVE_DOCUMENT_AS_MENU_ID
        )));
        assert!(!is_save_document_as_event(&event_for(
            OPEN_DOCUMENT_MENU_ID
        )));
        assert!(!is_save_document_as_event(&event_for("close_window")));
    }

    #[test]
    fn save_as_contract_uses_the_native_item_values_shared_with_the_frontend() {
        assert_eq!(SAVE_DOCUMENT_AS_MENU_ID, "save_document_as");
        assert_eq!(SAVE_DOCUMENT_AS_EVENT, "emend://menu/save-document-as");
        assert_eq!(SAVE_DOCUMENT_AS_LABEL, "Save As…");
        assert_eq!(SAVE_DOCUMENT_AS_ACCELERATOR, "CmdOrCtrl+Shift+S");
    }

    #[test]
    fn save_as_availability_follows_the_active_saved_document() {
        let paths = vec!["notes/one.md".into(), "notes/two.md".into()];

        assert!(!save_document_as_available(&paths, None));
        assert!(!save_document_as_available(
            &paths,
            Some("untitled:1:notes/one.md")
        ));
        assert!(save_document_as_available(&paths, Some("notes/one.md")));
        assert!(save_document_as_available(&paths, Some("notes/two.md")));
    }
}
