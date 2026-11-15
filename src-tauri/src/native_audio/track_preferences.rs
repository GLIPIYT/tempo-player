use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
use serde_json::Value;

use crate::database::Db;

pub(crate) const MIGRATION: &str = r#"
CREATE TABLE IF NOT EXISTS track_playback_preferences (
    source TEXT NOT NULL,
    source_id TEXT NOT NULL,
    last_volume REAL CHECK (last_volume BETWEEN 0 AND 1),
    last_playback_rate REAL CHECK (last_playback_rate BETWEEN 0.5 AND 2),
    volume_enabled INTEGER NOT NULL CHECK (volume_enabled IN (0, 1)),
    playback_rate_enabled INTEGER NOT NULL CHECK (playback_rate_enabled IN (0, 1)),
    PRIMARY KEY (source, source_id)
) WITHOUT ROWID;
"#;

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct TrackKey {
    source: String,
    source_id: String,
}

impl TrackKey {
    pub fn new(source: String, source_id: String) -> Result<Self, String> {
        if !matches!(source.as_str(), "local" | "soundcloud" | "youtube")
            || source_id.is_empty()
            || source_id.len() > 230
            || source_id.contains('\0')
        {
            return Err("Invalid track playback preference identity".into());
        }
        Ok(Self { source, source_id })
    }

    pub fn from_payload(track: &Value) -> Option<Self> {
        let source = track.get("source")?.as_str()?;
        let source_id = track.get("sourceId")?.as_str()?;
        Self::new(source.into(), source_id.into()).ok()
    }

    pub fn matches_payload(&self, track: &Value) -> bool {
        track.get("source").and_then(Value::as_str) == Some(self.source.as_str())
            && track.get("sourceId").and_then(Value::as_str) == Some(self.source_id.as_str())
    }

