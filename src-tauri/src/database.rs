use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};

use crate::models::{
    Album, AlbumDetail, AnalyticsData, Artist, ArtistDetail, FileStamp, HistoryEntryDto,
    LibraryFolder, Playlist, PlaylistTrack, SearchResults, StatsSummary, TopArtistItem, TopTrackItem,
    Track, TrackInput,
};

const TRACK_COLUMNS: &str =
    "t.id, t.path, t.title, t.artist_id, COALESCE(a.name, t.artist_name), t.album_id, al.title, t.track_number, \
     t.disc_number, t.duration_sec, t.year, t.genre, t.cover_path, t.file_size, t.modified_at, \
     t.added_at, t.source, t.external_id, t.last_played_at, t.play_count, t.skip_count";

const TRACK_FROM: &str =
    "tracks t LEFT JOIN artists a ON a.id = t.artist_id LEFT JOIN albums al ON al.id = t.album_id";

const HISTORY_TRACKS_FROM: &str = "listening_history h \
     JOIN tracks t ON t.id = h.track_id \
     LEFT JOIN artists a ON a.id = t.artist_id \
     LEFT JOIN albums al ON al.id = t.album_id";

const TRACK_SEARCH_PRED: &str = r"(t.folder_id IS NOT NULL OR (t.source = 'soundcloud' AND t.cached_at IS NOT NULL)) AND t.search_text LIKE ?1 ESCAPE '\'";

const TRACK_EXACT_TARGET: usize = 25;
const CATALOG_EXACT_TARGET: usize = 15;
const TRACK_CANDIDATE_LIMIT: i64 = 20000;
const SEARCH_MIN_COVERAGE: f64 = 0.5;

const ALBUM_COLUMNS: &str =
    "al.id, al.title, al.artist_id, ar.name, al.year, al.cover_path, \
     (SELECT COUNT(*) FROM tracks tc WHERE tc.album_id = al.id)";

const ALBUM_ORDER: &str = "al.title COLLATE NOCASE, al.id";

const ARTIST_COLUMNS: &str =
    "ar.id, ar.name, (SELECT COUNT(*) FROM albums ac WHERE ac.artist_id = ar.id), \
     (SELECT COUNT(*) FROM tracks tk WHERE tk.artist_id = ar.id)";

const PLAYLIST_COLUMNS: &str =
    "p.id, p.name, p.created_at, p.updated_at, \
     (SELECT COUNT(*) FROM playlist_tracks pc WHERE pc.playlist_id = p.id), \
     p.pinned, p.pin_order, p.is_likes, \
     (SELECT tc.cover_path FROM playlist_tracks ptc \
      JOIN tracks tc ON tc.id = ptc.track_id \
      WHERE ptc.playlist_id = p.id AND tc.cover_path IS NOT NULL \
      ORDER BY ptc.added_at DESC, ptc.id DESC LIMIT 1)";

const PLAYLIST_VISIBLE_PRED: &str =
    "t.folder_id IS NOT NULL OR (t.source = 'soundcloud' AND t.cached_at IS NOT NULL)";

const FOLDER_COLUMNS: &str =
    "f.id, f.path, f.enabled, f.added_at, \
     (SELECT COUNT(*) FROM tracks tf WHERE tf.folder_id = f.id)";

const MIGRATION_1: &str = r#"
CREATE TABLE IF NOT EXISTS library_folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    enabled INTEGER NOT NULL DEFAULT 1,
    added_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS artists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
);
CREATE TABLE IF NOT EXISTS albums (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL COLLATE NOCASE,
    artist_id INTEGER REFERENCES artists(id) ON DELETE SET NULL,
    year INTEGER,
    cover_path TEXT,
    UNIQUE(title COLLATE NOCASE, artist_id)
);
CREATE TABLE IF NOT EXISTS tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    folder_id INTEGER REFERENCES library_folders(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT '',
    artist_id INTEGER REFERENCES artists(id) ON DELETE SET NULL,
    album_id INTEGER REFERENCES albums(id) ON DELETE SET NULL,
    track_number INTEGER,
    disc_number INTEGER,
    duration_sec REAL,
    year INTEGER,
    genre TEXT,
    cover_path TEXT,
    file_size INTEGER NOT NULL DEFAULT 0,
    modified_at INTEGER NOT NULL DEFAULT 0,
    added_at INTEGER NOT NULL,
    source TEXT NOT NULL DEFAULT 'local',
    external_id TEXT,
    last_played_at INTEGER,
    play_count INTEGER NOT NULL DEFAULT 0,
    skip_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS playlist_tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    added_at INTEGER NOT NULL,
    UNIQUE(playlist_id, position)
);
CREATE TABLE IF NOT EXISTS listening_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    played_at INTEGER NOT NULL,
    start_sec REAL,
    listened_sec REAL,
    completed INTEGER NOT NULL DEFAULT 0,
    skipped INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album_id);
CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist_id);
CREATE INDEX IF NOT EXISTS idx_tracks_folder ON tracks(folder_id);
CREATE INDEX IF NOT EXISTS idx_tracks_added ON tracks(added_at);
CREATE INDEX IF NOT EXISTS idx_tracks_title ON tracks(title);
CREATE INDEX IF NOT EXISTS idx_playlist_tracks ON playlist_tracks(playlist_id, position);
"#;

const MIGRATION_2: &str = r#"
CREATE TABLE app_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
ALTER TABLE playlists ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE playlists ADD COLUMN pin_order INTEGER;
ALTER TABLE tracks ADD COLUMN lyrics TEXT;
"#;

const MIGRATION_3: &str =
    "ALTER TABLE tracks ADD COLUMN search_text TEXT NOT NULL DEFAULT '';";

const MIGRATION_4: &str = r#"
ALTER TABLE tracks ADD COLUMN artist_name TEXT;
CREATE INDEX idx_tracks_source ON tracks(source);
"#;

const MIGRATION_5: &str = r#"
ALTER TABLE tracks ADD COLUMN cached_at INTEGER;
ALTER TABLE playlists ADD COLUMN is_likes INTEGER NOT NULL DEFAULT 0;
INSERT INTO playlists(name, created_at, updated_at, pinned, pin_order, is_likes)
SELECT 'Likes', CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER), 1, 0, 1
WHERE NOT EXISTS (SELECT 1 FROM playlists WHERE is_likes = 1);
"#;

const MIGRATION_6: &str = r#"
UPDATE playlists SET pin_order = pin_order + 1 WHERE pinned = 1 AND is_likes = 0;
UPDATE playlists SET pin_order = 0 WHERE is_likes = 1 AND pinned = 1;
"#;

const MIGRATIONS: &[&str] = &[
    MIGRATION_1, MIGRATION_2, MIGRATION_3, MIGRATION_4, MIGRATION_5, MIGRATION_6,
];

pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    pub fn open_at(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() && !parent.exists() {
                std::fs::create_dir_all(parent).map_err(|e| {
                    format!("failed to create database directory {}: {}", parent.display(), e)
                })?;
            }
        }
        let conn = Connection::open(path)
            .map_err(|e| format!("failed to open database {}: {}", path.display(), e))?;
        conn.pragma_update(None, "journal_mode", "WAL").map_err(db_err)?;
        conn.pragma_update(None, "foreign_keys", "ON").map_err(db_err)?;
        let db = Db { conn: Mutex::new(conn) };
        db.migrate()?;
        db.ensure_likes_playlist()?;
        db.backfill_search_text()?;
        Ok(db)
    }

    fn migrate(&self) -> Result<(), String> {
        let conn = self.lock_conn()?;
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(db_err)?;
        for (index, migration) in MIGRATIONS.iter().enumerate() {
            let target = (index + 1) as i64;
            if version < target {
                let batch = format!("BEGIN;{} PRAGMA user_version = {};COMMIT;", migration, target);
                if let Err(e) = conn.execute_batch(&batch) {
                    let _ = conn.execute_batch("ROLLBACK;");
                    return Err(format!("migration {} failed: {}", target, e));
                }
            }
        }
        Ok(())
    }

    fn lock_conn(&self) -> Result<MutexGuard<'_, Connection>, String> {
        self.conn.lock().map_err(|_| "database mutex poisoned".to_string())
    }

    fn backfill_search_text(&self) -> Result<(), String> {
        self.with_conn(|conn| {
            let pending: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM tracks WHERE search_text = '' AND title <> ''",
                    [],
                    |row| row.get(0),
                )
                .map_err(db_err)?;
            if pending > 0 {
                backfill_search_text_conn(conn)?;
            }
            Ok(())
        })
    }

    pub fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
        let conn = self.lock_conn()?;
        f(&conn)
    }

    pub fn list_file_stamps(&self) -> Result<HashMap<String, FileStamp>, String> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT path, file_size, modified_at FROM tracks WHERE folder_id IS NOT NULL",
                )
                .map_err(db_err)?;
            let mapped = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        FileStamp { size: row.get(1)?, mtime: row.get(2)? },
                    ))
                })
                .map_err(db_err)?;
            let mut stamps = HashMap::new();
            for row in mapped {
                let (path, stamp) = row.map_err(db_err)?;
                stamps.insert(path, stamp);
            }
            Ok(stamps)
        })
    }

    pub fn upsert_scanned_tracks(
        &self,
        new: &[TrackInput],
        updated: &[TrackInput],
    ) -> Result<(u32, u32), String> {
        let conn = self.lock_conn()?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let mut added: u32 = 0;
        let mut updated_count: u32 = 0;
        for input in new {
            upsert_track_input(&tx, input)?;
            added += 1;
        }
        for input in updated {
            upsert_track_input(&tx, input)?;
            updated_count += 1;
        }
        tx.commit().map_err(db_err)?;
        Ok((added, updated_count))
    }

    pub fn delete_tracks_by_paths(&self, paths: &[String]) -> Result<u32, String> {
        if paths.is_empty() {
            return Ok(0);
        }
        let conn = self.lock_conn()?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let mut placeholders = String::new();
        for i in 0..paths.len() {
            if i > 0 {
                placeholders.push_str(", ");
            }
            placeholders.push('?');
        }
        let sql = format!("DELETE FROM tracks WHERE path IN ({})", placeholders);
        let deleted = tx.execute(&sql, params_from_iter(paths)).map_err(db_err)? as u32;
        tx.execute(
            "DELETE FROM albums WHERE id NOT IN \
             (SELECT DISTINCT album_id FROM tracks WHERE album_id IS NOT NULL)",
            [],
        )
        .map_err(db_err)?;
        tx.execute(
            "DELETE FROM artists WHERE id NOT IN \
             (SELECT DISTINCT artist_id FROM tracks WHERE artist_id IS NOT NULL) \
             AND id NOT IN (SELECT DISTINCT artist_id FROM albums WHERE artist_id IS NOT NULL)",
            [],
        )
        .map_err(db_err)?;
        tx.commit().map_err(db_err)?;
        Ok(deleted)
    }

    pub fn list_library_folders(&self) -> Result<Vec<LibraryFolder>, String> {
        self.with_conn(|conn| {
            let sql = format!(
                "SELECT {} FROM library_folders f ORDER BY f.added_at, f.id",
                FOLDER_COLUMNS
            );
            let mut stmt = conn.prepare(&sql).map_err(db_err)?;
            let mapped = stmt.query_map([], map_folder).map_err(db_err)?;
            let mut folders = Vec::new();
            for row in mapped {
                folders.push(row.map_err(db_err)?);
            }
            Ok(folders)
        })
    }

    pub fn add_library_folder(&self, path: &str) -> Result<LibraryFolder, String> {
        let conn = self.lock_conn()?;
        conn.execute(
            "INSERT OR IGNORE INTO library_folders(path, enabled, added_at) VALUES(?1, 1, ?2)",
            params![path, now()],
        )
        .map_err(db_err)?;
        let sql = format!(
            "SELECT {} FROM library_folders f WHERE f.path = ?1",
            FOLDER_COLUMNS
        );
        conn.query_row(&sql, params![path], map_folder).map_err(db_err)
    }

    pub fn remove_library_folder(&self, id: i64) -> Result<(), String> {
        self.with_conn(|conn| {
            conn.execute("DELETE FROM library_folders WHERE id = ?1", params![id])
                .map_err(db_err)?;
            Ok(())
        })
    }

    pub fn count_tracks(&self) -> Result<i64, String> {
        self.with_conn(|conn| {
            conn.query_row(
                &format!("SELECT COUNT(*) FROM tracks t WHERE {}", PLAYLIST_VISIBLE_PRED),
                [],
                |row| row.get(0),
            )
            .map_err(db_err)
        })
    }

    pub fn list_tracks(&self, query: &str, limit: i64, offset: i64) -> Result<Vec<Track>, String> {
        self.list_tracks_sorted(query, "added", limit, offset)
    }

    pub fn list_tracks_sorted(
        &self,
        query: &str,
        sort: &str,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<Track>, String> {
        self.with_conn(|conn| {
            if query.is_empty() {
                let order = match sort {
                    "title" => "t.title COLLATE NOCASE ASC, t.id ASC",
                    "artist" => {
                        "COALESCE(a.name, t.artist_name) COLLATE NOCASE ASC, \
                         t.title COLLATE NOCASE ASC, t.id ASC"
                    }
                    "duration" => "t.duration_sec DESC, t.id DESC",
                    "plays" => "t.play_count DESC, COALESCE(t.last_played_at, 0) DESC, t.id DESC",
                    _ => "t.added_at DESC, t.id DESC",
                };
                fetch_tracks(conn, TRACK_FROM, PLAYLIST_VISIBLE_PRED, None, order, limit, offset)
            } else {
                search_tracks(conn, query, limit, offset)
            }
        })
    }

    pub fn search_all(&self, query: &str) -> Result<SearchResults, String> {
        self.with_conn(|conn| {
            let tracks = search_tracks(conn, query, 200, 0)?;
            let albums = search_albums(conn, query, 50)?;
            let artists = search_artists(conn, query, 50)?;
            Ok(SearchResults { tracks, albums, artists })
        })
    }

    pub fn upsert_sc_track(
        &self,
        sc_id: &str,
        title: &str,
        artist: &str,
        duration_ms: i64,
        artwork_url: Option<&str>,
    ) -> Result<i64, String> {
        let path = format!("soundcloud://{}", sc_id);
        let duration_sec = duration_ms as f64 / 1000.0;
        let search_text = build_search_text(title, artist, "", "");
        self.with_conn(|conn| {
            conn.query_row(
                "INSERT INTO tracks(path, folder_id, title, artist_name, duration_sec, cover_path, \
                 file_size, modified_at, added_at, source, external_id, search_text) \
                 VALUES(?1, NULL, ?2, ?3, ?4, ?5, 0, 0, ?6, 'soundcloud', ?7, ?8) \
                 ON CONFLICT(path) DO UPDATE SET \
                 title = excluded.title, artist_name = excluded.artist_name, \
                 duration_sec = excluded.duration_sec, cover_path = excluded.cover_path, \
                 search_text = excluded.search_text \
                 RETURNING id",
                params![path, title, artist, duration_sec, artwork_url, now(), sc_id, search_text],
                |row| row.get(0),
            )
            .map_err(db_err)
        })
    }

    pub fn list_albums(&self, query: &str) -> Result<Vec<Album>, String> {
        self.with_conn(|conn| {
            if query.is_empty() {
                fetch_albums(conn, "", None, ALBUM_ORDER, -1)
            } else {
                search_albums(conn, query, -1)
            }
        })
    }

    pub fn get_album_detail(&self, album_id: i64) -> Result<Option<AlbumDetail>, String> {
        self.with_conn(|conn| {
            let albums = fetch_albums(
                conn,
                "al.id = ?1",
                Some(Value::Integer(album_id)),
                "al.id",
                1,
            )?;
            match albums.into_iter().next() {
                None => Ok(None),
                Some(album) => {
                    let tracks = fetch_tracks(
                        conn,
                        TRACK_FROM,
                        "t.album_id = ?1",
                        Some(Value::Integer(album_id)),
                        "t.disc_number, t.track_number, t.title COLLATE NOCASE, t.id",
                        -1,
                        0,
                    )?;
                    Ok(Some(AlbumDetail { album, tracks }))
                }
            }
        })
    }

    pub fn list_artists(&self, query: &str) -> Result<Vec<Artist>, String> {
        self.with_conn(|conn| {
            if query.is_empty() {
                fetch_artists(conn, "", None, -1)
            } else {
                search_artists(conn, query, -1)
            }
        })
    }

    pub fn get_artist_detail(&self, artist_id: i64) -> Result<Option<ArtistDetail>, String> {
        self.with_conn(|conn| {
            let artists = fetch_artists(conn, "ar.id = ?1", Some(Value::Integer(artist_id)), 1)?;
            match artists.into_iter().next() {
                None => Ok(None),
                Some(artist) => {
                    let albums = fetch_albums(
                        conn,
                        "al.artist_id = ?1",
                        Some(Value::Integer(artist_id)),
                        "al.year DESC, al.title COLLATE NOCASE",
                        -1,
                    )?;
                    Ok(Some(ArtistDetail { artist, albums }))
                }
            }
        })
    }

    pub fn list_playlists(&self) -> Result<Vec<Playlist>, String> {
        self.with_conn(|conn| {
            let sql = format!(
                "SELECT {} FROM playlists p ORDER BY p.updated_at DESC, p.id DESC",
                PLAYLIST_COLUMNS
            );
            let mut stmt = conn.prepare(&sql).map_err(db_err)?;
            let mapped = stmt.query_map([], map_playlist).map_err(db_err)?;
            let mut playlists = Vec::new();
            for row in mapped {
                playlists.push(row.map_err(db_err)?);
            }
            Ok(playlists)
        })
    }

    pub fn create_playlist(&self, name: &str) -> Result<Playlist, String> {
        let conn = self.lock_conn()?;
        let ts = now();
        conn.execute(
            "INSERT INTO playlists(name, created_at, updated_at) VALUES(?1, ?2, ?2)",
            params![name, ts],
        )
        .map_err(db_err)?;
        let id = conn.last_insert_rowid();
        Ok(Playlist {
            id,
            name: name.to_string(),
            created_at: ts,
            updated_at: ts,
            track_count: Some(0),
            pinned: Some(false),
            pin_order: None,
            is_likes: Some(false),
            cover_path: None,
        })
    }

    pub fn rename_playlist(&self, id: i64, name: &str) -> Result<(), String> {
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE playlists SET name = ?1, updated_at = ?2 WHERE id = ?3",
                params![name, now(), id],
            )
            .map_err(db_err)?;
            Ok(())
        })
    }

    pub fn delete_playlist(&self, id: i64) -> Result<(), String> {
        self.with_conn(|conn| {
            let deleted = conn
                .execute("DELETE FROM playlists WHERE id = ?1 AND is_likes = 0", params![id])
                .map_err(db_err)?;
            if deleted == 0 {
                let is_likes: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM playlists WHERE id = ?1 AND is_likes = 1",
                        params![id],
                        |row| row.get(0),
                    )
                    .map_err(db_err)?;
                if is_likes > 0 {
                    return Err("The Likes playlist cannot be deleted".to_string());
                }
            }
            Ok(())
        })
    }

    pub fn set_playlist_pinned(&self, playlist_id: i64, pinned: bool) -> Result<(), String> {
        let conn = self.lock_conn()?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        if pinned {
            tx.execute(
                "UPDATE playlists SET pinned = 1 WHERE id = ?1",
                params![playlist_id],
            )
            .map_err(db_err)?;
            tx.execute(
                "UPDATE playlists SET pin_order = \
                 COALESCE((SELECT MAX(pin_order) + 1 FROM playlists WHERE pinned = 1 AND id != ?1), 0) \
                 WHERE id = ?1",
                params![playlist_id],
            )
            .map_err(db_err)?;
        } else {
            tx.execute(
                "UPDATE playlists SET pinned = 0, pin_order = NULL WHERE id = ?1",
                params![playlist_id],
            )
            .map_err(db_err)?;
        }
        resequence_pinned(&tx)?;
        tx.execute(
            "UPDATE playlists SET updated_at = ?1 WHERE id = ?2",
            params![now(), playlist_id],
        )
        .map_err(db_err)?;
        tx.commit().map_err(db_err)?;
        Ok(())
    }

    pub fn move_pinned_playlist(&self, playlist_id: i64, new_order: i64) -> Result<(), String> {
        let conn = self.lock_conn()?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let mut stmt = tx
            .prepare("SELECT id FROM playlists WHERE pinned = 1 ORDER BY pin_order, id")
            .map_err(db_err)?;
        let mapped = stmt
            .query_map([], |row| row.get::<_, i64>(0))
            .map_err(db_err)?;
        let mut ids = Vec::new();
        for row in mapped {
            ids.push(row.map_err(db_err)?);
        }
        drop(stmt);
        let current = match ids.iter().position(|id| *id == playlist_id) {
            Some(index) => index,
            None => return Ok(()),
        };
        let count = ids.len() as i64;
        let target = new_order.clamp(0, count - 1);
        if target != current as i64 {
            ids.remove(current);
            ids.insert(target as usize, playlist_id);
            for (index, id) in ids.iter().enumerate() {
                tx.execute(
                    "UPDATE playlists SET pin_order = ?1 WHERE id = ?2",
                    params![index as i64, id],
                )
                .map_err(db_err)?;
            }
        }
        tx.commit().map_err(db_err)?;
        Ok(())
    }

    fn ensure_likes_playlist(&self) -> Result<(), String> {
        self.with_conn(|conn| {
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM playlists WHERE is_likes = 1",
                    [],
                    |row| row.get(0),
                )
                .map_err(db_err)?;
            if exists == 0 {
                let ts = now();
                conn.execute(
                    "INSERT INTO playlists(name, created_at, updated_at, pinned, pin_order, is_likes) \
                     VALUES('Likes', ?1, ?1, 1, 0, 1)",
                    params![ts],
                )
                .map_err(db_err)?;
            }
            Ok(())
        })
    }

    fn likes_playlist_id(conn: &Connection) -> Result<Option<i64>, String> {
        conn.query_row("SELECT id FROM playlists WHERE is_likes = 1", [], |row| row.get(0))
            .optional()
            .map_err(db_err)
    }

    pub fn like_track(&self, track_id: i64) -> Result<bool, String> {
        let conn = self.lock_conn()?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let likes_id: i64 = Self::likes_playlist_id(&tx)?
            .ok_or_else(|| "likes playlist is missing".to_string())?;
        let exists: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM playlist_tracks WHERE playlist_id = ?1 AND track_id = ?2",
                params![likes_id, track_id],
                |row| row.get(0),
            )
            .map_err(db_err)?;
        let added = exists == 0;
        if added {
            tx.execute(
                "INSERT INTO playlist_tracks(playlist_id, track_id, position, added_at) \
                 VALUES(?1, ?2, COALESCE((SELECT MAX(position) + 1 FROM playlist_tracks WHERE playlist_id = ?1), 0), ?3)",
                params![likes_id, track_id, now()],
            )
            .map_err(db_err)?;
            tx.execute(
                "UPDATE playlists SET updated_at = ?1 WHERE id = ?2",
                params![now(), likes_id],
            )
            .map_err(db_err)?;
        }
        tx.commit().map_err(db_err)?;
        Ok(added)
    }

    pub fn unlike_track(&self, track_id: i64) -> Result<bool, String> {
        let conn = self.lock_conn()?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let likes_id: i64 = Self::likes_playlist_id(&tx)?
            .ok_or_else(|| "likes playlist is missing".to_string())?;
        let deleted = tx
            .execute(
                "DELETE FROM playlist_tracks WHERE id = \
                 (SELECT id FROM playlist_tracks WHERE playlist_id = ?1 AND track_id = ?2 \
                 ORDER BY position LIMIT 1)",
                params![likes_id, track_id],
            )
            .map_err(db_err)?;
        if deleted > 0 {
            renumber_playlist(&tx, likes_id)?;
            tx.execute(
                "UPDATE playlists SET updated_at = ?1 WHERE id = ?2",
                params![now(), likes_id],
            )
            .map_err(db_err)?;
        }
        tx.commit().map_err(db_err)?;
        Ok(deleted > 0)
    }

    pub fn list_liked_track_ids(&self) -> Result<Vec<i64>, String> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT pt.track_id FROM playlist_tracks pt \
                     JOIN playlists p ON p.id = pt.playlist_id \
                     WHERE p.is_likes = 1 ORDER BY pt.position",
                )
                .map_err(db_err)?;
            let mapped = stmt.query_map([], |row| row.get::<_, i64>(0)).map_err(db_err)?;
            let mut ids = Vec::new();
            for row in mapped {
                ids.push(row.map_err(db_err)?);
            }
            Ok(ids)
        })
    }

    pub fn get_top_tracks(&self, limit: i64) -> Result<Vec<TopTrackItem>, String> {
        self.with_conn(|conn| fetch_top_tracks(conn, None, limit))
    }

    pub fn get_hour_picks(&self, limit: i64) -> Result<Vec<Track>, String> {
        self.with_conn(|conn| {
            let sql = format!(
                "SELECT {cols} FROM ( \
                     SELECT h.track_id AS tid, COUNT(*) AS plays, MAX(h.played_at) AS last_play \
                     FROM listening_history h \
                     WHERE (CAST(strftime('%H', h.played_at, 'unixepoch', 'localtime') AS INTEGER) \
                            - CAST(strftime('%H', 'now', 'localtime') AS INTEGER) + 24) % 24 IN (23, 0, 1) \
                     GROUP BY h.track_id \
                     ORDER BY plays DESC, last_play DESC \
                     LIMIT {lim} \
                 ) picks \
                 JOIN tracks t ON t.id = picks.tid \
                 LEFT JOIN artists a ON a.id = t.artist_id \
                 LEFT JOIN albums al ON al.id = t.album_id \
                 ORDER BY picks.plays DESC, picks.last_play DESC",
                cols = TRACK_COLUMNS,
                lim = limit,
            );
            let mut stmt = conn.prepare(&sql).map_err(db_err)?;
            let mapped = stmt
                .query_map([], |row| map_track_at(row, 0))
                .map_err(db_err)?;
            let mut tracks = Vec::new();
            for row in mapped {
                tracks.push(row.map_err(db_err)?);
            }
            Ok(tracks)
        })
    }

    pub fn mark_sc_cached(&self, external_id: &str, size: i64) -> Result<(), String> {
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE tracks SET cached_at = COALESCE(cached_at, ?1), file_size = ?2 \
                 WHERE source = 'soundcloud' AND external_id = ?3",
                params![now(), size, external_id],
            )
            .map_err(db_err)?;
            Ok(())
        })
    }

    /// Pulls album/artist/year/genre from the cached file's tags and links the
    /// SoundCloud row into the normal albums and artists catalogs. Returns false
    /// when the row is gone or the file has no readable tags.
    pub fn enrich_sc_track_from_tags(
        &self,
        external_id: &str,
        file: &Path,
        covers_dir: &Path,
    ) -> Result<bool, String> {
        let meta = match crate::metadata::read_metadata(file, covers_dir) {
            Ok(meta) => meta,
            Err(_) => return Ok(false),
        };
        self.with_conn(|conn| {
            let track_id: Option<i64> = conn
                .query_row(
                    "SELECT id FROM tracks WHERE source = 'soundcloud' AND external_id = ?1",
                    params![external_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(db_err)?;
            let Some(track_id) = track_id else { return Ok(false) };

            let tag_artist = meta.artist.as_deref().map(str::trim).filter(|s| !s.is_empty());
            let artist_id = match tag_artist {
                Some(name) => Some(get_or_create_artist(conn, name)?),
                None => None,
            };
            let tag_album = meta.album.as_deref().map(str::trim).filter(|s| !s.is_empty());
            let album_id = match tag_album {
                Some(title) => {
                    let album_artist = meta
                        .album_artist
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .or(tag_artist);
                    let album_artist_id = match album_artist {
                        Some(name) => Some(get_or_create_artist(conn, name)?),
                        None => artist_id,
                    };
                    let album_id = get_or_create_album(conn, title, album_artist_id)?;
                    if let Some(cover) = &meta.cover_path {
                        conn.execute(
                            "UPDATE albums SET cover_path = ?1 WHERE id = ?2 AND cover_path IS NULL",
                            params![cover, album_id],
                        )
                        .map_err(db_err)?;
                    } else {
                        // no embedded art in the file - fall back to the track's
                        // SoundCloud artwork so the album still has a cover
                        conn.execute(
                            "UPDATE albums SET cover_path = \
                             COALESCE(cover_path, (SELECT cover_path FROM tracks WHERE id = ?1)) \
                             WHERE id = ?2 AND cover_path IS NULL",
                            params![track_id, album_id],
                        )
                        .map_err(db_err)?;
                    }
                    Some(album_id)
                }
                None => None,
            };
            let new_search_text = build_search_text(
                meta.title.as_deref().unwrap_or(""),
                tag_artist.unwrap_or(""),
                tag_album.unwrap_or(""),
                meta.genre.as_deref().unwrap_or(""),
            );
            conn.execute(
                "UPDATE tracks SET \
                 title = CASE WHEN ?2 <> '' THEN ?2 ELSE title END, \
                 artist_id = COALESCE(?3, artist_id), \
                 album_id = COALESCE(?4, album_id), \
                 track_number = COALESCE(?5, track_number), \
                 disc_number = COALESCE(?6, disc_number), \
                 duration_sec = COALESCE(?7, duration_sec), \
                 year = COALESCE(?8, year), \
                 genre = COALESCE(?9, genre), \
                 search_text = CASE WHEN ?11 <> '' THEN ?11 ELSE search_text END, \
                 cover_path = COALESCE(cover_path, ?10) \
                 WHERE id = ?1",
                params![
                    track_id,
                    meta.title.as_deref().unwrap_or(""),
                    artist_id,
                    album_id,
                    meta.track_number,
                    meta.disc_number,
                    meta.duration_sec,
                    meta.year,
                    meta.genre,
                    meta.cover_path,
                    new_search_text,
                ],
            )
            .map_err(db_err)?;
            Ok(true)
        })
    }

    pub fn mark_sc_uncached(&self, external_id: &str) -> Result<(), String> {
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE tracks SET cached_at = NULL, file_size = 0 \
                 WHERE source = 'soundcloud' AND external_id = ?1",
                params![external_id],
            )
            .map_err(db_err)?;
            Ok(())
        })
    }

    pub fn oldest_cached_sc_track(&self) -> Result<Option<String>, String> {
        self.with_conn(|conn| {
            conn.query_row(
                "SELECT external_id FROM tracks \
                 WHERE source = 'soundcloud' AND cached_at IS NOT NULL AND external_id IS NOT NULL \
                 AND id NOT IN (SELECT track_id FROM playlist_tracks) \
                 ORDER BY COALESCE(last_played_at, cached_at, 0) ASC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_err)
        })
    }

    /// Syncs `cached_at` flags with the actual cache directory contents, imports
    /// orphan cache files that have no track row yet, removes duplicate local rows
    /// created by the old "add the cache folder as a library folder" workaround,
    /// and enriches cached rows with file tags. Returns the number of tracks
    /// currently backed by a file.
    pub fn reconcile_sc_cache(&self, cache_dir: &Path, covers_dir: &Path) -> Result<u32, String> {
        let mut cached_files: Vec<(String, std::path::PathBuf)> = Vec::new();
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare("SELECT id, external_id FROM tracks WHERE source = 'soundcloud'")
                .map_err(db_err)?;
            let mapped = stmt
                .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?)))
                .map_err(db_err)?;
            let mut rows: Vec<(i64, Option<String>)> = Vec::new();
            for row in mapped {
                rows.push(row.map_err(db_err)?);
            }
            drop(stmt);
            let tx = conn.unchecked_transaction().map_err(db_err)?;
            for (id, external_id) in rows {
                let Some(external_id) = external_id else { continue };
                let file = cache_dir.join(format!("{}.mp3", external_id));
                if file.exists() {
                    let size = std::fs::metadata(&file).map(|m| m.len() as i64).unwrap_or(0);
                    tx.execute(
                        "UPDATE tracks SET cached_at = COALESCE(cached_at, ?1), file_size = ?2 WHERE id = ?3",
                        params![now(), size, id],
                    )
                    .map_err(db_err)?;
                    tx.execute(
                        "DELETE FROM tracks WHERE source = 'local' AND path = ?1 COLLATE NOCASE",
                        params![file.to_string_lossy()],
                    )
                    .map_err(db_err)?;
                    cached_files.push((external_id, file));
                } else {
                    tx.execute(
                        "UPDATE tracks SET cached_at = NULL, file_size = 0 WHERE id = ?1 AND cached_at IS NOT NULL",
                        params![id],
                    )
                    .map_err(db_err)?;
                }
            }
            tx.commit().map_err(db_err)?;
            Ok(())
        })?;

        // orphan files: cached on disk but no soundcloud row (e.g. downloaded by
        // playback before the row existed). Import them so every cached track is
        // visible in the library.
        if let Ok(entries) = std::fs::read_dir(cache_dir) {
            let known: HashSet<String> = cached_files.iter().map(|(id, _)| id.clone()).collect();
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|ext| ext.to_str()) != Some("mp3") {
                    continue;
                }
                let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                    continue;
                };
                if known.contains(stem) {
                    continue;
                }
                let exists: i64 = self.with_conn(|conn| {
                    conn.query_row(
                        "SELECT COUNT(*) FROM tracks WHERE source = 'soundcloud' AND external_id = ?1",
                        params![stem],
                        |row| row.get(0),
                    )
                    .map_err(db_err)
                })?;
                if exists > 0 {
                    continue;
                }
                let size = std::fs::metadata(&path).map(|m| m.len() as i64).unwrap_or(0);
                self.upsert_sc_track(stem, stem, "", 0, None)?;
                self.mark_sc_cached(stem, size)?;
                cached_files.push((stem.to_string(), path));
            }
        }

        let cached = cached_files.len() as u32;
        for (external_id, file) in &cached_files {
            let _ = self.enrich_sc_track_from_tags(external_id, file, covers_dir);
        }
        Ok(cached)
    }

    pub fn get_artist_tracks(&self, artist_id: i64) -> Result<Vec<Track>, String> {
        self.with_conn(|conn| {
            fetch_tracks(
                conn,
                TRACK_FROM,
                "t.artist_id = ?1",
                Some(Value::Integer(artist_id)),
                "t.album_id, t.disc_number, t.track_number, t.title COLLATE NOCASE, t.id",
                -1,
                0,
            )
        })
    }

    pub fn get_daily_minutes(&self, days: i64) -> Result<Vec<crate::models::DailyMinutes>, String> {
        self.with_conn(|conn| {
            let since = now() - days * 86_400;
            let mut stmt = conn
                .prepare(
                    "SELECT date(h.played_at, 'unixepoch', 'localtime') AS d, \
                     COALESCE(SUM(h.listened_sec), 0) / 60.0 \
                     FROM listening_history h WHERE h.played_at >= ?1 \
                     GROUP BY d ORDER BY d",
                )
                .map_err(db_err)?;
            let mapped = stmt
                .query_map(params![since], |row| {
                    Ok(crate::models::DailyMinutes {
                        date: row.get(0)?,
                        minutes: row.get(1)?,
                    })
                })
                .map_err(db_err)?;
            let mut out = Vec::new();
            for row in mapped {
                out.push(row.map_err(db_err)?);
            }
            Ok(out)
        })
    }

    pub fn get_app_setting(&self, key: &str) -> Result<Option<String>, String> {
        self.with_conn(|conn| {
            conn.query_row(
                "SELECT value FROM app_settings WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_err)
        })
    }

    pub fn set_app_setting(&self, key: &str, value: &str) -> Result<(), String> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO app_settings(key, value) VALUES(?1, ?2) \
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .map_err(db_err)?;
            Ok(())
        })
    }

    pub fn get_track_lyrics(&self, track_id: i64) -> Result<Option<String>, String> {
        self.with_conn(|conn| {
            conn.query_row(
                "SELECT lyrics FROM tracks WHERE id = ?1",
                params![track_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .or_else(|err| match err {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })
            .map_err(db_err)
        })
    }

    pub fn get_playlist_tracks(&self, playlist_id: i64) -> Result<Vec<PlaylistTrack>, String> {
        self.with_conn(|conn| {
            let sql = format!(
                "SELECT pt.position, pt.added_at, {} FROM playlist_tracks pt \
                 JOIN tracks t ON t.id = pt.track_id \
                 LEFT JOIN artists a ON a.id = t.artist_id \
                 LEFT JOIN albums al ON al.id = t.album_id \
                 WHERE pt.playlist_id = ?1 ORDER BY pt.position",
                TRACK_COLUMNS
            );
            let mut stmt = conn.prepare(&sql).map_err(db_err)?;
            let mapped = stmt
                .query_map(params![playlist_id], |row| {
                    Ok(PlaylistTrack {
                        position: row.get(0)?,
                        added_at: row.get(1)?,
                        track: map_track_at(row, 2)?,
                    })
                })
                .map_err(db_err)?;
            let mut rows = Vec::new();
            for row in mapped {
                rows.push(row.map_err(db_err)?);
            }
            Ok(rows)
        })
    }

    pub fn playlist_add_track(&self, playlist_id: i64, track_id: i64) -> Result<(), String> {
        let conn = self.lock_conn()?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        tx.execute(
            "INSERT INTO playlist_tracks(playlist_id, track_id, position, added_at) \
             VALUES(?1, ?2, COALESCE((SELECT MAX(position) + 1 FROM playlist_tracks WHERE playlist_id = ?1), 0), ?3)",
            params![playlist_id, track_id, now()],
        )
        .map_err(db_err)?;
        tx.execute("UPDATE playlists SET updated_at = ?1 WHERE id = ?2", params![now(), playlist_id])
            .map_err(db_err)?;
        tx.commit().map_err(db_err)?;
        Ok(())
    }

    pub fn playlist_remove_track(&self, playlist_id: i64, track_id: i64) -> Result<(), String> {
        let conn = self.lock_conn()?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let deleted = tx
            .execute(
                "DELETE FROM playlist_tracks WHERE id = \
                 (SELECT id FROM playlist_tracks WHERE playlist_id = ?1 AND track_id = ?2 \
                 ORDER BY position LIMIT 1)",
                params![playlist_id, track_id],
            )
            .map_err(db_err)?;
        if deleted > 0 {
            renumber_playlist(&tx, playlist_id)?;
            tx.execute(
                "UPDATE playlists SET updated_at = ?1 WHERE id = ?2",
                params![now(), playlist_id],
            )
            .map_err(db_err)?;
        }
        tx.commit().map_err(db_err)?;
        Ok(())
    }

    pub fn playlist_move_track(&self, playlist_id: i64, from_pos: i64, to_pos: i64) -> Result<(), String> {
        if from_pos == to_pos {
            return Ok(());
        }
        let conn = self.lock_conn()?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let mut stmt = tx
            .prepare("SELECT id FROM playlist_tracks WHERE playlist_id = ?1 ORDER BY position")
            .map_err(db_err)?;
        let mapped = stmt
            .query_map(params![playlist_id], |row| row.get::<_, i64>(0))
            .map_err(db_err)?;
        let mut ids = Vec::new();
        for row in mapped {
            ids.push(row.map_err(db_err)?);
        }
        drop(stmt);
        let count = ids.len() as i64;
        if from_pos < 0 || from_pos >= count || to_pos < 0 || to_pos >= count {
            return Ok(());
        }
        let moved = ids.remove(from_pos as usize);
        ids.insert(to_pos as usize, moved);
        shift_playlist_positions(&tx, playlist_id)?;
        for (index, id) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE playlist_tracks SET position = ?1 WHERE id = ?2",
                params![index as i64, id],
            )
            .map_err(db_err)?;
        }
        tx.execute(
            "UPDATE playlists SET updated_at = ?1 WHERE id = ?2",
            params![now(), playlist_id],
        )
        .map_err(db_err)?;
        tx.commit().map_err(db_err)?;
        Ok(())
    }

    pub fn bump_play_count(&self, track_id: i64) -> Result<(), String> {
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE tracks SET play_count = play_count + 1, last_played_at = ?1 WHERE id = ?2",
                params![now(), track_id],
            )
            .map_err(db_err)?;
            Ok(())
        })
    }

    pub fn record_history(
        &self,
        track_id: i64,
        listened_sec: Option<f64>,
        completed: bool,
        skipped: bool,
    ) -> Result<(), String> {
        let conn = self.lock_conn()?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        tx.execute(
            "INSERT INTO listening_history(track_id, played_at, listened_sec, completed, skipped) \
             VALUES(?1, ?2, ?3, ?4, ?5)",
            params![track_id, now(), listened_sec, completed, skipped],
        )
        .map_err(db_err)?;
        if skipped {
            tx.execute(
                "UPDATE tracks SET skip_count = skip_count + 1 WHERE id = ?1",
                params![track_id],
            )
            .map_err(db_err)?;
        }
        tx.commit().map_err(db_err)?;
        Ok(())
    }

    pub fn get_analytics(
        &self,
        since_secs: Option<i64>,
        top_limit: i64,
        recent_limit: i64,
    ) -> Result<AnalyticsData, String> {
        self.with_conn(|conn| {
            let summary = fetch_stats_summary(conn, since_secs)?;
            let top_tracks = fetch_top_tracks(conn, since_secs, top_limit)?;
            let top_artists = fetch_top_artists(conn, since_secs, top_limit)?;
            let mut args: Vec<Value> = Vec::new();
            let mut where_clause = String::new();
            if let Some(since) = since_secs {
                where_clause.push_str("h.played_at >= ?1");
                args.push(Value::Integer(since));
            }
            let recent = fetch_history_entries(conn, &where_clause, args, recent_limit, 0)?;
            Ok(AnalyticsData { summary, top_tracks, top_artists, recent })
        })
    }

    pub fn get_history_page(
        &self,
        since_secs: Option<i64>,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<HistoryEntryDto>, String> {
        self.with_conn(|conn| {
            let mut args: Vec<Value> = Vec::new();
            let mut where_clause = String::new();
            if let Some(since) = since_secs {
                where_clause.push_str("h.played_at >= ?1");
                args.push(Value::Integer(since));
            }
            fetch_history_entries(conn, &where_clause, args, limit, offset)
        })
    }

    pub fn clear_history(&self) -> Result<u32, String> {
        self.with_conn(|conn| {
            let deleted = conn.execute("DELETE FROM listening_history", []).map_err(db_err)?;
            Ok(deleted as u32)
        })
    }

    pub fn reset_cover_refs(&self) -> Result<u32, String> {
        self.with_conn(|conn| {
            let tracks = conn
                .execute("UPDATE tracks SET cover_path = NULL WHERE cover_path IS NOT NULL", [])
                .map_err(db_err)?;
            let albums = conn
                .execute("UPDATE albums SET cover_path = NULL WHERE cover_path IS NOT NULL", [])
                .map_err(db_err)?;
            Ok((tracks + albums) as u32)
        })
    }
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn db_err(e: rusqlite::Error) -> String {
    format!("database error: {}", e)
}

fn like_pattern(query: &str) -> String {
    let mut pattern = String::with_capacity(query.len() + 2);
    pattern.push('%');
    for c in query.chars() {
        match c {
            '\\' => pattern.push_str("\\\\"),
            '%' => pattern.push_str("\\%"),
            '_' => pattern.push_str("\\_"),
            _ => pattern.push(c),
        }
    }
    pattern.push('%');
    pattern
}

fn normalize_query(query: &str) -> String {
    query.split_whitespace().collect::<Vec<&str>>().join(" ").to_lowercase()
}

fn build_search_text(title: &str, artist: &str, album: &str, genre: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in [title, artist, album, genre] {
        let trimmed = part.trim();
        if !trimmed.is_empty() {
            parts.push(trimmed);
        }
    }
    parts.join(" ").to_lowercase()
}

fn split_words(normalized: &str) -> Vec<String> {
    normalized.split(' ').map(|w| w.to_string()).collect()
}

fn is_cyrillic_char(c: char) -> bool {
    matches!(c, 'а'..='я' | 'ё')
}

fn has_cyrillic(s: &str) -> bool {
    s.chars().any(is_cyrillic_char)
}

fn has_latin(s: &str) -> bool {
    s.chars().any(|c| c.is_ascii_alphabetic())
}

fn layout_to_cyrillic(c: char) -> Option<char> {
    Some(match c {
        'q' => 'й', 'w' => 'ц', 'e' => 'у', 'r' => 'к', 't' => 'е',
        'y' => 'н', 'u' => 'г', 'i' => 'ш', 'o' => 'щ', 'p' => 'з',
        '[' => 'х', ']' => 'ъ', 'a' => 'ф', 's' => 'ы', 'd' => 'в',
        'f' => 'а', 'g' => 'п', 'h' => 'р', 'j' => 'о', 'k' => 'л',
        'l' => 'д', ';' => 'ж', '\'' => 'э', 'z' => 'я', 'x' => 'ч',
        'c' => 'с', 'v' => 'м', 'b' => 'и', 'n' => 'т', 'm' => 'ь',
        ',' => 'б', '.' => 'ю', '`' => 'ё',
        _ => return None,
    })
}

fn layout_to_latin(c: char) -> Option<char> {
    Some(match c {
        'й' => 'q', 'ц' => 'w', 'у' => 'e', 'к' => 'r', 'е' => 't',
        'н' => 'y', 'г' => 'u', 'ш' => 'i', 'щ' => 'o', 'з' => 'p',
        'х' => '[', 'ъ' => ']', 'ф' => 'a', 'ы' => 's', 'в' => 'd',
        'а' => 'f', 'п' => 'g', 'р' => 'h', 'о' => 'j', 'л' => 'k',
        'д' => 'l', 'ж' => ';', 'э' => '\'', 'я' => 'z', 'ч' => 'x',
        'с' => 'c', 'м' => 'v', 'и' => 'b', 'т' => 'n', 'ь' => 'm',
        'б' => ',', 'ю' => '.', 'ё' => '`',
        _ => return None,
    })
}

fn phonetic_to_cyrillic(c: char) -> Option<char> {
    Some(match c {
        'a' => 'а', 'b' => 'б', 'c' => 'к', 'd' => 'д', 'e' => 'е',
        'f' => 'ф', 'g' => 'г', 'h' => 'х', 'i' => 'и', 'j' => 'й',
        'k' => 'к', 'l' => 'л', 'm' => 'м', 'n' => 'н', 'o' => 'о',
        'p' => 'п', 'r' => 'р', 's' => 'с', 't' => 'т', 'u' => 'у',
        'v' => 'в', 'w' => 'ш', 'x' => 'х', 'y' => 'и', 'z' => 'з',
        _ => return None,
    })
}

fn phonetic_to_latin(c: char) -> Option<char> {
    Some(match c {
        'а' => 'a', 'б' => 'b', 'в' => 'v', 'г' => 'g', 'д' => 'd',
        'е' => 'e', 'ё' => 'e', 'ж' => 'j', 'з' => 'z', 'и' => 'i',
        'й' => 'y', 'к' => 'k', 'л' => 'l', 'м' => 'm', 'н' => 'n',
        'о' => 'o', 'п' => 'p', 'р' => 'r', 'с' => 's', 'т' => 't',
        'у' => 'u', 'ф' => 'f', 'х' => 'h', 'ц' => 'c', 'ч' => 'c',
        'ш' => 's', 'щ' => 's', 'ы' => 'y', 'э' => 'e', 'ю' => 'u',
        'я' => 'a',
        _ => return None,
    })
}

fn swap_layout(s: &str) -> String {
    let to_latin = has_cyrillic(s) && !has_latin(s);
    let to_cyrillic = has_latin(s) && !has_cyrillic(s);
    if !to_latin && !to_cyrillic {
        return s.to_string();
    }
    s.chars()
        .map(|c| {
            if to_latin {
                layout_to_latin(c).unwrap_or(c)
            } else {
                layout_to_cyrillic(c).unwrap_or(c)
            }
        })
        .collect()
}

fn transliterate(s: &str, to_cyrillic: bool) -> String {
    if to_cyrillic && has_cyrillic(s) {
        return s.to_string();
    }
    if !to_cyrillic && has_latin(s) {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        let mapped = if to_cyrillic {
            phonetic_to_cyrillic(c)
        } else {
            phonetic_to_latin(c)
        };
        match mapped {
            Some(m) => out.push(m),
            None => {
                if to_cyrillic || !is_cyrillic_char(c) {
                    out.push(c);
                }
            }
        }
    }
    out
}

fn push_unique_variant(variants: &mut Vec<String>, candidate: String) {
    if !candidate.is_empty() && !variants.contains(&candidate) {
        variants.push(candidate);
    }
}

fn search_query_variants(norm: &str) -> Vec<String> {
    let mut variants = vec![norm.to_string()];
    let cyr = has_cyrillic(norm);
    let lat = has_latin(norm);
    if cyr != lat {
        let swapped = swap_layout(norm);
        push_unique_variant(&mut variants, swapped.clone());
        push_unique_variant(&mut variants, transliterate(norm, !cyr));
        push_unique_variant(&mut variants, transliterate(&swapped, cyr));
    }
    variants.truncate(4);
    variants
}

fn subsequence_positions(needle: &[char], haystack: &[char]) -> Option<Vec<usize>> {
    let mut positions = Vec::with_capacity(needle.len());
    let mut cursor = 0usize;
    for ch in needle {
        let mut hit = None;
        while cursor < haystack.len() {
            if haystack[cursor] == *ch {
                hit = Some(cursor);
                break;
            }
            cursor += 1;
        }
        positions.push(hit?);
        cursor += 1;
    }
    Some(positions)
}

fn fuzzy_score(query: &str, words: &[String], text: &str) -> Option<f64> {
    if query.is_empty() || words.is_empty() {
        return None;
    }
    let text_chars: Vec<char> = text.chars().collect();
    if text_chars.is_empty() {
        return None;
    }
    let query_len = query.chars().count();
    let mut matched = 0usize;
    let mut starts_word = false;
    for word in words {
        let needle: Vec<char> = word.chars().collect();
        let positions = subsequence_positions(&needle, &text_chars)?;
        matched += positions.len();
        if let Some(first) = positions.first() {
            if *first == 0 || text_chars[*first - 1] == ' ' {
                starts_word = true;
            }
        }
    }
    let coverage = matched as f64 / query_len.max(1) as f64;
    if coverage < SEARCH_MIN_COVERAGE {
        return None;
    }
    let query_chars: Vec<char> = query.chars().collect();
    let prefix_bonus = if text_chars.starts_with(&query_chars) {
        0.4
    } else if starts_word {
        0.15
    } else {
        0.0
    };
    let brevity_bonus = 0.3 * (query_len as f64 / text_chars.len() as f64).min(1.0);
    Some(coverage + prefix_bonus + brevity_bonus)
}

fn sort_scored<T>(scored: &mut [(f64, String, T)]) {
    scored.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.1.cmp(&b.1))
    });
}

