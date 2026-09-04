//! One-shot Discord IPC probe: handshake + a series of SET_ACTIVITY variants,
//! printing every reply so rejections are visible verbatim.
//! Run: cargo run --example discord_probe [client_id]

use std::io::Read;
use std::io::Write;

fn main() {
    let client_id = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "1543766505295183904".to_string());

    let mut file = None;
    for i in 0..10 {
        let path = format!(r"\\.\pipe\discord-ipc-{i}");
        match std::fs::OpenOptions::new().read(true).write(true).open(&path) {
            Ok(f) => {
                println!("[probe] connected to {path}");
                file = Some(f);
                break;
            }
            Err(e) => println!("[probe] {path}: {e}"),
        }
    }
    let mut f = file.expect("no discord pipe found - is the desktop discord running?");

    let hs = format!(r#"{{"v":1,"client_id":"{client_id}"}}"#);
    write_frame(&mut f, 0, hs.as_bytes()).expect("handshake write failed");
    println!("[probe] handshake sent: {hs}");
    match read_frame(&mut f) {
        Ok((op, s)) => println!("[probe] handshake reply op={op}: {}", shorten(&s)),
        Err(e) => println!("[probe] handshake read error: {e}"),
    }

    let pid = std::process::id();
    let start = 1735600000000u64;

    let cases: Vec<(&str, String)> = vec![
        (
            "A: no assets at all",
            format!(
                r#"{{"name":"Tempo","type":2,"details":"Probe A plain","state":"no assets","timestamps":{{"start":{start}}}}}"#
            ),
        ),
        (
            "B: large_image = tempo_logo asset",
            format!(
                r#"{{"name":"Tempo","type":2,"details":"Probe B asset","state":"tempo_logo","timestamps":{{"start":{start}}},"assets":{{"large_image":"tempo_logo","large_text":"Tempo"}}}}"#
            ),
        ),
        (
            "C: large_image = raw public url",
            format!(
                r#"{{"name":"Tempo","type":2,"details":"Probe C url","state":"raw url","timestamps":{{"start":{start}}},"assets":{{"large_image":"https://i1.sndcdn.com/artworks-000000000000-000000-t500x500.jpg","large_text":"Tempo"}}}}"#
            ),
        ),
        (
            "D: start+end timestamps",
            format!(
                r#"{{"name":"Tempo","type":2,"details":"Probe D timing","state":"start+end","timestamps":{{"start":{start},"end":{}}}}}"#
            , start + 180_000),
        ),
        // The cases below pin the field rules activity_args relies on. E must be
        // accepted and F..H must be rejected; if that ever flips, the presence
        // silently loses its artwork or its whole activity.
        (
            "E: assets with large_text OMITTED - accepted, and no caption line",
            format!(
                r#"{{"name":"Tempo","type":2,"details":"Probe E no large_text","state":"lyric line","timestamps":{{"start":{start}}},"assets":{{"large_image":"https://i1.sndcdn.com/artworks-000000000000-000000-t500x500.jpg"}}}}"#
            ),
        ),
        (
            "F: large_text = \"\" - must be REJECTED (why it cannot just be blanked)",
            format!(
                r#"{{"name":"Tempo","type":2,"details":"Probe F empty large_text","state":"lyric line","timestamps":{{"start":{start}}},"assets":{{"large_image":"tempo_logo","large_text":""}}}}"#
            ),
        ),
        (
            "G: one-char details - must be REJECTED (min length is 2)",
            r#"{"name":"Tempo","type":2,"details":"o","state":"lyric line"}"#.to_string(),
        ),
        (
            "H: one-char state - must be REJECTED (min length is 2)",
            r#"{"name":"Tempo","type":2,"details":"Probe H","state":"o"}"#.to_string(),
        ),
        (
            "I: one-char fields padded to two - accepted (the fix for G/H)",
            r#"{"name":"Tempo","type":2,"details":"o ","state":"o "}"#.to_string(),
        ),
        // J answers the one question the paired-lines design rests on. large_text
        // is the second text slot, but it lives inside `assets` next to the
        // artwork - so does it render on its own, with no large_image? That is the
        // normal case for the first seconds of a track, while the cover is still
        // uploading. If the reply is accepted but nothing appears in Discord,
        // pairing has to disable itself until artwork exists.
        (
            "J: assets with ONLY large_text, no large_image - does the second line render?",
            format!(
                r#"{{"name":"Tempo","type":2,"details":"Probe J no cover","state":"current line","timestamps":{{"start":{start}}},"assets":{{"large_text":"next line"}}}}"#
            ),
        ),
    ];

    for (label, activity) in cases {
        let nonce = format!(
            "{:x}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let frame = format!(
            r#"{{"cmd":"SET_ACTIVITY","nonce":"{nonce}","args":{{"pid":{pid},"activity":{activity}}}}}"#
        );
        write_frame(&mut f, 1, frame.as_bytes()).expect("set write failed");
        println!("[probe] ---- {label}");
        println!("[probe] sent: {}", shorten(&frame));
        match read_frame(&mut f) {
            Ok((op, s)) => println!("[probe] reply op={op}: {}", shorten(&s)),
            Err(e) => println!("[probe] read error: {e}"),
        }
        std::thread::sleep(std::time::Duration::from_secs(2));
    }

    // leave a clean presence behind
    let nonce = format!(
        "{:x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let clear = format!(
        r#"{{"cmd":"SET_ACTIVITY","nonce":"{nonce}","args":{{"pid":{pid},"activity":null}}}}"#
    );
    write_frame(&mut f, 1, clear.as_bytes()).expect("clear write failed");
    match read_frame(&mut f) {
        Ok((op, s)) => println!("[probe] clear reply op={op}: {}", shorten(&s)),
        Err(e) => println!("[probe] clear read error: {e}"),
    }
    println!("[probe] done");
}

fn shorten(s: &str) -> &str {
    if s.len() > 700 {
        &s[..700]
    } else {
        s
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

fn read_frame(f: &mut std::fs::File) -> std::io::Result<(u32, String)> {
    let mut header = [0u8; 8];
    f.read_exact(&mut header)?;
    let op = u32::from_le_bytes([header[0], header[1], header[2], header[3]]);
    let len = u32::from_le_bytes([header[4], header[5], header[6], header[7]]) as usize;
    let mut buf = vec![0u8; len];
    f.read_exact(&mut buf)?;
    Ok((op, String::from_utf8_lossy(&buf).into_owned()))
}
