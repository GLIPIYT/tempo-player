//! Bounded local feedback. All network/decoding work belongs outside Db::with_conn.
use crate::commands::AppState;
use crate::database::Db;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::State;

pub const MIGRATION: &str = r#"
ALTER TABLE listening_history ADD COLUMN session_id TEXT;
ALTER TABLE listening_history ADD COLUMN covered_sec REAL;
CREATE UNIQUE INDEX idx_history_session ON listening_history(session_id) WHERE session_id IS NOT NULL;
CREATE TABLE recommendation_meta (id INTEGER PRIMARY KEY CHECK(id = 1), generation INTEGER NOT NULL DEFAULT 0);
INSERT INTO recommendation_meta(id, generation) VALUES(1, 0);
CREATE TABLE listening_sessions (
 id TEXT PRIMARY KEY, revision INTEGER NOT NULL, track_key TEXT NOT NULL,
 started_at INTEGER NOT NULL, elapsed_sec REAL NOT NULL, covered_sec REAL NOT NULL,
 duration_sec REAL, finished INTEGER NOT NULL, event_json TEXT NOT NULL
);
CREATE INDEX idx_sessions_started ON listening_sessions(started_at);
CREATE INDEX idx_sessions_track ON listening_sessions(track_key, started_at);
CREATE TABLE recommendation_taste (
 track_key TEXT PRIMARY KEY, track_json TEXT NOT NULL, weight REAL NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE recommendation_taste_days (track_key TEXT NOT NULL, day INTEGER NOT NULL, weight REAL NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(track_key,day));
CREATE TABLE recommendation_impressions (
 id TEXT PRIMARY KEY, track_key TEXT NOT NULL, recording_group TEXT, shown_at INTEGER NOT NULL, surface TEXT NOT NULL
);
CREATE INDEX idx_impressions_shown ON recommendation_impressions(shown_at);
CREATE TABLE recommendation_features (
 track_key TEXT PRIMARY KEY, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, data_json TEXT NOT NULL
);
CREATE TABLE recommendation_pages (page_key TEXT PRIMARY KEY, fetched_at INTEGER NOT NULL, data_json TEXT NOT NULL);
CREATE TABLE recommendation_state (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL, data_json TEXT NOT NULL);
"#;

// Migration 21 has already been applied in existing development databases.
pub const RETIREMENT_MIGRATION: &str = r#"
ALTER TABLE recommendation_meta ADD COLUMN write_floor_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE listening_sessions ADD COLUMN event_hash TEXT NOT NULL DEFAULT '';
CREATE TABLE listening_session_tombstones (
 id TEXT PRIMARY KEY, revision INTEGER NOT NULL, track_key TEXT NOT NULL,
 started_at INTEGER NOT NULL, event_hash TEXT NOT NULL
);
CREATE INDEX idx_session_tombstones_started ON listening_session_tombstones(started_at);
"#;

const SESSION_RETENTION_MS: i64 = 180 * 86_400_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Provenance {
    pub origin: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed_track_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recording_group: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecommendationTrack {
    pub track_key: String,
    pub source: String,
    pub source_id: String,
    pub db_id: Option<i64>,
    pub title: String,
    pub artists: Vec<String>,
    pub album: Option<String>,
    pub duration_sec: Option<f64>,
    pub cover_path: Option<String>,
    pub external_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provenance: Option<Provenance>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListeningEvent {
    pub id: String,
    pub revision: i64,
    pub track_key: String,
    pub track: RecommendationTrack,
    pub start_reason: String,
    pub started_at: i64,
    pub elapsed_sec: f64,
    pub covered_sec: f64,
    pub duration_sec: Option<f64>,
    pub playback_rate: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_reason: Option<String>,
    pub finished: bool,
    pub generation: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Impression {
    pub id: String,
    pub track_key: String,
    pub recording_group: Option<String>,
    pub shown_at: i64,
    pub surface: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Feature {
    pub track_key: String,
    pub revision: i64,
    pub updated_at: i64,
    pub data: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoredState {
    pub revision: i64,
    pub data: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderPage {
    pub key: String,
    pub fetched_at: i64,
    pub data: Value,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Seed {
    pub track: RecommendationTrack,
    pub evidence: String,
    pub confidence: f64,
    pub weight: f64,
    pub at: i64,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecommendationContext {
    pub generation: i64,
    pub seed_tracks: Vec<Seed>,
    pub liked_track_keys: Vec<String>,
    pub manually_saved_track_keys: Vec<String>,
    pub sessions: Vec<ListeningEvent>,
    pub impressions: Vec<Impression>,
    pub features: Vec<Feature>,
    pub stored_state: Option<StoredState>,
}

fn err(e: rusqlite::Error) -> String {
    format!("recommendation database: {e}")
}
fn millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
fn text(value: &str, limit: usize) -> Result<(), String> {
    if value.len() > limit || value.contains('\0') {
        Err("Oversized or invalid recommendation text".into())
    } else {
        Ok(())
    }
}
fn key(value: &str) -> Result<(), String> {
    text(value, 256)?;
    let (source, id) = value.split_once(':').ok_or("Invalid track key")?;
    if !matches!(source, "local" | "soundcloud" | "youtube")
        || id.is_empty()
        || (source == "local" && id.parse::<i64>().map_or(true, |id| id <= 0))
    {
        return Err("Invalid track key".into());
    }
    Ok(())
}
fn time(value: f64) -> Result<(), String> {
    if !value.is_finite() || !(0.0..=604_800.0).contains(&value) {
        Err("Invalid listening time".into())
    } else {
        Ok(())
    }
}
fn stamp(value: i64) -> Result<(), String> {
    if value <= 0 || value > millis() + 300_000 {
        Err("Invalid recommendation timestamp".into())
    } else {
        Ok(())
    }
}
fn json(value: &Value, limit: usize) -> Result<String, String> {
    fn visit(v: &Value, depth: usize) -> bool {
        if depth > 16 {
            return false;
        }
        match v {
            Value::Array(a) => a.len() <= 5000 && a.iter().all(|x| visit(x, depth + 1)),
            Value::Object(o) => {
                o.len() <= 128
                    && o.iter().all(|(k, x)| {
                        k.len() <= 128
                            && !matches!(
                                k.as_str(),
                                "lrc" | "syncedLrc" | "plainLyrics" | "lyricsText" | "fullLyrics"
                            )
                            && visit(x, depth + 1)
                    })
            }
            _ => true,
        }
    }
    if !value.is_object() || !visit(value, 0) {
        return Err("Invalid feature/state JSON; lyrics text is not stored here".into());
    }
    let encoded = serde_json::to_string(value).map_err(|e| e.to_string())?;
    if encoded.len() > limit {
        return Err("Recommendation JSON exceeds its size limit".into());
    }
    Ok(encoded)
}
fn validate(event: &ListeningEvent) -> Result<(), String> {
    text(&event.id, 128)?;
    if event.id.is_empty()
        || event.revision <= 0
        || event.revision > 9_007_199_254_740_991
        || event.generation < 0
    {
        return Err("Invalid session identity/revision".into());
    }
    key(&event.track_key)?;
    let track = &event.track;
    if event.track_key != track.track_key
        || track.track_key != format!("{}:{}", track.source, track.source_id)
        || track.db_id.is_some_and(|id| id <= 0)
    {
        return Err("Session metadata does not match track identity".into());
    }
    text(&track.source_id, 230)?;
    text(&track.title, 1024)?;
    if track.artists.len() > 16 {
        return Err("Too many track artists".into());
    }
    for artist in &track.artists {
        text(artist, 512)?;
    }
    for value in [&track.album, &track.cover_path, &track.external_url]
        .into_iter()
        .flatten()
    {
        text(value, 2048)?;
    }
    if let Some(p) = &track.provenance {
        if !matches!(p.origin.as_str(), "home" | "radio" | "search" | "library") {
            return Err("Invalid recommendation origin".into());
        }
        if let Some(k) = &p.seed_track_key {
            key(k)?;
        }
        for value in [&p.recording_group, &p.cursor].into_iter().flatten() {
            text(value, 2048)?;
        }
        if p.selection
            .as_ref()
            .is_some_and(|s| !matches!(s.as_str(), "manual" | "queue" | "autoplay"))
        {
            return Err("Invalid selection provenance".into());
        }
    }
    stamp(event.started_at)?;
    if event.started_at < millis() - SESSION_RETENTION_MS {
        return Err("Expired listening session".into());
    }
    time(event.elapsed_sec)?;
    time(event.covered_sec)?;
    if let Some(duration) = event.duration_sec {
        time(duration)?;
    }
    if let Some(duration) = track.duration_sec {
        time(duration)?;
    }
    if !event.playback_rate.is_finite()
        || !(0.25..=4.0).contains(&event.playback_rate)
        || event.covered_sec > event.duration_sec.unwrap_or(604_800.0) + 0.1
        || event.covered_sec > event.elapsed_sec * 4.0 + 0.5
        || event.elapsed_sec > (millis() - event.started_at).max(0) as f64 / 1000.0 + 2.0
    {
        return Err("Inconsistent listening measurements".into());
    }
    if !matches!(
        event.start_reason.as_str(),
        "manual" | "queue" | "autoplay" | "repeat" | "restore"
    ) || event.finished != event.end_reason.is_some()
        || event.end_reason.as_ref().is_some_and(|r| {
            !matches!(
                r.as_str(),
                "select"
                    | "next"
                    | "previous"
                    | "clear"
                    | "end"
                    | "error"
                    | "exit"
                    | "remove"
                    | "stop"
            )
        })
    {
        return Err("Invalid listening reason".into());
    }
    Ok(())
}

pub fn clear_feedback(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("DELETE FROM listening_sessions; DELETE FROM listening_session_tombstones; DELETE FROM recommendation_taste; DELETE FROM recommendation_taste_days; DELETE FROM recommendation_impressions; DELETE FROM recommendation_state; UPDATE recommendation_meta SET generation = generation + 1,write_floor_at = 0 WHERE id = 1;").map_err(err)
}

fn prune(conn: &Connection) -> Result<(), String> {
    let now = millis();
    // A transaction-local list handles tied timestamps and the hard event cap.
    conn.execute_batch("CREATE TEMP TABLE IF NOT EXISTS recommendation_prune_ids(id TEXT PRIMARY KEY); DELETE FROM recommendation_prune_ids;").map_err(err)?;
    conn.execute("INSERT OR IGNORE INTO recommendation_prune_ids SELECT id FROM listening_sessions WHERE started_at < ?1", params![now - SESSION_RETENTION_MS]).map_err(err)?;
    conn.execute("INSERT OR IGNORE INTO recommendation_prune_ids SELECT id FROM listening_sessions ORDER BY started_at DESC,id DESC LIMIT -1 OFFSET 50000", []).map_err(err)?;
    // Clamp each recording/day before adding its aggregate; daily guards survive
    // incremental retention sweeps, so repeats cannot gain weight on each sweep.
    conn.execute_batch("CREATE TEMP TABLE IF NOT EXISTS recommendation_prune_days(track_key TEXT,day INTEGER,track_json TEXT,weight REAL,updated_at INTEGER,PRIMARY KEY(track_key,day)); DELETE FROM recommendation_prune_days;").map_err(err)?;
    conn.execute("INSERT INTO recommendation_prune_days SELECT track_key,CAST(started_at/86400000 AS INTEGER),json_extract(event_json,'$.track'),MIN(1.0,SUM(MIN(1.0,covered_sec/duration_sec) * CASE WHEN json_extract(event_json,'$.startReason')='autoplay' THEN 0.7 ELSE 1.0 END)),MAX(started_at) FROM listening_sessions WHERE id IN (SELECT id FROM recommendation_prune_ids) AND duration_sec>=15 AND elapsed_sec>=MIN(30.0,duration_sec*0.8) AND covered_sec/duration_sec>=0.5 AND json_extract(event_json,'$.startReason')<>'restore' AND COALESCE(json_extract(event_json,'$.endReason'),'')<>'error' GROUP BY track_key,CAST(started_at/86400000 AS INTEGER)", []).map_err(err)?;
    conn.execute("INSERT INTO recommendation_taste(track_key,track_json,weight,updated_at) SELECT p.track_key,p.track_json,SUM(MAX(0.0,MIN(1.0,COALESCE(d.weight,0.0)+p.weight)-COALESCE(d.weight,0.0))),MAX(p.updated_at) FROM recommendation_prune_days p LEFT JOIN recommendation_taste_days d ON p.track_key=d.track_key AND p.day=d.day WHERE 1 GROUP BY p.track_key ON CONFLICT(track_key) DO UPDATE SET weight=MIN(365.0,recommendation_taste.weight+excluded.weight),updated_at=MAX(recommendation_taste.updated_at,excluded.updated_at)", []).map_err(err)?;
    conn.execute("INSERT INTO recommendation_taste_days(track_key,day,weight,updated_at) SELECT track_key,day,weight,updated_at FROM recommendation_prune_days WHERE 1 ON CONFLICT(track_key,day) DO UPDATE SET weight=MIN(1.0,recommendation_taste_days.weight+excluded.weight),updated_at=MAX(recommendation_taste_days.updated_at,excluded.updated_at)", []).map_err(err)?;
    // Retire identities before deleting payloads. Older rows from migration 21
    // have an empty hash and are conservatively rejected if retransmitted.
    conn.execute("INSERT OR REPLACE INTO listening_session_tombstones(id,revision,track_key,started_at,event_hash) SELECT id,revision,track_key,started_at,event_hash FROM listening_sessions WHERE id IN (SELECT id FROM recommendation_prune_ids)", []).map_err(err)?;
    conn.execute(
        "DELETE FROM listening_sessions WHERE id IN (SELECT id FROM recommendation_prune_ids)",
        [],
    )
    .map_err(err)?;
    conn.execute(
        "DELETE FROM listening_session_tombstones WHERE started_at < ?1",
        params![now - SESSION_RETENTION_MS],
    )
    .map_err(err)?;
    // Once a bounded tombstone is removed, its timestamp falls outside the
    // admissible range for any new identity; exact expired replay stays inert.
    conn.execute("UPDATE recommendation_meta SET write_floor_at=MAX(write_floor_at,COALESCE((SELECT MAX(started_at) FROM (SELECT started_at FROM listening_session_tombstones ORDER BY started_at DESC,id DESC LIMIT -1 OFFSET 50000)),0)) WHERE id=1", []).map_err(err)?;
    conn.execute("DELETE FROM listening_session_tombstones WHERE rowid IN (SELECT rowid FROM listening_session_tombstones ORDER BY started_at DESC,id DESC LIMIT -1 OFFSET 50000)", []).map_err(err)?;
    conn.execute(
        "DELETE FROM recommendation_taste_days WHERE updated_at < ?1",
        params![now - 186 * 86_400_000],
    )
    .map_err(err)?;
    conn.execute(
        "DELETE FROM recommendation_impressions WHERE shown_at < ?1",
        params![now - 30 * 86_400_000],
    )
    .map_err(err)?;
    conn.execute(
        "DELETE FROM recommendation_pages WHERE fetched_at < ?1",
        params![now - 86_400_000],
    )
    .map_err(err)?;
    for (table, order, limit) in [
        ("recommendation_features", "updated_at DESC", 5000),
        ("recommendation_pages", "fetched_at DESC", 200),
        ("recommendation_impressions", "shown_at DESC", 30_000),
        ("recommendation_taste", "weight DESC,updated_at DESC", 1000),
        ("recommendation_taste_days", "updated_at DESC", 50_000),
    ] {
        conn.execute(&format!("DELETE FROM {table} WHERE rowid IN (SELECT rowid FROM {table} ORDER BY {order} LIMIT -1 OFFSET {limit})"), []).map_err(err)?;
    }
    conn.execute_batch(
        "DELETE FROM recommendation_prune_ids; DELETE FROM recommendation_prune_days;",
    )
    .map_err(err)?;
    Ok(())
}

pub fn record(db: &Db, event: ListeningEvent) -> Result<(), String> {
    validate(&event)?;
    let encoded = serde_json::to_string(&event).map_err(|e| e.to_string())?;
    if encoded.len() > 16_384 {
        return Err("Listening event too large".into());
    }
    let event_hash = format!("{:x}", Sha256::digest(encoded.as_bytes()));
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction().map_err(err)?;
        let generation: i64 = tx.query_row("SELECT generation FROM recommendation_meta WHERE id = 1", [], |r| r.get(0)).map_err(err)?;
        if generation != event.generation { return Err("Listening history was cleared".into()); }
        let old: Option<(i64, String)> = tx.query_row("SELECT revision,event_json FROM listening_sessions WHERE id = ?1", [&event.id], |r| Ok((r.get(0)?,r.get(1)?))).optional().map_err(err)?;
        if let Some((revision, old_json)) = old {
            if revision > event.revision { return Err("Stale listening revision".into()); }
            if revision == event.revision { return if old_json == encoded { Ok(()) } else { Err("Conflicting listening revision".into()) }; }
            let old: ListeningEvent = serde_json::from_str(&old_json).map_err(|e| e.to_string())?;
            if old.finished || old.track_key != event.track_key || old.started_at != event.started_at
                || old.start_reason != event.start_reason || old.elapsed_sec > event.elapsed_sec || old.covered_sec > event.covered_sec {
                return Err("Session identity or counters cannot be overwritten".into());
            }
        } else {
            let retired: Option<(i64,String,i64,String)> = tx.query_row("SELECT revision,track_key,started_at,event_hash FROM listening_session_tombstones WHERE id=?1",[&event.id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(err)?;
            if let Some((revision,track_key,started_at,hash)) = retired {
                if revision == event.revision && track_key == event.track_key && started_at == event.started_at && hash == event_hash { return Ok(()); }
                return Err("Listening session was retired".into());
            }
            let floor:i64=tx.query_row("SELECT write_floor_at FROM recommendation_meta WHERE id=1",[],|r|r.get(0)).map_err(err)?;
            if event.started_at <= floor { return Err("Expired listening session".into()); }
        }
        tx.execute("INSERT INTO listening_sessions(id,revision,track_key,started_at,elapsed_sec,covered_sec,duration_sec,finished,event_json,event_hash) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,elapsed_sec=excluded.elapsed_sec,covered_sec=excluded.covered_sec,duration_sec=excluded.duration_sec,finished=excluded.finished,event_json=excluded.event_json,event_hash=excluded.event_hash",
            params![event.id,event.revision,event.track_key,event.started_at,event.elapsed_sec,event.covered_sec,event.duration_sec,event.finished,encoded,event_hash]).map_err(err)?;
        if event.finished && event.elapsed_sec > 0.0 {
            let track_id: Option<i64> = if event.track.source == "local" {
                tx.query_row("SELECT id FROM tracks WHERE id = ?1 AND source = 'local'", [event.track.source_id.parse::<i64>().map_err(|e| e.to_string())?], |r| r.get(0)).optional().map_err(err)?
            } else {
                tx.query_row("SELECT id FROM tracks WHERE source = ?1 AND external_id = ?2", params![event.track.source,event.track.source_id], |r| r.get(0)).optional().map_err(err)?
            };
            if let Some(id) = track_id {
                let complete = event.duration_sec.is_some_and(|d| d > 0.0 && event.covered_sec / d >= 0.9);
                let skipped = matches!(event.end_reason.as_deref(), Some("select" | "next" | "previous" | "clear" | "remove")) && !complete;
                let inserted = tx.execute("INSERT OR IGNORE INTO listening_history(track_id,played_at,listened_sec,covered_sec,completed,skipped,session_id) VALUES(?1,?2,?3,?4,?5,?6,?7)", params![id,event.started_at/1000,event.elapsed_sec,event.covered_sec,complete,skipped,event.id]).map_err(err)?;
                if skipped && inserted > 0 { tx.execute("UPDATE tracks SET skip_count=skip_count+1 WHERE id=?1", [id]).map_err(err)?; }
            }
        }
        prune(&tx)?;
        tx.commit().map_err(err)
    })
}

fn read_json<T: serde::de::DeserializeOwned>(
    conn: &Connection,
    sql: &str,
    budget: usize,
) -> Result<Vec<T>, String> {
    let mut stmt = conn.prepare(sql).map_err(err)?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(err)?;
    let mut result = Vec::new();
    let mut used = 0;
    for row in rows {
        let row = row.map_err(err)?;
        used += row.len();
        if used > budget {
            break;
        }
        if let Ok(value) = serde_json::from_str(&row) {
            result.push(value);
        }
    }
    Ok(result)
}

pub fn context(db: &Db) -> Result<RecommendationContext, String> {
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction().map_err(err)?;
        prune(&tx)?;
        let generation = tx.query_row("SELECT generation FROM recommendation_meta WHERE id=1", [], |r| r.get(0)).map_err(err)?;
        let sessions: Vec<ListeningEvent> = read_json(&tx,"SELECT event_json FROM listening_sessions ORDER BY started_at DESC LIMIT 1000",4*1024*1024)?;
        let mut seed_tracks = Vec::new(); let mut liked_track_keys = Vec::new(); let mut manually_saved_track_keys = Vec::new();
        let mut stmt = tx.prepare("SELECT t.id,t.source,t.external_id,t.title,COALESCE(a.name,t.artist_name),al.title,t.duration_sec,t.cover_path,MAX(p.is_likes),MAX(pt.added_at) FROM playlist_tracks pt JOIN playlists p ON p.id=pt.playlist_id JOIN tracks t ON t.id=pt.track_id LEFT JOIN artists a ON a.id=t.artist_id LEFT JOIN albums al ON al.id=t.album_id GROUP BY t.id ORDER BY MAX(p.is_likes) DESC,MAX(pt.added_at) DESC LIMIT 512").map_err(err)?;
        let rows = stmt.query_map([], |r| {
            let id: i64=r.get(0)?; let source: String=r.get(1)?; let external: Option<String>=r.get(2)?;
            let source_id=if source=="local" { id.to_string() } else { external.unwrap_or_default() };
            Ok((RecommendationTrack{track_key:format!("{source}:{source_id}"),source,source_id,db_id:Some(id),title:r.get(3)?,artists:r.get::<_,Option<String>>(4)?.into_iter().collect(),album:r.get(5)?,duration_sec:r.get(6)?,cover_path:r.get(7)?,external_url:None,provenance:None},r.get::<_,bool>(8)?,r.get::<_,i64>(9)?*1000))
        }).map_err(err)?;
        for row in rows {
            let (track, liked, at)=row.map_err(err)?; if key(&track.track_key).is_err() { continue; }
            if liked { liked_track_keys.push(track.track_key.clone()); } else { manually_saved_track_keys.push(track.track_key.clone()); }
            seed_tracks.push(Seed{track,evidence:if liked {"like"} else {"playlist"}.into(),confidence:if liked {1.0} else {0.65},weight:if liked {3.0} else {1.0},at});
        }
        drop(stmt);
        let mut per_day = std::collections::HashMap::<(String,i64), f64>::new();
        let mut stmt = tx.prepare("SELECT track_key,day,weight FROM recommendation_taste_days LIMIT 50000").map_err(err)?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,f64>(2)?))).map_err(err)?;
        for row in rows { let (track_key, day, weight) = row.map_err(err)?; per_day.insert((track_key,day),weight); }
        drop(stmt);
        for event in &sessions {
            let duration=event.duration_sec.unwrap_or(0.0);
            if duration < 15.0 || event.start_reason=="restore" || event.end_reason.as_deref()==Some("error") || event.covered_sec/duration < 0.5 || event.elapsed_sec < 30.0_f64.min(duration*0.8) { continue; }
            let day=per_day.entry((event.track_key.clone(),event.started_at/86_400_000)).or_default();
            let contribution=(event.covered_sec/duration).min(1.0) * if event.start_reason=="autoplay" {0.7} else {1.0};
            let weight=contribution.min((1.0-*day).max(0.0)); if weight <= 0.0 { continue; } *day += weight;
            seed_tracks.push(Seed{track:event.track.clone(),evidence:"listening".into(),confidence:0.9,weight,at:event.started_at});
        }
        let mut stmt=tx.prepare("SELECT track_json,weight,updated_at FROM recommendation_taste ORDER BY weight DESC,updated_at DESC LIMIT 128").map_err(err)?;
        let rows=stmt.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,f64>(1)?,r.get::<_,i64>(2)?))).map_err(err)?;
        for row in rows { let (track,weight,at)=row.map_err(err)?; if let Ok(track)=serde_json::from_str(&track) {seed_tracks.push(Seed{track,evidence:"aggregate".into(),confidence:0.7,weight,at});} }
        drop(stmt);
        // Legacy history gives weak bootstrap evidence, never raw play_count or cache status.
        let mut stmt=tx.prepare("SELECT t.id,t.source,t.external_id,t.title,COALESCE(a.name,t.artist_name),al.title,t.duration_sec,t.cover_path,MAX(h.played_at) FROM listening_history h JOIN tracks t ON t.id=h.track_id LEFT JOIN artists a ON a.id=t.artist_id LEFT JOIN albums al ON al.id=t.album_id WHERE h.session_id IS NULL AND h.completed=1 AND h.skipped=0 AND t.duration_sec >= 15 GROUP BY t.id ORDER BY MAX(h.played_at) DESC LIMIT 64").map_err(err)?;
        let rows=stmt.query_map([],|r|{
            let id:i64=r.get(0)?;let source:String=r.get(1)?;let external:Option<String>=r.get(2)?;let source_id=if source=="local"{id.to_string()}else{external.unwrap_or_default()};
            Ok(Seed{track:RecommendationTrack{track_key:format!("{source}:{source_id}"),source,source_id,db_id:Some(id),title:r.get(3)?,artists:r.get::<_,Option<String>>(4)?.into_iter().collect(),album:r.get(5)?,duration_sec:r.get(6)?,cover_path:r.get(7)?,external_url:None,provenance:None},evidence:"legacy".into(),confidence:0.25,weight:0.25,at:r.get::<_,i64>(8)?*1000})
        }).map_err(err)?;
        for row in rows {let seed=row.map_err(err)?; if key(&seed.track.track_key).is_ok(){seed_tracks.push(seed);}}
        drop(stmt);
        seed_tracks.truncate(1024);
        let impressions=read_json(&tx,"SELECT json_object('id',id,'trackKey',track_key,'recordingGroup',recording_group,'shownAt',shown_at,'surface',surface) FROM recommendation_impressions ORDER BY shown_at DESC LIMIT 10000",2*1024*1024)?;
        let features=read_json(&tx,"SELECT json_object('trackKey',track_key,'revision',revision,'updatedAt',updated_at,'data',json(data_json)) FROM recommendation_features ORDER BY updated_at DESC LIMIT 5000",4*1024*1024)?;
        let stored_state=read_json(&tx,"SELECT json_object('revision',revision,'data',json(data_json)) FROM recommendation_state WHERE id=1",512*1024+256)?.pop();
        tx.commit().map_err(err)?;
        Ok(RecommendationContext{generation,seed_tracks,liked_track_keys,manually_saved_track_keys,sessions,impressions,features,stored_state})
    })
}

#[tauri::command]
pub fn record_listening_session(
    state: State<'_, AppState>,
    event: ListeningEvent,
) -> Result<(), String> {
    record(&state.db, event)
}
#[tauri::command]
pub fn get_recommendation_context(
    state: State<'_, AppState>,
) -> Result<RecommendationContext, String> {
    context(&state.db)
}
#[tauri::command]
pub fn record_recommendation_impressions(
    state: State<'_, AppState>,
    impressions: Vec<Impression>,
    generation: i64,
) -> Result<(), String> {
    if impressions.len() > 100 {
        return Err("Impression batch exceeds 100".into());
    }
    for item in &impressions {
        text(&item.id, 128)?;
        key(&item.track_key)?;
        stamp(item.shown_at)?;
        if let Some(group) = &item.recording_group {
            text(group, 256)?;
        }
        if item.id.is_empty() || !matches!(item.surface.as_str(), "home" | "radio") {
            return Err("Invalid impression".into());
        }
    }
    state.db.with_conn(|conn|{
        let tx=conn.unchecked_transaction().map_err(err)?;
        let current:i64=tx.query_row("SELECT generation FROM recommendation_meta WHERE id=1",[],|r|r.get(0)).map_err(err)?;
        if current!=generation{return Err("Recommendation feedback was cleared".into());}
        for item in &impressions {tx.execute("INSERT OR IGNORE INTO recommendation_impressions(id,track_key,recording_group,shown_at,surface) VALUES(?1,?2,?3,?4,?5)",params![item.id,item.track_key,item.recording_group,item.shown_at,item.surface]).map_err(err)?;}
        prune(&tx)?;tx.commit().map_err(err)
    })
}
#[tauri::command]
pub fn save_recommendation_features(
    state: State<'_, AppState>,
    features: Vec<Feature>,
) -> Result<(), String> {
    if features.len() > 100 {
        return Err("Feature batch exceeds 100".into());
    }
    let mut encoded = Vec::new();
    for feature in &features {
        key(&feature.track_key)?;
        stamp(feature.updated_at)?;
        if feature.revision <= 0 {
            return Err("Invalid feature revision".into());
        }
        encoded.push(json(&feature.data, 16 * 1024)?);
    }
    state.db.with_conn(|conn|{
        let tx=conn.unchecked_transaction().map_err(err)?;
        for (feature,data) in features.iter().zip(encoded.iter()) {
            let previous:Option<i64>=tx.query_row("SELECT revision FROM recommendation_features WHERE track_key=?1",[&feature.track_key],|r|r.get(0)).optional().map_err(err)?;
            if previous.is_some_and(|r|r>feature.revision){return Err("Stale feature revision".into());}
            tx.execute("INSERT INTO recommendation_features(track_key,revision,updated_at,data_json) VALUES(?1,?2,?3,?4) ON CONFLICT(track_key) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at,data_json=excluded.data_json WHERE excluded.revision>recommendation_features.revision",params![feature.track_key,feature.revision,feature.updated_at,data]).map_err(err)?;
        }
        prune(&tx)?;tx.commit().map_err(err)
    })
}
#[tauri::command]
pub fn save_recommendation_state(
    state: State<'_, AppState>,
    stored_state: StoredState,
    generation: i64,
) -> Result<(), String> {
    if stored_state.revision <= 0 {
        return Err("Invalid feed revision".into());
    }
    let encoded = json(&stored_state.data, 512 * 1024)?;
    state.db.with_conn(|conn|{
        let tx=conn.unchecked_transaction().map_err(err)?;
        let current:i64=tx.query_row("SELECT generation FROM recommendation_meta WHERE id=1",[],|r|r.get(0)).map_err(err)?;
        if generation!=current{return Err("Recommendation feedback was cleared".into());}
        let previous:Option<i64>=tx.query_row("SELECT revision FROM recommendation_state WHERE id=1",[],|r|r.get(0)).optional().map_err(err)?;
        if previous.is_some_and(|r|r>stored_state.revision){return Err("Stale feed revision".into());}
        tx.execute("INSERT INTO recommendation_state(id,revision,data_json) VALUES(1,?1,?2) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,data_json=excluded.data_json WHERE excluded.revision>recommendation_state.revision",params![stored_state.revision,encoded]).map_err(err)?;
        tx.commit().map_err(err)
    })
}
#[tauri::command]
pub fn get_recommendation_page(
    state: State<'_, AppState>,
    key: String,
) -> Result<Option<ProviderPage>, String> {
    text(&key, 2048)?;
    state.db.with_conn(|conn|conn.query_row("SELECT fetched_at,data_json FROM recommendation_pages WHERE page_key=?1 AND fetched_at>=?2",params![key,millis()-86_400_000],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?))).optional().map_err(err)?.map(|(fetched_at,data)|serde_json::from_str(&data).map(|data|ProviderPage{key,fetched_at,data}).map_err(|e|e.to_string())).transpose())
}
#[tauri::command]
pub fn save_recommendation_page(
    state: State<'_, AppState>,
    page: ProviderPage,
) -> Result<(), String> {
    text(&page.key, 2048)?;
    stamp(page.fetched_at)?;
    let encoded = json(&page.data, 512 * 1024)?;
    state.db.with_conn(|conn|{
        let tx=conn.unchecked_transaction().map_err(err)?;
        tx.execute("INSERT INTO recommendation_pages(page_key,fetched_at,data_json) VALUES(?1,?2,?3) ON CONFLICT(page_key) DO UPDATE SET fetched_at=excluded.fetched_at,data_json=excluded.data_json WHERE excluded.fetched_at>=recommendation_pages.fetched_at",params![page.key,page.fetched_at,encoded]).map_err(err)?;
        prune(&tx)?;tx.commit().map_err(err)
    })
}
