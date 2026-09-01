//! Minimal Discord Rich Presence client over the local IPC named pipe.
//! Every request carries a nonce (Discord rejects payloads without one) and a
//! helper thread continuously drains replies/events so the pipe buffer never
//! fills up and blocks discord's side.

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

/// discord tolerates up to 5 updates per 20s; the frontend paces real updates,
/// this is only a backstop so a buggy caller still cannot spam
const MIN_SEND_INTERVAL: Duration = Duration::from_secs(1);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
const RECONNECT_DELAY: Duration = Duration::from_secs(5);
/// periodic resend heals any update discord silently dropped
const REFRESH_INTERVAL: Duration = Duration::from_secs(60);
/// discord caps the details/state strings at 128 bytes of utf-8
const FIELD_MAX_BYTES: usize = 128;

pub enum PresenceMsg {
    Set {
        client_id: String,
        details: String,
        state: Option<String>,
        start_ms: Option<u64>,
        end_ms: Option<u64>,
        large_image: Option<String>,
        small_image: Option<String>,
    },
    Clear,
}

fn sender() -> &'static Sender<PresenceMsg> {
    static SENDER: OnceLock<Sender<PresenceMsg>> = OnceLock::new();
    SENDER.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<PresenceMsg>();
        std::thread::Builder::new()
            .name("discord-presence".into())
            .spawn(move || run_loop(rx))
            .expect("failed to spawn discord thread");
        tx
    })
}

pub fn set_presence(
    client_id: String,
    details: String,
    state: Option<String>,
    start_ms: Option<u64>,
    end_ms: Option<u64>,
    large_image: Option<String>,
    small_image: Option<String>,
) {
    if client_id.trim().is_empty() {
        return;
    }
    let _ = sender().send(PresenceMsg::Set {
        client_id,
        details,
        state,
        start_ms,
        end_ms,
        large_image,
        small_image,
    });
}

pub fn clear_presence() {
    let _ = sender().send(PresenceMsg::Clear);
}

struct Pending {
    client_id: String,
    /// nonce-free SET_ACTIVITY args; the nonce is added when the frame goes
    /// out, so identical activities can be detected by comparing args
    args: String,
    nonce: String,
}

