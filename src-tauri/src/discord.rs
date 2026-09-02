//! Minimal Discord Rich Presence client over the local IPC named pipe.
//!
//! Single-threaded by design: on Windows a synchronous pipe handle serialises
//! I/O per file object, and `try_clone` duplicates the *same* file object, so a
//! blocking read on a helper thread makes the next `write_all` block forever -
//! the presence would appear once and then freeze. Replies are therefore
//! drained on the sending thread, and only when `PeekNamedPipe` reports bytes
//! are actually waiting.
//!
//! Every request carries a nonce; Discord rejects payloads without one.

use std::io::{Read, Write};
use std::sync::mpsc::{self, Sender};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

/// discord tolerates ~5 updates per 20s; the frontend paces real updates, this
/// is only a backstop so a buggy caller still cannot spam
const MIN_SEND_INTERVAL: Duration = Duration::from_secs(1);
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

type SetPayload = (
    String,
    Option<String>,
    Option<u64>,
    Option<u64>,
    Option<String>,
    Option<String>,
);

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

/// some discord builds reject an image url they cannot proxy; once that
/// happens, drop assets entirely so the activity itself still shows
static IMAGE_DISABLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn gen_nonce() -> String {
    format!(
        "{:x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    )
}

struct Conn {
    file: std::fs::File,
    handle: std::os::windows::io::RawHandle,
}

fn run_loop(rx: mpsc::Receiver<PresenceMsg>) {
    let mut conn: Option<Conn> = None;
    let mut client_id = String::new();
    // newest requested activity that has not been accepted yet
    let mut pending: Option<SetPayload> = None;
    let mut last_sent_args: Option<String> = None;
    let mut last_set: Option<SetPayload> = None;
    let mut last_sent_at = Instant::now() - MIN_SEND_INTERVAL;
    let mut last_refresh = Instant::now();
    let mut clear_requested = false;

    loop {
        // block until the first Set carries a client id (rpc disabled otherwise)
        if client_id.is_empty() {
            match rx.recv() {
                Ok(PresenceMsg::Set { client_id: id, details, state, start_ms, end_ms, large_image, small_image }) => {
                    if id.trim().is_empty() {
                        continue;
                    }
                    client_id = id;
                    pending = Some((details, state, start_ms, end_ms, large_image, small_image));
                }
                Ok(PresenceMsg::Clear) => continue,
                Err(_) => return,
            }
        }

        // drain everything queued so only the freshest activity goes out
        loop {
            match rx.try_recv() {
                Ok(PresenceMsg::Set { client_id: id, details, state, start_ms, end_ms, large_image, small_image }) => {
                    if id.trim() != client_id {
                        client_id = id;
                        conn = None; // re-handshake under the new application id
                        last_sent_args = None;
                    }
                    pending = Some((details, state, start_ms, end_ms, large_image, small_image));
                    clear_requested = false;
                }
                Ok(PresenceMsg::Clear) => {
                    pending = None;
                    last_set = None;
                    clear_requested = true;
                }
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => return,
            }
        }

        if conn.is_none() {
            match connect(&client_id) {
                Some(c) => {
                    conn = Some(c);
                    last_sent_args = None; // fresh session shows nothing yet
                    last_sent_at = Instant::now() - MIN_SEND_INTERVAL;
                }
                None => {
                    // discord is not running; keep the payload and retry so it
                    // goes out once discord appears instead of being lost
                    std::thread::sleep(RECONNECT_DELAY);
                    continue;
                }
            }
        }
        let c = conn.as_mut().unwrap();

        // read replies only when bytes are actually waiting: a blocking read on
        // this handle would stall the next write (see the module comment)
        match drain_replies(c) {
            Ok(rejected) => {
                if rejected {
                    last_sent_args = None;
                    pending = last_set.take().or(pending);
                }
            }
            Err(()) => {
                conn = None;
                continue;
            }
        }

        let now = Instant::now();
        if clear_requested {
            if send_frame(c, &wrap_set(&clear_args(), &gen_nonce())).is_err() {
                conn = None;
                continue;
            }
            clear_requested = false;
            client_id = String::new();
            last_sent_args = None;
            conn = None; // re-handshake when presence returns
            continue;
        }

        // periodic resend heals an update discord silently dropped
        if pending.is_none() && now.duration_since(last_refresh) >= REFRESH_INTERVAL {
            last_refresh = now;
            pending = last_set.clone();
            last_sent_args = None;
        }

        if let Some(payload) = pending.take() {
            let args = build_args(&payload);
            if last_sent_args.as_deref() == Some(args.as_str()) {
                last_set = Some(payload);
                continue; // identical to what discord already shows
            }
            if now.duration_since(last_sent_at) < MIN_SEND_INTERVAL {
                pending = Some(payload);
                std::thread::sleep(Duration::from_millis(120));
                continue;
            }
            if send_frame(c, &wrap_set(&args, &gen_nonce())).is_err() {
                conn = None;
                pending = Some(payload);
                continue;
            }
            last_sent_at = Instant::now();
            last_sent_args = Some(args);
            last_set = Some(payload);
            last_refresh = Instant::now();
            continue;
        }

        std::thread::sleep(Duration::from_millis(120));
    }
}

/// Builds the SET_ACTIVITY args, honouring the image-rejected fallback.
fn build_args(p: &SetPayload) -> String {
    let (details, state, start_ms, end_ms, large_image, small_image) = p;
    let drop_images = std::sync::atomic::AtomicBool::load(
        &IMAGE_DISABLED,
        std::sync::atomic::Ordering::Relaxed,
    );
    activity_args(
        details,
        state.clone(),
        *start_ms,
        *end_ms,
        if drop_images { None } else { large_image.clone() },
        if drop_images { None } else { small_image.clone() },
    )
}

fn send_frame(c: &mut Conn, payload: &str) -> Result<(), ()> {
    write_frame(&mut c.file, 1, payload.as_bytes()).map_err(|_| ())
}

/// Reads any replies already buffered in the pipe. Returns whether discord
/// rejected the last activity; `Err(())` means the connection is dead.
fn drain_replies(c: &mut Conn) -> Result<bool, ()> {
    let mut rejected = false;
    loop {
        let waiting = peek_available(c.handle)?;
        if waiting < 8 {
            return Ok(rejected);
        }
        let mut header = [0u8; 8];
        if c.file.read_exact(&mut header).is_err() {
            return Err(());
        }
        let len = u32::from_le_bytes([header[4], header[5], header[6], header[7]]) as usize;
        let mut body = vec![0u8; len];
        if len > 0 && c.file.read_exact(&mut body).is_err() {
            return Err(());
        }
        let text = String::from_utf8_lossy(&body);
        if text.contains("\"evt\":\"ERROR\"") {
            #[cfg(debug_assertions)]
            eprintln!("[tempo discord] rejected: {}", &text[..text.len().min(300)]);
            rejected = true;
            // an image url discord cannot proxy fails the whole activity;
            // remember it and retry without assets
            if text.contains("large_image") || text.contains("mp:external") {
                std::sync::atomic::AtomicBool::store(
                    &IMAGE_DISABLED,
                    true,
                    std::sync::atomic::Ordering::Relaxed,
                );
            }
        }
    }
}

/// Bytes currently readable from the pipe without blocking.
fn peek_available(handle: std::os::windows::io::RawHandle) -> Result<u32, ()> {
    #[link(name = "kernel32")]
    extern "system" {
        fn PeekNamedPipe(
            handle: std::os::windows::io::RawHandle,
            buffer: *mut u8,
            buffer_size: u32,
            bytes_read: *mut u32,
            total_bytes_avail: *mut u32,
            bytes_left_this_message: *mut u32,
        ) -> i32;
    }
    let mut avail: u32 = 0;
    let ok = unsafe {
        PeekNamedPipe(
            handle,
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            &mut avail,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(());
    }
    Ok(avail)
}

fn connect(client_id: &str) -> Option<Conn> {
    use std::os::windows::io::AsRawHandle;
    for i in 0..10 {
        let path = format!(r"\\.\pipe\discord-ipc-{i}");
        if let Ok(mut f) = std::fs::OpenOptions::new().read(true).write(true).open(&path) {
            let handshake = format!(r#"{{"v":1,"client_id":"{client_id}"}}"#);
            if write_frame(&mut f, 0, handshake.as_bytes()).is_ok() {
                #[cfg(debug_assertions)]
                eprintln!("[tempo discord] connected to {path}");
                let handle = f.as_raw_handle();
                return Some(Conn { file: f, handle });
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
            s.push_str(&format!(",\"timestamps\":{{\"start\":{st},\"end\":{en}}}"));
        }
        (Some(ms), None) => {
            s.push_str(&format!(",\"timestamps\":{{\"start\":{ms}}}"));
        }
        _ => {}
    }
    let has_large = large_image.as_deref().map(|v| !v.trim().is_empty()).unwrap_or(false);
    if has_large {
        // large_text must not be an empty string - discord rejects the whole
        // activity with "large_text is not allowed to be empty"
        s.push_str(",\"assets\":{\"large_image\":\"");
        s.push_str(&json_escape(large_image.as_deref().unwrap_or("")));
        s.push_str("\",\"large_text\":\"Tempo\"");
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

fn write_frame(f: &mut std::fs::File, op: u32, payload: &[u8]) -> std::io::Result<()> {
    let mut buf = Vec::with_capacity(8 + payload.len());
    buf.extend_from_slice(&op.to_le_bytes());
    buf.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    buf.extend_from_slice(payload);
    f.write_all(&buf)?;
    f.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn activity_frame_is_valid_json() {
        let args = activity_args(
            "Det \"quote\"",
            Some("St".into()),
            Some(1),
            Some(181),
            Some("https://example.com/a.png".into()),
            Some("tempo_logo".into()),
        );
        let frame = wrap_set(&args, "n1");
        let parsed: serde_json::Value =
            serde_json::from_str(&frame).expect("SET_ACTIVITY frame must be valid json");
        let activity = &parsed["args"]["activity"];
        assert_eq!(activity["details"], "Det \"quote\"");
        assert_eq!(activity["state"], "St");
        assert_eq!(activity["timestamps"]["start"], 1);
        assert_eq!(activity["timestamps"]["end"], 181);
        // assets must sit INSIDE activity, and large_text must be non-empty -
        // discord rejects the whole payload otherwise
        assert_eq!(activity["assets"]["large_image"], "https://example.com/a.png");
        assert_eq!(activity["assets"]["large_text"], "Tempo");
        assert_eq!(activity["assets"]["small_image"], "tempo_logo");
        assert_eq!(parsed["cmd"], "SET_ACTIVITY");
        assert_eq!(parsed["nonce"], "n1");

        let no_assets = activity_args("D", None, None, None, None, None);
        assert!(!no_assets.contains("assets"));
        let paused: serde_json::Value =
            serde_json::from_str(&wrap_set(&no_assets, "n2")).unwrap();
        assert!(paused["args"]["activity"]["timestamps"].is_null());
    }

    #[test]
    fn clear_frame_is_valid_json() {
        let parsed: serde_json::Value =
            serde_json::from_str(&wrap_set(&clear_args(), "cn")).unwrap();
        assert!(parsed["args"]["activity"].is_null());
        assert_eq!(parsed["nonce"], "cn");
    }

    #[test]
    fn nonce_is_not_part_of_dedup() {
        // dedup compares the nonce-free args, so identical content must yield
        // an identical string while the wrapped frames still differ
        let a = activity_args("D", None, None, None, None, None);
        let b = activity_args("D", None, None, None, None, None);
        assert_eq!(a, b);
        assert_ne!(wrap_set(&a, "x"), wrap_set(&b, "y"));
    }

    #[test]
    fn long_fields_are_truncated_on_char_boundary() {
        let long = "ы".repeat(200); // 400 bytes of utf-8
        let args = activity_args(&long, Some(long.clone()), None, None, None, None);
        let parsed: serde_json::Value = serde_json::from_str(&wrap_set(&args, "n")).unwrap();
        let details = parsed["args"]["activity"]["details"].as_str().unwrap();
        assert!(details.len() <= FIELD_MAX_BYTES);
        assert!(!details.contains('\u{fffd}')); // no replacement char from a bad cut
    }
}

