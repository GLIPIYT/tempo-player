use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::future::select_all;
use regex::Regex;
use reqwest::Client;
use serde_json::Value;
use tokio::sync::Mutex;

const DESKTOP_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";
const MXM_BASE_URL: &str = "https://apic-desktop.musixmatch.com/ws/1.1/";
const MXM_APP_ID: &str = "web-desktop-app-v1.0";
const MXM_USER_AGENT: &str =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MXM_TOKEN_TTL: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineLyrics {
    pub plain: Option<String>,
    pub synced_lrc: Option<String>,
    pub copyright: Option<String>,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineLyricsCandidate {
    pub provider: String,
    pub plain: Option<String>,
    pub synced_lrc: Option<String>,
    pub id: Option<i64>,
    pub track_name: Option<String>,
    pub artist_name: Option<String>,
    pub album_name: Option<String>,
    pub duration: Option<f64>,
    pub instrumental: Option<bool>,
    pub copyright: Option<String>,
}

#[derive(Debug, Clone)]
struct MusixmatchLyrics {
    lrc: String,
    commontrack_id: Option<i64>,
    track_name: Option<String>,
    artist_name: Option<String>,
    album_name: Option<String>,
    duration: Option<f64>,
    instrumental: Option<bool>,
    copyright: Option<String>,
}

impl MusixmatchLyrics {
    fn into_online_lyrics(self) -> OnlineLyrics {
        OnlineLyrics {
            plain: None,
            synced_lrc: Some(self.lrc),
            copyright: self.copyright,
        }
    }

    fn into_candidate(self) -> OnlineLyricsCandidate {
        OnlineLyricsCandidate {
            provider: "musixmatch".to_string(),
            plain: None,
            synced_lrc: Some(self.lrc),
            id: self.commontrack_id,
            track_name: self.track_name,
            artist_name: self.artist_name,
            album_name: self.album_name,
            duration: self.duration,
            instrumental: self.instrumental,
            copyright: self.copyright,
        }
    }
}

#[derive(Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedMusixmatchToken {
    token: String,
    saved_at_unix: u64,
}

#[derive(Clone)]
struct CachedMusixmatchToken {
    token: String,
    expires_at: Instant,
}

fn lyrics_variants(provider: &str, lyrics: OnlineLyrics) -> Vec<OnlineLyricsCandidate> {
    let mut out = Vec::with_capacity(2);
    let copyright = lyrics.copyright;
    if let Some(synced_lrc) = lyrics.synced_lrc.filter(|text| !text.trim().is_empty()) {
        out.push(OnlineLyricsCandidate {
            provider: provider.to_string(),
            synced_lrc: Some(synced_lrc),
            copyright: copyright.clone(),
            ..OnlineLyricsCandidate::default()
        });
    }
    if let Some(plain) = lyrics.plain.filter(|text| !text.trim().is_empty()) {
        out.push(OnlineLyricsCandidate {
            provider: provider.to_string(),
            plain: Some(plain),
            copyright,
            ..OnlineLyricsCandidate::default()
        });
    }
    out
}

fn client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        Client::builder()
            .user_agent(DESKTOP_UA)
            .timeout(Duration::from_secs(8))
            .build()
            .expect("reqwest client")
    })
}

fn cache_slot() -> &'static Mutex<HashMap<String, Option<OnlineLyrics>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<OnlineLyrics>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn musixmatch_token_slot() -> &'static Mutex<Option<CachedMusixmatchToken>> {
    static TOKEN: OnceLock<Mutex<Option<CachedMusixmatchToken>>> = OnceLock::new();
    TOKEN.get_or_init(|| Mutex::new(None))
}

fn unix_time_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

async fn musixmatch_get(endpoint: &str, params: &[(&str, String)]) -> Option<Value> {
    let mut query = vec![
        ("app_id".to_string(), MXM_APP_ID.to_string()),
        ("format".to_string(), "json".to_string()),
    ];
    query.extend(
        params
            .iter()
            .map(|(key, value)| ((*key).to_string(), value.clone())),
    );

    let response = client()
        .get(format!("{MXM_BASE_URL}{endpoint}"))
        .header("User-Agent", MXM_USER_AGENT)
        .header("Cookie", "x-mxm-token-guid=")
        .query(&query)
        .send()
        .await
        .ok()?;
    let status = response.status();
    if status.as_u16() == 401 {
        let body = response.json::<Value>().await.ok().filter(|body| {
            json_contains_status_code(body, 401)
        });
        return Some(body.unwrap_or_else(|| {
            serde_json::json!({"message": {"header": {"status_code": 401}}})
        }));
    }
    if !status.is_success() {
        return None;
    }
    response.json::<Value>().await.ok()
}

