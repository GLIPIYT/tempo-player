use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Instant;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use super::models::{NativeSettings, TrackPayload};
use super::output::{self, OutputSettings, PreparedAudio, SourceSpec};

fn log_startup_timing(stage: &str, source: &str, started: Instant) {
    #[cfg(debug_assertions)]
    eprintln!(
        "[tempo startup] stage={stage} source={source} elapsed_ms={}",
        started.elapsed().as_millis()
    );
    #[cfg(not(debug_assertions))]
    let _ = (stage, source, started);
}

pub struct PreparedTrack {
    pub audio: PreparedAudio,
    pub track: Value,
}

pub struct ReservoirResult {
    pub revision: i64,
    pub track: Value,
}

/// Resolves provider input and prepares the decoder away from the actor thread.
/// The returned source has no output-device ownership and is safe to send back
/// to the single native playback actor.
pub fn prepare_track(
    app: AppHandle,
    payload: Value,
    settings: NativeSettings,
    position: f64,
    force_soundcloud_ytdlp: bool,
) -> Result<PreparedTrack, String> {
    let prepare_started = Instant::now();
    let mut track = TrackPayload::parse(payload)?.0;
    let source = track
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let source_kind = match source.as_str() {
        "local" => "local",
        "soundcloud" => "soundcloud",
        "youtube" => "youtube",
        _ => "other",
    };
    let resolver_started = Instant::now();
    let source_id = track
        .get("sourceId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let title = track
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let duration = track
        .get("durationSec")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0);
    let gain_db = track
        .get("gainDb")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .filter(|_| settings.normalize)
        .unwrap_or(0.0)
        .clamp(-36.0, 36.0);
    let (db, covers_dir, sc_cache_dir, yt_cache_dir, bin_dir) = {
        let state = app.state::<crate::commands::AppState>();
        (
            state.db.clone(),
            state.covers_dir.clone(),
            state.sc_cache_dir.clone(),
            state.yt_cache_dir.clone(),
            state.bin_dir.clone(),
        )
    };

    let preserved_path = (!force_soundcloud_ytdlp || source != "soundcloud")
        .then(|| track.get("localPath").and_then(Value::as_str))
        .flatten()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_file());
    let spec = if let Some(path) = preserved_path {
        SourceSpec {
            location: path.to_string_lossy().into_owned(),
            duration_sec: duration,
            gain_db,
        }
    } else {
        match source.as_str() {
            "local" => {
                let mut path = track
                    .get("localPath")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .map(PathBuf::from);
                if path.is_none() {
                    if let Some(id) = track
                        .get("dbId")
                        .and_then(Value::as_i64)
                        .filter(|id| *id > 0)
                    {
                        path = db
                            .get_tracks_by_ids(&[id])?
                            .first()
                            .map(|row| PathBuf::from(&row.path));
                    }
                }
                let path =
                    path.ok_or_else(|| format!("local audio path is unavailable for {title}"))?;
                if !path.is_file() {
                    return Err(format!("audio file no longer exists: {}", path.display()));
                }
                SourceSpec {
                    location: path.to_string_lossy().into_owned(),
                    duration_sec: duration,
                    gain_db,
                }
            }
            "soundcloud" => {
                if source_id.is_empty()
                    || source_id.len() > 32
                    || !source_id.bytes().all(|byte| byte.is_ascii_digit())
                {
                    return Err("invalid SoundCloud track ID".into());
                }
                let artwork = track
                    .get("coverPath")
                    .and_then(Value::as_str)
                    .filter(|value| value.starts_with("https://"));
                let artist = track
                    .get("artists")
                    .and_then(Value::as_array)
                    .and_then(|items| items.first())
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let duration_ms = duration.unwrap_or(0.0).clamp(0.0, 604_800.0) * 1000.0;
                let db_id = db.upsert_sc_track(
                    &source_id,
                    &title,
                    artist,
                    duration_ms.round() as i64,
                    artwork,
                )?;
                if let Some(object) = track.as_object_mut() {
                    object.insert("dbId".into(), json!(db_id));
                }
                let permalink = track
                    .get("externalUrl")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let root = crate::soundcloud_store::cache_dir(&db, &sc_cache_dir);
                let playback_started = Instant::now();
                let playback =
                    tauri::async_runtime::block_on(crate::soundcloud_store::get_playback(
                        db.clone(),
                        root,
                        covers_dir,
                        &source_id,
                        permalink.as_deref(),
                        &settings.ytdlp_path,
                        &bin_dir,
                        force_soundcloud_ytdlp,
                        Some(app.clone()),
                        settings.cache_before_play,
                    ));
                let resolved_kind = playback
                    .as_ref()
                    .ok()
                    .map(|playback| {
                        if playback.cached_path.is_some() {
                            "cache_hit"
                        } else if playback.url.is_some() {
                            "stream"
                        } else {
                            "empty"
                        }
                    })
                    .unwrap_or("error");
                log_startup_timing("soundcloud_resolve", resolved_kind, playback_started);
                let playback = playback?;
                let location = if let Some(path) = playback.cached_path {
                    path
                } else if let Some(url) = playback.url {
                    url
                } else {
                    return Err("SoundCloud did not return an audio source".into());
                };
                // A cached SoundCloud file may have just completed. Query its row
                // so metadata written from the tags appears in the authoritative
                // snapshot without changing the playback source identity.
                if let Some(row) = db.get_tracks_by_ids(&[db_id])?.first() {
                    if let Some(object) = track.as_object_mut() {
                        object.insert("title".into(), json!(row.title.clone()));
                        object.insert(
                            "artists".into(),
                            json!(row.artist_name.clone().into_iter().collect::<Vec<_>>()),
                        );
                        object.insert("album".into(), json!(row.album_title.clone()));
                        object.insert("durationSec".into(), json!(row.duration_sec));
                        if let Some(cover) = &row.cover_path {
                            object.insert("coverPath".into(), json!(cover));
                        }
                        if let Some(gain) = row.gain_db {
                            object.insert("gainDb".into(), json!(gain));
                        }
                    }
                }
                let resolved_duration = track
                    .get("durationSec")
                    .and_then(Value::as_f64)
                    .filter(|value| value.is_finite() && *value >= 0.0)
                    .or(duration);
                let resolved_gain = TrackPayload(track.clone()).gain_db(settings.normalize);
                SourceSpec {
                    location,
                    duration_sec: resolved_duration,
                    gain_db: resolved_gain,
                }
            }
            "youtube" => {
                let safe: String = source_id
                    .chars()
                    .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
                    .collect();
                if safe.is_empty() || safe.len() > 128 || safe != source_id {
                    return Err("invalid YouTube video ID".into());
                }
                std::fs::create_dir_all(&yt_cache_dir)
                    .map_err(|error| format!("YouTube cache directory: {error}"))?;
                let cache_lookup_started = Instant::now();
                let cached = find_youtube_cache(&yt_cache_dir, &safe);
                log_startup_timing(
                    "youtube_cache_lookup",
                    if cached.is_some() { "hit" } else { "miss" },
                    cache_lookup_started,
                );
                let path = match cached {
                    Some(path) => path,
                    None => {
                        let destination = yt_cache_dir.join(&safe);
                        let lock = youtube_cache_lock(&destination);
                        let _guard = lock
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        match find_youtube_cache(&yt_cache_dir, &safe) {
                            Some(path) => path,
                            None => {
                                let download_started = Instant::now();
                                crate::ytdlp::download(
                                    &settings.ytdlp_path,
                                    &bin_dir,
                                    &format!("https://www.youtube.com/watch?v={safe}"),
                                    &destination,
                                )?;
                                log_startup_timing(
                                    "youtube_download",
                                    source_kind,
                                    download_started,
                                );
                                find_youtube_cache(&yt_cache_dir, &safe).ok_or(
                                    "yt-dlp reported success but no finalized audio file was found",
                                )?
                            }
                        }
                    }
                };
                let mut artist = track
                    .get("artists")
                    .and_then(Value::as_array)
                    .and_then(|items| items.first())
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let mut album = track
                    .get("album")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let mut final_duration = duration;
                if artist.trim().is_empty() || album.trim().is_empty() {
                    let metadata_started = Instant::now();
                    let extra = crate::ytdlp::resolve_one(&settings.ytdlp_path, &bin_dir, &safe);
                    log_startup_timing("youtube_metadata_probe", source_kind, metadata_started);
                    if let Ok(Some(extra)) = extra {
                        if let Some(value) = extra.artist.filter(|value| !value.trim().is_empty()) {
                            artist = value;
                        }
                        if let Some(value) = extra.album.filter(|value| !value.trim().is_empty()) {
                            album = value;
                        }
                        if let Some(value) = extra.duration_ms.filter(|value| *value > 0) {
                            final_duration = Some(value as f64 / 1000.0);
                        }
                    }
                }
                let artwork = track
                    .get("coverPath")
                    .and_then(Value::as_str)
                    .filter(|value| value.starts_with("https://"));
                let size = std::fs::metadata(&path).ok().map(|meta| meta.len() as i64);
                let db_id = db.upsert_yt_track(
                    &safe,
                    &title,
                    &artist,
                    &album,
                    (final_duration.unwrap_or(0.0).clamp(0.0, 604_800.0) * 1000.0).round() as i64,
                    artwork,
                    size,
                )?;
                if let Some(object) = track.as_object_mut() {
                    object.insert("dbId".into(), json!(db_id));
                    object.insert(
                        "artists".into(),
                        json!(if artist.is_empty() {
                            Vec::<String>::new()
                        } else {
                            vec![artist]
                        }),
                    );
                    object.insert("album".into(), json!((!album.is_empty()).then_some(album)));
                    object.insert("durationSec".into(), json!(final_duration));
                }
                let _ = app.emit(crate::soundcloud_store::LIBRARY_CHANGED_EVENT, safe);
                SourceSpec {
                    location: path.to_string_lossy().into_owned(),
                    duration_sec: final_duration,
                    gain_db,
                }
            }
            other => return Err(format!("unsupported audio source: {other}")),
        }
    };

    let output_settings = OutputSettings {
        volume: settings.volume,
        playback_rate: settings.playback_rate,
        preserve_pitch: settings.preserve_pitch,
        equalizer_enabled: settings.equalizer_enabled,
        equalizer_gains: settings.equalizer_gains,
    };
    log_startup_timing("resolver_complete", source_kind, resolver_started);
    let input_kind =
        if spec.location.starts_with("http://") || spec.location.starts_with("https://") {
            "remote"
        } else {
            "local"
        };
    let decoder_started = Instant::now();
    let audio = output::prepare(spec, position.max(0.0), output_settings, bin_dir)?;
    log_startup_timing("output_prepare", input_kind, decoder_started);
    log_startup_timing("prepare_track_total", source_kind, prepare_started);
    Ok(PreparedTrack { audio, track })
}