    pub fn matches_control_key(&self, key: &str) -> bool {
        key.split_once(':') == Some((self.source.as_str(), self.source_id.as_str()))
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackPlaybackPreferences {
    pub volume: Option<f32>,
    pub playback_rate: Option<f32>,
    pub saved_volume: Option<f32>,
    pub saved_playback_rate: Option<f32>,
}

#[derive(Debug, Default)]
pub(crate) struct TrackPreferencesPatch {
    pub volume: Option<Option<f32>>,
    pub playback_rate: Option<Option<f32>>,
}

impl TrackPreferencesPatch {
    pub fn parse(value: &Value) -> Result<Self, String> {
        let object = value
            .as_object()
            .ok_or("Track playback preference patch must be an object")?;
        if object
            .keys()
            .any(|key| key != "volume" && key != "playbackRate")
        {
            return Err("Unknown track playback preference".into());
        }
        Ok(Self {
            volume: parse_field(value.get("volume"), 0.0, 1.0)?,
            playback_rate: parse_field(value.get("playbackRate"), 0.5, 2.0)?,
        })
    }

    pub fn is_empty(&self) -> bool {
        self.volume.is_none() && self.playback_rate.is_none()
    }
}

fn parse_field(
    value: Option<&Value>,
    minimum: f64,
    maximum: f64,
) -> Result<Option<Option<f32>>, String> {
    match value {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(value) => value
            .as_f64()
            .filter(|value| value.is_finite() && (minimum..=maximum).contains(value))
            .map(|value| Some(Some(value as f32)))
            .ok_or_else(|| "Track playback preference is out of range".into()),
    }
}

pub(crate) fn open_reader(db: &Db) -> Result<Connection, String> {
    // Selection and pre-transport reads should not queue behind the library scanner.
    let path = db.with_conn(|conn| {
        conn.path()
            .filter(|path| !path.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| "Track playback preferences require a file-backed database".into())
    })?;
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("Track playback preferences: {error}"))
}

pub(crate) fn get(
    db: &Db,
    reader: Option<&Connection>,
    key: &TrackKey,
) -> Result<TrackPlaybackPreferences, String> {
    if let Some(reader) = reader {
        read(reader, key)
    } else {
        db.with_conn(|conn| read(conn, key))
    }
}

pub(crate) fn update(
    db: &Db,
    key: &TrackKey,
    patch: TrackPreferencesPatch,
) -> Result<TrackPlaybackPreferences, String> {
    db.with_conn(|conn| {
        let previous = read(conn, key)?;
        let mut next = previous;
        if let Some(value) = patch.volume {
            next.volume = value;
            next.saved_volume = value.or(next.saved_volume);
        }
        if let Some(value) = patch.playback_rate {
            next.playback_rate = value;
            next.saved_playback_rate = value.or(next.saved_playback_rate);
        }
        if next != previous {
            conn.execute(
                "INSERT INTO track_playback_preferences
                 (source, source_id, last_volume, last_playback_rate, volume_enabled, playback_rate_enabled)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(source, source_id) DO UPDATE SET
                    last_volume = excluded.last_volume,
                    last_playback_rate = excluded.last_playback_rate,
                    volume_enabled = excluded.volume_enabled,
                    playback_rate_enabled = excluded.playback_rate_enabled",
                params![
                    key.source,
                    key.source_id,
                    next.saved_volume,
                    next.saved_playback_rate,
                    next.volume.is_some(),
                    next.playback_rate.is_some(),
                ],
            )
            .map_err(|error| format!("Track playback preferences: {error}"))?;
        }
        Ok(next)
    })
}

fn read(conn: &Connection, key: &TrackKey) -> Result<TrackPlaybackPreferences, String> {
    conn.query_row(
        "SELECT last_volume, last_playback_rate, volume_enabled, playback_rate_enabled
         FROM track_playback_preferences WHERE source=?1 AND source_id=?2",
        params![key.source, key.source_id],
        |row| {
            let saved_volume = row.get(0)?;
            let saved_playback_rate = row.get(1)?;
            Ok(TrackPlaybackPreferences {
                volume: if row.get(2)? { saved_volume } else { None },
                playback_rate: if row.get(3)? {
                    saved_playback_rate
                } else {
                    None
                },
                saved_volume,
                saved_playback_rate,
            })
        },
    )
    .optional()
    .map(|value| value.unwrap_or_default())
    .map_err(|error| format!("Track playback preferences: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn preferences_survive_restart_and_disable_keeps_the_last_values() {
        let dir = tempfile::tempdir().unwrap();
        let database = dir.path().join("library.db");
        let db = Db::open_at(&database).unwrap();
        let youtube = TrackKey::new("youtube".into(), "123".into()).unwrap();
        let soundcloud = TrackKey::new("soundcloud".into(), "123".into()).unwrap();
        let patch = |value| TrackPreferencesPatch::parse(&value).unwrap();

        let reader = open_reader(&db).unwrap();
        assert_eq!(
            get(&db, Some(&reader), &youtube).unwrap(),
            TrackPlaybackPreferences::default()
        );
        update(
            &db,
            &youtube,
            patch(json!({ "volume": 0, "playbackRate": 1.4 })),
        )
        .unwrap();
        let disabled = update(&db, &youtube, patch(json!({ "volume": null }))).unwrap();
        assert_eq!(disabled.volume, None);
        assert_eq!(disabled.saved_volume, Some(0.0));
        assert_eq!(disabled.playback_rate, Some(1.4));
        assert_eq!(
            get(&db, Some(&reader), &soundcloud).unwrap(),
            TrackPlaybackPreferences::default()
        );
        assert_eq!(get(&db, Some(&reader), &youtube).unwrap(), disabled);

        drop(reader);
        drop(db);
        let db = Db::open_at(&database).unwrap();
        assert_eq!(get(&db, None, &youtube).unwrap(), disabled);
        let enabled = update(
            &db,
            &youtube,
            patch(json!({ "volume": disabled.saved_volume })),
        )
        .unwrap();
        assert_eq!(enabled.volume, Some(0.0));
        assert_eq!(enabled.saved_playback_rate, Some(1.4));
    }

    #[test]
    fn patch_distinguishes_missing_fields_from_null_and_checks_ranges() {
        let patch = TrackPreferencesPatch::parse(&json!({ "volume": null })).unwrap();
        assert_eq!(patch.volume, Some(None));
        assert_eq!(patch.playback_rate, None);
        assert!(TrackPreferencesPatch::parse(&json!({ "volume": 1.1 })).is_err());
        assert!(TrackPreferencesPatch::parse(&json!({ "playbackRate": 0 })).is_err());
    }
}
