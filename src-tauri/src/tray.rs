//! Tray icon and close-to-tray behaviour.
//!
//! The tray owns no playback state: every command it produces is forwarded to
//! the webview, which is the only place that knows about the queue and the
//! audio element. That also keeps the tray menu labels translatable - the
//! frontend pushes them in on mount and whenever the language changes.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Event the webview listens on for tray commands ("toggle", "prev", "next").
pub const TRAY_EVENT: &str = "tray://command";

const TRAY_ID: &str = "tempo-tray";

/// When true, closing the main window hides it instead of quitting. Written by
/// the frontend, read by the window-event hook below.
static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(false);

/// Menu labels, kept so the menu can be rebuilt when the language changes.
#[derive(Clone, Default)]
pub struct TrayLabels {
    pub show: String,
    pub toggle: String,
    pub prev: String,
    pub next: String,
    pub quit: String,
}

static LABELS: Mutex<Option<TrayLabels>> = Mutex::new(None);

fn default_labels() -> TrayLabels {
    TrayLabels {
        show: "Show Tempo".into(),
        toggle: "Play / Pause".into(),
        prev: "Previous".into(),
        next: "Next".into(),
        quit: "Quit".into(),
    }
}

pub fn set_close_to_tray(enabled: bool) {
    CLOSE_TO_TRAY.store(enabled, Ordering::Relaxed);
}

pub fn close_to_tray() -> bool {
    CLOSE_TO_TRAY.load(Ordering::Relaxed)
}

fn menu_for<R: Runtime>(app: &AppHandle<R>, labels: &TrayLabels) -> tauri::Result<Menu<R>> {
    let show = MenuItem::with_id(app, "show", &labels.show, true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle", &labels.toggle, true, None::<&str>)?;
    let prev = MenuItem::with_id(app, "prev", &labels.prev, true, None::<&str>)?;
    let next = MenuItem::with_id(app, "next", &labels.next, true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", &labels.quit, true, None::<&str>)?;
    Menu::with_items(app, &[&show, &toggle, &prev, &next, &sep, &quit])
}

pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

fn on_menu<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        "show" => show_main(app),
        "quit" => {
            // bypass the close-to-tray hook, otherwise quitting just hides
            set_close_to_tray(false);
            app.exit(0);
        }
        // everything else is playback, which only the webview can do
        other => {
            let _ = app.emit(TRAY_EVENT, other.to_string());
        }
    }
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let labels = LABELS
        .lock()
        .ok()
        .and_then(|l| l.clone())
        .unwrap_or_else(default_labels);
    let menu = menu_for(app, &labels)?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Tempo")
        .menu(&menu)
        // left click raises the window; the menu belongs on right click
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| on_menu(app, event.id.as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    Ok(())
}

/// Rebuilds the menu with new labels. Called when the UI language changes.
pub fn set_labels<R: Runtime>(app: &AppHandle<R>, labels: TrayLabels) -> tauri::Result<()> {
    if let Ok(mut slot) = LABELS.lock() {
        *slot = Some(labels.clone());
    }
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(menu_for(app, &labels)?))?;
    }
    Ok(())
}