fn search_tracks(
    conn: &Connection,
    query: &str,
    limit: i64,
    offset: i64,
) -> Result<Vec<Track>, String> {
    let normalized = normalize_query(query);
    if normalized.is_empty() {
        return fetch_tracks(
            conn,
            TRACK_FROM,
            PLAYLIST_VISIBLE_PRED,
            None,
            "t.added_at DESC, t.id DESC",
            limit,
            offset,
        );
    }
    let variants = search_query_variants(&normalized);
    let cap = if limit < 0 { usize::MAX } else { limit as usize };
    let mut results: Vec<Track> = Vec::new();
    let mut seen: HashSet<i64> = HashSet::new();
    for variant in &variants {
        if results.len() >= cap {
            break;
        }
        let batch_limit = if limit < 0 { -1 } else { (cap - results.len()) as i64 };
        for track in fetch_tracks(
            conn,
            TRACK_FROM,
            TRACK_SEARCH_PRED,
            Some(Value::Text(like_pattern(variant))),
            "t.title COLLATE NOCASE, t.id",
            batch_limit,
            offset,
        )? {
            if seen.insert(track.id) {
                results.push(track);
            }
        }
    }
    if cap <= results.len() || results.len() >= TRACK_EXACT_TARGET {
        return Ok(results);
    }
    let contexts: Vec<(String, Vec<String>)> = variants
        .iter()
        .take(3)
        .map(|v| (v.clone(), split_words(v)))
        .collect();
    let mut scored: Vec<(f64, String, Track)> = Vec::new();
    for (track, text) in fetch_track_candidates(conn)? {
        if seen.contains(&track.id) {
            continue;
        }
        let mut best: Option<f64> = None;
        for (qv, qw) in &contexts {
            if let Some(score) = fuzzy_score(qv, qw, &text) {
                if best.map_or(true, |b| score > b) {
                    best = Some(score);
                }
            }
        }
        if let Some(score) = best {
            scored.push((score, track.title.to_lowercase(), track));
        }
    }
    sort_scored(&mut scored);
    let remaining = cap.saturating_sub(results.len());
    for (_, _, track) in scored.into_iter().take(remaining) {
        results.push(track);
    }
    Ok(results)
}

