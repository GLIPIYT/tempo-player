//! Minimal Discord Rich Presence client over the local IPC named pipe.
//! Send-only by design: every write is followed by a Discord reply that we
//! deliberately leave buffered (a few hundred bytes per 15s heartbeat drains
//! slowly enough to never matter for a desktop session).

use std::io::Write;
use std::sync::mpsc::{self, Sender};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

const UPDATE_INTERVAL: Duration = Duration::from_secs(15);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
const RECONNECT_DELAY: Duration = Duration::from_secs(5);

pub enum PresenceMsg {
    Set {
        client_id: String,
        details: String,
        state: Option<String>,
        start_ms: Option<u64>,
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

pub fn set_presence(client_id: String, details: String, state: Option<String>, start_ms: Option<u64>) {
    if client_id.trim().is_empty() {
        return;
    }
    let _ = sender().send(PresenceMsg::Set { client_id, details, state, start_ms });
}

pub fn clear_presence() {
    let _ = sender().send(PresenceMsg::Clear);
}

struct Pending {
    client_id: String,
    payload: String,
}

fn run_loop(rx: mpsc::Receiver<PresenceMsg>) {
    let mut file: Option<std::fs::File> = None;
    let mut pending: Option<Pending> = None;
    let mut client_id = String::new();
    let mut last_beat = Instant::now() - HEARTBEAT_INTERVAL;
    let mut last_update = Instant::now() - UPDATE_INTERVAL;

    loop {
        // disabled until the first Set carries a client id
        if client_id.is_empty() {
            match rx.recv() {
                Ok(PresenceMsg::Set { client_id: id, details, state, start_ms }) => {
                    if id.trim().is_empty() {
                        continue;
                    }
                    client_id = id;
                    pending = Some(Pending {
                        client_id: client_id.clone(),
                        payload: build_activity(&details, state, start_ms),
                    });
                }
                Ok(PresenceMsg::Clear) => continue,
                Err(_) => return,
            }
        }

        // (re)connect
        if file.is_none() {
            match connect(&client_id) {
                Some(f) => {
                    last_beat = Instant::now();
                    last_update = Instant::now() - UPDATE_INTERVAL; // allow immediate set
                    file = Some(f);
                }
                None => {
                    // Discord is not running or the pipe is busy; retry later
                    pending = None;
                    std::thread::sleep(RECONNECT_DELAY);
                    continue;
                }
            }
        }
        let f = file.as_mut().unwrap();

        match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(PresenceMsg::Set { client_id: id, details, state, start_ms }) => {
                if id.trim() != client_id {
                    // id changed: drop the connection so the next loop re-handshakes
                    client_id = id;
                    file = None;
                    pending = None;
                    continue;
                }
                pending = Some(Pending {
                    client_id: client_id.clone(),
                    payload: build_activity(&details, state, start_ms),
                });
            }
            Ok(PresenceMsg::Clear) => {
                pending = Some(Pending { client_id: String::new(), payload: build_clear() });
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
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
            if p.client_id.is_empty() {
                // clear goes out immediately
                if write_frame(f, 1, p.payload.as_bytes()).is_ok() {
                    last_update = now;
                    client_id = String::new();
                    file = None; // re-handshake when presence returns
                } else {
                    file = None;
                }
                continue;
            }
            if now.duration_since(last_update) < UPDATE_INTERVAL {
                pending = Some(p);
            } else if write_frame(f, 1, p.payload.as_bytes()).is_err() {
                file = None;
                pending = Some(p);
                continue;
            } else {
                last_update = now;
            }
        }
    }
}

fn connect(client_id: &str) -> Option<std::fs::File> {
    for i in 0..10 {
        let path = format!(r"\\.\pipe\discord-ipc-{i}");
        if let Ok(mut f) = std::fs::OpenOptions::new().read(true).write(true).open(&path) {
            let handshake = format!(r#"{{"v":1,"client_id":"{client_id}"}}"#);
            if write_frame(&mut f, 0, handshake.as_bytes()).is_ok() {
                return Some(f);
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

fn build_activity(details: &str, state: Option<String>, start_ms: Option<u64>) -> String {
    let mut s = String::new();
    s.push_str("{\"cmd\":\"SET_ACTIVITY\",\"args\":{\"pid\":");
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
    s.push_str("}}");
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn activity_json_is_balanced() {
        let s = build_activity("Det \"quote\"", Some("St".into()), Some(1));
        assert_eq!(s.matches('{').count(), s.matches('}').count());
        assert!(s.contains("\"details\":\"Det \\\"quote\\\"\""));
        assert!(s.contains("\"timestamps\":{\"start\":1}"));
        let c = build_clear();
        assert_eq!(c.matches('{').count(), c.matches('}').count());
        assert!(c.contains("\"activity\":null"));
    }
}

fn build_clear() -> String {
    let mut s = String::new();
    s.push_str("{\"cmd\":\"SET_ACTIVITY\",\"args\":{\"pid\":");
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
