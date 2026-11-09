use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::params;
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
fn default_genre_mode() -> MixMode { MixMode::Allow }
fn default_time_window() -> [u16; 2] { [0, 1440] }
fn default_completion_percent() -> [u8; 2] { [0, 100] }
fn default_genre_percent() -> [u8; 2] { [0, 100] }
fn default_sources() -> Vec<MixSource> { vec![MixSource::Local, MixSource::Soundcloud, MixSource::Youtube] }
fn default_forgotten_percent() -> [u8; 2] { [0, 100] }
fn default_forgotten_days() -> [u16; 2] { [1, 365] }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CustomMixRule {
    #[serde(default)]
    pub id: Option<i64>,
    pub name: String,
    #[serde(default = "default_artist_mode")]
    pub artist_mode: MixMode,
    #[serde(default)]
    pub artist_ids: Vec<i64>,
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
            conn.execute("DELETE FROM custom_mix_rules WHERE id = ?1", params![rule_id])
                .map_err(db_error)?;
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
            artist_mode: MixMode::Allow,
            artist_ids: Vec::new(),
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
        let updated = db.save_custom_mix_rule(saved.clone()).unwrap();
        assert_eq!(updated.time_window, [1080, 1440]);
        assert_eq!(db.list_custom_mix_rules().unwrap(), vec![updated.clone()]);

        db.delete_custom_mix_rule(updated.id.unwrap()).unwrap();
        assert!(db.list_custom_mix_rules().unwrap().is_empty());
        drop(db);
        let _ = std::fs::remove_file(&path);
        let mut wal = PathBuf::from(&path);
        wal.set_extension("sqlite-wal");
        let _ = std::fs::remove_file(wal);
        let mut shm = PathBuf::from(&path);
        shm.set_extension("sqlite-shm");
        let _ = std::fs::remove_file(shm);
    }
}