fn fetch_track_candidates(conn: &Connection) -> Result<Vec<(Track, String)>, String> {
    let sql = format!(
        "SELECT {}, t.search_text FROM {} WHERE t.folder_id IS NOT NULL ORDER BY t.id LIMIT ?1",
        TRACK_COLUMNS, TRACK_FROM
    );
    let mut stmt = conn.prepare(&sql).map_err(db_err)?;
    let mapped = stmt
        .query_map(params![TRACK_CANDIDATE_LIMIT], |row| {
            Ok((map_track_at(row, 0)?, row.get::<_, String>(21)?))
        })
        .map_err(db_err)?;
    let mut out = Vec::new();
    for row in mapped {
        out.push(row.map_err(db_err)?);
    }
    Ok(out)
}

fn search_albums(conn: &Connection, query: &str, limit: i64) -> Result<Vec<Album>, String> {
    let normalized = normalize_query(query);
    if normalized.is_empty() {
        return fetch_albums(conn, "", None, ALBUM_ORDER, limit);
    }
    let variants = search_query_variants(&normalized);
    let all = fetch_albums(conn, "", None, ALBUM_ORDER, -1)?;
    let mut results: Vec<Album> = Vec::new();
    let mut seen: HashSet<i64> = HashSet::new();
    for album in &all {
        if variants.iter().any(|v| album_contains(album, v)) {
            seen.insert(album.id);
            results.push(album.clone());
        }
    }
    if results.len() < CATALOG_EXACT_TARGET {
        append_fuzzy_albums(&all, &seen, &variants, &mut results);
    }
    if limit >= 0 && results.len() > limit as usize {
        results.truncate(limit as usize);
    }
    Ok(results)
}

fn album_contains(album: &Album, needle: &str) -> bool {
    album.title.to_lowercase().contains(needle)
        || album.artist_name.as_deref().unwrap_or("").to_lowercase().contains(needle)
}

fn album_search_text(album: &Album) -> String {
    format!("{} {}", album.title, album.artist_name.as_deref().unwrap_or("")).to_lowercase()
}

fn append_fuzzy_albums(
    all: &[Album],
    seen: &HashSet<i64>,
    variants: &[String],
    results: &mut Vec<Album>,
) {
    let contexts: Vec<(String, Vec<String>)> = variants
        .iter()
        .take(3)
        .map(|v| (v.clone(), split_words(v)))
        .collect();
    let mut scored: Vec<(f64, String, Album)> = Vec::new();
    for album in all {
        if seen.contains(&album.id) {
            continue;
        }
        let text = album_search_text(album);
        let mut best: Option<f64> = None;
        for (qv, qw) in &contexts {
            if let Some(score) = fuzzy_score(qv, qw, &text) {
                if best.map_or(true, |b| score > b) {
                    best = Some(score);
                }
            }
        }
        if let Some(score) = best {
            scored.push((score, album.title.to_lowercase(), album.clone()));
        }
    }
    sort_scored(&mut scored);
    for (_, _, album) in scored {
        results.push(album);
    }
}

fn search_artists(conn: &Connection, query: &str, limit: i64) -> Result<Vec<Artist>, String> {
    let normalized = normalize_query(query);
    if normalized.is_empty() {
        return fetch_artists(conn, "", None, limit);
    }
    let variants = search_query_variants(&normalized);
    let all = fetch_artists(conn, "", None, -1)?;
    let mut results: Vec<Artist> = Vec::new();
    let mut seen: HashSet<i64> = HashSet::new();
    for artist in &all {
        if variants.iter().any(|v| artist.name.to_lowercase().contains(v.as_str())) {
            seen.insert(artist.id);
            results.push(artist.clone());
        }
    }
    if results.len() < CATALOG_EXACT_TARGET {
        let contexts: Vec<(String, Vec<String>)> = variants
            .iter()
            .take(3)
            .map(|v| (v.clone(), split_words(v)))
            .collect();
        let mut scored: Vec<(f64, String, Artist)> = Vec::new();
        for artist in &all {
            if seen.contains(&artist.id) {
                continue;
            }
            let name_key = artist.name.to_lowercase();
            let mut best: Option<f64> = None;
            for (qv, qw) in &contexts {
                if let Some(score) = fuzzy_score(qv, qw, &name_key) {
                    if best.map_or(true, |b| score > b) {
                        best = Some(score);
                    }
                }
            }
            if let Some(score) = best {
                scored.push((score, name_key, artist.clone()));
            }
        }
        sort_scored(&mut scored);
        for (_, _, artist) in scored {
            results.push(artist);
        }
    }
    if limit >= 0 && results.len() > limit as usize {
        results.truncate(limit as usize);
    }
    Ok(results)
}

fn map_track_at(row: &rusqlite::Row, base: usize) -> rusqlite::Result<Track> {
    Ok(Track {
        id: row.get(base)?,
        path: row.get(base + 1)?,
        title: row.get(base + 2)?,
        artist_id: row.get(base + 3)?,
        artist_name: row.get(base + 4)?,
        album_id: row.get(base + 5)?,
        album_title: row.get(base + 6)?,
        track_number: row.get(base + 7)?,
        disc_number: row.get(base + 8)?,
        duration_sec: row.get(base + 9)?,
        year: row.get(base + 10)?,
        genre: row.get(base + 11)?,
        cover_path: row.get(base + 12)?,
        file_size: row.get(base + 13)?,
        modified_at: row.get(base + 14)?,
        added_at: row.get(base + 15)?,
        source: row.get(base + 16)?,
        external_id: row.get(base + 17)?,
        last_played_at: row.get(base + 18)?,
        play_count: row.get(base + 19)?,
        skip_count: row.get(base + 20)?,
    })
}

fn map_folder(row: &rusqlite::Row) -> rusqlite::Result<LibraryFolder> {
    Ok(LibraryFolder {
        id: row.get(0)?,
        path: row.get(1)?,
        enabled: row.get(2)?,
        added_at: row.get(3)?,
        track_count: Some(row.get(4)?),
    })
}

fn map_album(row: &rusqlite::Row) -> rusqlite::Result<Album> {
    Ok(Album {
        id: row.get(0)?,
        title: row.get(1)?,
        artist_id: row.get(2)?,
        artist_name: row.get(3)?,
        year: row.get(4)?,
        cover_path: row.get(5)?,
        track_count: Some(row.get(6)?),
    })
}

fn map_artist(row: &rusqlite::Row) -> rusqlite::Result<Artist> {
    Ok(Artist {
        id: row.get(0)?,
        name: row.get(1)?,
        album_count: Some(row.get(2)?),
        track_count: Some(row.get(3)?),
    })
}

fn map_playlist(row: &rusqlite::Row) -> rusqlite::Result<Playlist> {
    Ok(Playlist {
        id: row.get(0)?,
        name: row.get(1)?,
        created_at: row.get(2)?,
        updated_at: row.get(3)?,
        track_count: Some(row.get(4)?),
        pinned: Some(row.get(5)?),
        pin_order: row.get(6)?,
        is_likes: Some(row.get::<_, i64>(7)? != 0),
        cover_path: row.get(8)?,
    })
}

fn fetch_tracks(
    conn: &Connection,
    from_clause: &str,
    pred: &str,
    arg: Option<Value>,
    order_clause: &str,
    limit: i64,
    offset: i64,
) -> Result<Vec<Track>, String> {
    let mut args: Vec<Value> = Vec::new();
    let mut sql = format!("SELECT {} FROM {}", TRACK_COLUMNS, from_clause);
    if !pred.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(pred);
    }
    if let Some(v) = arg {
        args.push(v);
    }
    sql.push_str(" ORDER BY ");
    sql.push_str(order_clause);
    sql.push_str(&format!(" LIMIT ?{} OFFSET ?{}", args.len() + 1, args.len() + 2));
    args.push(Value::Integer(limit));
    args.push(Value::Integer(offset));
    let mut stmt = conn.prepare(&sql).map_err(db_err)?;
    let mapped = stmt
        .query_map(params_from_iter(args), |row| map_track_at(row, 0))
        .map_err(db_err)?;
    let mut tracks = Vec::new();
    for row in mapped {
        tracks.push(row.map_err(db_err)?);
    }
    Ok(tracks)
}

