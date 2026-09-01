import io

p = 'src-tauri/src/discord.rs'
s = io.open(p, encoding='utf-8').read()

s = s.replace(
    "const RECONNECT_DELAY: Duration = Duration::from_secs(5);",
    "const RECONNECT_DELAY: Duration = Duration::from_secs(5);\n/// periodic resend heals any update discord silently dropped\nconst REFRESH_INTERVAL: Duration = Duration::from_secs(60);",
    1,
)

old = '''                Ok(PresenceMsg::Set { client_id: id, details, state, start_ms, large_image, small_image }) => {
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
                }'''
new = '''                Ok(PresenceMsg::Set { client_id: id, details, state, start_ms, end_ms, large_image, small_image }) => {
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
                            end_ms,
                            large_image.clone(),
                            small_image.clone(),
                            &nonce,
                        ),
                        nonce,
                    });
                    last_set = Some((details, state, start_ms, end_ms, large_image, small_image));
                }'''
assert old in s, 'initial recv'
s = s.replace(old, new, 1)

old = '''            Ok(PresenceMsg::Set { client_id: id, details, state, start_ms, large_image, small_image }) => {
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
            }'''
new = '''            Ok(PresenceMsg::Set { client_id: id, details, state, start_ms, end_ms, large_image, small_image }) => {
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
                        end_ms,
                        large_image.clone(),
                        small_image.clone(),
                        &nonce,
                    ),
                    nonce,
                });
                last_set = Some((details, state, start_ms, end_ms, large_image, small_image));
                error_retries = 0;
            }'''
assert old in s, 'recv_timeout'
s = s.replace(old, new, 1)

s = s.replace(
    """    let mut last_set: Option<(String, Option<String>, Option<u64>, Option<String>, Option<String>)> =
        None;""",
    """    let mut last_set: Option<(
        String,
        Option<String>,
        Option<u64>,
        Option<u64>,
        Option<String>,
        Option<String>,
    )> = None;""",
    1,
)

old = '''                if let Some((details, state, start_ms, large_image, small_image)) = &last_set {
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
                    }'''
new = '''                if let Some((details, state, start_ms, end_ms, large_image, small_image)) = &last_set {
                        let nonce = gen_nonce();
                        pending = Some(Pending {
                            client_id: client_id.clone(),
                            payload: build_activity(
                                details,
                                state.clone(),
                                *start_ms,
                                *end_ms,
                                large_image.clone(),
                                small_image.clone(),
                                &nonce,
                            ),
                            nonce,
                        });
                    }'''
assert old in s, 'retry'
s = s.replace(old, new, 1)

s = s.replace('''fn build_activity(
    details: &str,
    state: Option<String>,
    start_ms: Option<u64>,
    large_image: Option<String>,
    small_image: Option<String>,
    nonce: &str,
) -> String {''', '''fn build_activity(
    details: &str,
    state: Option<String>,
    start_ms: Option<u64>,
    end_ms: Option<u64>,
    large_image: Option<String>,
    small_image: Option<String>,
    nonce: &str,
) -> String {''', 1)

old = '''    if let Some(ms) = start_ms {
        s.push_str(&format!(",\\"timestamps\\":{{\\"start\\":{}}}}}", ms));
    }'''
new = '''    match (start_ms, end_ms) {
        (Some(st), Some(en)) => {
            s.push_str(&format!(",\\"timestamps\\":{{\\"start\\":{st},\\"end\\":{en}}}}}", st = st, en = en));
        }
        (Some(ms), None) => {
            s.push_str(&format!(",\\"timestamps\\":{{\\"start\\":{}}}}}", ms));
        }
        _ => {}
    }'''
assert old in s, 'timestamps'
s = s.replace(old, new, 1)

old = '''        let s = build_activity(
            "Det \\"quote\\"",
            Some("St".into()),
            Some(1),
            Some("mp:external/aGk".into()),
            Some("tempo_logo".into()),
            "n1",
        );'''
new = '''        let s = build_activity(
            "Det \\"quote\\"",
            Some("St".into()),
            Some(1),
            Some(181),
            Some("mp:external/aGk".into()),
            Some("tempo_logo".into()),
            "n1",
        );
        assert!(s.contains("\\"timestamps\\":{\\"start\\":1,\\"end\\":181}"));'''
assert old in s, 'test 1'
s = s.replace(old, new, 1)

s = s.replace('let no_assets = build_activity("D", None, None, None, None, "n");',
              'let no_assets = build_activity("D", None, None, None, None, None, "n");', 1)
s = s.replace('let a = build_activity("D", None, None, None, None, "a");',
              'let a = build_activity("D", None, None, None, None, None, "a");', 1)
s = s.replace('let b = build_activity("D", None, None, None, None, "b");',
              'let b = build_activity("D", None, None, None, None, None, "b");', 1)

old = '''        let now = Instant::now();
        if now.duration_since(last_beat) >= HEARTBEAT_INTERVAL {'''
new = '''        let now = Instant::now();
        // periodic resend: heals any update discord silently dropped
        if now.duration_since(last_refresh) >= REFRESH_INTERVAL {
            last_refresh = now;
            if let Some((details, state, start_ms, end_ms, large_image, small_image)) = &last_set {
                let nonce = gen_nonce();
                pending = Some(Pending {
                    client_id: client_id.clone(),
                    payload: build_activity(
                        details,
                        state.clone(),
                        *start_ms,
                        *end_ms,
                        large_image.clone(),
                        small_image.clone(),
                        &nonce,
                    ),
                    nonce,
                });
                last_sent_payload = None; // force the resend past the dedupe
            }
        }
        if now.duration_since(last_beat) >= HEARTBEAT_INTERVAL {'''
assert old in s, 'refresh insert'
s = s.replace(old, new, 1)
s = s.replace('''    let mut error_retries: u32 = 0;''',
              '''    let mut error_retries: u32 = 0;
    let mut last_refresh = Instant::now();''', 1)

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('discord.rs patched')
