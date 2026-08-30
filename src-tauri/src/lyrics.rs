use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;
use std::time::Duration;

use futures_util::future::select_all;
use regex::Regex;
use reqwest::Client;
use serde_json::Value;
use tokio::sync::Mutex;

const DESKTOP_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";
const MXM_APP_ID: &str = "web-desktop-app-v1.0";

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineLyrics {
    pub plain: Option<String>,
    pub synced_lrc: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineLyricsCandidate {
    pub provider: String,
    pub plain: Option<String>,
    pub synced_lrc: Option<String>,
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

fn mxm_token_slot() -> &'static Mutex<Option<String>> {
    static TOKEN: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    TOKEN.get_or_init(|| Mutex::new(None))
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
            });
        }
        if plain_only.is_none() && !plain.trim().is_empty() {
            plain_only = Some(OnlineLyrics {
                plain: Some(plain.to_string()),
                synced_lrc: None,
            });
        }
    }
    plain_only
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
        })
    }
}

async fn mxm_token() -> Result<String, String> {
    if let Some(t) = mxm_token_slot().lock().await.clone() {
        return Ok(t);
    }
    let json = get_json(&format!(
        "https://apic-desktop.musixmatch.com/ws/1.1/token.get?app_id={MXM_APP_ID}"
    ))
    .await?;
    let token = json
        .pointer("/message/body/user_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "mxm token missing".to_string())?
        .to_string();
    *mxm_token_slot().lock().await = Some(token.clone());
    Ok(token)
}

fn parse_mxm_subtitle(body: &str) -> Option<String> {
    let trimmed = body.trim();
    let looks_json = trimmed.starts_with('[')
        && serde_json::from_str::<Value>(trimmed).map(|v| v.is_array()).unwrap_or(false);
    if looks_json {
        let arr = serde_json::from_str::<Value>(trimmed).ok()?;
        let lines: Vec<(f64, String)> = arr
            .as_array()?
            .iter()
            .filter_map(|item| {
                let text = item.get("text").and_then(|v| v.as_str())?.to_string();
                let total = item.pointer("/time/total").and_then(|v| v.as_f64())?;
                Some((total, text))
            })
            .collect();
        if lines.is_empty() {
            None
        } else {
            Some(lines_to_lrc(&lines))
        }
    } else {
        let re = Regex::new(r"\[\d{1,2}:\d{2}").ok()?;
        if re.is_match(trimmed) {
            Some(trimmed.to_string())
        } else {
            None
        }
    }
}

async fn musixmatch_provider(artist: String, title: String) -> Option<OnlineLyrics> {
    for attempt in 0..2 {
        let token = mxm_token().await.ok()?;
        let json = get_json(&format!(
            "https://apic-desktop.musixmatch.com/ws/1.1/matcher.subtitle.get?q_artist={}&q_track={}&subtitle_format=mxm&app_id={MXM_APP_ID}&usertoken={}",
            urlencode(&artist),
            urlencode(&title),
            token
        ))
        .await
        .ok()?;
        let body = json
            .pointer("/message/body/subtitle/subtitle_body")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        match body {
            Some(b) => {
                return parse_mxm_subtitle(&b)
                    .map(|synced_lrc| OnlineLyrics { plain: None, synced_lrc: Some(synced_lrc) });
            }
            None => {
                if attempt == 0 {
                    *mxm_token_slot().lock().await = None;
                }
            }
        }
    }
    None
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

pub async fn fetch_online_lyrics(artist: &str, title: &str) -> Result<Option<OnlineLyrics>, String> {
    if title.trim().is_empty() {
        return Ok(None);
    }
    let key = format!("{}|{}", artist.trim().to_lowercase(), title.trim().to_lowercase());
    if let Some(cached) = cache_slot().lock().await.get(&key) {
        return Ok(cached.clone());
    }
    let artist = artist.trim().to_string();
    let title = title.trim().to_string();
    let chain = async move {
        for (va, vt) in build_variants(&artist, &title) {
            let g1_tasks: Vec<std::pin::Pin<Box<dyn Future<Output = Option<OnlineLyrics>> + Send>>> = vec![
                Box::pin(lrclib_provider(va.clone(), vt.clone())),
                Box::pin(textyl_provider(va.clone(), vt.clone())),
                Box::pin(musixmatch_provider(va.clone(), vt.clone())),
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
    let result = tokio::time::timeout(Duration::from_secs(12), chain).await.unwrap_or(None);
    let mut cache = cache_slot().lock().await;
    if cache.len() >= 256 {
        if let Some(first) = cache.keys().next().cloned() {
            cache.remove(&first);
        }
    }
    cache.insert(key, result.clone());
    Ok(result)
}

pub async fn fetch_online_lyrics_all(artist: &str, title: &str) -> Result<Vec<OnlineLyricsCandidate>, String> {
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
    let ca_ov = ca.clone();
    let ct_ov = ct.clone();
    let ca_ge = ca.clone();
    let ct_ge = ct.clone();
    let mut handles: Vec<tokio::task::JoinHandle<(usize, Option<OnlineLyricsCandidate>)>> = Vec::new();
    handles.push(tokio::spawn(async move {
        let r = lrclib_provider(ca_lr, ct_lr).await;
        (
            0usize,
            r.map(|v| OnlineLyricsCandidate {
                provider: "lrclib".to_string(),
                plain: v.plain,
                synced_lrc: v.synced_lrc,
            }),
        )
    }));
    handles.push(tokio::spawn(async move {
        let r = textyl_provider(ca_tx, ct_tx).await;
        (
            1usize,
            r.map(|v| OnlineLyricsCandidate {
                provider: "textyl".to_string(),
                plain: v.plain,
                synced_lrc: v.synced_lrc,
            }),
        )
    }));
    handles.push(tokio::spawn(async move {
        let r = musixmatch_provider(ca_mx, ct_mx).await;
        (
            2usize,
            r.map(|v| OnlineLyricsCandidate {
                provider: "musixmatch".to_string(),
                plain: v.plain,
                synced_lrc: v.synced_lrc,
            }),
        )
    }));
    handles.push(tokio::spawn(async move {
        let r = lyrics_ovh_provider(ca_ov, ct_ov).await;
        (
            3usize,
            r.map(|v| OnlineLyricsCandidate {
                provider: "lyrics.ovh".to_string(),
                plain: v.plain,
                synced_lrc: v.synced_lrc,
            }),
        )
    }));
    handles.push(tokio::spawn(async move {
        let r = genius_provider(ca_ge, ct_ge).await;
        (
            4usize,
            r.map(|v| OnlineLyricsCandidate {
                provider: "genius".to_string(),
                plain: v.plain,
                synced_lrc: v.synced_lrc,
            }),
        )
    }));
    let deadline = tokio::time::Instant::now() + Duration::from_secs(14);
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
                if let Ok((prio, Some(cand))) = out {
                    if cand.plain.is_some() || cand.synced_lrc.is_some() {
                        collected.push((prio, cand));
                    }
                }
            }
            Err(_) => break,
        }
    }
    collected.sort_by_key(|(p, _)| *p);
    let mut seen: HashSet<String> = HashSet::new();
    let mut deduped: Vec<OnlineLyricsCandidate> = Vec::new();
    for (_, c) in collected {
        if let Some(ref s) = c.synced_lrc {
            let key = s.trim().to_string();
            if seen.contains(&key) {
                continue;
            }
            seen.insert(key);
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
    fn mxm_json_array_converts_to_lrc() {
        let body = r#"[{"text":"hello","time":{"total":1.0}},{"text":"world","time":{"total":3.5}}]"#;
        let lrc = parse_mxm_subtitle(body).unwrap();
        assert_eq!(lrc, "[00:01.00] hello\n[00:03.50] world");
    }

    #[test]
    fn mxm_raw_lrc_passthrough() {
        assert_eq!(parse_mxm_subtitle("[00:01.00] hi").as_deref(), Some("[00:01.00] hi"));
        assert!(parse_mxm_subtitle("just plain words").is_none());
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