async fn musixmatch_user_token(
    force_refresh: bool,
    cache_file: Option<PathBuf>,
) -> Option<String> {
    let mut memory_cache = musixmatch_token_slot().lock().await;
    if !force_refresh {
        if let Some(cached) = memory_cache
            .as_ref()
            .filter(|cached| cached.expires_at > Instant::now())
        {
            return Some(cached.token.clone());
        }

        if let Some(path) = cache_file.as_ref() {
            if let Ok(contents) = tokio::fs::read(path).await {
                if let Ok(persisted) = serde_json::from_slice::<PersistedMusixmatchToken>(&contents)
                {
                    let age = unix_time_secs().saturating_sub(persisted.saved_at_unix);
                    if age < MXM_TOKEN_TTL.as_secs()
                        && !persisted.token.starts_with("UpgradeOnly")
                        && !persisted.token.trim().is_empty()
                    {
                        let expires_in = MXM_TOKEN_TTL.saturating_sub(Duration::from_secs(age));
                        *memory_cache = Some(CachedMusixmatchToken {
                            token: persisted.token.clone(),
                            expires_at: Instant::now() + expires_in,
                        });
                        return Some(persisted.token);
                    }
                }
            }
        }
    }

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().to_string())
        .unwrap_or_else(|_| "0".to_string());
    let response = musixmatch_get("token.get", &[("t", timestamp)]).await?;
    if response
        .pointer("/message/header/status_code")
        .and_then(Value::as_i64)
        != Some(200)
    {
        return None;
    }
    let token = response
        .pointer("/message/body/user_token")
        .and_then(Value::as_str)?
        .trim();
    if token.is_empty() || token.starts_with("UpgradeOnly") {
        return None;
    }

    let token = token.to_string();
    let saved_at_unix = unix_time_secs();
    *memory_cache = Some(CachedMusixmatchToken {
        token: token.clone(),
        expires_at: Instant::now() + MXM_TOKEN_TTL,
    });

    if let Some(path) = cache_file {
        if let Some(parent) = path.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        if let Ok(contents) = serde_json::to_vec(&PersistedMusixmatchToken {
            token: token.clone(),
            saved_at_unix,
        }) {
            let _ = tokio::fs::write(path, contents).await;
        }
    }

    Some(token)
}

fn json_contains_status_code(value: &Value, status: i64) -> bool {
    match value {
        Value::Object(object) => object.iter().any(|(key, value)| {
            (key == "status_code" && value.as_i64() == Some(status))
                || json_contains_status_code(value, status)
        }),
        Value::Array(values) => values
            .iter()
            .any(|value| json_contains_status_code(value, status)),
        _ => false,
    }
}

fn normalize_musixmatch_text(value: &str) -> String {
    let lower = value.to_lowercase();
    lower.chars().filter(|character| character.is_alphanumeric()).collect()
}

fn musixmatch_field_matches(actual: &str, requested: &str) -> bool {
    let actual = normalize_musixmatch_text(actual);
    let requested = normalize_musixmatch_text(requested);
    !actual.is_empty()
        && !requested.is_empty()
        && (actual == requested
            || (requested.chars().count() >= 4 && actual.contains(&requested))
            || (actual.chars().count() >= 4 && requested.contains(&actual)))
}

fn sec_to_lrc_time(sec: f64) -> String {
    let total = sec.max(0.0);
    let minutes = (total / 60.0).floor() as i64;
    let seconds = (total % 60.0).floor() as i64;
    let centis = ((total - (total).floor()) * 100.0).round() as i64;
    let (seconds, centis) = if centis >= 100 { (seconds + 1, 0) } else { (seconds, centis) };
    format!("[{minutes:02}:{seconds:02}.{centis:02}]")
}

fn lines_to_lrc(lines: &[(f64, String)]) -> String {
    lines
        .iter()
        .map(|(t, text)| format!("{} {}", sec_to_lrc_time(*t), text))
        .collect::<Vec<_>>()
        .join("\n")
}