/// Returns one already-published SoundCloud recommendation in the JS-published
/// order. The read never modifies the feed row or its revision.
pub fn stored_feed_candidate(
    app: AppHandle,
    excluded: HashSet<String>,
    consumed: HashSet<String>,
) -> Result<Option<ReservoirResult>, String> {
    let db = app.state::<crate::commands::AppState>().db.clone();
    let context = crate::recommendation_store::context(&db)?;
    let Some(stored) = context.stored_state else {
        return Ok(None);
    };
    let Some(published) = stored.data.get("published").and_then(Value::as_array) else {
        return Ok(None);
    };
    for candidate in published {
        let Some(sc_value) = candidate.get("track") else {
            continue;
        };
        let Ok(track) = serde_json::from_value::<crate::soundcloud::ScTrack>(sc_value.clone())
        else {
            continue;
        };
        if track.id.is_empty()
            || !track.id.bytes().all(|byte| byte.is_ascii_digit())
            || !track.streamable
            || !(track.has_progressive || track.has_hls)
        {
            continue;
        }
        let key = format!("soundcloud:{}", track.id);
        let group = candidate
            .get("groupKey")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or(&key);
        let group_key = format!("group:{group}");
        if excluded.contains(&key)
            || consumed.contains(&key)
            || excluded.contains(&group_key)
            || consumed.contains(&group_key)
        {
            continue;
        }
        let seed_key = candidate
            .get("seedTrackKey")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty());
        let cursor = candidate.get("cursor").and_then(Value::as_str);
        let added_at = candidate
            .get("addedAt")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let playable = track.streamable && (track.has_progressive || track.has_hls);
        let payload = json!({
            "source": "soundcloud",
            "traits": {"genre": track.genre.clone(), "tags": track.tags.clone(), "bpm": track.bpm, "version": null},
            "sourceId": track.id.clone(),
            "dbId": null,
            "title": track.title.clone(),
            "artists": [track.artist.clone()],
            "artistAvatarUrl": track.artist_avatar_url.clone(),
            "album": null,
            "durationSec": track.duration_ms.max(0) as f64 / 1000.0,
            "coverPath": track.artwork_url.clone(),
            "playable": playable,
            "localPath": null,
            "externalUrl": track.permalink_url.clone(),
            "gainDb": null,
            "auto": true,
            "selectionReason": "autoplay",
            "provenance": {
                "recommendationId": format!("sc:{}:{added_at}", track.id),
                "recordingKey": group,
                "seedIds": seed_key.map(|key| vec![key]).unwrap_or_default(),
                "placement": "radio",
                "origin": "radio",
                "seedTrackKey": seed_key,
                "recordingGroup": group,
                "cursor": cursor,
                "selection": "autoplay"
            }
        });
        TrackPayload::parse(payload.clone())?;
        return Ok(Some(ReservoirResult {
            revision: stored.revision,
            track: payload,
        }));
    }
    Ok(None)
}

fn find_youtube_cache(directory: &Path, key: &str) -> Option<PathBuf> {
    const AUDIO_EXTENSIONS: &[&str] = &[
        "m4a", "mp4", "webm", "opus", "ogg", "oga", "mp3", "aac", "flac", "wav",
    ];
    std::fs::read_dir(directory)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            path.is_file()
                && path
                    .file_stem()
                    .is_some_and(|stem| stem.to_string_lossy() == key)
                && path.extension().is_some_and(|extension| {
                    AUDIO_EXTENSIONS
                        .contains(&extension.to_string_lossy().to_ascii_lowercase().as_str())
                })
        })
}

fn youtube_cache_lock(path: &Path) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<std::collections::HashMap<PathBuf, Weak<Mutex<()>>>>> =
        OnceLock::new();
    let locks = LOCKS.get_or_init(|| Mutex::new(std::collections::HashMap::new()));
    let mut locks = locks
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(path).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(path.to_path_buf(), Arc::downgrade(&lock));
    lock
}
