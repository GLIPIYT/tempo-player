//! Offline search: no provider requests or inactive editor drafts.
use crate::{commands::AppState, database::Db, models::Track};
use tauri::State;

fn terms(text: &str) -> Vec<String> {
    let normalized = text.to_lowercase().replace('ё', "е");
    let mut result = Vec::new();
    for word in normalized.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()) {
        if !result.iter().any(|s| s == word) { result.push(word.to_owned()); }
        if result.len() == 8 { break; }
    }
    result
}

fn score(text: &str, query: &[String]) -> (usize, usize) {
    let mut clean = String::with_capacity(text.len().min(262144));
    let mut tag = None;
    for c in text.chars().take(262144) {
        if let Some(end) = tag { if c == end { tag = None; clean.push(' '); } continue; }
        if c == '[' { tag = Some(']'); continue; }
        if c == '<' { tag = Some('>'); continue; }
        clean.push(c);
    }
    let normalized = clean.to_lowercase().replace('ё', "е");
    let mut counts = vec![0usize; query.len()];
    for word in normalized.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()) {
        for (i, term) in query.iter().enumerate() { if word == term { counts[i] += 1; } }
    }
    (counts.iter().filter(|&&n| n > 0).count(), counts.iter().sum())
}

pub fn search(db: &Db, query: &str) -> Result<Vec<Track>, String> {
    let query = terms(&query.chars().take(128).collect::<String>());
    if query.is_empty() { return Ok(Vec::new()); }
    let ids = db.with_conn(|conn| {
        let mut stmt = conn.prepare("SELECT t.id, COALESCE(NULLIF(o.lrc, ''), t.lyrics) FROM tracks t LEFT JOIN track_lyrics_override o ON o.track_id=t.id WHERE COALESCE(NULLIF(o.lrc, ''), t.lyrics) IS NOT NULL")
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))).map_err(|e| e.to_string())?;
        let mut best = Vec::new();
        for row in rows {
            let (id, text) = row.map_err(|e| e.to_string())?;
            let (matched, count) = score(&text, &query);
            if count == 0 { continue; }
            best.push((matched, count, id));
            best.sort_unstable_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)).then(a.2.cmp(&b.2)));
            best.truncate(5);
        }
        Ok(best.into_iter().map(|(_, _, id)| id).collect::<Vec<_>>())
    })?;
    db.get_tracks_by_ids(&ids)
}

#[tauri::command]
pub async fn search_cached_lyrics(state: State<'_, AppState>, query: String) -> Result<Vec<Track>, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || search(&db, &query)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn searches_words_not_tags_and_normalizes_russian() {
        let q = terms("ЕЩЁ, домой");
        assert_eq!(score("[ar:домой]\n[00:11.2]Ещё домой, домой <00:12.0>", &q), (2, 3));
        assert_eq!(score("[ar:домой]\nбездомой", &terms("домой")), (0, 0));
        assert_eq!(terms("домой домой"), vec!["домой"]);
    }

    #[test]
    fn cached_search_limits_and_ranks_results_and_prefers_pinned_text() {
        let path = std::env::temp_dir().join(format!("tempo-lyric-search-{}-{}.db", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let db = Db::open_at(&path).unwrap();
        db.with_conn(|conn| {
            for id in 1..=7i64 {
                conn.execute("INSERT INTO tracks(id,path,title,added_at,lyrics) VALUES(?1,?2,?3,1,?4)", rusqlite::params![id, format!("test-{id}.mp3"), format!("Track {id}"), "домой ".repeat(id as usize)]).map_err(|e| e.to_string())?;
            }
            conn.execute("INSERT INTO track_lyrics_override(track_id,provider,lrc,updated_at) VALUES(7,'manual','другой текст',1)", []).map_err(|e| e.to_string())?;
            Ok(())
        }).unwrap();
        assert_eq!(search(&db, "домой").unwrap().iter().map(|t| t.id).collect::<Vec<_>>(), vec![6, 5, 4, 3, 2]);
        assert_eq!(search(&db, "другой").unwrap()[0].id, 7);
        assert!(search(&db, "%%____").unwrap().is_empty());
        drop(db);
        let _ = std::fs::remove_file(path);
    }
}