fn strip_bracketed(s: &str) -> String {
    let mut out = String::new();
    let mut depth = 0i32;
    for ch in s.chars() {
        match ch {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth = (depth - 1).max(0),
            c if depth == 0 => out.push(c),
            _ => {}
        }
    }
    out
}

fn clean_pair(artist: &str, title: &str) -> (String, String) {
    let clean = |s: &str| -> String {
        let no_brackets = strip_bracketed(s);
        let lower = no_brackets.to_lowercase();
        let cut = lower
            .find(" feat")
            .or_else(|| lower.find(" ft"))
            .or_else(|| lower.find("featuring "))
            .unwrap_or(no_brackets.len());
        let mut res = no_brackets[..cut.min(no_brackets.len())].trim().to_string();
        while res.ends_with('-') || res.ends_with('–') || res.ends_with(',') {
            res.pop();
            res = res.trim_end().to_string();
        }
        res
    };
    (clean(artist), clean(title))
}

fn build_variants(artist: &str, title: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut push = |a: String, t: String| {
        if !t.is_empty() && !out.contains(&(a.clone(), t.clone())) {
            out.push((a, t));
        }
    };
    let (ca, ct) = clean_pair(artist, title);
    push(ca.clone(), ct.clone());
    push(artist.trim().to_string(), title.trim().to_string());
    if ca.is_empty() {
        if let Some(pos) = title.find(" - ") {
            let (a, t) = title.split_at(pos);
            push(clean_pair(a, &t[3..]).0, clean_pair(a, &t[3..]).1);
        }
    }
    push(String::new(), ct.clone());
    push(String::new(), title.trim().to_string());
    out
}

fn decode_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
}

fn strip_tags(s: &str) -> String {
    let re = Regex::new(r"<[^>]+>").ok();
    match re {
        Some(re) => re.replace_all(s, "").to_string(),
        None => s.to_string(),
    }
}

async fn get_json(url: &str) -> Result<Value, String> {
    client()
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json::<Value>()
        .await
        .map_err(|e| e.to_string())
}

fn pick_lrclib(json: &Value) -> Option<OnlineLyrics> {
    let records = json.as_array()?;
    let mut plain_only = None;
    for rec in records {
        let synced = rec.get("syncedLyrics").and_then(|v| v.as_str()).unwrap_or_default();
        let plain = rec.get("plainLyrics").and_then(|v| v.as_str()).unwrap_or_default();
        if !synced.trim().is_empty() {
            return Some(OnlineLyrics {
                plain: if plain.trim().is_empty() { None } else { Some(plain.to_string()) },
                synced_lrc: Some(synced.to_string()),
                copyright: None,
            });
        }
        if plain_only.is_none() && !plain.trim().is_empty() {
            plain_only = Some(OnlineLyrics {
                plain: Some(plain.to_string()),
                synced_lrc: None,
                copyright: None,
            });
        }
    }
    plain_only
}

fn lrclib_candidates(json: &Value) -> Vec<OnlineLyricsCandidate> {
    let Some(records) = json.as_array() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for record in records {
        let lyrics = OnlineLyrics {
            plain: record
                .get("plainLyrics")
                .and_then(Value::as_str)
                .filter(|text| !text.trim().is_empty())
                .map(str::to_owned),
            copyright: None,
            synced_lrc: record
                .get("syncedLyrics")
                .and_then(Value::as_str)
                .filter(|text| !text.trim().is_empty())
                .map(str::to_owned),
        };
        let mut variants = lyrics_variants("lrclib", lyrics);
        for candidate in &mut variants {
            candidate.id = record.get("id").and_then(Value::as_i64);
            candidate.track_name = record
                .get("trackName")
                .or_else(|| record.get("name"))
                .and_then(Value::as_str)
                .map(str::to_owned);
            candidate.artist_name = record.get("artistName").and_then(Value::as_str).map(str::to_owned);
            candidate.album_name = record.get("albumName").and_then(Value::as_str).map(str::to_owned);
            candidate.duration = record.get("duration").and_then(Value::as_f64);
            candidate.instrumental = record.get("instrumental").and_then(Value::as_bool);
        }
        out.extend(variants);
    }
    out
}

