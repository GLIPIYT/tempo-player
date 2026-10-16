//! Tray icon and close-to-tray behaviour.
//!
//! Transport commands go directly to the native audio actor. The frontend
//! supplies translated labels, but is not required for playback control.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime};

const TRAY_ID: &str = "tempo-tray";

/// When true, closing the main window hides it instead of quitting. Written by
/// the frontend, read by the window-event hook below.
static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(false);
static EXIT_REQUESTED: AtomicBool = AtomicBool::new(false);
static EXIT_READY: AtomicBool = AtomicBool::new(false);

pub fn exit_ready() -> bool {
    EXIT_READY.load(Ordering::Acquire)
}

/// Flush native listening state and release audio/helper resources before exit.
pub fn request_exit<R: Runtime>(app: &AppHandle<R>) {
    if EXIT_REQUESTED.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(error) = crate::native_audio::shutdown(&app) {
            eprintln!("[tempo native audio] shutdown: {error}");
        }
        EXIT_READY.store(true, Ordering::Release);
        app.exit(0);
    });
}

#[tauri::command]
pub fn complete_listening_exit(app: AppHandle) {
    if EXIT_REQUESTED.load(Ordering::Acquire) {
        EXIT_READY.store(true, Ordering::Release);
        app.exit(0);
    }
}

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

/// Creates or removes the tray icon to match the setting.
///
/// The tray is not built at startup on purpose. On Windows a tray icon keeps
/// the process alive after its last window closes, so an always-present icon
/// meant the app never exited: `tauri dev` left the old process and its icon
/// behind on every run, and each of those lingering instances opened its own
/// Discord presence, which is what stacked up in the status.
pub fn set_enabled<R: Runtime>(app: &AppHandle<R>, enabled: bool) -> tauri::Result<()> {
    set_close_to_tray(enabled);
    if enabled {
        if app.tray_by_id(TRAY_ID).is_none() {
            build(app)?;
        }
    } else {
        app.remove_tray_by_id(TRAY_ID);
    }
    Ok(())
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
            request_exit(app);
        }
        "toggle" | "prev" | "next" => {
            let op = if id == "prev" { "previous" } else { id };
            let command = serde_json::json!({ "op": op });
            let app = app.clone();
            std::thread::spawn(move || {
                if let Err(error) = crate::native_audio::dispatch(&app, command) {
                    eprintln!("[tempo native audio] tray: {error}");
                }
            });
        }
        _ => {}
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
