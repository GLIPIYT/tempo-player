use super::*;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

static SEQ: AtomicU64 = AtomicU64::new(0);

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "tempo_lyric_analysis_{}_{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[derive(Clone, Copy)]
enum Reply {
    Good,
    Corrupt,
    Oversized,
    OversizedChunked,
    Truncated,
    StallHeaders,
    StallBody,
}
struct Server {
    url: String,
    hits: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Server {
    fn new(reply: Reply) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let hits = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let thread_hits = hits.clone();
        let thread_stop = stop.clone();
        let thread = std::thread::spawn(move || {
            while !thread_stop.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let hits = thread_hits.clone();
                        std::thread::spawn(move || {
                            // Winsock accepted sockets can inherit nonblocking
                            // mode from the listener. Read a complete request.
                            stream.set_nonblocking(false).unwrap();
                            stream
                                .set_read_timeout(Some(Duration::from_secs(2)))
                                .unwrap();
                            let mut request = Vec::new();
                            while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n")
                                && request.len() < 8192
                            {
                                let mut buffer = [0u8; 1024];
                                let len = stream.read(&mut buffer).unwrap();
                                if len == 0 {
                                    break;
                                }
                                request.extend_from_slice(&buffer[..len]);
                            }
                            let line = String::from_utf8_lossy(&request);
                            if request.is_empty() {
                                return;
                            }
                            let path = line
                                .split_whitespace()
                                .nth(1)
                                .unwrap_or("")
                                .trim_start_matches('/');
                            hits.fetch_add(1, Ordering::SeqCst);
                            if matches!(reply, Reply::StallHeaders) {
                                std::thread::sleep(Duration::from_secs(1));
                            }
                            let mut body = fixture_bytes(path);
                            if matches!(reply, Reply::Corrupt) {
                                body[0] ^= 1;
                            }
                            if matches!(reply, Reply::Oversized | Reply::OversizedChunked) {
                                body.extend_from_slice(b"extra");
                            }
                            if matches!(reply, Reply::OversizedChunked) {
                                let _ = write!(stream, "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n", body.len());
                                let _ = stream.write_all(&body);
                                let _ = stream.write_all(b"\r\n0\r\n\r\n");
                                return;
                            }
                            let declared = body.len();
                            let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {declared}\r\nConnection: close\r\n\r\n");
                            if matches!(reply, Reply::Truncated | Reply::StallBody) {
                                let _ = stream.write_all(&body[..body.len() / 2]);
                                let _ = stream.flush();
                                if matches!(reply, Reply::StallBody) {
                                    std::thread::sleep(Duration::from_secs(1));
                                    let _ = stream.write_all(&body[body.len() / 2..]);
                                }
                            } else {
                                let _ = stream.write_all(&body);
                            }
                        });
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(2)),
                }
            }
        });
        Self {
            url,
            hits,
            stop,
            thread: Some(thread),
        }
    }
    async fn started(&self) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while self.hits.load(Ordering::SeqCst) == 0 {
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .unwrap();
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.thread.take().unwrap().join().unwrap();
    }
}
fn fixture_bytes(path: &str) -> Vec<u8> {
    format!("fixture bytes for {path}").into_bytes()
}
fn fixture_manifest() -> ModelManifest {
    ModelManifest {
        model_id: MODEL_ID.into(),
        revision: MODEL_REVISION.into(),
        files: MODEL_PATHS
            .iter()
            .map(|path| {
                let bytes = fixture_bytes(path);
                ManifestFile {
                    relative_path: (*path).into(),
                    size: bytes.len() as u64,
                    sha256: format!("{:x}", Sha256::digest(&bytes)),
                }
            })
            .collect(),
    }
}
fn manager(root: &Path, server: &Server, enabled: bool) -> Arc<ModelManager> {
    Arc::new(
        ModelManager::with_source(
            root.to_path_buf(),
            enabled,
            None,
            fixture_manifest(),
            server.url.clone(),
        )
        .unwrap(),
    )
}