async fn lrclib_candidates_provider(artist: String, title: String) -> Vec<OnlineLyricsCandidate> {
    let base = "https://lrclib.net/api/search";
    let exact = get_json(&format!(
        "{base}?artist_name={}&track_name={}",
        urlencode(&artist),
        urlencode(&title)
    ))
    .await
    .ok();
    if let Some(json) = exact {
        let candidates = lrclib_candidates(&json);
        if !candidates.is_empty() {
            return candidates;
        }
    }
    get_json(&format!("{base}?q={}%20{}", urlencode(&artist), urlencode(&title)))
        .await
        .map(|json| lrclib_candidates(&json))
        .unwrap_or_default()
}

async fn lrclib_provider(artist: String, title: String) -> Option<OnlineLyrics> {
    let base = "https://lrclib.net/api/search";
    let mut json = get_json(&format!(
        "{base}?artist_name={}&track_name={}",
        urlencode(&artist),
        urlencode(&title)
    ))
    .await
    .ok()?;
    let mut res = pick_lrclib(&json);
    if res.is_none() {
        json = get_json(&format!("{base}?q={}%20{}", urlencode(&artist), urlencode(&title)))
            .await
            .ok()?;
        res = pick_lrclib(&json);
    }
    res
}

async fn textyl_provider(artist: String, title: String) -> Option<OnlineLyrics> {
    let json = get_json(&format!(
        "https://api.textyl.co/api/lyrics?q={}%20{}",
        urlencode(&artist),
        urlencode(&title)
    ))
    .await
    .ok()?;
    let arr = json.as_array()?;
    let lines: Vec<(f64, String)> = arr
        .iter()
        .filter_map(|item| {
            let sec = item.get("seconds").and_then(|v| v.as_f64())?;
            let text = item.get("lyrics").and_then(|v| v.as_str())?.to_string();
            Some((sec, text))
        })
        .collect();
    if lines.is_empty() {
        None
    } else {
        Some(OnlineLyrics {
            plain: None,
            synced_lrc: Some(lines_to_lrc(&lines)),
            copyright: None,
        })
    }
}

async fn musixmatch_request(
    artist: &str,
    title: &str,
    album: &str,
    duration_sec: Option<f64>,
    token: &str,
) -> Option<Value> {
    let duration = duration_sec
        .filter(|duration| duration.is_finite() && *duration > 0.0)
        .map(|duration| duration.floor().to_string())
        .unwrap_or_default();
    let params = [
        ("namespace", "lyrics_richsynched".to_string()),
        ("subtitle_format", "lrc".to_string()),
        ("q_track", title.to_string()),
        ("q_artist", artist.to_string()),
        ("q_album", album.to_string()),
        ("q_duration", duration),
        ("usertoken", token.to_string()),
    ];
    let params: Vec<_> = params
        .iter()
        .map(|(key, value)| (*key, value.clone()))
        .collect();
    musixmatch_get("macro.subtitles.get", &params).await
}