fn fetch_albums(
    conn: &Connection,
    pred: &str,
    arg: Option<Value>,
    order_clause: &str,
    limit: i64,
) -> Result<Vec<Album>, String> {
    let mut args: Vec<Value> = Vec::new();
    let mut sql = format!(
        "SELECT {} FROM albums al LEFT JOIN artists ar ON ar.id = al.artist_id",
        ALBUM_COLUMNS
    );
    if !pred.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(pred);
    }
    if let Some(v) = arg {
        args.push(v);
    }
    sql.push_str(" ORDER BY ");
    sql.push_str(order_clause);
    sql.push_str(&format!(" LIMIT ?{}", args.len() + 1));
    args.push(Value::Integer(limit));
    let mut stmt = conn.prepare(&sql).map_err(db_err)?;
    let mapped = stmt.query_map(params_from_iter(args), map_album).map_err(db_err)?;
    let mut albums = Vec::new();
    for row in mapped {
        albums.push(row.map_err(db_err)?);
    }
    Ok(albums)
}

fn fetch_artists(
    conn: &Connection,
    pred: &str,
    arg: Option<Value>,
    limit: i64,
) -> Result<Vec<Artist>, String> {
    let mut args: Vec<Value> = Vec::new();
    let mut sql = format!("SELECT {} FROM artists ar", ARTIST_COLUMNS);
    if !pred.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(pred);
    }
    if let Some(v) = arg {
        args.push(v);
    }
    sql.push_str(" ORDER BY ar.name COLLATE NOCASE, ar.id");
    sql.push_str(&format!(" LIMIT ?{}", args.len() + 1));
    args.push(Value::Integer(limit));
    let mut stmt = conn.prepare(&sql).map_err(db_err)?;
    let mapped = stmt.query_map(params_from_iter(args), map_artist).map_err(db_err)?;
    let mut artists = Vec::new();
    for row in mapped {
        artists.push(row.map_err(db_err)?);
    }
    Ok(artists)
}

fn fetch_stats_summary(conn: &Connection, since_secs: Option<i64>) -> Result<StatsSummary, String> {
    let mut args: Vec<Value> = Vec::new();
    let mut sql = format!(
        "SELECT COALESCE(SUM(h.listened_sec), 0) / 60.0, COUNT(*), COUNT(DISTINCT t.artist_id), \
         COALESCE(AVG(CASE WHEN t.duration_sec > 0 \
         THEN 100.0 * MIN(h.listened_sec, t.duration_sec) / t.duration_sec ELSE NULL END), 0) \
         FROM {}",
        HISTORY_TRACKS_FROM
    );
    if let Some(since) = since_secs {
        sql.push_str(" WHERE h.played_at >= ?1");
        args.push(Value::Integer(since));
    }
    conn.query_row(&sql, params_from_iter(args), |row| {
        Ok(StatsSummary {
            total_minutes: row.get(0)?,
            plays: row.get(1)?,
            unique_artists: row.get(2)?,
            avg_completion_pct: row.get(3)?,
        })
    })
    .map_err(db_err)
}

fn fetch_top_tracks(
    conn: &Connection,
    since_secs: Option<i64>,
    limit: i64,
) -> Result<Vec<TopTrackItem>, String> {
    let mut args: Vec<Value> = Vec::new();
    let mut sql = format!("SELECT COUNT(*), {} FROM {}", TRACK_COLUMNS, HISTORY_TRACKS_FROM);
    if let Some(since) = since_secs {
        sql.push_str(" WHERE h.played_at >= ?1");
        args.push(Value::Integer(since));
    }
    sql.push_str(" GROUP BY h.track_id ORDER BY COUNT(*) DESC, MAX(h.played_at) DESC");
    sql.push_str(&format!(" LIMIT ?{}", args.len() + 1));
    args.push(Value::Integer(limit));
    let mut stmt = conn.prepare(&sql).map_err(db_err)?;
    let mapped = stmt
        .query_map(params_from_iter(args), |row| {
            Ok(TopTrackItem {
                play_count: row.get(0)?,
                track: map_track_at(row, 1)?,
            })
        })
        .map_err(db_err)?;
    let mut items = Vec::new();
    for row in mapped {
        items.push(row.map_err(db_err)?);
    }
    Ok(items)
}

fn fetch_top_artists(
    conn: &Connection,
    since_secs: Option<i64>,
    limit: i64,
) -> Result<Vec<TopArtistItem>, String> {
    let mut args: Vec<Value> = Vec::new();
    let mut sql = format!(
        "SELECT {}, COUNT(*) FROM listening_history h \
         JOIN tracks t ON t.id = h.track_id \
         JOIN artists ar ON ar.id = t.artist_id",
        ARTIST_COLUMNS
    );
    if let Some(since) = since_secs {
        sql.push_str(" WHERE h.played_at >= ?1");
        args.push(Value::Integer(since));
    }
    sql.push_str(" GROUP BY ar.id ORDER BY COUNT(*) DESC");
    sql.push_str(&format!(" LIMIT ?{}", args.len() + 1));
    args.push(Value::Integer(limit));
    let mut stmt = conn.prepare(&sql).map_err(db_err)?;
    let mapped = stmt
        .query_map(params_from_iter(args), |row| {
            Ok(TopArtistItem {
                artist: map_artist(row)?,
                play_count: row.get(4)?,
            })
        })
        .map_err(db_err)?;
    let mut items = Vec::new();
    for row in mapped {
        items.push(row.map_err(db_err)?);
    }
    Ok(items)
}

fn fetch_history_entries(
    conn: &Connection,
    where_clause: &str,
    mut args: Vec<Value>,
    limit: i64,
    offset: i64,
) -> Result<Vec<HistoryEntryDto>, String> {
    let mut sql = format!(
        "SELECT h.id, h.track_id, h.played_at, h.start_sec, h.listened_sec, h.completed, h.skipped, {} FROM {}",
        TRACK_COLUMNS, HISTORY_TRACKS_FROM
    );
    if !where_clause.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(where_clause);
    }
    sql.push_str(" ORDER BY h.played_at DESC, h.id DESC");
    sql.push_str(&format!(" LIMIT ?{} OFFSET ?{}", args.len() + 1, args.len() + 2));
    args.push(Value::Integer(limit));
    args.push(Value::Integer(offset));
    let mut stmt = conn.prepare(&sql).map_err(db_err)?;
    let mapped = stmt
        .query_map(params_from_iter(args), |row| {
            Ok(HistoryEntryDto {
                id: row.get(0)?,
                track_id: row.get(1)?,
                played_at: row.get(2)?,
                start_sec: row.get(3)?,
                listened_sec: row.get(4)?,
                completed: row.get(5)?,
                skipped: row.get(6)?,
                track: map_track_at(row, 7)?,
            })
        })
        .map_err(db_err)?;
    let mut entries = Vec::new();
    for row in mapped {
        entries.push(row.map_err(db_err)?);
    }
    Ok(entries)
}

fn upsert_track_input(conn: &Connection, input: &TrackInput) -> Result<(), String> {
    let artist_id = match &input.artist {
        Some(name) => Some(get_or_create_artist(conn, name)?),
        None => None,
    };
    let album_id = match &input.album {
        Some(title) => {
            let album_artist_name = input.album_artist.as_deref().or(input.artist.as_deref());
            let album_artist_id = match album_artist_name {
                Some(name) => Some(get_or_create_artist(conn, name)?),
                None => None,
            };
            let album_id = get_or_create_album(conn, title, album_artist_id)?;
            if let Some(cover_path) = &input.cover_path {
                conn.execute(
                    "UPDATE albums SET cover_path = ?1 WHERE id = ?2 AND cover_path IS NULL",
                    params![cover_path, album_id],
                )
                .map_err(db_err)?;
            }
            Some(album_id)
        }
        None => None,
    };
    let search_text = build_search_text(
        &input.title,
        input.artist.as_deref().unwrap_or(""),
        input.album.as_deref().unwrap_or(""),
        input.genre.as_deref().unwrap_or(""),
    );
    conn.execute(
        "INSERT INTO tracks(path, folder_id, title, artist_id, album_id, track_number, disc_number, \
         duration_sec, year, genre, cover_path, file_size, modified_at, added_at, lyrics, search_text) \
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16) \
         ON CONFLICT(path) DO UPDATE SET \
         title = excluded.title, artist_id = excluded.artist_id, album_id = excluded.album_id, \
         track_number = excluded.track_number, disc_number = excluded.disc_number, \
         duration_sec = excluded.duration_sec, year = excluded.year, genre = excluded.genre, \
         cover_path = excluded.cover_path, file_size = excluded.file_size, \
         modified_at = excluded.modified_at, folder_id = excluded.folder_id, \
         lyrics = excluded.lyrics, search_text = excluded.search_text",
        params![
            input.path,
            input.folder_id,
            input.title,
            artist_id,
            album_id,
            input.track_number,
            input.disc_number,
            input.duration_sec,
            input.year,
            input.genre,
            input.cover_path,
            input.file_size,
            input.modified_at,
            now(),
            input.lyrics,
            search_text
        ],
    )
    .map_err(db_err)?;
    Ok(())
}

fn backfill_search_text_conn(conn: &Connection) -> Result<(), String> {
    let sql = "SELECT t.id, t.title, COALESCE(a.name, ''), COALESCE(al.title, ''), COALESCE(t.genre, '') \
               FROM tracks t LEFT JOIN artists a ON a.id = t.artist_id \
               LEFT JOIN albums al ON al.id = t.album_id \
               WHERE t.search_text = '' AND t.title <> ''";
    let mut stmt = conn.prepare(sql).map_err(db_err)?;
    let mapped = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                build_search_text(
                    &row.get::<_, String>(1)?,
                    &row.get::<_, String>(2)?,
                    &row.get::<_, String>(3)?,
                    &row.get::<_, String>(4)?,
                ),
            ))
        })
        .map_err(db_err)?;
    let mut updates: Vec<(i64, String)> = Vec::new();
    for row in mapped {
        updates.push(row.map_err(db_err)?);
    }
    drop(stmt);
    let tx = conn.unchecked_transaction().map_err(db_err)?;
    for (id, text) in &updates {
        tx.execute(
            "UPDATE tracks SET search_text = ?1 WHERE id = ?2",
            params![text, id],
        )
        .map_err(db_err)?;
    }
    tx.commit().map_err(db_err)?;
    Ok(())
}

fn get_or_create_artist(conn: &Connection, name: &str) -> Result<i64, String> {
    let existing: Option<i64> = conn
        .query_row(
            "SELECT id FROM artists WHERE name = ?1 COLLATE NOCASE",
            params![name],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_err)?;
    if let Some(id) = existing {
        return Ok(id);
    }
    conn.execute("INSERT INTO artists(name) VALUES(?1)", params![name])
        .map_err(db_err)?;
    Ok(conn.last_insert_rowid())
}

fn get_or_create_album(conn: &Connection, title: &str, artist_id: Option<i64>) -> Result<i64, String> {
    let existing: Option<i64> = conn
        .query_row(
            "SELECT id FROM albums WHERE title = ?1 COLLATE NOCASE AND artist_id IS ?2",
            params![title, artist_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_err)?;
    if let Some(id) = existing {
        return Ok(id);
    }
    conn.execute(
        "INSERT INTO albums(title, artist_id) VALUES(?1, ?2)",
        params![title, artist_id],
    )
    .map_err(db_err)?;
    Ok(conn.last_insert_rowid())
}

fn shift_playlist_positions(conn: &Connection, playlist_id: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE playlist_tracks SET position = position - 1000000000 WHERE playlist_id = ?1",
        params![playlist_id],
    )
    .map_err(db_err)?;
    Ok(())
}

fn renumber_playlist(conn: &Connection, playlist_id: i64) -> Result<(), String> {
    shift_playlist_positions(conn, playlist_id)?;
    let mut stmt = conn
        .prepare("SELECT id FROM playlist_tracks WHERE playlist_id = ?1 ORDER BY position")
        .map_err(db_err)?;
    let mapped = stmt
        .query_map(params![playlist_id], |row| row.get::<_, i64>(0))
        .map_err(db_err)?;
    let mut ids = Vec::new();
    for row in mapped {
        ids.push(row.map_err(db_err)?);
    }
    drop(stmt);
    for (index, id) in ids.iter().enumerate() {
        conn.execute(
            "UPDATE playlist_tracks SET position = ?1 WHERE id = ?2",
            params![index as i64, id],
        )
        .map_err(db_err)?;
    }
    Ok(())
}