/// some discord builds reject the undocumented mp:external image format;
/// once a payload with it is rejected, fall back to the uploaded logo asset
static MP_EXTERNAL_DISABLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn gen_nonce() -> String {
    format!(
        "{:x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    )
}

fn run_loop(rx: mpsc::Receiver<PresenceMsg>) {
    let mut file: Option<std::fs::File> = None;
    let mut pending: Option<Pending> = None;
    let mut client_id = String::new();
    let mut last_beat = Instant::now() - HEARTBEAT_INTERVAL;
    let mut last_sent_at = Instant::now() - MIN_SEND_INTERVAL;
    let mut last_sent_args: Option<String> = None;
    // last accepted Set, so a rejected payload can be retried on a fresh session
    let mut last_set: Option<(
        String,
        Option<String>,
        Option<u64>,
        Option<u64>,
        Option<String>,
        Option<String>,
    )> = None;
    let mut error_retries: u32 = 0;
    let mut last_refresh = Instant::now();
    let mut err_flag: Option<Arc<AtomicBool>> = None;

    loop {
        // disabled until the first Set carries a client id
        if client_id.is_empty() {
            match rx.recv() {
                Ok(PresenceMsg::Set { client_id: id, details, state, start_ms, end_ms, large_image, small_image }) => {
                    if id.trim().is_empty() {
                        continue;
                    }
                    client_id = id;
                    let args = activity_args(
                        &details,
                        state.clone(),
                        start_ms,
                        end_ms,
                        large_image.clone(),
                        small_image.clone(),
                    );
                    pending = Some(Pending {
                        client_id: client_id.clone(),
                        args: args.clone(),
                        nonce: gen_nonce(),
                    });
                    last_set = Some((details, state, start_ms, end_ms, large_image, small_image));
                }
                Ok(PresenceMsg::Clear) => continue,
                Err(_) => return,
            }
        }

        // (re)connect
        if file.is_none() {
            match connect(&client_id) {
                Some((f, flag)) => {
                    last_beat = Instant::now();
                    last_sent_at = Instant::now() - MIN_SEND_INTERVAL; // allow immediate set
                    file = Some(f);
                    err_flag = Some(flag);
                }
                None => {
                    // Discord is not running or the pipe is busy; keep the
                    // payload and retry later so it goes out once discord
                    // appears instead of being silently lost.
                    std::thread::sleep(RECONNECT_DELAY);
                    continue;
                }
            }
        }
        let f = file.as_mut().unwrap();

        match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(PresenceMsg::Set { client_id: id, details, state, start_ms, end_ms, mut large_image, mut small_image }) => {
                if std::sync::atomic::AtomicBool::load(&MP_EXTERNAL_DISABLED, Ordering::Relaxed) {
                    if let Some(l) = &large_image {
                        if l.starts_with("mp:external/") {
                            large_image = Some("tempo_logo".into());
                            small_image = None;
                        }
                    }
                }
                if id.trim() != client_id {
                    // id changed: drop the connection so the next loop re-handshakes
                    client_id = id;
                    file = None;
                    pending = None;
                    continue;
                }
                let args = activity_args(
                    &details,
                    state.clone(),
                    start_ms,
                    end_ms,
                    large_image.clone(),
                    small_image.clone(),
                );
                pending = Some(Pending {
                    client_id: client_id.clone(),
                    args: args.clone(),
                    nonce: gen_nonce(),
                });
                last_set = Some((details, state, start_ms, end_ms, large_image, small_image));
                error_retries = 0;
            }
            Ok(PresenceMsg::Clear) => {
                pending = Some(Pending {
                    client_id: String::new(),
                    args: clear_args(),
                    nonce: gen_nonce(),
                });
                last_set = None;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }

        // discord rejected the previous request: retry it once on a fresh session
        if let Some(flag) = &err_flag {
            if flag.swap(false, Ordering::Relaxed) {
                if error_retries < 2 {
                    error_retries += 1;
                    if let Some((details, state, start_ms, end_ms, large_image, small_image)) = &last_set {
                        let args = activity_args(
                            details,
                            state.clone(),
                            *start_ms,
                            *end_ms,
                            large_image.clone(),
                            small_image.clone(),
                        );
                        pending = Some(Pending {
                            client_id: client_id.clone(),
                            args,
                            nonce: gen_nonce(),
                        });
                    }
                } else {
                    #[cfg(debug_assertions)]
                    eprintln!("[tempo discord] discord keeps rejecting the activity payload");
                    pending = None;
                    last_set = None;
                }
                last_sent_args = None;
                file = None; // re-handshake on the next loop iteration
                continue;
            }
        }

        let now = Instant::now();
        // periodic resend: heals any update discord silently dropped
        if now.duration_since(last_refresh) >= REFRESH_INTERVAL {
            last_refresh = now;
            if let Some((details, state, start_ms, end_ms, large_image, small_image)) = &last_set {
                let args = activity_args(
                    details,
                    state.clone(),
                    *start_ms,
                    *end_ms,
                    large_image.clone(),
                    small_image.clone(),
                );
                pending = Some(Pending {
                    client_id: client_id.clone(),
                    args,
                    nonce: gen_nonce(),
                });
                last_sent_args = None; // force the resend past the dedupe
            }
        }
        if now.duration_since(last_beat) >= HEARTBEAT_INTERVAL {
            if write_frame(f, 1, b"{}").is_err() {
                file = None;
                continue;
            }
            last_beat = now;
        }
        if let Some(p) = pending.take() {
            let is_clear = p.client_id.is_empty();
            let changed = last_sent_args.as_deref() != Some(p.args.as_str());
            if !is_clear && !changed {
                // identical to what discord already shows - drop it
                continue;
            }
            if now.duration_since(last_sent_at) < MIN_SEND_INTERVAL {
                pending = Some(p);
                continue;
            }
            let frame = wrap_set(&p.args, &p.nonce);
            if write_frame(f, 1, frame.as_bytes()).is_err() {
                file = None;
                pending = Some(p);
                continue;
            }
            last_sent_at = now;
            if is_clear {
                client_id = String::new();
                file = None; // re-handshake when presence returns
                last_sent_args = None;
            } else {
                last_sent_args = Some(p.args);
            }
        }
    }
}

fn connect(client_id: &str) -> Option<(std::fs::File, Arc<AtomicBool>)> {
    for i in 0..10 {
        let path = format!(r"\\.\pipe\discord-ipc-{i}");
        if let Ok(mut f) = std::fs::OpenOptions::new().read(true).write(true).open(&path) {
            let handshake = format!(r#"{{"v":1,"client_id":"{client_id}"}}"#);
            if write_frame(&mut f, 0, handshake.as_bytes()).is_ok() {
                // continuously drain replies/events on a helper handle so the
                // pipe buffer never fills up and blocks discord's side; error
                // replies set a shared flag the send loop reacts to
                let err_flag = Arc::new(AtomicBool::new(false));
                if let Ok(reader) = f.try_clone() {
                    let flag = Arc::clone(&err_flag);
                    std::thread::Builder::new()
                        .name("discord-drain".into())
                        .spawn(move || {
                            let mut reader = reader;
                            let mut header = [0u8; 8];
                            loop {
                                if reader.read_exact(&mut header).is_err() {
                                    break;
                                }
                                let len = u32::from_le_bytes([
                                    header[4], header[5], header[6], header[7],
                                ]) as usize;
                                let mut sink = vec![0u8; len];
                                if reader.read_exact(&mut sink).is_err() {
                                    break;
                                }
                                if sink.windows(12).any(|w| w == b"\"evt\":\"ERROR\"") {
                                    flag.store(true, Ordering::Relaxed);
                                    if sink.windows(14).any(|w| w == b"mp:external/") {
                                        std::sync::atomic::AtomicBool::store(
                                            &MP_EXTERNAL_DISABLED,
                                            true,
                                            Ordering::Relaxed,
                                        );
                                    }
                                }
                            }
                        })
                        .ok();
                }
                return Some((f, err_flag));
            }
        }
    }
    None
}

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// discord caps the details/state strings at 128 bytes of utf-8
fn truncate_utf8(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

/// Builds the nonce-free `args` object of a SET_ACTIVITY frame. Deduping
/// compares this string, so identical activities are dropped even though every
/// frame carries a fresh nonce.
fn activity_args(
    details: &str,
    state: Option<String>,
    start_ms: Option<u64>,
    end_ms: Option<u64>,
    large_image: Option<String>,
    small_image: Option<String>,
) -> String {
    let mut s = String::new();
    s.push_str("{\"pid\":");
    s.push_str(&std::process::id().to_string());
    s.push_str(",\"activity\":{\"name\":\"Tempo\",\"type\":2,\"details\":\"");
    s.push_str(&json_escape(&truncate_utf8(details, FIELD_MAX_BYTES)));
    s.push('"');
    if let Some(st) = state {
        if !st.is_empty() {
            s.push_str(",\"state\":\"");
            s.push_str(&json_escape(&truncate_utf8(&st, FIELD_MAX_BYTES)));
            s.push('"');
        }
    }
    match (start_ms, end_ms) {
        (Some(st), Some(en)) => {
            s.push_str(&format!(",\"timestamps\":{{\"start\":{st},\"end\":{en}}}", st = st, en = en));
        }
        (Some(ms), None) => {
            s.push_str(&format!(",\"timestamps\":{{\"start\":{ms}}}"));
        }
        _ => {}
    }
    let has_large = large_image.as_deref().map(|v| !v.trim().is_empty()).unwrap_or(false);
    if has_large {
        s.push_str(",\"assets\":{\"large_image\":\"");
        s.push_str(&json_escape(large_image.as_deref().unwrap_or("")));
        s.push('"');
        s.push_str(",\"large_text\":\"\"");
        if let Some(sm) = small_image {
            if !sm.trim().is_empty() {
                s.push_str(",\"small_image\":\"");
                s.push_str(&json_escape(&sm));
                s.push_str("\",\"small_text\":\"Tempo\"");
            }
        }
        s.push('}');
    }
    s.push_str("}}");
    s
}

fn wrap_set(args: &str, nonce: &str) -> String {
    let mut s = String::with_capacity(args.len() + 48);
    s.push_str("{\"cmd\":\"SET_ACTIVITY\",\"nonce\":\"");
    s.push_str(&json_escape(nonce));
    s.push_str("\",\"args\":");
    s.push_str(args);
    s.push('}');
    s
}

fn clear_args() -> String {
    format!("{{\"pid\":{},\"activity\":null}}", std::process::id())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn activity_json_is_balanced() {
        let args = activity_args(
            "Det \"quote\"",
            Some("St".into()),
            Some(1),
            Some(181),
            Some("mp:external/aGk".into()),
            Some("tempo_logo".into()),
        );
        assert!(args.contains("\"timestamps\":{\"start\":1,\"end\":181}"));
        let no_assets = activity_args("D", None, None, None, None, None);
        assert!(!no_assets.contains("assets"));

        let frame = wrap_set(&args, "n1");
        let parsed: serde_json::Value = serde_json::from_str(&frame)
            .expect("SET_ACTIVITY frame must be valid json");
        let activity = &parsed["args"]["activity"];
        assert_eq!(activity["details"], "Det \"quote\"");
        assert_eq!(activity["state"], "St");
        assert_eq!(activity["timestamps"]["start"], 1);
        assert_eq!(activity["timestamps"]["end"], 181);
        // assets must live INSIDE activity - a stray brace here used to push
        // them into args where discord silently ignored them
        assert_eq!(activity["assets"]["large_image"], "mp:external/aGk");
        assert_eq!(activity["assets"]["small_image"], "tempo_logo");
        assert_eq!(parsed["cmd"], "SET_ACTIVITY");
        assert_eq!(parsed["nonce"], "n1");

        let c = wrap_set(&clear_args(), "cn");
        let parsed: serde_json::Value =
            serde_json::from_str(&c).expect("clear frame must be valid json");
        assert!(parsed["args"]["activity"].is_null());
        assert_eq!(parsed["nonce"], "cn");
    }

    #[test]
    fn nonce_is_not_part_of_dedup() {
        // identical content must produce identical args regardless of nonce,
        // because dedup compares the nonce-free args string
        let a = activity_args("D", None, None, None, None, None);
        let b = activity_args("D", None, None, None, None, None);
        assert_eq!(a, b);
        assert_ne!(wrap_set(&a, "x"), wrap_set(&b, "y"));
    }

    #[test]
    fn long_fields_are_truncated_on_char_boundary() {
        let long = "ы".repeat(200); // 400 bytes of utf-8
        let args = activity_args(&long, Some(long.clone()), None, None, None, None);
        assert!(args.len() < 600);
        assert!(args.contains("\"details\":\""));
        assert!(!args.contains('\u{fffd}')); // no replacement char from a bad cut
    }
}

fn write_frame(f: &mut std::fs::File, op: u32, payload: &[u8]) -> std::io::Result<()> {
    let mut buf = Vec::with_capacity(8 + payload.len());
    buf.extend_from_slice(&op.to_le_bytes());
    buf.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    buf.extend_from_slice(payload);
    f.write_all(&buf)?;
    f.flush()
}