#[tokio::test]
async fn ready_requires_every_verified_file_and_reuses_offline_artifacts() {
    let root = Temp::new();
    let server = Server::new(Reply::Good);
    let model = manager(&root.0, &server, true);
    let bundle = model.ensure_model().await.unwrap();
    assert_eq!(bundle.files.len(), 7);
    assert_eq!(model.status().phase, ModelPhase::Ready);
    for file in &bundle.files {
        assert_eq!(
            std::fs::read(&file.absolute_path).unwrap(),
            fixture_bytes(&file.relative_path)
        );
    }
    assert_eq!(model.status().loaded_bytes, model.status().total_bytes);
    assert_eq!(server.hits.load(Ordering::SeqCst), 7);
    model.ensure_model().await.unwrap();
    assert_eq!(server.hits.load(Ordering::SeqCst), 7);
    let second = manager(&root.0, &server, true);
    second.ensure_model().await.unwrap();
    assert_eq!(server.hits.load(Ordering::SeqCst), 7);
    std::fs::write(&bundle.files[6].absolute_path, b"bad").unwrap();
    second.ensure_model().await.unwrap();
    assert_eq!(server.hits.load(Ordering::SeqCst), 8);
}

#[tokio::test]
async fn concurrent_ensure_has_one_download_writer() {
    let root = Temp::new();
    let server = Server::new(Reply::Good);
    let model = manager(&root.0, &server, true);
    let (one, two, three) = futures_util::join!(
        model.ensure_model(),
        model.ensure_model(),
        model.ensure_model()
    );
    assert!(one.is_ok() && two.is_ok() && three.is_ok());
    assert_eq!(server.hits.load(Ordering::SeqCst), 7);
}

#[tokio::test]
async fn corrupt_oversized_and_truncated_downloads_are_never_published() {
    for reply in [
        Reply::Corrupt,
        Reply::Oversized,
        Reply::OversizedChunked,
        Reply::Truncated,
    ] {
        let root = Temp::new();
        let server = Server::new(reply);
        let model = manager(&root.0, &server, true);
        assert!(model.ensure_model().await.is_err());
        assert_eq!(model.status().phase, ModelPhase::Error);
        assert!(!model.directory().join("config.json").exists());
        assert!(!model.directory().join("config.json.part").exists());
    }
}

#[tokio::test]
async fn disable_interrupts_header_and_body_stalls_and_deletes_after_writer_closes() {
    for reply in [Reply::StallHeaders, Reply::StallBody] {
        let root = Temp::new();
        std::fs::write(root.0.join("unrelated"), b"keep").unwrap();
        let server = Server::new(reply);
        let model = manager(&root.0, &server, true);
        let writer = {
            let model = model.clone();
            tokio::spawn(async move { model.ensure_model().await })
        };
        server.started().await;
        if matches!(reply, Reply::StallBody) {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        let start = Instant::now();
        let state = model.set_enabled(false).await.unwrap();
        assert!(start.elapsed() < Duration::from_millis(500));
        assert!(!state.enabled);
        assert!(writer.await.unwrap().is_err());
        assert!(!model.directory().exists());
        assert!(root.0.join("unrelated").exists());
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(!model.directory().exists());
    }
}

#[tokio::test]
async fn enable_during_disable_cannot_resurrect_cancelled_download() {
    let root = Temp::new();
    let server = Server::new(Reply::StallBody);
    let model = manager(&root.0, &server, true);
    let writer = {
        let model = model.clone();
        tokio::spawn(async move { model.ensure_model().await })
    };
    server.started().await;
    let (disabled, enabled) =
        futures_util::join!(model.set_enabled(false), model.set_enabled(true));
    assert!(!disabled.unwrap().enabled);
    assert!(enabled.unwrap().enabled);
    assert!(writer.await.unwrap().is_err());
    assert_eq!(model.status().phase, ModelPhase::Absent);
    assert!(!model.directory().exists());
}

#[test]
fn paused_progress_publication_cannot_follow_a_newer_disabled_event() {
    use std::sync::mpsc;
    let root = Temp::new();
    let server = Server::new(Reply::Good);
    let mut model = ModelManager::with_source(
        root.0.clone(),
        true,
        None,
        fixture_manifest(),
        server.url.clone(),
    )
    .unwrap();
    std::fs::create_dir_all(model.directory()).unwrap();
    std::fs::write(model.directory().join("config.json.part"), b"partial").unwrap();
    let events = Arc::new(Mutex::new(Vec::<ModelState>::new()));
    let (paused_tx, paused_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let (disabled_tx, disabled_rx) = mpsc::channel();
    let release_rx = Mutex::new(release_rx);
    let captured = events.clone();
    model.publish = Arc::new(move |state| {
        if state.enabled && state.phase == ModelPhase::Downloading {
            paused_tx.send(()).unwrap();
            release_rx
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(2))
                .unwrap();
        }
        captured.lock().unwrap().push(state.clone());
        if !state.enabled {
            disabled_tx.send(()).unwrap();
        }
    });
    let model = Arc::new(model);
    let old_model = model.clone();
    let old = std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let _writer = old_model.writer.lock().await;
                old_model.update(0, ModelPhase::Downloading, 1, None);
            });
    });
    paused_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let disabling_model = model.clone();
    let disabling = std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(disabling_model.set_enabled(false))
            .unwrap()
    });
    // On the broken publisher, the old snapshot holds no publication gate:
    // make disable publish first, then release the paused old writer/event.
    // On the repaired publisher, disable cannot publish until that event exits.
    let unprotected = model.publication.try_lock().is_ok();
    if unprotected {
        disabled_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    }
    release_tx.send(()).unwrap();
    old.join().unwrap();
    let disabled = disabling.join().unwrap();
    assert!(!disabled.enabled);
    assert!(!model.directory().exists());
    let event_count = events.lock().unwrap().len();
    model.update(0, ModelPhase::Ready, model.status().total_bytes, None);
    assert_eq!(
        events.lock().unwrap().len(),
        event_count,
        "cancelled generation published ready"
    );
    let events = events.lock().unwrap();
    let first_disabled = events.iter().position(|state| !state.enabled).unwrap();
    assert!(
        events[first_disabled..].iter().all(|state| !state.enabled),
        "old enabled event followed a newer disabled event"
    );
    assert!(!events.last().unwrap().enabled);
    assert_eq!(events.last().unwrap().phase, ModelPhase::Absent);
}

