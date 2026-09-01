mod commands;
mod database;
mod discord;
mod lyrics;
mod metadata;
mod models;
mod scanner;
mod soundcloud;
mod soundcloud_store;

use std::sync::Arc;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            // the saved window state must not resurrect native decorations
            // over the frameless windows configured in tauri.conf.json
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        & !tauri_plugin_window_state::StateFlags::DECORATIONS,
                )
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let covers_dir = app.path().app_cache_dir()?.join("covers");
            let fonts_dir = data_dir.join("fonts");
            let backgrounds_dir = data_dir.join("backgrounds");
            let avatars_dir = data_dir.join("avatars");
            let sc_cache_dir = data_dir.join("sc_cache");
            std::fs::create_dir_all(&covers_dir)?;
            std::fs::create_dir_all(&fonts_dir)?;
            std::fs::create_dir_all(&backgrounds_dir)?;
            std::fs::create_dir_all(&avatars_dir)?;
            std::fs::create_dir_all(&sc_cache_dir)?;
            let db = database::Db::open_at(&data_dir.join("tempo.db"))?;
            app.manage(commands::AppState {
                db: Arc::new(db),
                covers_dir,
                fonts_dir,
                backgrounds_dir,
                avatars_dir,
                sc_cache_dir,
            });
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let state = handle.state::<commands::AppState>();
                soundcloud_store::startup_maintenance(&state.db, &state.sc_cache_dir, &state.covers_dir);
                commands::startup_rescan(handle.clone());
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_library_folders,
            commands::add_library_folder,
            commands::remove_library_folder,
            commands::rescan_folder,
            commands::rescan_library,
            commands::list_tracks,
            commands::count_tracks,
            commands::search_all,
            commands::list_albums,
            commands::get_album,
            commands::list_artists,
            commands::get_artist,
            commands::create_playlist,
            commands::rename_playlist,
            commands::delete_playlist,
            commands::list_playlists,
            commands::get_playlist,
            commands::playlist_add_track,
            commands::playlist_remove_track,
            commands::playlist_move_track,
            commands::bump_play_count,
            commands::record_history,
            commands::import_font,
            commands::import_background,
            commands::import_avatar,
            commands::set_playlist_pinned,
            commands::move_pinned_playlist,
            commands::get_app_setting,
            commands::set_app_setting,
            commands::get_track_lyrics,
            commands::get_analytics,
            commands::get_history,
            commands::clear_history,
            commands::get_covers_cache_info,
            commands::clear_covers_cache,
            commands::set_taskbar_progress,
            commands::sc_search_tracks,
            commands::sc_stream_url,
            commands::fetch_online_lyrics,
            commands::fetch_online_lyrics_all,
            commands::sc_get_playback,
            commands::sc_upsert_track,
            commands::add_sc_track_to_playlist,
            commands::sc_cache_info,
            commands::set_sc_cache_dir,
            commands::clear_sc_cache,
            commands::sc_set_cache_limit,
            commands::like_track,
            commands::unlike_track,
            commands::list_liked_track_ids,
            commands::get_top_tracks,
            commands::get_hour_picks,
            commands::get_artist_tracks,
            commands::get_daily_minutes,
            commands::discord_set_presence,
            commands::discord_clear_presence,
            commands::catbox_upload_cover,
            commands::set_track_lyrics,
            commands::toggle_favorite_artist,
            commands::list_favorite_artists,
            commands::is_favorite_artist,
            commands::toggle_favorite_album,
            commands::list_favorite_albums,
            commands::is_favorite_album,
            commands::import_artist_image,
            commands::export_playlist_m3u8,
            commands::import_playlist_m3u8
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