fn resequence_pinned(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT id FROM playlists WHERE pinned = 1 ORDER BY pin_order, id")
        .map_err(db_err)?;
    let mapped = stmt
        .query_map([], |row| row.get::<_, i64>(0))
        .map_err(db_err)?;
    let mut ids = Vec::new();
    for row in mapped {
        ids.push(row.map_err(db_err)?);
    }
    drop(stmt);
    for (index, id) in ids.iter().enumerate() {
        conn.execute(
            "UPDATE playlists SET pin_order = ?1 WHERE id = ?2",
            params![index as i64, id],
        )
        .map_err(db_err)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static DIR_SEQ: AtomicU64 = AtomicU64::new(0);

    fn test_db(tag: &str) -> (Db, PathBuf) {
        let seq = DIR_SEQ.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .subsec_nanos();
        let dir = std::env::temp_dir().join(format!(
            "tempo_db_{}_{}_{}_{}",
            tag,
            std::process::id(),
            nanos,
            seq
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open_at(&dir.join("tempo.db")).unwrap();
        (db, dir)
    }

    fn track_input(
        path: &str,
        folder_id: i64,
        title: &str,
        artist: Option<&str>,
        album: Option<&str>,
    ) -> TrackInput {
        TrackInput {
            path: path.to_string(),
            folder_id,
            title: title.to_string(),
            artist: artist.map(|s| s.to_string()),
            album: album.map(|s| s.to_string()),
            album_artist: None,
            track_number: Some(1),
            disc_number: Some(1),
            duration_sec: Some(180.0),
            year: Some(2020),
            genre: Some("Rock".to_string()),
            cover_path: None,
            file_size: 1024,
            modified_at: 111,
            lyrics: None,
        }
    }

    #[test]
    fn migrations_are_idempotent() {
        let (db, dir) = test_db("migrate");
        let version: i64 = db
            .with_conn(|c| c.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(db_err))
            .unwrap();
        assert_eq!(version, MIGRATIONS.len() as i64);
        db.add_library_folder(r"C:\persist").unwrap();
        drop(db);
        let reopened = Db::open_at(&dir.join("tempo.db")).unwrap();
        let version_again: i64 = reopened
            .with_conn(|c| c.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(db_err))
            .unwrap();
        assert_eq!(version_again, MIGRATIONS.len() as i64);
        let folders = reopened.list_library_folders().unwrap();
        assert_eq!(folders.len(), 1);
        assert_eq!(folders[0].path, r"C:\persist");
        let table_count: i64 = reopened
            .with_conn(|c| {
                c.query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN \
                     ('library_folders','artists','albums','tracks','playlists','playlist_tracks','listening_history')",
                    [],
                    |r| r.get(0),
                )
                .map_err(db_err)
            })
            .unwrap();
        assert_eq!(table_count, 7);
        drop(reopened);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn folder_crud_reports_track_count() {
        let (db, dir) = test_db("folders");
        let first = db.add_library_folder(r"C:\music\one").unwrap();
        assert!(first.enabled);
        let duplicate = db.add_library_folder(r"C:\music\one").unwrap();
        assert_eq!(first.id, duplicate.id);
        let second = db.add_library_folder(r"C:\music\two").unwrap();
        assert_ne!(first.id, second.id);
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO tracks(path, folder_id, title, added_at) VALUES(?1, ?2, 'T', ?3)",
                params![r"C:\music\one\t.mp3", first.id, now()],
            )
            .map_err(db_err)
        })
        .unwrap();
        let folders = db.list_library_folders().unwrap();
        assert_eq!(folders.len(), 2);
        let counts: HashMap<i64, i64> =
            folders.iter().map(|f| (f.id, f.track_count.unwrap())).collect();
        assert_eq!(counts[&first.id], 1);
        assert_eq!(counts[&second.id], 0);
        db.remove_library_folder(first.id).unwrap();
        let folders = db.list_library_folders().unwrap();
        assert_eq!(folders.len(), 1);
        assert_eq!(folders[0].id, second.id);
        assert_eq!(db.count_tracks().unwrap(), 0);
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn scan_upsert_and_stamp_flow() {
        let (db, dir) = test_db("scan");
        let folder = db.add_library_folder(r"C:\music").unwrap();
        let fresh = track_input(r"C:\music\a.mp3", folder.id, "Song A", Some("Artist X"), Some("Album Y"));
        let counts = db.upsert_scanned_tracks(&[fresh], &[]).unwrap();
        assert_eq!(counts, (1, 0));
        let stamps = db.list_file_stamps().unwrap();
        assert!(stamps.contains_key(r"C:\music\a.mp3"));
        assert_eq!(stamps[r"C:\music\a.mp3"].size, 1024);
        assert_eq!(stamps[r"C:\music\a.mp3"].mtime, 111);
        let mut changed =
            track_input(r"C:\music\a.mp3", folder.id, "Song A Remastered", Some("Artist X"), Some("Album Y"));
        changed.cover_path = Some(r"C:\covers\y.jpg".to_string());
        changed.file_size = 2048;
        changed.modified_at = 222;
        let counts = db.upsert_scanned_tracks(&[], &[changed]).unwrap();
        assert_eq!(counts, (0, 1));
        let tracks = db.list_tracks("", 10, 0).unwrap();
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].title, "Song A Remastered");
        assert_eq!(tracks[0].file_size, 2048);
        assert_eq!(tracks[0].modified_at, 222);
        assert_eq!(tracks[0].added_at > 0, true);
        assert_eq!(tracks[0].source, "local");
        assert_eq!(tracks[0].artist_name.as_deref(), Some("Artist X"));
        assert_eq!(tracks[0].album_title.as_deref(), Some("Album Y"));
        let album_cover: Option<String> = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT cover_path FROM albums WHERE title = 'Album Y'",
                    [],
                    |r| r.get(0),
                )
                .map_err(db_err)
            })
            .unwrap();
        assert_eq!(album_cover.as_deref(), Some(r"C:\covers\y.jpg"));
        let deleted = db.delete_tracks_by_paths(&[r"C:\music\a.mp3".to_string()]).unwrap();
        assert_eq!(deleted, 1);
        assert_eq!(db.count_tracks().unwrap(), 0);
        let orphan_counts: (i64, i64) = db
            .with_conn(|c| {
                let artists_left: i64 = c
                    .query_row("SELECT COUNT(*) FROM artists", [], |r| r.get(0))
                    .map_err(db_err)?;
                let albums_left: i64 = c
                    .query_row("SELECT COUNT(*) FROM albums", [], |r| r.get(0))
                    .map_err(db_err)?;
                Ok((artists_left, albums_left))
            })
            .unwrap();
        assert_eq!(orphan_counts, (0, 0));
        let deleted_again = db.delete_tracks_by_paths(&[r"C:\music\a.mp3".to_string()]).unwrap();
        assert_eq!(deleted_again, 0);
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn playlist_add_move_remove_renumbers() {
        let (db, dir) = test_db("playlist");
        let pl = db.create_playlist("Focus").unwrap();
        assert_eq!(pl.name, "Focus");
        assert_eq!(pl.track_count, Some(0));
        let folder = db.add_library_folder(r"C:\pl").unwrap();
        let names = ["One", "Two", "Three"];
        let mut ids = Vec::new();
        for name in names {
            let path = format!(r"C:\pl\{}.mp3", name.to_lowercase());
            let input = track_input(&path, folder.id, name, None, None);
            let counts = db.upsert_scanned_tracks(&[input], &[]).unwrap();
            assert_eq!(counts, (1, 0));
            let id: i64 = db
                .with_conn(|c| {
                    c.query_row("SELECT id FROM tracks WHERE path = ?1", params![path], |r| r.get(0))
                        .map_err(db_err)
                })
                .unwrap();
            ids.push(id);
        }
        for id in &ids {
            db.playlist_add_track(pl.id, *id).unwrap();
        }
        let rows = db.get_playlist_tracks(pl.id).unwrap();
        let row_ids: Vec<i64> = rows.iter().map(|r| r.track.id).collect();
        assert_eq!(row_ids, ids);
        let positions: Vec<i64> = rows.iter().map(|r| r.position).collect();
        assert_eq!(positions, vec![0, 1, 2]);
        db.playlist_add_track(pl.id, ids[2]).unwrap();
        let rows = db.get_playlist_tracks(pl.id).unwrap();
        assert_eq!(rows.len(), 4);
        assert_eq!(rows[3].track.id, ids[2]);
        db.playlist_remove_track(pl.id, ids[2]).unwrap();
        let rows = db.get_playlist_tracks(pl.id).unwrap();
        let row_ids: Vec<i64> = rows.iter().map(|r| r.track.id).collect();
        assert_eq!(row_ids, ids);
        let positions: Vec<i64> = rows.iter().map(|r| r.position).collect();
        assert_eq!(positions, vec![0, 1, 2]);
        db.playlist_move_track(pl.id, 2, 0).unwrap();
        let rows = db.get_playlist_tracks(pl.id).unwrap();
        let row_ids: Vec<i64> = rows.iter().map(|r| r.track.id).collect();
        assert_eq!(row_ids, vec![ids[2], ids[0], ids[1]]);
        let positions: Vec<i64> = rows.iter().map(|r| r.position).collect();
        assert_eq!(positions, vec![0, 1, 2]);
        db.playlist_remove_track(pl.id, ids[0]).unwrap();
        let rows = db.get_playlist_tracks(pl.id).unwrap();
        let row_ids: Vec<i64> = rows.iter().map(|r| r.track.id).collect();
        assert_eq!(row_ids, vec![ids[2], ids[1]]);
        let positions: Vec<i64> = rows.iter().map(|r| r.position).collect();
        assert_eq!(positions, vec![0, 1]);
        db.rename_playlist(pl.id, "Deep Focus").unwrap();
        let playlists = db.list_playlists().unwrap();
        let renamed = playlists
            .iter()
            .find(|p| p.id == pl.id)
            .expect("playlist still exists");
        assert_eq!(renamed.name, "Deep Focus");
        assert_eq!(renamed.track_count, Some(2));
        db.delete_playlist(pl.id).unwrap();
        assert!(!db.list_playlists().unwrap().iter().any(|p| p.id == pl.id));
        assert!(db.get_playlist_tracks(pl.id).unwrap().is_empty());
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn record_history_counts_plays_and_skips() {
        let (db, dir) = test_db("history");
        let folder = db.add_library_folder(r"C:\h").unwrap();
        let input = track_input(r"C:\h\t.mp3", folder.id, "H", Some("HA"), None);
        let counts = db.upsert_scanned_tracks(&[input], &[]).unwrap();
        assert_eq!(counts, (1, 0));
        let track_id: i64 = db
            .with_conn(|c| c.query_row("SELECT id FROM tracks", [], |r| r.get(0)).map_err(db_err))
            .unwrap();
        db.record_history(track_id, Some(210.5), true, false).unwrap();
        db.record_history(track_id, Some(4.0), false, true).unwrap();
        db.bump_play_count(track_id).unwrap();
        let (plays, skips, last_played): (i64, i64, Option<i64>) = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT play_count, skip_count, last_played_at FROM tracks WHERE id = ?1",
                    params![track_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .map_err(db_err)
            })
            .unwrap();
        assert_eq!(plays, 1);
        assert_eq!(skips, 1);
        assert!(last_played.is_some());
        let (rows, total_listened, completed_sum, skipped_sum): (i64, Option<f64>, i64, i64) = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT COUNT(*), SUM(listened_sec), SUM(completed), SUM(skipped) \
                     FROM listening_history WHERE track_id = ?1",
                    params![track_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
                .map_err(db_err)
            })
            .unwrap();
        assert_eq!(rows, 2);
        assert_eq!(total_listened, Some(214.5));
        assert_eq!(completed_sum, 1);
        assert_eq!(skipped_sum, 1);
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn catalog_search_and_detail_queries() {
        let (db, dir) = test_db("catalog");
        let folder = db.add_library_folder(r"C:\cat").unwrap();
        let mut inputs = Vec::new();
        inputs.push(track_input(r"C:\cat\arrival.mp3", folder.id, "Arrival", Some("Aurora"), Some("North")));
        let mut first_light =
            track_input(r"C:\cat\first.mp3", folder.id, "First Light", Some("Aurora"), Some("North"));
        first_light.track_number = Some(2);
        inputs.push(first_light);
        let mut departure =
            track_input(r"C:\cat\departure.mp3", folder.id, "Departure", Some("Aurora"), Some("North"));
        departure.disc_number = Some(2);
        inputs.push(departure);
        inputs.push(track_input(r"C:\cat\wanderer.mp3", folder.id, "Wanderer", Some("Borealis"), None));
        let counts = db.upsert_scanned_tracks(&inputs, &[]).unwrap();
        assert_eq!(counts, (4, 0));

        let browse = db.list_tracks("", 10, 0).unwrap();
        assert_eq!(browse.len(), 4);
        assert_eq!(browse[0].title, "Wanderer");

        let by_title = db.list_tracks("first li", 10, 0).unwrap();
        assert_eq!(by_title.len(), 1);
        assert_eq!(by_title[0].artist_name.as_deref(), Some("Aurora"));

        let by_artist = db.list_tracks("AURORA", 10, 0).unwrap();
        let titles: Vec<&str> = by_artist.iter().map(|t| t.title.as_str()).collect();
        assert_eq!(titles, vec!["Arrival", "Departure", "First Light"]);

        assert!(db.list_tracks("100%", 10, 0).unwrap().is_empty());

        let albums = db.list_albums("").unwrap();
        assert_eq!(albums.len(), 1);
        assert_eq!(albums[0].title, "North");
        assert_eq!(albums[0].artist_name.as_deref(), Some("Aurora"));
        assert_eq!(albums[0].track_count, Some(3));

        let detail = db.get_album_detail(albums[0].id).unwrap().unwrap();
        let detail_titles: Vec<&str> = detail.tracks.iter().map(|t| t.title.as_str()).collect();
        assert_eq!(detail_titles, vec!["Arrival", "First Light", "Departure"]);
        assert!(db.get_album_detail(9999).unwrap().is_none());

        let artists = db.list_artists("").unwrap();
        assert_eq!(artists.len(), 2);
        assert_eq!(artists[0].name, "Aurora");
        assert_eq!(artists[0].album_count, Some(1));
        assert_eq!(artists[0].track_count, Some(3));
        assert_eq!(artists[1].album_count, Some(0));
        assert_eq!(artists[1].track_count, Some(1));

        let artist_detail = db.get_artist_detail(artists[0].id).unwrap().unwrap();
        assert_eq!(artist_detail.artist.name, "Aurora");
        assert_eq!(artist_detail.albums.len(), 1);
        assert!(db.get_artist_detail(9999).unwrap().is_none());

        let hits = db.search_all("north").unwrap();
        assert_eq!(hits.tracks.len(), 3);
        assert_eq!(hits.albums.len(), 1);
        assert!(hits.artists.is_empty());
        assert_eq!(db.search_all("zzz").unwrap().tracks.len(), 0);

        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn pinned_rows(db: &Db) -> Vec<(i64, i64)> {
        db.with_conn(|c| {
            let mut stmt = c
                .prepare("SELECT id, pin_order FROM playlists WHERE pinned = 1 ORDER BY pin_order, id")
                .map_err(db_err)?;
            let mapped = stmt
                .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)))
                .map_err(db_err)?;
            let mut rows = Vec::new();
            for row in mapped {
                rows.push(row.map_err(db_err)?);
            }
            Ok(rows)
        })
        .unwrap()
    }

    #[test]
    fn migration_v2_upgrades_existing_v1_database() {
        let seq = DIR_SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("tempo_db_v1_{}_{}", std::process::id(), seq));
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("tempo.db");
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute_batch(MIGRATION_1).unwrap();
            conn.execute_batch("PRAGMA user_version = 1;").unwrap();
            conn.execute(
                "INSERT INTO playlists(name, created_at, updated_at) VALUES('Legacy', 5, 5)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO tracks(path, title, added_at) VALUES('C:\\old.mp3', 'Old', 5)",
                [],
            )
            .unwrap();
        }
        let db = Db::open_at(&db_path).unwrap();
        let version: i64 = db
            .with_conn(|c| c.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(db_err))
            .unwrap();
        assert_eq!(version, MIGRATIONS.len() as i64);
        let playlists = db.list_playlists().unwrap();
        // the auto-created Likes playlist coexists with the legacy one
        assert_eq!(playlists.len(), 2);
        let legacy_id = playlists
            .iter()
            .find(|p| p.name == "Legacy")
            .expect("legacy playlist kept")
            .id;
        let legacy = playlists.iter().find(|p| p.id == legacy_id).unwrap();
        assert_eq!(legacy.pinned, Some(false));
        assert_eq!(legacy.pin_order, None);
        db.set_playlist_pinned(legacy_id, true).unwrap();
        let playlists = db.list_playlists().unwrap();
        let legacy = playlists.iter().find(|p| p.id == legacy_id).unwrap();
        assert_eq!(legacy.pinned, Some(true));
        assert_eq!(legacy.pin_order, Some(1));
        db.set_app_setting("volume", "0.8").unwrap();
        assert_eq!(db.get_app_setting("volume").unwrap().as_deref(), Some("0.8"));
        let track_id: i64 = db
            .with_conn(|c| c.query_row("SELECT id FROM tracks", [], |r| r.get(0)).map_err(db_err))
            .unwrap();
        assert_eq!(db.get_track_lyrics(track_id).unwrap(), None);
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn seed_track(
        db: &Db,
        folder_id: i64,
        path: &str,
        title: &str,
        artist: &str,
        album: Option<&str>,
        duration: f64,
    ) -> i64 {
        let mut input = track_input(path, folder_id, title, Some(artist), album);
        input.duration_sec = Some(duration);
        db.upsert_scanned_tracks(&[input], &[]).unwrap();
        db.with_conn(|c| {
            c.query_row("SELECT id FROM tracks WHERE path = ?1", params![path], |r| r.get(0))
                .map_err(db_err)
        })
        .unwrap()
    }

    fn insert_old_history(db: &Db, track_id: i64, played_at: i64, listened_sec: f64) {
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO listening_history(track_id, played_at, start_sec, listened_sec, completed, skipped) \
                 VALUES(?1, ?2, 0, ?3, 1, 0)",
                params![track_id, played_at, listened_sec],
            )
            .map_err(db_err)
        })
        .unwrap();
    }

    #[test]
    fn analytics_summary_top_lists_and_recent() {
        let (db, dir) = test_db("analytics");
        let folder = db.add_library_folder(r"C:\an").unwrap();
        let t1 = seed_track(&db, folder.id, r"C:\an\one.mp3", "One", "Alpha", None, 200.0);
        let t2 = seed_track(&db, folder.id, r"C:\an\two.mp3", "Two", "Beta", None, 100.0);
        db.record_history(t1, Some(150.0), false, false).unwrap();
        db.record_history(t1, Some(200.0), true, false).unwrap();
        db.record_history(t2, Some(50.0), false, true).unwrap();

        let data = db.get_analytics(None, 10, 10).unwrap();
        assert_eq!(data.summary.plays, 3);
        assert_eq!(data.summary.unique_artists, 2);
        assert!((data.summary.total_minutes - 400.0 / 60.0).abs() < 1e-9);
        assert!((data.summary.avg_completion_pct - 75.0).abs() < 1e-9);

        assert_eq!(data.top_tracks.len(), 2);
        assert_eq!(data.top_tracks[0].track.id, t1);
        assert_eq!(data.top_tracks[0].play_count, 2);
        assert_eq!(data.top_tracks[0].track.artist_name.as_deref(), Some("Alpha"));
        assert_eq!(data.top_tracks[1].track.id, t2);
        assert_eq!(data.top_tracks[1].play_count, 1);

        assert_eq!(data.top_artists.len(), 2);
        assert_eq!(data.top_artists[0].artist.name, "Alpha");
        assert_eq!(data.top_artists[0].play_count, 2);
        assert_eq!(data.top_artists[0].artist.album_count, Some(0));
        assert_eq!(data.top_artists[0].artist.track_count, Some(1));
        assert_eq!(data.top_artists[1].artist.name, "Beta");
        assert_eq!(data.top_artists[1].play_count, 1);

        assert_eq!(data.recent.len(), 3);
        assert_eq!(data.recent[0].track_id, t2);
        assert_eq!(data.recent[0].skipped, true);
        assert_eq!(data.recent[0].completed, false);
        assert_eq!(data.recent[0].track.artist_name.as_deref(), Some("Beta"));
        assert_eq!(data.recent[1].completed, true);
        assert_eq!(data.recent[1].listened_sec, Some(200.0));
        assert_eq!(data.recent[2].listened_sec, Some(150.0));

        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn analytics_respects_since_cutoff() {
        let (db, dir) = test_db("since");
        let folder = db.add_library_folder(r"C:\sn").unwrap();
        let t1 = seed_track(&db, folder.id, r"C:\sn\a.mp3", "A", "Solo", None, 300.0);
        insert_old_history(&db, t1, now() - 60 * 60 * 24 * 30, 120.0);
        db.record_history(t1, Some(300.0), true, false).unwrap();

        let all = db.get_analytics(None, 5, 5).unwrap();
        assert_eq!(all.summary.plays, 2);
        assert_eq!(all.summary.unique_artists, 1);
        assert!((all.summary.total_minutes - 7.0).abs() < 1e-9);
        assert!((all.summary.avg_completion_pct - (40.0 + 100.0) / 2.0).abs() < 1e-9);
        assert_eq!(all.top_tracks.len(), 1);
        assert_eq!(all.top_tracks[0].play_count, 2);
        assert_eq!(all.recent.len(), 2);

        let cutoff = now() - 60 * 60 * 24;
        let recent_only = db.get_analytics(Some(cutoff), 5, 5).unwrap();
        assert_eq!(recent_only.summary.plays, 1);
        assert!((recent_only.summary.total_minutes - 5.0).abs() < 1e-9);
        assert_eq!(recent_only.summary.avg_completion_pct, 100.0);
        assert_eq!(recent_only.top_tracks.len(), 1);
        assert_eq!(recent_only.top_tracks[0].play_count, 1);
        assert_eq!(recent_only.top_artists.len(), 1);
        assert_eq!(recent_only.top_artists[0].play_count, 1);
        assert_eq!(recent_only.recent.len(), 1);

        let page = db.get_history_page(Some(cutoff), 10, 0).unwrap();
        assert_eq!(page.len(), 1);
        assert!(page[0].played_at >= cutoff);
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn history_page_orders_desc_and_pages() {
        let (db, dir) = test_db("page");
        let folder = db.add_library_folder(r"C:\pg").unwrap();
        let t1 = seed_track(&db, folder.id, r"C:\pg\a.mp3", "A", "P", None, 90.0);
        for _ in 0..5 {
            db.record_history(t1, Some(10.0), false, false).unwrap();
        }
        let pages: Vec<Vec<HistoryEntryDto>> =
            [(0, 2), (2, 2), (4, 2), (6, 2)]
                .iter()
                .map(|&(offset, limit)| db.get_history_page(None, limit, offset).unwrap())
                .collect();
        assert_eq!(
            pages.iter().map(|p| p.len()).collect::<Vec<_>>(),
            vec![2, 2, 1, 0]
        );
        let mut ids: Vec<i64> = Vec::new();
        for page in &pages {
            ids.extend(page.iter().map(|e| e.id));
        }
        assert_eq!(ids.len(), 5);
        let mut sorted_desc = ids.clone();
        sorted_desc.sort_unstable_by(|a, b| b.cmp(a));
        assert_eq!(ids, sorted_desc);
        assert!(pages[0][0].played_at >= pages[2][0].played_at);
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn clear_history_removes_rows_keeps_aggregates() {
        let (db, dir) = test_db("clear");
        let folder = db.add_library_folder(r"C:\cl").unwrap();
        let t1 = seed_track(&db, folder.id, r"C:\cl\a.mp3", "A", "C", None, 60.0);
        db.bump_play_count(t1).unwrap();
        for _ in 0..3 {
            db.record_history(t1, Some(30.0), false, true).unwrap();
        }
        assert_eq!(db.clear_history().unwrap(), 3);
        let remaining: i64 = db
            .with_conn(|c| {
                c.query_row("SELECT COUNT(*) FROM listening_history", [], |r| r.get(0))
                    .map_err(db_err)
            })
            .unwrap();
        assert_eq!(remaining, 0);
        assert_eq!(db.clear_history().unwrap(), 0);
        let (plays, skips): (i64, i64) = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT play_count, skip_count FROM tracks WHERE id = ?1",
                    params![t1],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .map_err(db_err)
            })
            .unwrap();
        assert_eq!((plays, skips), (1, 3));
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reset_cover_refs_nulls_track_and_album_covers() {
        let (db, dir) = test_db("covers");
        let folder = db.add_library_folder(r"C:\cv").unwrap();
        let mut input = track_input(r"C:\cv\a.mp3", folder.id, "A", Some("Art"), Some("Lp"));
        input.cover_path = Some(r"C:\covers\a.jpg".to_string());
        db.upsert_scanned_tracks(&[input], &[]).unwrap();
        let track_cover: Option<String> = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT cover_path FROM tracks WHERE path = ?1",
                    params![r"C:\cv\a.mp3"],
                    |r| r.get(0),
                )
                .map_err(db_err)
            })
            .unwrap();
        let album_cover: Option<String> = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT cover_path FROM albums WHERE title = 'Lp'",
                    [],
                    |r| r.get(0),
                )
                .map_err(db_err)
            })
            .unwrap();
        assert_eq!(track_cover.as_deref(), Some(r"C:\covers\a.jpg"));
        assert_eq!(album_cover.as_deref(), Some(r"C:\covers\a.jpg"));
        assert_eq!(db.reset_cover_refs().unwrap(), 2);
        let track_cover: Option<String> = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT cover_path FROM tracks WHERE path = ?1",
                    params![r"C:\cv\a.mp3"],
                    |r| r.get(0),
                )
                .map_err(db_err)
            })
            .unwrap();
        let album_cover: Option<String> = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT cover_path FROM albums WHERE title = 'Lp'",
                    [],
                    |r| r.get(0),
                )
                .map_err(db_err)
            })
            .unwrap();
        assert_eq!(track_cover, None);
        assert_eq!(album_cover, None);
        assert_eq!(db.reset_cover_refs().unwrap(), 0);
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pinned_playlists_pin_move_unpin_resequence() {
        let (db, dir) = test_db("pins");
        let likes = db
            .list_playlists()
            .unwrap()
            .into_iter()
            .find(|p| p.is_likes == Some(true))
            .expect("likes playlist exists");
        // keep the pinned-set assertions focused on regular playlists
        db.set_playlist_pinned(likes.id, false).unwrap();
        let a = db.create_playlist("A").unwrap();
        let b = db.create_playlist("B").unwrap();
        let c = db.create_playlist("C").unwrap();
        let plain = db.create_playlist("Plain").unwrap();

        db.move_pinned_playlist(a.id, 0).unwrap();
        assert!(pinned_rows(&db).is_empty());

        db.set_playlist_pinned(c.id, true).unwrap();
        db.set_playlist_pinned(a.id, true).unwrap();
        db.set_playlist_pinned(b.id, true).unwrap();
        let order: Vec<i64> = pinned_rows(&db).iter().map(|(id, _)| *id).collect();
        assert_eq!(order, vec![c.id, a.id, b.id]);
        let orders: Vec<i64> = pinned_rows(&db).iter().map(|(_, pos)| *pos).collect();
        assert_eq!(orders, vec![0, 1, 2]);

        db.move_pinned_playlist(b.id, 0).unwrap();
        let order: Vec<i64> = pinned_rows(&db).iter().map(|(id, _)| *id).collect();
        assert_eq!(order, vec![b.id, c.id, a.id]);

        db.move_pinned_playlist(b.id, 99).unwrap();
        let order: Vec<i64> = pinned_rows(&db).iter().map(|(id, _)| *id).collect();
        assert_eq!(order, vec![c.id, a.id, b.id]);

        db.move_pinned_playlist(a.id, -3).unwrap();
        let order: Vec<i64> = pinned_rows(&db).iter().map(|(id, _)| *id).collect();
        assert_eq!(order, vec![a.id, c.id, b.id]);

        db.set_playlist_pinned(c.id, false).unwrap();
        assert_eq!(pinned_rows(&db), vec![(a.id, 0), (b.id, 1)]);
        let playlists = db.list_playlists().unwrap();
        let by_id: HashMap<i64, Playlist> =
            playlists.iter().map(|p| (p.id, p.clone())).collect();
        assert_eq!(by_id[&c.id].pinned, Some(false));
        assert_eq!(by_id[&c.id].pin_order, None);
        assert_eq!(by_id[&plain.id].pinned, Some(false));

        db.set_playlist_pinned(a.id, true).unwrap();
        assert_eq!(pinned_rows(&db), vec![(b.id, 0), (a.id, 1)]);

        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn app_settings_upsert_and_read() {
        let (db, dir) = test_db("settings");
        assert_eq!(db.get_app_setting("theme").unwrap(), None);
        db.set_app_setting("theme", "dark").unwrap();
        assert_eq!(db.get_app_setting("theme").unwrap().as_deref(), Some("dark"));
        db.set_app_setting("theme", "midnight").unwrap();
        assert_eq!(
            db.get_app_setting("theme").unwrap().as_deref(),
            Some("midnight")
        );
        db.set_app_setting("volume", "0.4").unwrap();
        assert_eq!(db.get_app_setting("volume").unwrap().as_deref(), Some("0.4"));
        assert_eq!(
            db.get_app_setting("theme").unwrap().as_deref(),
            Some("midnight")
        );
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn lyrics_round_trip_through_scanned_tracks() {
        let (db, dir) = test_db("lyrics");
        let folder = db.add_library_folder(r"C:\lyr").unwrap();
        let mut input = track_input(r"C:\lyr\s.mp3", folder.id, "Song", Some("Art"), None);
        input.lyrics = Some("first verse".to_string());
        db.upsert_scanned_tracks(&[input], &[]).unwrap();
        let track_id: i64 = db
            .with_conn(|c| c.query_row("SELECT id FROM tracks", [], |r| r.get(0)).map_err(db_err))
            .unwrap();
        assert_eq!(
            db.get_track_lyrics(track_id).unwrap().as_deref(),
            Some("first verse")
        );
        let mut changed = track_input(r"C:\lyr\s.mp3", folder.id, "Song", Some("Art"), None);
        changed.lyrics = Some("second verse".to_string());
        db.upsert_scanned_tracks(&[], &[changed]).unwrap();
        assert_eq!(
            db.get_track_lyrics(track_id).unwrap().as_deref(),
            Some("second verse")
        );
        let mut cleared = track_input(r"C:\lyr\s.mp3", folder.id, "Song", Some("Art"), None);
        cleared.lyrics = None;
        db.upsert_scanned_tracks(&[], &[cleared]).unwrap();
        assert_eq!(db.get_track_lyrics(track_id).unwrap(), None);
        assert_eq!(db.get_track_lyrics(987654).unwrap(), None);
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn track_search_unicode_case_insensitive_and_fuzzy() {
        let (db, dir) = test_db("usearch");
        let folder = db.add_library_folder(r"C:\ru").unwrap();
        let mut apple =
            track_input(r"C:\ru\a.mp3", folder.id, "Эппл", Some("Купце"), Some("Апельсин"));
        apple.genre = Some("Рок".to_string());
        let zen = track_input(r"C:\ru\z.mp3", folder.id, "Zenith", Some("Lumen"), None);
        let counts = db.upsert_scanned_tracks(&[apple, zen], &[]).unwrap();
        assert_eq!(counts, (2, 0));
        for q in ["эпп", "ЭПП", "купц"] {
            let hits = db.list_tracks(q, 10, 0).unwrap();
            assert_eq!(hits.len(), 1);
            assert_eq!(hits[0].title, "Эппл");
            assert_eq!(hits[0].artist_name.as_deref(), Some("Купце"));
        }
        let fuzzy = db.list_tracks("апл", 10, 0).unwrap();
        assert_eq!(fuzzy.len(), 1);
        assert_eq!(fuzzy[0].title, "Эппл");
        assert!(db.list_tracks("жжж", 10, 0).unwrap().is_empty());
        assert_eq!(db.search_all("КУПЦ").unwrap().tracks.len(), 1);
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_text_backfill_repairs_legacy_rows() {
        let (db, dir) = test_db("backfill");
        let folder = db.add_library_folder(r"C:\legacy").unwrap();
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO tracks(path, folder_id, title, added_at) VALUES(?1, ?2, ?3, ?4)",
                params![r"C:\legacy\o.mp3", folder.id, "Древний Лес", now()],
            )
            .map_err(db_err)
        })
        .unwrap();
        let stale: i64 = db
            .with_conn(|c| {
                c.query_row("SELECT COUNT(*) FROM tracks WHERE search_text = ''", [], |r| r.get(0))
                    .map_err(db_err)
            })
            .unwrap();
        assert_eq!(stale, 1);
        db.backfill_search_text().unwrap();
        let hits = db.list_tracks("ДРЕВНИЙ", 10, 0).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "Древний Лес");
        let fuzzy = db.list_tracks("длес", 10, 0).unwrap();
        assert_eq!(fuzzy.len(), 1);
        assert_eq!(fuzzy[0].id, hits[0].id);
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn album_artist_search_unicode_contains_and_fuzzy() {
        let (db, dir) = test_db("ucatalog");
        let folder = db.add_library_folder(r"C:\uc").unwrap();
        let mut t1 = track_input(r"C:\uc\a.mp3", folder.id, "Трек", Some("Заря"), Some("Север"));
        t1.genre = Some("Инди".to_string());
        let t2 =
            track_input(r"C:\uc\b.mp3", folder.id, "North Wind", Some("Lumen"), Some("Horizon"));
        db.upsert_scanned_tracks(&[t1, t2], &[]).unwrap();
        let albums = db.list_albums("СЕВЕР").unwrap();
        assert_eq!(albums.len(), 1);
        assert_eq!(albums[0].title, "Север");
        let fuzzy_albums = db.list_albums("севр").unwrap();
        assert_eq!(fuzzy_albums.len(), 1);
        assert_eq!(fuzzy_albums[0].title, "Север");
        let artists = db.list_artists("зар").unwrap();
        assert_eq!(artists.len(), 1);
        assert_eq!(artists[0].name, "Заря");
        let fuzzy_artists = db.list_artists("ЗРЯ").unwrap();
        assert_eq!(fuzzy_artists.len(), 1);
        assert_eq!(fuzzy_artists[0].name, "Заря");
        let hits = db.search_all("север").unwrap();
        assert_eq!(hits.tracks.len(), 1);
        assert_eq!(hits.albums.len(), 1);
        assert!(hits.artists.is_empty());
        assert!(db.list_albums("жжж").unwrap().is_empty());
        assert!(db.list_artists("жжж").unwrap().is_empty());
        assert!(db.search_all("жжж").unwrap().tracks.is_empty());
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn upsert_sc_track_is_idempotent_and_updates_fields() {
        let (db, dir) = test_db("scupsert");
        let first = db
            .upsert_sc_track("777001", "Original Title", "SC Artist", 195_000, Some("https://art/1.jpg"))
            .unwrap();
        let second = db
            .upsert_sc_track("777001", "Updated Title", "SC Artist Two", 201_500, None)
            .unwrap();
        assert_eq!(first, second);
        let count: i64 = db
            .with_conn(|c| c.query_row("SELECT COUNT(*) FROM tracks", [], |r| r.get(0)).map_err(db_err))
            .unwrap();
        assert_eq!(count, 1);
        let (path, title, artist_name, duration_sec, cover_path): (
            String,
            String,
            Option<String>,
            Option<f64>,
            Option<String>,
        ) = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT path, title, artist_name, duration_sec, cover_path FROM tracks WHERE id = ?1",
                    params![first],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
                )
                .map_err(db_err)
            })
            .unwrap();
        assert_eq!(path, "soundcloud://777001");
        assert_eq!(title, "Updated Title");
        assert_eq!(artist_name.as_deref(), Some("SC Artist Two"));
        assert!((duration_sec.unwrap() - 201.5).abs() < 1e-9);
        assert_eq!(cover_path, None);
        let (source, external_id, folder_is_null): (String, Option<String>, i64) = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT source, external_id, folder_id IS NULL FROM tracks WHERE id = ?1",
                    params![first],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .map_err(db_err)
            })
            .unwrap();
        assert_eq!(source, "soundcloud");
        assert_eq!(external_id.as_deref(), Some("777001"));
        assert_eq!(folder_is_null, 1);
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn soundcloud_rows_hidden_from_library_but_kept_in_playlists() {
        let (db, dir) = test_db("schidden");
        let folder = db.add_library_folder(r"C:\hidden").unwrap();
        let local = seed_track(&db, folder.id, r"C:\hidden\sun.mp3", "Sunlit Path", "Lumen", None, 120.0);
        let sc_id = db.upsert_sc_track("42", "Nightdrive Zqx", "Neon Wolf", 240_000, None).unwrap();
        assert_ne!(local, sc_id);

        let browse = db.list_tracks("", 50, 0).unwrap();
        let browse_ids: Vec<i64> = browse.iter().map(|t| t.id).collect();
        assert_eq!(browse_ids, vec![local]);

        assert!(db.list_tracks("nightdrive", 50, 0).unwrap().is_empty());
        assert!(db.search_all("nightdrive").unwrap().tracks.is_empty());
        assert!(db.search_all("zqx").unwrap().tracks.is_empty());

        let local_hits = db.list_tracks("sunlit", 50, 0).unwrap();
        assert_eq!(local_hits.len(), 1);
        assert_eq!(local_hits[0].id, local);

        let pl = db.create_playlist("Blend").unwrap();
        db.playlist_add_track(pl.id, sc_id).unwrap();
        db.playlist_add_track(pl.id, local).unwrap();
        let rows = db.get_playlist_tracks(pl.id).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].track.id, sc_id);
        assert_eq!(rows[0].track.source, "soundcloud");
        assert_eq!(rows[0].track.path, "soundcloud://42");
        assert_eq!(rows[0].track.external_id.as_deref(), Some("42"));
        assert_eq!(rows[0].track.artist_name.as_deref(), Some("Neon Wolf"));
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn artist_display_coalesce_prefers_join_then_override() {
        let (db, dir) = test_db("coalname");
        let folder = db.add_library_folder(r"C:\coal").unwrap();
        let local = seed_track(&db, folder.id, r"C:\coal\a.mp3", "Song", "Real Artist", None, 60.0);
        let sc = db
            .upsert_sc_track("55", "Remote Song", "Override Artist", 90_000, None)
            .unwrap();
        let pl = db.create_playlist("Coalesce").unwrap();
        db.playlist_add_track(pl.id, local).unwrap();
        db.playlist_add_track(pl.id, sc).unwrap();
        let rows = db.get_playlist_tracks(pl.id).unwrap();
        assert_eq!(rows[0].track.artist_name.as_deref(), Some("Real Artist"));
        assert!(rows[0].track.artist_id.is_some());
        assert_eq!(rows[1].track.artist_name.as_deref(), Some("Override Artist"));
        assert!(rows[1].track.artist_id.is_none());
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_query_variants_cover_layout_and_phonetics() {
        let positional = search_query_variants("ifvfy");
        assert_eq!(positional[0], "ifvfy");
        assert!(positional.contains(&"шаман".to_string()));
        assert!(search_query_variants("zppp").contains(&"зппп".to_string()));
        assert_eq!(search_query_variants("шаман")[0], "шаман");
        assert!(search_query_variants("шаман").contains(&"ifvfy".to_string()));
        assert!(search_query_variants("зппп").contains(&"pggg".to_string()));
        let mixed = search_query_variants("шаman");
        assert_eq!(mixed.len(), 1);
        assert_eq!(mixed[0], "шаman");
    }

    #[test]
    fn track_search_tolerates_layout_swap_and_transliteration() {
        let (db, dir) = test_db("layout");
        let folder = db.add_library_folder(r"C:\lay").unwrap();
        let inputs = vec![
            track_input(r"C:\lay\s.mp3", folder.id, "Шаман", Some("Горная"), None),
            track_input(r"C:\lay\z.mp3", folder.id, "Зппп", Some("Круг"), None),
            track_input(r"C:\lay\l.mp3", folder.id, "Zppp", Some("Loop"), None),
        ];
        let counts = db.upsert_scanned_tracks(&inputs, &[]).unwrap();
        assert_eq!(counts, (3, 0));
        for q in ["ifvfy", "Шаман"] {
            let hits = db.list_tracks(q, 10, 0).unwrap();
            assert_eq!(hits.len(), 1, "query {} -> {:?}", q, hits.len());
            assert_eq!(hits[0].title, "Шаман");
        }
        let phonetic = db.list_tracks("zppp", 10, 0).unwrap();
        assert!(phonetic.iter().any(|t| t.title == "Зппп"));
        assert!(phonetic.iter().any(|t| t.title == "Zppp"));
        let reverse = db.list_tracks("pggg", 10, 0).unwrap();
        assert!(reverse.iter().any(|t| t.title == "Zppp"), "pggg must find Zppp");
        let cyr_query = db.list_tracks("зппп", 10, 0).unwrap();
        assert!(cyr_query.iter().any(|t| t.title == "Zppp"));
        assert!(cyr_query.iter().any(|t| t.title == "Зппп"));
        assert!(db.list_tracks("шаman", 10, 0).unwrap().is_empty());
        assert!(db.list_tracks("жжж", 10, 0).unwrap().is_empty());
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn likes_playlist_auto_created_cannot_be_deleted_and_tracks_toggle() {
        let (db, dir) = test_db("likes");
        let folder = db.add_library_folder(r"C:\likes").unwrap();
        let t1 = seed_track(&db, folder.id, r"C:\likes\a.mp3", "Song One", "Artist", None, 90.0);
        let t2 = db.upsert_sc_track("900", "SC Song", "SC Artist", 120_000, None).unwrap();

        let playlists = db.list_playlists().unwrap();
        assert_eq!(playlists.len(), 1);
        let likes = &playlists[0];
        assert_eq!(likes.is_likes, Some(true));
        assert_eq!(likes.pinned, Some(true));

        assert!(db.like_track(t1).unwrap());
        assert!(db.like_track(t2).unwrap());
        assert!(!db.like_track(t1).unwrap());

        let liked = db.list_liked_track_ids().unwrap();
        assert_eq!(liked, vec![t1, t2]);

        assert!(db.list_tracks("", 10, 0).unwrap().iter().all(|t| t.id != t2));

        assert!(db.unlike_track(t1).unwrap());
        assert_eq!(db.list_liked_track_ids().unwrap(), vec![t2]);

        assert!(db.delete_playlist(likes.id).is_err());
        assert!(db.list_playlists().unwrap().iter().any(|p| p.id == likes.id));

        db.rename_playlist(likes.id, "My Likes").unwrap();
        assert_eq!(db.list_playlists().unwrap()[0].name, "My Likes");
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cached_soundcloud_tracks_become_visible_in_library_and_search() {
        let (db, dir) = test_db("scvis");
        let folder = db.add_library_folder(r"C:\vis").unwrap();
        let local = seed_track(&db, folder.id, r"C:\vis\l.mp3", "Local Song", "Local", None, 60.0);
        let sc = db.upsert_sc_track("901", "Cached Song", "Net Artist", 100_000, None).unwrap();

        assert_eq!(db.count_tracks().unwrap(), 1);
        let browse = db.list_tracks("", 10, 0).unwrap();
        assert_eq!(browse.iter().map(|t| t.id).collect::<Vec<_>>(), vec![local]);

        db.mark_sc_cached("901", 4096).unwrap();
        assert_eq!(db.count_tracks().unwrap(), 2);
        let browse = db.list_tracks("", 10, 0).unwrap();
        assert!(browse.iter().any(|t| t.id == sc));
        let hits = db.list_tracks("cached song", 10, 0).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, sc);
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn playlist_cover_follows_last_added_track_with_cover() {
        let (db, dir) = test_db("plcover");
        let folder = db.add_library_folder(r"C:\plc").unwrap();
        let t1 = seed_track(&db, folder.id, r"C:\plc\a.mp3", "One", "A", None, 60.0);
        let t2 = seed_track(&db, folder.id, r"C:\plc\b.mp3", "Two", "B", None, 60.0);
        db.with_conn(|c| {
            c.execute(
                "UPDATE tracks SET cover_path = 'covers/a.png' WHERE id = ?1",
                params![t1],
            )
            .map_err(|e| e.to_string())?;
            Ok(())
        })
        .unwrap();
        let pl = db.create_playlist("Mix").unwrap();
        db.playlist_add_track(pl.id, t1).unwrap();
        let cover = db
            .list_playlists()
            .unwrap()
            .into_iter()
            .find(|p| p.id == pl.id)
            .unwrap()
            .cover_path;
        assert_eq!(cover.as_deref(), Some("covers/a.png"));

        db.playlist_add_track(pl.id, t2).unwrap();
        let cover = db
            .list_playlists()
            .unwrap()
            .into_iter()
            .find(|p| p.id == pl.id)
            .unwrap()
            .cover_path;
        assert_eq!(cover.as_deref(), Some("covers/a.png"));

        db.with_conn(|c| {
            c.execute(
                "UPDATE tracks SET cover_path = 'covers/b.png' WHERE id = ?1",
                params![t2],
            )
            .map_err(|e| e.to_string())?;
            Ok(())
        })
        .unwrap();
        let cover = db
            .list_playlists()
            .unwrap()
            .into_iter()
            .find(|p| p.id == pl.id)
            .unwrap()
            .cover_path;
        assert_eq!(cover.as_deref(), Some("covers/b.png"));
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_tracks_sorted_orders_by_each_key() {
        let (db, dir) = test_db("sort");
        let folder = db.add_library_folder(r"C:\srt").unwrap();
        let played = seed_track(&db, folder.id, r"C:\srt.mp3", "Beta", "Zeta", None, 200.0);
        seed_track(&db, folder.id, r"C:\srt.mp3", "Alpha", "Yankee", None, 100.0);
        db.upsert_sc_track("777", "Charlie", "Xray", 150_000, None).unwrap();
        db.mark_sc_cached("777", 1000).unwrap();
        db.bump_play_count(played).unwrap();

        let by_title = db.list_tracks_sorted("", "title", 10, 0).unwrap();
        assert_eq!(
            by_title.iter().map(|t| t.title.as_str()).collect::<Vec<_>>(),
            vec!["Alpha", "Beta", "Charlie"]
        );
        let by_artist = db.list_tracks_sorted("", "artist", 10, 0).unwrap();
        assert_eq!(by_artist[0].title, "Charlie");
        let by_duration = db.list_tracks_sorted("", "duration", 10, 0).unwrap();
        assert_eq!(by_duration[0].title, "Beta");
        let by_plays = db.list_tracks_sorted("", "plays", 10, 0).unwrap();
        assert_eq!(by_plays[0].title, "Beta");
        let added = db.list_tracks_sorted("", "added", 10, 0).unwrap();
        assert_eq!(added.last().map(|t| t.title.as_str()), Some("Beta"));
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn hour_picks_return_tracks_played_at_the_current_hour() {
        let (db, dir) = test_db("hourpicks");
        let folder = db.add_library_folder(r"C:\hp").unwrap();
        let now_track = seed_track(&db, folder.id, r"C:\hp\m.mp3", "Morning", "A", None, 60.0);
        seed_track(&db, folder.id, r"C:\hp\n.mp3", "Night", "B", None, 60.0);
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO listening_history(track_id, played_at, listened_sec, completed, skipped) \
                 VALUES(?1, strftime('%s', 'now'), 60, 1, 0)",
                params![now_track],
            )
            .map_err(|e| e.to_string())?;
            Ok(())
        })
        .unwrap();
        let picks = db.get_hour_picks(5).unwrap();
        assert_eq!(picks.len(), 1);
        assert_eq!(picks[0].id, now_track);
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
