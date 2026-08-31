//! One-shot Discord IPC probe: handshake + SET_ACTIVITY, printing every reply.
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
    let nonce = format!("{:x}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos());
    let activity = format!(
        r#"{{"cmd":"SET_ACTIVITY","nonce":"{nonce}","args":{{"pid":{pid},"activity":{{"name":"Tempo","type":2,"details":"Probe details","state":"probe state","timestamps":{{"start":1735600000000}}}}}}}}"#
    );
    write_frame(&mut f, 1, activity.as_bytes()).expect("set write failed");
    println!("[probe] set sent");
    match read_frame(&mut f) {
        Ok((op, s)) => println!("[probe] set reply op={op}: {}", shorten(&s)),
        Err(e) => println!("[probe] set read error: {e}"),
    }

    std::thread::sleep(std::time::Duration::from_secs(5));
    println!("[probe] done - check discord now");
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