#[tokio::test]
async fn disabled_ensure_does_not_fetch_or_create_directory() {
    let root = Temp::new();
    let server = Server::new(Reply::Good);
    let model = manager(&root.0, &server, false);
    assert!(model.ensure_model().await.is_err());
    assert_eq!(server.hits.load(Ordering::SeqCst), 0);
    assert!(!model.directory().exists());
}

#[tokio::test]
async fn aborted_caller_never_publishes_a_partial_file_and_a_new_manager_recovers() {
    let root = Temp::new();
    let stalled = Server::new(Reply::StallBody);
    let model = manager(&root.0, &stalled, true);
    let writer = {
        let model = model.clone();
        tokio::spawn(async move { model.ensure_model().await })
    };
    stalled.started().await;
    tokio::time::timeout(Duration::from_secs(2), async {
        while !model.directory().join("config.json.part").exists() {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
    writer.abort();
    assert!(writer.await.unwrap_err().is_cancelled());
    assert!(!model.directory().join("config.json").exists());
    let good = Server::new(Reply::Good);
    let restarted = manager(&root.0, &good, true);
    restarted.ensure_model().await.unwrap();
    assert!(!restarted.directory().join("config.json.part").exists());
    assert_eq!(restarted.status().phase, ModelPhase::Ready);
}

#[tokio::test]
async fn a_missing_last_artifact_keeps_ready_false_until_its_hash_is_verified() {
    let root = Temp::new();
    let server = Server::new(Reply::Corrupt);
    let model = manager(&root.0, &server, true);
    for path in &MODEL_PATHS[..6] {
        let path_on_disk = model.directory().join(path);
        std::fs::create_dir_all(path_on_disk.parent().unwrap()).unwrap();
        std::fs::write(path_on_disk, fixture_bytes(path)).unwrap();
    }
    assert!(model.ensure_model().await.is_err());
    assert_eq!(model.status().phase, ModelPhase::Error);
    assert_eq!(server.hits.load(Ordering::SeqCst), 1);
    assert!(!model.directory().join(MODEL_PATHS[6]).exists());
}

#[tokio::test]
async fn linked_dedicated_directory_is_rejected_without_deleting_the_external_target() {
    let root = Temp::new();
    let external = Temp::new();
    std::fs::write(external.0.join("keep"), b"outside").unwrap();
    let server = Server::new(Reply::Good);
    let model = manager(&root.0, &server, true);
    let link = root.0.join("lyrics-analysis-model");
    #[cfg(windows)]
    {
        let result = std::process::Command::new("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(&link)
            .arg(&external.0)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "junction fixture: {}",
            String::from_utf8_lossy(&result.stderr)
        );
    }
    #[cfg(unix)]
    std::os::unix::fs::symlink(&external.0, &link).unwrap();
    assert!(model.ensure_model().await.is_err());
    assert!(model.set_enabled(false).await.is_err());
    assert_eq!(model.status().phase, ModelPhase::Error);
    assert_eq!(std::fs::read(external.0.join("keep")).unwrap(), b"outside");
    assert_eq!(server.hits.load(Ordering::SeqCst), 0);
    #[cfg(windows)]
    std::fs::remove_dir(&link).unwrap();
    #[cfg(unix)]
    std::fs::remove_file(&link).unwrap();
}

#[test]
fn manifest_rejects_traversal_nonallowlisted_duplicate_and_missing_files() {
    for path in [
        "../config.json",
        "onnx/../../outside",
        "C:/outside",
        "onnx\\encoder_model_quantized.onnx",
        "onnx/extra.onnx",
    ] {
        let mut manifest = fixture_manifest();
        manifest.files[0].relative_path = path.into();
        assert!(validate_manifest(&manifest).is_err());
    }
    let mut manifest = fixture_manifest();
    manifest.files[0] = manifest.files[1].clone();
    assert!(validate_manifest(&manifest).is_err());
    manifest.files.pop();
    assert!(validate_manifest(&manifest).is_err());
}

fn wav(path: &Path, duration: u32) {
    let byte_count = duration * 16000 * 2;
    let mut file = std::fs::File::create(path).unwrap();
    file.write_all(b"RIFF").unwrap();
    file.write_all(&(36 + byte_count).to_le_bytes()).unwrap();
    file.write_all(b"WAVEfmt ").unwrap();
    file.write_all(&16u32.to_le_bytes()).unwrap();
    file.write_all(&1u16.to_le_bytes()).unwrap();
    file.write_all(&1u16.to_le_bytes()).unwrap();
    file.write_all(&16000u32.to_le_bytes()).unwrap();
    file.write_all(&32000u32.to_le_bytes()).unwrap();
    file.write_all(&2u16.to_le_bytes()).unwrap();
    file.write_all(&16u16.to_le_bytes()).unwrap();
    file.write_all(b"data").unwrap();
    file.write_all(&byte_count.to_le_bytes()).unwrap();
    file.write_all(&vec![0u8; byte_count as usize]).unwrap();
}
fn track(db: &Db, path: &Path, source: &str, source_id: Option<&str>) -> i64 {
    db.with_conn(|conn| {
        conn.execute("INSERT INTO tracks(path,title,duration_sec,added_at,source,external_id) VALUES(?1,'fixture',9999,0,?2,?3)", rusqlite::params![path.to_string_lossy(), source, source_id]).map_err(|e| e.to_string())?;
        Ok(conn.last_insert_rowid())
    }).unwrap()
}
fn audio_env(root: &Path) -> (Arc<Db>, AudioAnalysisStore, i64) {
    let db = Arc::new(Db::open_at(&root.join("tempo.db")).unwrap());
    let path = root.join("audio.wav");
    wav(&path, 20);
    let id = track(&db, &path, "local", None);
    let store = AudioAnalysisStore::new(db.clone(), root.join("sc"), root.join("yt"));
    (db, store, id)
}
fn fragment(start: f64, end: f64, words: Vec<AnalysisWord>) -> CompletedFragment {
    CompletedFragment {
        start_sec: start,
        end_sec: end,
        status: FragmentStatus::Completed,
        words,
    }
}
fn accepted(key: &str, source_end: f64, media_end: f64, offset: f64) -> CachedLyricMatches {
    CachedLyricMatches {
        source_lyric_key: key.into(),
        ends: vec![MatchedSourceEnd {
            line_index: 0,
            source_end_sec: source_end,
            matched_media_end_sec: media_end,
            offset_at_match_ms: offset,
            confidence: 0.95,
        }],
    }
}
#[test]
fn identity_uses_actual_audio_properties_and_rejects_unregistered_or_missing_files() {
    let root = Temp::new();
    let (_db, store, id) = audio_env(&root.0);
    let identity = store
        .audio_identity(Some(id), "local", None)
        .unwrap()
        .unwrap();
    assert_eq!(identity.duration_sec, 20.0);
    assert_eq!(identity.file_size, 640044);
    assert_eq!(identity.sample_rate, Some(16000));
    assert_eq!(identity.channels, Some(1));
    assert!(store
        .audio_identity(Some(id + 1000), "local", None)
        .unwrap()
        .is_none());
    assert!(store
        .audio_identity(Some(id), "youtube", Some("abcdefghijk"))
        .is_err());
    std::fs::remove_file(root.0.join("audio.wav")).unwrap();
    assert!(store
        .audio_identity(Some(id), "local", None)
        .unwrap()
        .is_none());
    assert!(store
        .merge(
            &identity.fingerprint,
            ALGORITHM_VERSION,
            MODEL_REVISION,
            Some(BpmEstimate {
                bpm: 120.0,
                confidence: 0.9
            }),
            None,
            None
        )
        .is_err());
}

#[test]
fn completed_empty_and_partial_fragments_and_provider_source_ends_survive_reopen() {
    let root = Temp::new();
    let (db, store, id) = audio_env(&root.0);
    let identity = store
        .audio_identity(Some(id), "local", None)
        .unwrap()
        .unwrap();
    let words = vec![AnalysisWord {
        text: "one".into(),
        start_sec: 12.0,
        end_sec: 14.0,
    }];
    store
        .merge(
            &identity.fingerprint,
            ALGORITHM_VERSION,
            MODEL_REVISION,
            Some(BpmEstimate {
                bpm: 120.0,
                confidence: 0.85,
            }),
            Some(fragment(11.0, 15.0, words)),
            Some(accepted("provider-a", 19.0, 14.0, -5000.0)),
        )
        .unwrap();
    store
        .merge(
            &identity.fingerprint,
            ALGORITHM_VERSION,
            MODEL_REVISION,
            None,
            Some(fragment(15.0, 20.0, vec![])),
            Some(accepted("provider-b", 12.0, 14.0, 2000.0)),
        )
        .unwrap();
    drop(store);
    drop(db);
    let db = Arc::new(Db::open_at(&root.0.join("tempo.db")).unwrap());
    let store = AudioAnalysisStore::new(db.clone(), root.0.join("sc"), root.0.join("yt"));
    let identity = store
        .audio_identity(Some(id), "local", None)
        .unwrap()
        .unwrap();
    let saved = store.get(&identity.fingerprint).unwrap().unwrap();
    assert_eq!(saved.fragments.len(), 2);
    assert!(saved.fragments[1].words.is_empty());
    assert_eq!(saved.fragments[0].words[0].end_sec, 14.0);
    assert_eq!(saved.bpm, Some(120.0));
    assert_eq!(saved.lyric_matches.len(), 2);
    let source_end = saved.lyric_matches[0].ends[0].source_end_sec;
    assert_eq!(source_end, 19.0);
    assert_eq!(source_end - 5.0, 14.0);
    assert_eq!(source_end - 4.0, 15.0);
    assert_eq!(saved.lyric_matches[1].ends[0].source_end_sec + 2.0, 14.0);
    assert_eq!(
        db.with_conn(|c| c
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .map_err(|e| e.to_string()))
            .unwrap(),
        19
    );
}

#[test]
fn accepted_source_end_may_exceed_duration_but_media_endpoint_must_be_bounded() {
    let root = Temp::new();
    let (_db, store, id) = audio_env(&root.0);
    let identity = store
        .audio_identity(Some(id), "local", None)
        .unwrap()
        .unwrap();
    let saved = store
        .merge(
            &identity.fingerprint,
            ALGORITHM_VERSION,
            MODEL_REVISION,
            None,
            None,
            Some(accepted("negative", 25.0, 20.0, -5000.0)),
        )
        .unwrap();
    assert_eq!(saved.lyric_matches[0].ends[0].source_end_sec, 25.0);
    for matches in [
        accepted("bad", 26.0, 21.0, -5000.0),
        accepted("bad", 9.0, 14.0, -5000.0),
        accepted("bad", 14.0, 14.0, f64::NAN),
    ] {
        assert!(store
            .merge(
                &identity.fingerprint,
                ALGORITHM_VERSION,
                MODEL_REVISION,
                None,
                None,
                Some(matches)
            )
            .is_err());
    }
}

#[test]
fn changed_size_mtime_and_versions_invalidate_asr_while_model_change_reuses_bpm() {
    let root = Temp::new();
    let (_db, store, id) = audio_env(&root.0);
    let first = store
        .audio_identity(Some(id), "local", None)
        .unwrap()
        .unwrap();
    store
        .merge(
            &first.fingerprint,
            ALGORITHM_VERSION,
            MODEL_REVISION,
            Some(BpmEstimate {
                bpm: 110.0,
                confidence: 0.8,
            }),
            Some(fragment(0.0, 5.0, vec![])),
            Some(accepted("provider", 4.0, 4.0, 0.0)),
        )
        .unwrap();
    let new_model = store
        .merge(
            &first.fingerprint,
            ALGORITHM_VERSION,
            "future-model",
            None,
            None,
            None,
        )
        .unwrap();
    assert_eq!(new_model.bpm, Some(110.0));
    assert!(new_model.fragments.is_empty());
    assert!(new_model.lyric_matches.is_empty());
    let replay = store.get(&first.fingerprint).unwrap().unwrap();
    assert_eq!(replay.model_revision, MODEL_REVISION);
    assert_eq!(replay.bpm, Some(110.0));
    assert!(replay.fragments.is_empty());
    store
        .merge(
            &first.fingerprint,
            ALGORITHM_VERSION,
            MODEL_REVISION,
            None,
            Some(fragment(0.0, 5.0, vec![])),
            None,
        )
        .unwrap();
    let new_algorithm = store
        .merge(
            &first.fingerprint,
            "future-algorithm",
            MODEL_REVISION,
            None,
            None,
            None,
        )
        .unwrap();
    assert!(new_algorithm.fragments.is_empty());
    assert_eq!(new_algorithm.bpm, None);
    std::thread::sleep(Duration::from_millis(20));
    wav(&root.0.join("audio.wav"), 20);
    assert!(store.get(&first.fingerprint).unwrap().is_none());
    assert!(store
        .merge(
            &first.fingerprint,
            ALGORITHM_VERSION,
            MODEL_REVISION,
            None,
            Some(fragment(0.0, 5.0, vec![])),
            None
        )
        .is_err());
    let second = store
        .audio_identity(Some(id), "local", None)
        .unwrap()
        .unwrap();
    assert_ne!(first.fingerprint, second.fingerprint);
    wav(&root.0.join("audio.wav"), 21);
    let third = store
        .audio_identity(Some(id), "local", None)
        .unwrap()
        .unwrap();
    assert_ne!(second.fingerprint, third.fingerprint);
    assert!(store.get(&third.fingerprint).unwrap().is_none());
}

#[test]
fn malformed_nonfinite_and_out_of_range_words_are_rejected_without_overwriting_cache() {
    let root = Temp::new();
    let (_db, store, id) = audio_env(&root.0);
    let identity = store
        .audio_identity(Some(id), "local", None)
        .unwrap()
        .unwrap();
    store
        .merge(
            &identity.fingerprint,
            ALGORITHM_VERSION,
            MODEL_REVISION,
            None,
            Some(fragment(0.0, 5.0, vec![])),
            None,
        )
        .unwrap();
    for (start, end, text) in [
        (f64::NAN, 2.0, "bad"),
        (1.0, f64::INFINITY, "bad"),
        (-1.0, 2.0, "bad"),
        (3.0, 2.0, "bad"),
        (1.0, 21.0, "bad"),
        (1.0, 2.0, ""),
    ] {
        assert!(store
            .merge(
                &identity.fingerprint,
                ALGORITHM_VERSION,
                MODEL_REVISION,
                None,
                Some(fragment(
                    0.0,
                    5.0,
                    vec![AnalysisWord {
                        text: text.into(),
                        start_sec: start,
                        end_sec: end
                    }]
                )),
                None
            )
            .is_err());
    }
    assert!(store
        .merge(
            "unissued",
            ALGORITHM_VERSION,
            MODEL_REVISION,
            None,
            Some(fragment(0.0, 5.0, vec![])),
            None
        )
        .is_err());
    assert_eq!(
        store
            .get(&identity.fingerprint)
            .unwrap()
            .unwrap()
            .fragments
            .len(),
        1
    );
}

#[test]
fn uncached_streams_return_none_and_cached_stream_lookup_is_exact_and_path_scoped() {
    let root = Temp::new();
    let (db, store, _id) = audio_env(&root.0);
    let sc = track(
        &db,
        Path::new("soundcloud://123"),
        "soundcloud",
        Some("123"),
    );
    let yt = track(
        &db,
        Path::new("youtube://abcdefghijk"),
        "youtube",
        Some("abcdefghijk"),
    );
    assert!(store
        .audio_identity(Some(sc), "soundcloud", Some("123"))
        .unwrap()
        .is_none());
    assert!(store
        .audio_identity(None, "youtube", Some("abcdefghijk"))
        .unwrap()
        .is_none());
    assert!(!root.0.join("sc").exists());
    assert!(!root.0.join("yt").exists());
    std::fs::create_dir_all(root.0.join("sc")).unwrap();
    std::fs::create_dir_all(root.0.join("yt")).unwrap();
    wav(&root.0.join("sc/123.mp3"), 20);
    wav(&root.0.join("yt/abcdefghijk-extra.wav"), 20);
    assert!(store
        .audio_identity(Some(yt), "youtube", Some("abcdefghijk"))
        .unwrap()
        .is_none());
    wav(&root.0.join("yt/abcdefghijk.wav"), 20);
    assert!(store
        .audio_identity(Some(sc), "soundcloud", Some("123"))
        .unwrap()
        .is_some());
    assert!(store
        .audio_identity(None, "youtube", Some("abcdefghijk"))
        .unwrap()
        .is_some());
    assert!(
        crate::soundcloud_store::existing_cached_file(&db, &root.0.join("sc"), "../123").is_err()
    );
}

#[test]
fn audio_size_duration_and_estimated_pcm_limits_precede_full_decode() {
    let root = Temp::new();
    let (db, store, _id) = audio_env(&root.0);
    let large = root.0.join("large.wav");
    wav(&large, 1);
    std::fs::OpenOptions::new()
        .write(true)
        .open(&large)
        .unwrap()
        .set_len(MAX_AUDIO_FILE_BYTES + 1)
        .unwrap();
    let large_id = track(&db, &large, "local", None);
    assert!(store
        .audio_identity(Some(large_id), "local", None)
        .unwrap()
        .is_none());
    let long = root.0.join("long.wav");
    wav(&long, 601);
    let long_id = track(&db, &long, "local", None);
    assert!(store
        .audio_identity(Some(long_id), "local", None)
        .unwrap()
        .is_none());
    let limit = root.0.join("limit.wav");
    wav(&limit, 600);
    let limit_id = track(&db, &limit, "local", None);
    assert!(store
        .audio_identity(Some(limit_id), "local", None)
        .unwrap()
        .is_some());
}

#[test]
fn estimated_pcm_guard_accepts_its_exact_limit_and_skips_unknown_or_over_budget_headers() {
    // 256s × 262144Hz × 1 channel × 4 bytes is exactly 256 MiB.
    // 600s × 48000Hz × 2 × 4 = 230400000; doubling the rate exceeds 256 MiB.
    for (seconds, rate, channels, expected) in [
        (256.0, Some(262144), Some(1), true),
        (256.0, Some(262145), Some(1), false),
        (600.0, Some(48000), Some(2), true),
        (600.0, Some(96000), Some(2), false),
        (601.0, Some(16000), Some(1), false),
        (20.0, None, Some(1), false),
        (20.0, Some(16000), None, false),
        (20.0, Some(0), Some(1), false),
        (20.0, Some(16000), Some(0), false),
        (f64::NAN, Some(16000), Some(1), false),
    ] {
        assert_eq!(
            audio_properties_within_limits(seconds, rate, channels),
            expected
        );
    }
}

#[test]
fn replacement_with_same_size_and_restored_mtime_rejects_the_previous_issued_identity() {
    let root = Temp::new();
    let (_db, store, id) = audio_env(&root.0);
    let identity = store
        .audio_identity(Some(id), "local", None)
        .unwrap()
        .unwrap();
    store
        .merge(
            &identity.fingerprint,
            ALGORITHM_VERSION,
            MODEL_REVISION,
            None,
            Some(fragment(0.0, 5.0, vec![])),
            None,
        )
        .unwrap();
    let path = root.0.join("audio.wav");
    let mtime = std::fs::metadata(&path).unwrap().modified().unwrap();
    std::thread::sleep(Duration::from_millis(20));
    let replacement = root.0.join("replacement.wav");
    wav(&replacement, 20);
    std::fs::File::options()
        .write(true)
        .open(&replacement)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(mtime))
        .unwrap();
    std::fs::remove_file(&path).unwrap();
    std::fs::rename(replacement, path).unwrap();
    assert!(store.get(&identity.fingerprint).unwrap().is_none());
    assert!(store
        .merge(
            &identity.fingerprint,
            ALGORITHM_VERSION,
            MODEL_REVISION,
            None,
            Some(fragment(0.0, 5.0, vec![])),
            None
        )
        .is_err());
    let replacement_identity = store
        .audio_identity(Some(id), "local", None)
        .unwrap()
        .unwrap();
    assert_ne!(replacement_identity.fingerprint, identity.fingerprint);
}

#[test]
fn migration19_reopen_is_idempotent_and_merges_do_not_lose_prior_lines_or_windows() {
    let root = Temp::new();
    let (db, store, id) = audio_env(&root.0);
    let identity = store
        .audio_identity(Some(id), "local", None)
        .unwrap()
        .unwrap();
    store
        .merge(
            &identity.fingerprint,
            ALGORITHM_VERSION,
            MODEL_REVISION,
            None,
            Some(fragment(0.0, 5.0, vec![])),
            Some(accepted("provider", 3.0, 3.0, 0.0)),
        )
        .unwrap();
    let mut second = accepted("provider", 7.0, 7.0, 0.0);
    second.ends[0].line_index = 1;
    store
        .merge(
            &identity.fingerprint,
            ALGORITHM_VERSION,
            MODEL_REVISION,
            None,
            Some(fragment(5.0, 10.0, vec![])),
            Some(second),
        )
        .unwrap();
    let saved = store
        .merge(
            &identity.fingerprint,
            ALGORITHM_VERSION,
            MODEL_REVISION,
            None,
            Some(fragment(
                0.0,
                5.0,
                vec![AnalysisWord {
                    text: "word".into(),
                    start_sec: 2.0,
                    end_sec: 3.0,
                }],
            )),
            None,
        )
        .unwrap();
    assert_eq!(saved.fragments.len(), 2);
    assert_eq!(saved.lyric_matches[0].ends.len(), 2);
    db.with_conn(|conn| {
        conn.execute_batch("PRAGMA user_version=18")
            .map_err(|e| e.to_string())
    })
    .unwrap();
    drop(store);
    drop(db);
    let db = Arc::new(Db::open_at(&root.0.join("tempo.db")).unwrap());
    let store = AudioAnalysisStore::new(db, root.0.join("sc"), root.0.join("yt"));
    let identity = store
        .audio_identity(Some(id), "local", None)
        .unwrap()
        .unwrap();
    let saved = store.get(&identity.fingerprint).unwrap().unwrap();
    assert_eq!(saved.fragments.len(), 2);
    assert_eq!(saved.fragments[0].words[0].text, "word");
    assert_eq!(saved.lyric_matches[0].ends.len(), 2);
}

#[test]
fn configured_soundcloud_cache_and_deleted_registration_are_rechecked_before_save() {
    let root = Temp::new();
    let (db, store, _id) = audio_env(&root.0);
    let configured = root.0.join("configured_sc");
    std::fs::create_dir(&configured).unwrap();
    db.set_app_setting("sc_cache_dir", configured.to_str().unwrap())
        .unwrap();
    let id = track(
        &db,
        Path::new("soundcloud://123"),
        "soundcloud",
        Some("123"),
    );
    wav(&configured.join("123.mp3"), 20);
    let identity = store
        .audio_identity(None, "soundcloud", Some("123"))
        .unwrap()
        .unwrap();
    assert_eq!(
        Path::new(&identity.absolute_path).parent().unwrap(),
        std::fs::canonicalize(&configured).unwrap()
    );
    db.with_conn(|conn| {
        conn.execute("DELETE FROM tracks WHERE id=?1", [id])
            .map(|_| ())
            .map_err(|e| e.to_string())
    })
    .unwrap();
    assert!(store
        .merge(
            &identity.fingerprint,
            ALGORITHM_VERSION,
            MODEL_REVISION,
            None,
            Some(fragment(0.0, 5.0, vec![])),
            None
        )
        .is_err());
}