async fn musixmatch_provider(
    artist: String,
    title: String,
    album: String,
    duration_sec: Option<f64>,
    token_cache_file: Option<PathBuf>,
) -> Option<MusixmatchLyrics> {
    if artist.trim().is_empty() || title.trim().is_empty() {
        return None;
    }

    let mut token = musixmatch_user_token(false, token_cache_file.clone()).await?;
    let mut response = musixmatch_request(&artist, &title, &album, duration_sec, &token).await?;
    if json_contains_status_code(&response, 401) {
        token = musixmatch_user_token(true, token_cache_file).await?;
        response = musixmatch_request(&artist, &title, &album, duration_sec, &token).await?;
    }
    if response
        .pointer("/message/header/status_code")
        .and_then(Value::as_i64)
        != Some(200)
    {
        return None;
    }

    let track = response
        .pointer("/message/body/macro_calls/matcher.track.get/message/body/track")?;
    let track_name = track.get("track_name").and_then(Value::as_str)?.trim();
    let artist_name = track.get("artist_name").and_then(Value::as_str)?.trim();
    if !musixmatch_field_matches(track_name, &title)
        || !musixmatch_field_matches(artist_name, &artist)
    {
        return None;
    }

    let instrumental = track
        .get("instrumental")
        .and_then(|value| value.as_bool().or_else(|| value.as_i64().map(|n| n != 0)));
    if instrumental == Some(true) {
        return None;
    }

    let track_duration = track
        .get("track_length")
        .and_then(|value| value.as_f64().or_else(|| value.as_i64().map(|n| n as f64)));
    if let (Some(requested), Some(returned)) = (duration_sec, track_duration) {
        if requested.is_finite() && requested > 0.0 && (requested - returned).abs() > 15.0 {
            return None;
        }
    }

    let subtitle_list = response
        .pointer("/message/body/macro_calls/track.subtitles.get/message/body/subtitle_list")?
        .as_array()?;
    let subtitle = subtitle_list.iter().find_map(|item| {
        let subtitle = item.get("subtitle")?;
        let body = subtitle.get("subtitle_body")?.as_str()?.trim();
        if body.is_empty() || !body.contains('[') {
            None
        } else {
            Some((subtitle, body.to_string()))
        }
    })?;

    Some(MusixmatchLyrics {
        lrc: subtitle.1,
        commontrack_id: track.get("commontrack_id").and_then(Value::as_i64),
        track_name: Some(track_name.to_string()),
        artist_name: Some(artist_name.to_string()),
        album_name: track
            .get("album_name")
            .and_then(Value::as_str)
            .map(str::to_string),
        duration: track_duration,
        instrumental,
        copyright: subtitle
            .0
            .get("lyrics_copyright")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

async fn lyrics_ovh_provider(artist: String, title: String) -> Option<OnlineLyrics> {
    if artist.is_empty() {
        return None;
    }
    let url = format!(
        "https://api.lyrics.ovh/v1/{}/{}",
        urlencode(&artist),
        urlencode(&title)
    );
    let json = get_json(&url).await.ok()?;
    let lyrics = json.get("lyrics").and_then(|v| v.as_str())?.trim().to_string();
    let low = lyrics.to_lowercase();
    if lyrics.len() < 20 || low.contains("working on") || low.contains("not available") {
        return None;
    }
    Some(OnlineLyrics {
        plain: Some(lyrics),
        synced_lrc: None,
        copyright: None,
    })
}

fn extract_genius_lyrics(html: &str) -> Option<String> {
    let re = Regex::new(r#"<div[^>]*data-lyrics-container="true"[^>]*>(?s)(.*?)</div>"#).ok()?;
    let br_re = Regex::new(r"(?i)<br\s*/?>").ok()?;
    let block_re = Regex::new(r"(?i)</(?:p|div)[^>]*>").ok()?;
    let nl_re = Regex::new(r"\n{3,}").ok()?;
    let mut parts = Vec::new();
    for cap in re.captures_iter(html) {
        let raw = cap.get(1).map(|m| m.as_str()).unwrap_or("");
        let with_br = br_re.replace_all(raw, "\n");
        let with_blocks = block_re.replace_all(&with_br, "\n\n");
        let stripped = strip_tags(&with_blocks);
        let decoded = decode_entities(&stripped);
        let trimmed = decoded.split('\n').map(|l| l.trim_end()).collect::<Vec<_>>().join("\n");
        let collapsed = nl_re.replace_all(&trimmed, "\n\n").to_string();
        parts.push(collapsed.trim().to_string());
    }
    if parts.is_empty() {
        None
    } else {
        let joined = parts.join("\n\n");
        let collapsed = nl_re.replace_all(&joined, "\n\n").to_string();
        let trimmed = collapsed.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    }
}

async fn genius_provider(artist: String, title: String) -> Option<OnlineLyrics> {
    let query = if artist.is_empty() {
        title.to_string()
    } else {
        format!("{artist} {title}")
    };
    let search = get_json(&format!(
        "https://genius.com/api/search/multi?per_page=5&q={}",
        urlencode(&query)
    ))
    .await
    .ok()?;
    let mut song_url = None;
    if let Some(sections) = search.get("response").and_then(|r| r.get("sections")).and_then(|s| s.as_array()) {
        for section in sections {
            for hit in section.pointer("/hits").and_then(|h| h.as_array()).unwrap_or(&Vec::new()) {
                if hit.get("type").and_then(|v| v.as_str()) == Some("song") {
                    song_url = hit.pointer("/result/url").and_then(|v| v.as_str()).map(|s| s.to_string());
                    break;
                }
            }
            if song_url.is_some() {
                break;
            }
        }
    }
    let url = song_url?;
    let html = client()
        .get(&url)
        .header("Referer", "https://genius.com/")
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .text()
        .await
        .ok()?;
    let text = extract_genius_lyrics(&html)?;
    if text.len() < 20 {
        return None;
    }
    Some(OnlineLyrics {
        plain: Some(text),
        synced_lrc: None,
        copyright: None,
    })
}

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

async fn race_first(
    tasks: Vec<std::pin::Pin<Box<dyn Future<Output = Option<OnlineLyrics>> + Send>>>,
) -> Option<OnlineLyrics> {
    let mut handles: Vec<_> = tasks.into_iter().map(tokio::spawn).collect();
    while !handles.is_empty() {
        let (res, _idx, rest) = select_all(handles).await;
        handles = rest;
        if let Ok(Some(found)) = res {
            for h in handles {
                h.abort();
            }
            return Some(found);
        }
    }
    None
}

use std::future::Future;

pub async fn fetch_online_lyrics(
    artist: &str,
    title: &str,
    album: Option<&str>,
    duration_sec: Option<f64>,
    token_cache_file: Option<PathBuf>,
) -> Result<Option<OnlineLyrics>, String> {
    if title.trim().is_empty() {
        return Ok(None);
    }
    let album = album.unwrap_or_default().trim().to_string();
    let key = format!(
        "{}|{}|{}|{}",
        artist.trim().to_lowercase(),
        title.trim().to_lowercase(),
        album.to_lowercase(),
        duration_sec.map(|duration| duration.round() as i64).unwrap_or_default()
    );
    if let Some(cached) = cache_slot().lock().await.get(&key) {
        return Ok(cached.clone());
    }
    let artist = artist.trim().to_string();
    let title = title.trim().to_string();
    let chain = async move {
        for (va, vt) in build_variants(&artist, &title) {
            let mxm_artist = va.clone();
            let mxm_title = vt.clone();
            let mxm_album = album.clone();
            let mxm_token_cache = token_cache_file.clone();
            let g1_tasks: Vec<std::pin::Pin<Box<dyn Future<Output = Option<OnlineLyrics>> + Send>>> = vec![
                Box::pin(lrclib_provider(va.clone(), vt.clone())),
                Box::pin(textyl_provider(va.clone(), vt.clone())),
                Box::pin(async move {
                    musixmatch_provider(
                        mxm_artist,
                        mxm_title,
                        mxm_album,
                        duration_sec,
                        mxm_token_cache,
                    )
                    .await
                    .map(MusixmatchLyrics::into_online_lyrics)
                }),
            ];
            let found = race_first(g1_tasks).await;
            let found = match found {
                Some(res) => Some(res),
                None => {
                    let g2_tasks: Vec<
                        std::pin::Pin<Box<dyn Future<Output = Option<OnlineLyrics>> + Send>>,
                    > = vec![
                        Box::pin(lyrics_ovh_provider(va.clone(), vt.clone())),
                        Box::pin(genius_provider(va, vt)),
                    ];
                    race_first(g2_tasks).await
                }
            };
            if let Some(res) = found {
                return Some(res);
            }
        }
        None
    };
    let result = tokio::time::timeout(Duration::from_secs(18), chain).await.unwrap_or(None);
    let mut cache = cache_slot().lock().await;
    if cache.len() >= 256 {
        if let Some(first) = cache.keys().next().cloned() {
            cache.remove(&first);
        }
    }
    cache.insert(key, result.clone());
    Ok(result)
}

pub async fn fetch_online_lyrics_all(
    artist: &str,
    title: &str,
    album: Option<&str>,
    duration_sec: Option<f64>,
    token_cache_file: Option<PathBuf>,
) -> Result<Vec<OnlineLyricsCandidate>, String> {
    if title.trim().is_empty() {
        return Ok(Vec::new());
    }
    let (mut ca, mut ct) = clean_pair(artist, title);
    if ct.trim().is_empty() {
        ct = title.trim().to_string();
    }
    if ct.trim().is_empty() {
        return Ok(Vec::new());
    }
    ca = ca.trim().to_string();
    ct = ct.trim().to_string();
    let ca_lr = ca.clone();
    let ct_lr = ct.clone();
    let ca_tx = ca.clone();
    let ct_tx = ct.clone();
    let ca_mx = ca.clone();
    let ct_mx = ct.clone();
    let album_mx = album.unwrap_or_default().trim().to_string();
    let token_cache_mx = token_cache_file;
    let ca_ov = ca.clone();
    let ct_ov = ct.clone();
    let ca_ge = ca.clone();
    let ct_ge = ct.clone();
    let mut handles: Vec<tokio::task::JoinHandle<(usize, Vec<OnlineLyricsCandidate>)>> = Vec::new();
    handles.push(tokio::spawn(async move {
        (0usize, lrclib_candidates_provider(ca_lr, ct_lr).await)
    }));
    handles.push(tokio::spawn(async move {
        let r = textyl_provider(ca_tx, ct_tx).await;
        (1usize, r.map(|v| lyrics_variants("textyl", v)).unwrap_or_default())
    }));
    handles.push(tokio::spawn(async move {
        let r = musixmatch_provider(ca_mx, ct_mx, album_mx, duration_sec, token_cache_mx).await;
        (2usize, r.map(|v| vec![v.into_candidate()]).unwrap_or_default())
    }));
    handles.push(tokio::spawn(async move {
        let r = lyrics_ovh_provider(ca_ov, ct_ov).await;
        (3usize, r.map(|v| lyrics_variants("lyrics.ovh", v)).unwrap_or_default())
    }));
    handles.push(tokio::spawn(async move {
        let r = genius_provider(ca_ge, ct_ge).await;
        (4usize, r.map(|v| lyrics_variants("genius", v)).unwrap_or_default())
    }));
    let deadline = tokio::time::Instant::now() + Duration::from_secs(18);
    let mut pending = handles;
    let mut collected: Vec<(usize, OnlineLyricsCandidate)> = Vec::new();
    while !pending.is_empty() {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        match tokio::time::timeout(remaining, select_all(pending)).await {
            Ok((out, _idx, rest)) => {
                pending = rest;
                if let Ok((prio, candidates)) = out {
                    collected.extend(
                        candidates
                            .into_iter()
                            .filter(|candidate| candidate.plain.is_some() || candidate.synced_lrc.is_some())
                            .map(|candidate| (prio, candidate)),
                    );
                }
            }
            Err(_) => break,
        }
    }
    collected.sort_by_key(|(p, _)| *p);
    let mut seen: HashSet<String> = HashSet::new();
    let mut deduped: Vec<OnlineLyricsCandidate> = Vec::new();
    for (_, c) in collected {
        let body = c.synced_lrc.as_deref().or(c.plain.as_deref()).unwrap_or_default().trim();
        let identity = c
            .id
            .map(|id| format!("id:{id}"))
            .unwrap_or_else(|| format!("body:{}", body.to_lowercase()));
        let kind = if c.synced_lrc.is_some() { "synced" } else { "plain" };
        let key = format!("{}\0{}\0{}", c.provider, identity, kind);
        if !seen.insert(key) {
            continue;
        }
        deduped.push(c);
    }
    Ok(deduped)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lrc_time_formatting() {
        assert_eq!(sec_to_lrc_time(12.34), "[00:12.34]");
        assert_eq!(sec_to_lrc_time(75.0), "[01:15.00]");
        assert_eq!(sec_to_lrc_time(-1.0), "[00:00.00]");
    }

    #[test]
    fn lines_to_lrc_builds_synced_text() {
        let lrc = lines_to_lrc(&[(1.0, "a".into()), (61.5, "b".into())]);
        assert_eq!(lrc, "[00:01.00] a\n[01:01.50] b");
    }

    #[test]
    fn clean_pair_strips_brackets_and_feats() {
        let (a, t) = clean_pair("Artist (feat. Someone)", "Song [Official Video] (2020)");
        assert_eq!(a, "Artist");
        assert_eq!(t, "Song");
        let (a, t) = clean_pair("X ft. Y", "Title - Remaster");
        assert_eq!(a, "X");
        assert_eq!(t, "Title - Remaster");
    }

    #[test]
    fn build_variants_dedupes_and_includes_title_only() {
        let v = build_variants("A", "B");
        assert_eq!(v[0], ("A".to_string(), "B".to_string()));
        assert!(v.iter().any(|(a, _)| a.is_empty()));
    }

    #[test]
    fn genius_blocks_extract_and_clean() {
        let html = r#"<div class="a"><div data-lyrics-container="true">Line &amp; one<br/>Line two</div></div><div data-lyrics-container="true">Part <b>two</b></div>"#;
        let res = extract_genius_lyrics(html).unwrap();
        assert!(res.contains("Line & one"));
        assert!(res.contains("Line two"));
        assert!(res.contains("Part two"));
        assert!(!res.contains('<'));
    }
}
