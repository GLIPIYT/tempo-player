use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::database::Db;
use crate::models::Track;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MixMode {
    Allow,
    Deny,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MixSource {
    Local,
    Soundcloud,
    Youtube,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MixSpecial {
    CurrentHour,
    OnlineGenre,
    Forgotten,
    OnRepeat,
    NewToYou,
    NoSkips,
}

fn default_artist_mode() -> MixMode { MixMode::Allow }
fn default_artist_percent() -> [u8; 2] { [0, 100] }
fn default_genre_mode() -> MixMode { MixMode::Allow }
fn default_time_window() -> [u16; 2] { [0, 1440] }
fn default_completion_percent() -> [u8; 2] { [0, 100] }
fn default_genre_percent() -> [u8; 2] { [0, 100] }
fn default_sources() -> Vec<MixSource> { vec![MixSource::Local, MixSource::Soundcloud, MixSource::Youtube] }
fn default_forgotten_percent() -> [u8; 2] { [0, 100] }
fn default_forgotten_days() -> [u16; 2] { [1, 365] }
fn default_track_count() -> u8 { 24 }
fn default_refresh_interval_minutes() -> u16 { 0 }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CustomMixRule {
    #[serde(default)]
    pub id: Option<i64>,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_track_count")]
    pub track_count: u8,
    #[serde(default = "default_refresh_interval_minutes")]
    pub refresh_interval_minutes: u16,
    #[serde(default = "default_artist_mode")]
    pub artist_mode: MixMode,
    #[serde(default)]
    pub artist_ids: Vec<i64>,
    #[serde(default = "default_artist_percent")]
    pub artist_percent: [u8; 2],
    #[serde(default = "default_time_window")]
    pub time_window: [u16; 2],
    #[serde(default = "default_completion_percent")]
    pub completion_percent: [u8; 2],
    #[serde(default = "default_genre_mode")]
    pub genre_mode: MixMode,
    #[serde(default)]
    pub genres: Vec<String>,
    #[serde(default = "default_genre_percent")]
    pub genre_percent: [u8; 2],
    #[serde(default = "default_sources")]
    pub sources: Vec<MixSource>,
    #[serde(default)]
    pub specials: Vec<MixSpecial>,
    #[serde(default = "default_forgotten_percent")]
    pub forgotten_percent: [u8; 2],
    #[serde(default = "default_forgotten_days")]
    pub forgotten_days: [u16; 2],
}

impl CustomMixRule {
    pub fn validate(&self) -> Result<(), String> {
        if self.name.trim().is_empty() {
            return Err("mix name must not be empty".to_string());
        }
        if self.description.encode_utf16().count() > 150 {
            return Err("description must contain at most 150 characters".to_string());
        }
        if !(1..=50).contains(&self.track_count) {
            return Err("trackCount must be between 1 and 50".to_string());
        }
        if self.refresh_interval_minutes > 1440 || self.refresh_interval_minutes % 10 != 0 {
            return Err("refreshIntervalMinutes must use 10-minute steps from 0 to 1440".to_string());
        }
        if self.artist_ids.iter().any(|id| *id <= 0) {
            return Err("artist IDs must be positive".to_string());
        }
        if self.time_window[0] > self.time_window[1]
            || self.time_window[1] > 1440
            || self.time_window.iter().any(|minute| *minute != 1440 && minute % 30 != 0)
        {
            return Err("timeWindow must be an ordered half-hour range from 0 to 1440".to_string());
        }
        for (name, range) in [
            ("artistPercent", self.artist_percent),
            ("completionPercent", self.completion_percent),
            ("genrePercent", self.genre_percent),
            ("forgottenPercent", self.forgotten_percent),
        ] {
            if range[0] > range[1] || range[1] > 100 {
                return Err(format!("{name} must be an ordered percentage range"));
            }
        }
        if self.forgotten_days[0] < 1
            || self.forgotten_days[0] > self.forgotten_days[1]
            || self.forgotten_days[1] > 365
        {
            return Err("forgottenDays must be an ordered range from 1 to 365".to_string());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CustomMixSnapshot {
    pub rule_fingerprint: String,
    /// Unix seconds.
    pub generated_at: i64,
    pub tracks: Vec<Track>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CustomMixCandidate {
    pub track: Track,
    pub average_completion_percent: Option<f64>,
    pub history_minutes: Vec<u16>,
    pub liked: bool,
    /// Database metadata is trusted; callers mark provider recommendations explicitly.
    pub metadata_trusted: bool,
}

#[derive(Default)]
struct HistoryAggregate {
    minutes: Vec<u16>,
    completion_sum: f64,
    completion_count: usize,
}

const CUSTOM_MIX_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS custom_mix_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    rule_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_custom_mix_rules_updated ON custom_mix_rules(updated_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS custom_mix_snapshots (
    rule_id INTEGER PRIMARY KEY,
    snapshot_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
"#;

/// Separate idempotent initialization avoids changing the shared migration history.
pub fn init_schema(db: &Db) -> Result<(), String> {
    db.with_conn(|conn| conn.execute_batch(CUSTOM_MIX_SCHEMA).map_err(db_error))
}

impl Db {
    pub fn list_custom_mix_rules(&self) -> Result<Vec<CustomMixRule>, String> {
        self.with_conn(|conn| {
            conn.execute_batch(CUSTOM_MIX_SCHEMA).map_err(db_error)?;
            let mut stmt = conn.prepare("SELECT id, rule_json FROM custom_mix_rules ORDER BY updated_at DESC, id DESC")
                .map_err(db_error)?;
            let rows = stmt.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))
                .map_err(db_error)?;
            let mut rules = Vec::new();
            for row in rows {
                let (id, json) = row.map_err(db_error)?;
                let mut rule: CustomMixRule = serde_json::from_str(&json)
                    .map_err(|error| format!("invalid saved custom mix rule {id}: {error}"))?;
                rule.id = Some(id);
                rules.push(rule);
            }
            Ok(rules)
        })
    }

    pub fn save_custom_mix_rule(&self, mut rule: CustomMixRule) -> Result<CustomMixRule, String> {
        rule.name = rule.name.trim().to_string();
        rule.validate()?;
        self.with_conn(|conn| {
            conn.execute_batch(CUSTOM_MIX_SCHEMA).map_err(db_error)?;
            let tx = conn.unchecked_transaction().map_err(db_error)?;
            if let Some(id) = rule.id {
                if id <= 0 {
                    return Err("mix ID must be positive".to_string());
                }
                let updated_at = unix_now();
                let initial_json = serde_json::to_string(&rule).map_err(|error| error.to_string())?;
                let changed = tx.execute(
                    "UPDATE custom_mix_rules SET name = ?1, rule_json = ?2, updated_at = ?3 WHERE id = ?4",
                    params![rule.name, initial_json, updated_at, id],
                ).map_err(db_error)?;
                if changed == 0 {
                    return Err(format!("custom mix {id} was not found"));
                }
            } else {
                let updated_at = unix_now();
                let provisional_json = serde_json::to_string(&rule).map_err(|error| error.to_string())?;
                tx.execute(
                    "INSERT INTO custom_mix_rules(name, rule_json, updated_at) VALUES(?1, ?2, ?3)",
                    params![rule.name, provisional_json, updated_at],
                ).map_err(db_error)?;
                rule.id = Some(tx.last_insert_rowid());
                let json = serde_json::to_string(&rule).map_err(|error| error.to_string())?;
                tx.execute("UPDATE custom_mix_rules SET rule_json = ?1 WHERE id = ?2", params![json, rule.id])
                    .map_err(db_error)?;
            }
            tx.execute("DELETE FROM custom_mix_snapshots WHERE rule_id = ?1", params![rule.id])
                .map_err(db_error)?;
            tx.commit().map_err(db_error)?;
            Ok(rule)
        })
    }

    pub fn delete_custom_mix_rule(&self, rule_id: i64) -> Result<(), String> {
        if rule_id <= 0 {
            return Err("mix ID must be positive".to_string());
        }
        self.with_conn(|conn| {
            conn.execute_batch(CUSTOM_MIX_SCHEMA).map_err(db_error)?;
            let tx = conn.unchecked_transaction().map_err(db_error)?;
            tx.execute("DELETE FROM custom_mix_snapshots WHERE rule_id = ?1", params![rule_id]).map_err(db_error)?;
            tx.execute("DELETE FROM custom_mix_rules WHERE id = ?1", params![rule_id]).map_err(db_error)?;
            tx.commit().map_err(db_error)?;
            Ok(())
        })
    }

    pub fn get_custom_mix_snapshot(&self, rule_id: i64) -> Result<Option<CustomMixSnapshot>, String> {
        if rule_id <= 0 { return Err("mix ID must be positive".into()); }
        self.with_conn(|conn| {
            conn.execute_batch(CUSTOM_MIX_SCHEMA).map_err(db_error)?;
            let json = conn.query_row(
                "SELECT snapshot_json FROM custom_mix_snapshots WHERE rule_id = ?1",
                params![rule_id],
                |row| row.get::<_, String>(0),
            ).optional().map_err(db_error)?;
            json.map(|json| serde_json::from_str(&json)
                .map_err(|error| format!("invalid custom mix snapshot for rule {rule_id}: {error}")))
                .transpose()
        })
    }

    pub fn save_custom_mix_snapshot(&self, rule_id: i64, snapshot: CustomMixSnapshot) -> Result<(), String> {
        if rule_id <= 0 { return Err("mix ID must be positive".into()); }
        if snapshot.rule_fingerprint.is_empty() || snapshot.rule_fingerprint.len() > 16 * 1024 {
            return Err("invalid custom mix snapshot fingerprint".into());
        }
        if snapshot.tracks.is_empty() || snapshot.tracks.len() > 50 {
            return Err("custom mix snapshots must contain between 1 and 50 tracks".into());
        }
        if snapshot.warnings.len() > 100 {
            return Err("custom mix snapshot has too many warnings".into());
        }
        let json = serde_json::to_string(&snapshot).map_err(|error| error.to_string())?;
        if json.len() > 2 * 1024 * 1024 {
            return Err("custom mix snapshot exceeds its size limit".into());
        }
        self.with_conn(|conn| {
            conn.execute_batch(CUSTOM_MIX_SCHEMA).map_err(db_error)?;
            let tx = conn.unchecked_transaction().map_err(db_error)?;
            let rule_json = tx.query_row(
                "SELECT rule_json FROM custom_mix_rules WHERE id = ?1",
                params![rule_id],
                |row| row.get::<_, String>(0),
            ).optional().map_err(db_error)?
                .ok_or_else(|| format!("custom mix {rule_id} was not found"))?;
            let saved_rule: CustomMixRule = serde_json::from_str(&rule_json)
                .map_err(|error| format!("invalid saved custom mix rule {rule_id}: {error}"))?;
            let mut current_rule = serde_json::to_value(saved_rule).map_err(|error| error.to_string())?;
            if let Some(object) = current_rule.as_object_mut() { let _ = object.remove("id"); }
            let fingerprint: serde_json::Value = serde_json::from_str(&snapshot.rule_fingerprint)
                .map_err(|error| format!("invalid custom mix snapshot fingerprint: {error}"))?;
            if current_rule != fingerprint {
                return Err(format!("custom mix {rule_id} changed before this selection could be saved"));
            }
            tx.execute(
                "INSERT INTO custom_mix_snapshots(rule_id, snapshot_json, updated_at) VALUES(?1, ?2, ?3) \
                 ON CONFLICT(rule_id) DO UPDATE SET snapshot_json = excluded.snapshot_json, updated_at = excluded.updated_at",
                params![rule_id, json, unix_now()],
            ).map_err(db_error)?;
            tx.commit().map_err(db_error)?;
            Ok(())
        })
    }

    /// Return visible library tracks together with per-track history facts for rule evaluation.
    pub fn get_custom_mix_candidates(&self) -> Result<Vec<CustomMixCandidate>, String> {
        let (track_ids, mut history, liked_ids) = self.with_conn(|conn| {
            let mut track_stmt = conn.prepare(
                "SELECT t.id FROM tracks t \
                 WHERE t.folder_id IS NOT NULL OR (t.source <> 'local' AND t.cached_at IS NOT NULL) \
                 ORDER BY t.id",
            ).map_err(db_error)?;
            let track_rows = track_stmt.query_map([], |row| row.get::<_, i64>(0)).map_err(db_error)?;
            let mut ids = Vec::new();
            for row in track_rows { ids.push(row.map_err(db_error)?); }

            let mut liked_stmt = conn.prepare(
                "SELECT pt.track_id FROM playlist_tracks pt \
                 JOIN playlists p ON p.id = pt.playlist_id WHERE p.is_likes = 1",
            ).map_err(db_error)?;
            let liked_rows = liked_stmt.query_map([], |row| row.get::<_, i64>(0)).map_err(db_error)?;
            let mut liked_ids = HashSet::new();
            for row in liked_rows { liked_ids.insert(row.map_err(db_error)?); }

            let mut aggregates = HashMap::<i64, HistoryAggregate>::new();
            let mut stmt = conn.prepare(
                "SELECT h.track_id, \
                 CAST(strftime('%H', h.played_at, 'unixepoch', 'localtime') AS INTEGER) * 60 + \
                 CAST(strftime('%M', h.played_at, 'unixepoch', 'localtime') AS INTEGER), \
                 COALESCE(h.covered_sec, h.listened_sec), t.duration_sec \
                 FROM listening_history h JOIN tracks t ON t.id = h.track_id \
                 WHERE t.folder_id IS NOT NULL OR (t.source <> 'local' AND t.cached_at IS NOT NULL) \
                 ORDER BY h.track_id, h.id",
            ).map_err(db_error)?;
            let rows = stmt.query_map([], |row| Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, Option<f64>>(2)?,
                row.get::<_, Option<f64>>(3)?,
            ))).map_err(db_error)?;
            for row in rows {
                let (track_id, minute, listened_sec, duration_sec) = row.map_err(db_error)?;
                let aggregate = aggregates.entry(track_id).or_default();
                if let Some(minute) = minute.filter(|minute| (0..1440).contains(minute)) {
                    aggregate.minutes.push(minute as u16);
                }
                if let (Some(listened), Some(duration)) = (listened_sec, duration_sec) {
                    if listened.is_finite() && duration.is_finite() && duration > 0.0 {
                        let percent = (listened.max(0.0).min(duration) / duration * 100.0).clamp(0.0, 100.0);
                        aggregate.completion_sum += percent;
                        aggregate.completion_count += 1;
                    }
                }
            }
            Ok((ids, aggregates, liked_ids))
        })?;

        let tracks = self.get_tracks_by_ids(&track_ids)?;
        let mut candidates = Vec::with_capacity(tracks.len());
        for track in tracks {
            let aggregate = history.remove(&track.id).unwrap_or_default();
            let average_completion_percent = (aggregate.completion_count > 0)
                .then_some(aggregate.completion_sum / aggregate.completion_count as f64);
            let liked = liked_ids.contains(&track.id);
            candidates.push(CustomMixCandidate {
                track,
                average_completion_percent,
                history_minutes: aggregate.minutes,
                liked,
                metadata_trusted: true,
            });
        }
        Ok(candidates)
    }
}

fn db_error(error: rusqlite::Error) -> String {
    format!("database error: {error}")
}

fn unix_now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEST_DB: AtomicU64 = AtomicU64::new(0);

    fn test_db_path() -> PathBuf {
        let id = NEXT_TEST_DB.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("tempo-custom-mix-{}-{id}.sqlite", std::process::id()))
    }

    fn rule(name: &str) -> CustomMixRule {
        CustomMixRule {
            id: None,
            name: name.to_string(),
            description: String::new(),
            track_count: 24,
            refresh_interval_minutes: 0,
            artist_mode: MixMode::Allow,
            artist_ids: Vec::new(),
            artist_percent: [0, 100],
            time_window: [0, 1440],
            completion_percent: [0, 100],
            genre_mode: MixMode::Allow,
            genres: Vec::new(),
            genre_percent: [0, 100],
            sources: default_sources(),
            specials: Vec::new(),
            forgotten_percent: [0, 100],
            forgotten_days: [1, 365],
        }
    }

    #[test]
    fn custom_mix_rules_round_trip_and_delete_from_sqlite() {
        let path = test_db_path();
        let db = Db::open_at(&path).unwrap();
        init_schema(&db).unwrap();

        let mut saved = db.save_custom_mix_rule(rule("Evening set")).unwrap();
        assert!(saved.id.is_some());
        saved.time_window = [1080, 1440];
        saved.artist_percent = [20, 25];
        let updated = db.save_custom_mix_rule(saved.clone()).unwrap();
        assert_eq!(updated.time_window, [1080, 1440]);
        assert_eq!(updated.artist_percent, [20, 25]);
        assert_eq!(db.list_custom_mix_rules().unwrap(), vec![updated.clone()]);

        db.delete_custom_mix_rule(updated.id.unwrap()).unwrap();
        assert!(db.list_custom_mix_rules().unwrap().is_empty());
        assert!(db.get_custom_mix_snapshot(updated.id.unwrap()).unwrap().is_none());
        drop(db);
        let _ = std::fs::remove_file(&path);
        let mut wal = PathBuf::from(&path);
        wal.set_extension("sqlite-wal");
        let _ = std::fs::remove_file(wal);
        let mut shm = PathBuf::from(&path);
        shm.set_extension("sqlite-shm");
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn legacy_custom_mix_rules_use_new_field_defaults() {
        let legacy: CustomMixRule = serde_json::from_str(r#"{"name":"Legacy"}"#).unwrap();
        assert_eq!(legacy.description, "");
        assert_eq!(legacy.track_count, 24);
        assert_eq!(legacy.refresh_interval_minutes, 0);
        assert_eq!(legacy.artist_percent, [0, 100]);
    }

    #[test]
    fn custom_mix_rule_validation_enforces_description_count_and_cadence() {
        let mut value = rule("Valid");
        value.artist_percent = [80, 60];
        assert!(value.validate().unwrap_err().contains("artistPercent"));
        value.artist_percent = [0, 100];
        value.description = "x".repeat(151);
        assert!(value.validate().unwrap_err().contains("description"));
        value.description.clear();
        value.track_count = 51;
        assert!(value.validate().unwrap_err().contains("trackCount"));
        value.track_count = 24;
        value.refresh_interval_minutes = 15;
        assert!(value.validate().unwrap_err().contains("refreshIntervalMinutes"));
        value.refresh_interval_minutes = 1440;
        value.track_count = 50;
        assert!(value.validate().is_ok());
    }

    #[test]
    fn generated_custom_mix_snapshot_round_trips_and_rule_edits_clear_it() {
        let path = test_db_path();
        let db = Db::open_at(&path).unwrap();
        init_schema(&db).unwrap();
        let mut saved = db.save_custom_mix_rule(rule("Saved selection")).unwrap();
        let rule_id = saved.id.unwrap();
        let snapshot = CustomMixSnapshot {
            rule_fingerprint: fingerprint(&saved),
            generated_at: 1_800_000_000,
            tracks: vec![Track {
                id: -42,
                path: "soundcloud://42".to_string(),
                title: "Provider result".to_string(),
                artist_id: None,
                artist_name: Some("Artist".to_string()),
                album_id: None,
                album_title: None,
                track_number: None,
                disc_number: None,
                duration_sec: Some(180.0),
                year: None,
                genre: Some("Ambient".to_string()),
                cover_path: None,
                file_size: 0,
                modified_at: 0,
                added_at: 1_800_000_000,
                source: "soundcloud".to_string(),
                external_id: Some("42".to_string()),
                last_played_at: None,
                play_count: 0,
                skip_count: 0,
                gain_db: None,
                peak_db: None,
            }],
            warnings: vec!["A sample warning".to_string()],
        };
        db.save_custom_mix_snapshot(rule_id, snapshot.clone()).unwrap();
        let loaded = db.get_custom_mix_snapshot(rule_id).unwrap().unwrap();
        assert_eq!(loaded.rule_fingerprint, snapshot.rule_fingerprint);
        assert_eq!(loaded.generated_at, snapshot.generated_at);
        assert_eq!(loaded.tracks[0].id, -42);
        assert_eq!(loaded.tracks[0].external_id.as_deref(), Some("42"));
        assert_eq!(loaded.warnings, snapshot.warnings);

        saved.description = "Changed criteria".to_string();
        let updated = db.save_custom_mix_rule(saved).unwrap();
        assert!(db.get_custom_mix_snapshot(rule_id).unwrap().is_none());
        assert!(db.save_custom_mix_snapshot(rule_id, snapshot.clone()).unwrap_err().contains("changed"));

        let mut refreshed = snapshot;
        refreshed.rule_fingerprint = fingerprint(&updated);
        db.save_custom_mix_snapshot(rule_id, refreshed).unwrap();
        assert!(db.get_custom_mix_snapshot(rule_id).unwrap().is_some());

        drop(db);
        let _ = std::fs::remove_file(&path);
        let mut wal = PathBuf::from(&path);
        wal.set_extension("sqlite-wal");
        let _ = std::fs::remove_file(wal);
        let mut shm = PathBuf::from(&path);
        shm.set_extension("sqlite-shm");
        let _ = std::fs::remove_file(shm);
    }

    fn fingerprint(rule: &CustomMixRule) -> String {
        let mut value = serde_json::to_value(rule).unwrap();
        let _ = value.as_object_mut().unwrap().remove("id");
        serde_json::to_string(&value).unwrap()
    }
}
