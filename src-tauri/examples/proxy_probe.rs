//! Asks discord to proxy a list of image urls and prints the signed
//! mp:external reference for each, so the proxy can then be fetched directly.
//! Run: cargo run --example proxy_probe -- <url> [url...]

use std::io::Read;
use std::io::Write;

fn main() {
    let urls: Vec<String> = std::env::args().skip(1).collect();
    if urls.is_empty() {
        eprintln!("usage: proxy_probe <image-url> [more urls]");
        return;
    }
    let client_id = "1543766505295183904";
    let mut file = None;
    for i in 0..10 {
        let path = format!(r"\\.\pipe\discord-ipc-{i}");
        if let Ok(f) = std::fs::OpenOptions::new().read(true).write(true).open(&path) {
            file = Some(f);
            break;
        }
    }
    let mut f = file.expect("no discord pipe found");
    write_frame(&mut f, 0, format!(r#"{{"v":1,"client_id":"{client_id}"}}"#).as_bytes()).unwrap();
    let _ = read_frame(&mut f);

    let pid = std::process::id();
    for url in urls {
        let nonce = format!(
            "{:x}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let frame = format!(
            r#"{{"cmd":"SET_ACTIVITY","nonce":"{nonce}","args":{{"pid":{pid},"activity":{{"name":"Tempo","type":2,"details":"proxy probe","state":"checking","assets":{{"large_image":"{url}","large_text":"Tempo"}}}}}}}}"#
        );
        write_frame(&mut f, 1, frame.as_bytes()).unwrap();
        match read_frame(&mut f) {
            Ok((_, s)) => {
                let large = s
                    .split("\"large_image\":\"")
                    .nth(1)
                    .and_then(|rest| rest.split('"').next())
                    .unwrap_or("<none>");
                println!("SRC {url}");
                println!("REF {large}");
                if s.contains("\"evt\":\"ERROR\"") {
                    println!("ERR {s}");
                }
            }
            Err(e) => println!("read error: {e}"),
        }
        std::thread::sleep(std::time::Duration::from_millis(1500));
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
