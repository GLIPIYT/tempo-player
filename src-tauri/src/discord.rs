//! Minimal Discord Rich Presence client over the local IPC named pipe.
//! Every request carries a nonce (Discord rejects payloads without one) and a
//! helper thread continuously drains replies/events so the pipe buffer never
//! fills up and blocks discord's side.

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

/// discord tolerates up to 5 updates per 20s; anything above this gap is
/// safety-only, real updates go out as soon as the payload changes
const MIN_SEND_INTERVAL: Duration = Duration::from_secs(2);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
const RECONNECT_DELAY: Duration = Duration::from_secs(5);

pub enum PresenceMsg {
    Set {
        client_id: String,
        details: String,
        state: Option<String>,
        start_ms: Option<u64>,
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
        large_image,
        small_image,
    });
}

pub fn clear_presence() {
    let _ = sender().send(PresenceMsg::Clear);
}

struct Pending {
    client_id: String,
    payload: String,
    nonce: String,
}

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
    let mut last_sent_payload: Option<String> = None;
    // last accepted Set, so a rejected payload can be retried on a fresh session
    let mut last_set: Option<(String, Option<String>, Option<u64>, Option<String>, Option<String>)> =
        None;
    let mut error_retries: u32 = 0;
    let mut err_flag: Option<Arc<AtomicBool>> = None;

    loop {
        // disabled until the first Set carries a client id
        if client_id.is_empty() {
            match rx.recv() {
                Ok(PresenceMsg::Set { client_id: id, details, state, start_ms, large_image, small_image }) => {
                    if id.trim().is_empty() {
                        continue;
                    }
                    client_id = id;
                    let nonce = gen_nonce();
                    pending = Some(Pending {
                        client_id: client_id.clone(),
                        payload: build_activity(
                            &details,
                            state.clone(),
                            start_ms,
                            large_image.clone(),
                            small_image.clone(),
                            &nonce,
                        ),
                        nonce,
                    });
                    last_set = Some((details, state, start_ms, large_image, small_image));
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
            Ok(PresenceMsg::Set { client_id: id, details, state, start_ms, large_image, small_image }) => {
                if id.trim() != client_id {
                    // id changed: drop the connection so the next loop re-handshakes
                    client_id = id;
                    file = None;
                    pending = None;
                    continue;
                }
                let nonce = gen_nonce();
                pending = Some(Pending {
                    client_id: client_id.clone(),
                    payload: build_activity(
                        &details,
                        state.clone(),
                        start_ms,
                        large_image.clone(),
                        small_image.clone(),
                        &nonce,
                    ),
                    nonce,
                });
                last_set = Some((details, state, start_ms, large_image, small_image));
                error_retries = 0;
            }
            Ok(PresenceMsg::Clear) => {
                pending = Some(Pending {
                    client_id: String::new(),
                    payload: build_clear(&gen_nonce()),
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
                    if let Some((details, state, start_ms, large_image, small_image)) = &last_set {
                        let nonce = gen_nonce();
                        pending = Some(Pending {
                            client_id: client_id.clone(),
                            payload: build_activity(
                                details,
                                state.clone(),
                                *start_ms,
                                large_image.clone(),
                                small_image.clone(),
                                &nonce,
                            ),
                            nonce,
                        });
                    }
                } else {
                    #[cfg(debug_assertions)]
                    eprintln!("[tempo discord] discord keeps rejecting the activity payload");
                    pending = None;
                    last_set = None;
                }
                last_sent_payload = None;
                file = None; // re-handshake on the next loop iteration
                continue;
            }
        }

        let now = Instant::now();
        if now.duration_since(last_beat) >= HEARTBEAT_INTERVAL {
            if write_frame(f, 1, b"{}").is_err() {
                file = None;
                continue;
            }
            last_beat = now;
        }
        if let Some(p) = pending.take() {
            let is_clear = p.client_id.is_empty();
            let changed = last_sent_payload.as_deref() != Some(p.payload.as_str());
            if !is_clear && !changed {
                // identical to what discord already shows - drop it
                continue;
            }
            if now.duration_since(last_sent_at) < MIN_SEND_INTERVAL {
                pending = Some(p);
                continue;
            }
            if write_frame(f, 1, p.payload.as_bytes()).is_err() {
                file = None;
                pending = Some(p);
                continue;
            }
            last_sent_at = now;
            if is_clear {
                client_id = String::new();
                file = None; // re-handshake when presence returns
                last_sent_payload = None;
            } else {
                last_sent_payload = Some(p.payload);
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

fn build_activity(
    details: &str,
    state: Option<String>,
    start_ms: Option<u64>,
    large_image: Option<String>,
    small_image: Option<String>,
    nonce: &str,
) -> String {
    let mut s = String::new();
    s.push_str("{\"cmd\":\"SET_ACTIVITY\",\"nonce\":\"");
    s.push_str(&json_escape(nonce));
    s.push_str("\",\"args\":{\"pid\":");
    s.push_str(&std::process::id().to_string());
    s.push_str(",\"activity\":{\"name\":\"Tempo\",\"type\":2,\"details\":\"");
    s.push_str(&json_escape(details));
    s.push('"');
    if let Some(st) = state {
        if !st.is_empty() {
            s.push_str(",\"state\":\"");
            s.push_str(&json_escape(&st));
            s.push('"');
        }
    }
    if let Some(ms) = start_ms {
        s.push_str(&format!(",\"timestamps\":{{\"start\":{}}}}}", ms));
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn activity_json_is_balanced() {
        let s = build_activity(
            "Det \"quote\"",
            Some("St".into()),
            Some(1),
            Some("mp:external/aGk".into()),
            Some("tempo_logo".into()),
            "n1",
        );
        assert_eq!(s.matches('{').count(), s.matches('}').count());
        assert!(s.contains("\"details\":\"Det \\\"quote\\\"\""));
        assert!(s.contains("\"timestamps\":{\"start\":1}"));
        assert!(s.contains("\"large_image\":\"mp:external/aGk\""));
        assert!(s.contains("\"small_image\":\"tempo_logo\""));
        let no_assets = build_activity("D", None, None, None, None, "n");
        assert!(!no_assets.contains("assets"));
        let c = build_clear("cn");
        assert_eq!(c.matches('{').count(), c.matches('}').count());
        assert!(c.contains("\"activity\":null"));
        assert!(c.contains("\"nonce\":\"cn\""));
    }

    #[test]
    fn nonce_changes_each_call() {
        let a = build_activity("D", None, None, None, None, "a");
        let b = build_activity("D", None, None, None, None, "b");
        assert!(a.contains("\"nonce\":\"a\""));
        assert!(b.contains("\"nonce\":\"b\""));
    }
}

fn build_clear(nonce: &str) -> String {
    let mut s = String::new();
    s.push_str("{\"cmd\":\"SET_ACTIVITY\",\"nonce\":\"");
    s.push_str(&json_escape(nonce));
    s.push_str("\",\"args\":{\"pid\":");
    s.push_str(&std::process::id().to_string());
    s.push_str(",\"activity\":null}}");
    s
}

fn write_frame(f: &mut std::fs::File, op: u32, payload: &[u8]) -> std::io::Result<()> {
    let mut buf = Vec::with_capacity(8 + payload.len());
    buf.extend_from_slice(&op.to_le_bytes());
    buf.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    buf.extend_from_slice(payload);
    f.write_all(&buf)?;
    f.flush()
}
