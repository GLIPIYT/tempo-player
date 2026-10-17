//! Local-only PCM piece alignment and Opus finalization.
//!
//! Capture code writes one PCM WebM file per piece. This module decodes those
//! files sequentially to temporary 48 kHz stereo float PCM files, aligns only
//! neighboring pieces using their shared audio, blends the chosen seam, and
//! encodes a single Opus file. No input is opened through a network protocol.

use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const SAMPLE_RATE: u32 = 48_000;
const CHANNELS: u64 = 2;
const BYTES_PER_SAMPLE: u64 = 4;
const BYTES_PER_FRAME: u64 = CHANNELS * BYTES_PER_SAMPLE;
const MAX_PIECES: usize = 12;
const MAX_EXPECTED_DURATION_SECONDS: f64 = 24.0 * 60.0 * 60.0;
const MAX_MARKER_ERROR_SECONDS: f64 = 0.250;
const MAX_FIRST_MARKER_SECONDS: f64 = 0.010;
const MIN_PLANNED_OVERLAP_SECONDS: f64 = 0.050;
const MIN_ALIGNMENT_OVERLAP_SECONDS: f64 = 0.100;
const MAX_ALIGNMENT_SHIFT_SECONDS: f64 = 0.200;
const ALIGNMENT_WINDOW_SECONDS: f64 = 0.250;
const BLEND_MILLISECONDS: u64 = 8;
const IO_BUFFER_BYTES: usize = 64 * 1024;
const FFMPEG_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const FFMPEG_MAX_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(100);
const CORRELATION_STRIDE: usize = 4;

static JOIN_FFMPEG_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

/// One locally recorded PCM WebM piece and its planned/observed track interval.
#[derive(Clone, Debug)]
pub(crate) struct Piece {
    pub(crate) path: PathBuf,
    pub(crate) start: f64,
    pub(crate) end: f64,
    pub(crate) media_start: f64,
    pub(crate) media_end: f64,
}

/// Joins locally captured PCM pieces into one validated Opus 192 VBR file.
///
/// The destination must not exist. It is created only after the staged Opus
/// file passes a complete local decode and duration check. Cancellation kills
/// the current FFmpeg child and removes this call's staging and output files.
pub(crate) async fn join_pieces(
    pieces: &[Piece],
    expected_duration: f64,
    output: &Path,
    ffmpeg: &Path,
    cancelled: Arc<AtomicBool>,
    progress: Arc<dyn Fn(f64) + Send + Sync>,
) -> Result<(), String> {
    let pieces = pieces.to_vec();
    let output = output.to_path_buf();
    let ffmpeg = ffmpeg.to_path_buf();
    tokio::task::spawn_blocking(move || {
        join_blocking(
            &pieces,
            expected_duration,
            &output,
            &ffmpeg,
            cancelled,
            progress,
        )
    })
    .await
    .map_err(|error| format!("PCM join worker failed: {error}"))?
}

fn join_blocking(
    pieces: &[Piece],
    expected_duration: f64,
    output: &Path,
    ffmpeg: &Path,
    cancelled: Arc<AtomicBool>,
    progress: Arc<dyn Fn(f64) + Send + Sync>,
) -> Result<(), String> {
    let _ffmpeg_guard = JOIN_FFMPEG_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    validate_request(pieces, expected_duration, output, ffmpeg)?;
    check_cancelled(&cancelled)?;

    let output_parent = output
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let temp = TempDir::new(output_parent)?;
    let total_frames = duration_to_frames(expected_duration)?;
    let overall_budget =
        Duration::from_secs(((expected_duration * 3.0 + 90.0).ceil() as u64).clamp(120, 30 * 60));
    let deadline = Instant::now() + overall_budget;

    let mut decoded = Vec::with_capacity(pieces.len());
    for (index, piece) in pieces.iter().enumerate() {
        check_deadline(&cancelled, deadline)?;
        let raw_path = temp.path.join(format!("piece-{index:02}.f32le"));
        let log_path = temp.path.join(format!("decode-{index:02}.log"));
        decode_piece(
            ffmpeg,
            piece,
            &raw_path,
            &log_path,
            deadline,
            &cancelled,
            &progress,
            0.52 * index as f64 / pieces.len() as f64,
            0.52 * (index + 1) as f64 / pieces.len() as f64,
            (piece.media_end - piece.media_start) * SAMPLE_RATE as f64 * BYTES_PER_FRAME as f64,
        )?;
        let frames = validate_pcm_file(&raw_path, &cancelled)?;
        let actual_duration = frames as f64 / SAMPLE_RATE as f64;
        let marker_duration = piece.media_end - piece.media_start;
        if (actual_duration - marker_duration).abs() > 1.0 {
            return Err(format!(
                "PCM piece {} duration does not match its observed media interval",
                index + 1
            ));
        }
        decoded.push(DecodedPiece {
            path: raw_path,
            frames,
        });
    }

    check_deadline(&cancelled, deadline)?;
    let offsets = align_pieces(pieces, &decoded, &cancelled)?;
    report(&progress, 0.55);

    let joined_pcm = temp.path.join("joined.f32le");
    let output_frames = stitch_pieces(
        &decoded,
        &offsets,
        total_frames,
        &joined_pcm,
        &cancelled,
        &progress,
    )?;
    let duration_error = (output_frames as f64 / SAMPLE_RATE as f64 - expected_duration).abs();
    if duration_error > MAX_MARKER_ERROR_SECONDS {
        return Err(format!(
            "Joined PCM duration differs from the expected duration by {:.3} seconds",
            duration_error
        ));
    }
    report(&progress, 0.78);

    let staged_opus = temp.path.join("validated.opus");
    let encode_log = temp.path.join("encode.log");
    encode_opus(
        ffmpeg,
        &joined_pcm,
        expected_duration,
        &staged_opus,
        &encode_log,
        deadline,
        &cancelled,
        &progress,
    )?;
    let encoded_size = fs::metadata(&staged_opus)
        .map_err(|error| format!("Could not inspect the staged Opus file: {error}"))?
        .len();
    if encoded_size == 0 {
        return Err("FFmpeg produced an empty Opus file".into());
    }
    report(&progress, 0.90);

    let decoded_check = temp.path.join("validated-decode.f32le");
    let validate_log = temp.path.join("validate.log");
    decode_output_for_validation(
        ffmpeg,
        &staged_opus,
        &decoded_check,
        &validate_log,
        deadline,
        &cancelled,
        &progress,
    )?;
    let decoded_frames = validate_pcm_file(&decoded_check, &cancelled)?;
    let decoded_duration = decoded_frames as f64 / SAMPLE_RATE as f64;
    let decoded_duration_error = (decoded_duration - expected_duration).abs();
    if decoded_frames == 0 || decoded_duration_error > MAX_MARKER_ERROR_SECONDS {
        return Err(format!(
            "Encoded Opus duration is {:.3} seconds; expected {:.3} seconds",
            decoded_duration, expected_duration
        ));
    }
    report(&progress, 0.97);

    check_deadline(&cancelled, deadline)?;
    copy_validated_output(&staged_opus, output, &cancelled)?;
    report(&progress, 1.0);
    Ok(())
}

fn validate_request(
    pieces: &[Piece],
    expected_duration: f64,
    output: &Path,
    ffmpeg: &Path,
) -> Result<(), String> {
    if pieces.is_empty() || pieces.len() > MAX_PIECES {
        return Err(format!("Expected 1 to {MAX_PIECES} PCM pieces"));
    }
    if !expected_duration.is_finite()
        || expected_duration <= 0.0
        || expected_duration > MAX_EXPECTED_DURATION_SECONDS
    {
        return Err("Expected track duration is invalid".into());
    }
    if !ffmpeg.is_file() {
        return Err("The managed FFmpeg executable is unavailable".into());
    }
    if output.exists() {
        return Err("The Opus staging destination already exists".into());
    }
    let parent = output
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    if !parent.is_dir() {
        return Err("The Opus staging directory does not exist".into());
    }

    let expected_frames = duration_to_frames(expected_duration)?;
    for (index, piece) in pieces.iter().enumerate() {
        if !piece.path.is_file() {
            return Err(format!("PCM piece {} is not a local file", index + 1));
        }
        if !has_webm_signature(&piece.path)? {
            return Err(format!(
                "PCM piece {} is not a local WebM recording",
                index + 1
            ));
        }
        if !piece.start.is_finite()
            || !piece.end.is_finite()
            || !piece.media_start.is_finite()
            || !piece.media_end.is_finite()
            || piece.start < 0.0
            || piece.end <= piece.start
            || piece.end > expected_duration + MAX_MARKER_ERROR_SECONDS
            || piece.media_end <= piece.media_start
        {
            return Err(format!(
                "PCM piece {} has invalid timeline markers",
                index + 1
            ));
        }
        if (piece.start - piece.media_start).abs() > MAX_MARKER_ERROR_SECONDS
            || (piece.end - piece.media_end).abs() > MAX_MARKER_ERROR_SECONDS
        {
            return Err(format!(
                "PCM piece {} media markers do not cover its planned interval",
                index + 1
            ));
        }
        if index == 0 {
            if piece.start > MAX_FIRST_MARKER_SECONDS
                || piece.media_start.abs() > MAX_FIRST_MARKER_SECONDS
            {
                return Err("The first PCM piece does not cover the start of the track".into());
            }
        } else {
            let previous = &pieces[index - 1];
            let planned_overlap = previous.end - piece.start;
            let observed_overlap = previous.media_end - piece.media_start;
            if planned_overlap < MIN_PLANNED_OVERLAP_SECONDS
                || observed_overlap < MIN_PLANNED_OVERLAP_SECONDS
            {
                return Err(format!(
                    "PCM pieces {} and {} do not have a usable shared overlap",
                    index,
                    index + 1
                ));
            }
            if piece.start <= previous.start || piece.media_start <= previous.media_start {
                return Err("PCM pieces are not ordered by track position".into());
            }
        }
    }
    let last = pieces.last().expect("pieces were checked as non-empty");
    if (last.end - expected_duration).abs() > MAX_MARKER_ERROR_SECONDS
        || (last.media_end - expected_duration).abs() > MAX_MARKER_ERROR_SECONDS
    {
        return Err("The last PCM piece does not cover the expected track end".into());
    }
    if expected_frames == 0 {
        return Err("Expected track duration is too short to encode".into());
    }
    Ok(())
}

fn decode_piece(
    ffmpeg: &Path,
    piece: &Piece,
    output: &Path,
    log: &Path,
    deadline: Instant,
    cancelled: &AtomicBool,
    progress: &Arc<dyn Fn(f64) + Send + Sync>,
    progress_start: f64,
    progress_end: f64,
    estimated_output_bytes: f64,
) -> Result<(), String> {
    let mut command = Command::new(ffmpeg);
    command.args([
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-protocol_whitelist",
        "file",
        "-i",
    ]);
    command.arg(&piece.path);
    command.args([
        "-map",
        "0:a:0",
        "-vn",
        "-sn",
        "-dn",
        "-c:a",
        "pcm_f32le",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-f",
        "f32le",
        "-n",
    ]);
    command.arg(output);
    run_ffmpeg(
        &mut command,
        output,
        log,
        deadline,
        cancelled,
        "PCM decode",
        progress,
        progress_start,
        progress_end,
        estimated_output_bytes,
    )
}

fn encode_opus(
    ffmpeg: &Path,
    input: &Path,
    expected_duration: f64,
    output: &Path,
    log: &Path,
    deadline: Instant,
    cancelled: &AtomicBool,
    progress: &Arc<dyn Fn(f64) + Send + Sync>,
) -> Result<(), String> {
    let mut command = Command::new(ffmpeg);
    command.args([
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "f32le",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-protocol_whitelist",
        "file",
        "-i",
    ]);
    command.arg(input);
    command.args([
        "-map",
        "0:a:0",
        "-vn",
        "-sn",
        "-dn",
        "-c:a",
        "libopus",
        "-b:a",
        "192k",
        "-vbr",
        "on",
        "-compression_level",
        "10",
        "-application",
        "audio",
        "-frame_duration",
        "20",
        "-t",
    ]);
    command.arg(format!("{expected_duration:.6}"));
    command.args(["-f", "opus", "-n"]);
    command.arg(output);
    run_ffmpeg(
        &mut command,
        output,
        log,
        deadline,
        cancelled,
        "Opus encode",
        progress,
        0.78,
        0.90,
        expected_duration * 24_000.0,
    )
}

fn decode_output_for_validation(
    ffmpeg: &Path,
    input: &Path,
    output: &Path,
    log: &Path,
    deadline: Instant,
    cancelled: &AtomicBool,
    progress: &Arc<dyn Fn(f64) + Send + Sync>,
) -> Result<(), String> {
    let mut command = Command::new(ffmpeg);
    command.args([
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-protocol_whitelist",
        "file",
        "-i",
    ]);
    command.arg(input);
    command.args([
        "-map",
        "0:a:0",
        "-vn",
        "-sn",
        "-dn",
        "-c:a",
        "pcm_f32le",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-f",
        "f32le",
        "-n",
    ]);
    command.arg(output);
    run_ffmpeg(
        &mut command,
        output,
        log,
        deadline,
        cancelled,
        "Opus validation decode",
        progress,
        0.90,
        0.97,
        file_size(input) as f64 * 16.0,
    )
}

fn run_ffmpeg(
    command: &mut Command,
    progress_path: &Path,
    log_path: &Path,
    overall_deadline: Instant,
    cancelled: &AtomicBool,
    operation: &str,
    progress: &Arc<dyn Fn(f64) + Send + Sync>,
    progress_start: f64,
    progress_end: f64,
    estimated_output_bytes: f64,
) -> Result<(), String> {
    let log =
        File::create(log_path).map_err(|error| format!("Could not create FFmpeg log: {error}"))?;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(log));
    crate::child::quiet(command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start FFmpeg for {operation}: {error}"))?;
    let process_deadline = (Instant::now() + FFMPEG_MAX_TIMEOUT).min(overall_deadline);
    let mut last_progress = Instant::now();
    let mut observed_size = file_size(progress_path);

    loop {
        if cancelled.load(Ordering::Acquire) {
            terminate_child(&mut child);
            return Err("Audio processing was cancelled".into());
        }
        match child.try_wait() {
            Ok(Some(status)) if status.success() => {
                report(progress, progress_end);
                return Ok(());
            }
            Ok(Some(status)) => {
                let details = read_log_tail(log_path);
                return Err(if details.is_empty() {
                    format!("FFmpeg {operation} exited with {status}")
                } else {
                    format!("FFmpeg {operation} failed: {details}")
                });
            }
            Ok(None) => {}
            Err(error) => {
                terminate_child(&mut child);
                return Err(format!("Could not monitor FFmpeg {operation}: {error}"));
            }
        }

        let size = file_size(progress_path);
        if size > observed_size {
            observed_size = size;
            last_progress = Instant::now();
            let fraction = if estimated_output_bytes > 0.0 {
                (size as f64 / estimated_output_bytes).clamp(0.0, 0.99)
            } else {
                0.0
            };
            report(
                progress,
                progress_start + (progress_end - progress_start) * fraction,
            );
        }
        if Instant::now() >= process_deadline {
            terminate_child(&mut child);
            return Err(format!("FFmpeg {operation} exceeded its time budget"));
        }
        if last_progress.elapsed() >= FFMPEG_IDLE_TIMEOUT {
            terminate_child(&mut child);
            return Err(format!("FFmpeg {operation} stopped making progress"));
        }
        thread::sleep(PROCESS_POLL_INTERVAL);
    }
}

fn terminate_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn validate_pcm_file(path: &Path, cancelled: &AtomicBool) -> Result<u64, String> {
    let file = File::open(path).map_err(|error| format!("Could not open decoded PCM: {error}"))?;
    let size = file
        .metadata()
        .map_err(|error| format!("Could not inspect decoded PCM: {error}"))?
        .len();
    if size == 0 || size % BYTES_PER_FRAME != 0 {
        return Err("Decoded PCM is empty or has an incomplete sample frame".into());
    }

    let mut reader = BufReader::with_capacity(IO_BUFFER_BYTES, file);
    let mut bytes = vec![0u8; IO_BUFFER_BYTES];
    let mut carry = Vec::with_capacity(7);
    loop {
        if cancelled.load(Ordering::Acquire) {
            return Err("Audio processing was cancelled".into());
        }
        let count = reader
            .read(&mut bytes)
            .map_err(|error| format!("Could not validate decoded PCM: {error}"))?;
        if count == 0 {
            break;
        }
        let mut chunk = Vec::with_capacity(carry.len() + count);
        chunk.extend_from_slice(&carry);
        chunk.extend_from_slice(&bytes[..count]);
        let usable = chunk.len() - chunk.len() % BYTES_PER_SAMPLE as usize;
        for sample in chunk[..usable].chunks_exact(BYTES_PER_SAMPLE as usize) {
            let value = f32::from_le_bytes(sample.try_into().expect("four-byte sample"));
            if !value.is_finite() {
                return Err("Decoded PCM contains a non-finite audio sample".into());
            }
        }
        carry.clear();
        carry.extend_from_slice(&chunk[usable..]);
    }
    if !carry.is_empty() {
        return Err("Decoded PCM ends with a partial audio sample".into());
    }
    Ok(size / BYTES_PER_FRAME)
}

fn has_webm_signature(path: &Path) -> Result<bool, String> {
    let mut file = File::open(path)
        .map_err(|error| format!("Could not inspect local PCM recording: {error}"))?;
    let mut signature = [0u8; 4];
    file.read_exact(&mut signature)
        .map_err(|error| format!("Could not read local PCM recording header: {error}"))?;
    Ok(signature == [0x1a, 0x45, 0xdf, 0xa3])
}

#[derive(Debug)]
struct DecodedPiece {
    path: PathBuf,
    frames: u64,
}

fn align_pieces(
    pieces: &[Piece],
    decoded: &[DecodedPiece],
    cancelled: &AtomicBool,
) -> Result<Vec<i64>, String> {
    let mut offsets = Vec::with_capacity(pieces.len());
    offsets.push(0i64);
    for index in 1..pieces.len() {
        if cancelled.load(Ordering::Acquire) {
            return Err("Audio processing was cancelled".into());
        }
        let previous = &pieces[index - 1];
        let current = &pieces[index];
        let expected_delta = seconds_to_i64_frames(current.media_start - previous.media_start)?;
        let adjustment =
            estimate_neighbor_shift(&decoded[index - 1], &decoded[index], expected_delta)?;
        let offset = offsets[index - 1]
            .checked_add(expected_delta)
            .and_then(|value| value.checked_add(adjustment))
            .ok_or_else(|| "PCM piece timeline exceeds supported bounds".to_string())?;
        if offset <= offsets[index - 1] {
            return Err("Aligned PCM piece positions are not increasing".into());
        }
        offsets.push(offset);
    }
    Ok(offsets)
}

fn estimate_neighbor_shift(
    previous: &DecodedPiece,
    current: &DecodedPiece,
    expected_offset: i64,
) -> Result<i64, String> {
    let overlap_start = 0i64.max(-expected_offset);
    let overlap_end = (current.frames as i64).min(previous.frames as i64 - expected_offset);
    let overlap_frames = overlap_end - overlap_start;
    if overlap_frames < seconds_to_i64_frames(MIN_ALIGNMENT_OVERLAP_SECONDS)? {
        return Err("Neighboring PCM pieces have too little overlap to align".into());
    }

    let search_radius = seconds_to_i64_frames(MAX_ALIGNMENT_SHIFT_SECONDS)?
        .min(overlap_frames / 4)
        .max(CORRELATION_STRIDE as i64);
    let search_radius = search_radius / CORRELATION_STRIDE as i64 * CORRELATION_STRIDE as i64;
    let window_frames = seconds_to_i64_frames(ALIGNMENT_WINDOW_SECONDS)?
        .min(overlap_frames - 2 * search_radius)
        .max(1);
    if window_frames < seconds_to_i64_frames(0.050)? {
        return Err("Neighboring PCM overlap is too short for stable alignment".into());
    }

    let current_window_start = overlap_start + (overlap_frames - window_frames) / 2;
    let expected_previous_start = expected_offset + current_window_start;
    let previous_window_start = expected_previous_start - search_radius;
    let previous_window_frames = window_frames + 2 * search_radius;
    if previous_window_start < 0
        || previous_window_start + previous_window_frames > previous.frames as i64
        || current_window_start < 0
        || current_window_start + window_frames > current.frames as i64
    {
        return Err("Neighboring PCM overlap falls outside a recording".into());
    }

    let previous_samples = read_mono_window(
        &previous.path,
        previous_window_start as u64,
        previous_window_frames as u64,
        CORRELATION_STRIDE as u64,
    )?;
    let current_samples = read_mono_window(
        &current.path,
        current_window_start as u64,
        window_frames as u64,
        CORRELATION_STRIDE as u64,
    )?;
    let radius_sampled = search_radius as usize / CORRELATION_STRIDE;
    let coarse_window_len = current_samples.len();
    let mut best_shift = 0i64;
    let mut best_score = f64::NEG_INFINITY;
    let coarse_step =
        (SAMPLE_RATE as i64 / 6_000 / CORRELATION_STRIDE as i64).max(1) * CORRELATION_STRIDE as i64;
    let mut shift = -search_radius;
    while shift <= search_radius {
        let start = (radius_sampled as i64 + shift / CORRELATION_STRIDE as i64) as usize;
        if let Some(score) = normalized_correlation(
            &previous_samples[start..start + coarse_window_len],
            &current_samples,
        ) {
            if score > best_score + 1.0e-8
                || ((score - best_score).abs() <= 1.0e-8 && shift.abs() < best_shift.abs())
            {
                best_score = score;
                best_shift = shift;
            }
        }
        shift += coarse_step;
    }

    // Refine the coarse peak at one-sample resolution using the same bounded
    // overlap window. The sample arrays are still well below one MiB total.
    let previous_full = read_mono_window(
        &previous.path,
        previous_window_start as u64,
        previous_window_frames as u64,
        1,
    )?;
    let current_full = read_mono_window(
        &current.path,
        current_window_start as u64,
        window_frames as u64,
        1,
    )?;
    let coarse_refine_radius = coarse_step.min(32);
    let min_refine = (-search_radius).max(best_shift - coarse_refine_radius);
    let max_refine = search_radius.min(best_shift + coarse_refine_radius);
    let mut refined_shift = best_shift;
    let mut refined_score = f64::NEG_INFINITY;
    for candidate in min_refine..=max_refine {
        let start = (search_radius + candidate) as usize;
        if let Some(score) = normalized_correlation(
            &previous_full[start..start + current_full.len()],
            &current_full,
        ) {
            if score > refined_score + 1.0e-8
                || ((score - refined_score).abs() <= 1.0e-8
                    && candidate.abs() < refined_shift.abs())
            {
                refined_score = score;
                refined_shift = candidate;
            }
        }
    }

    let signal_level = rms(&current_full);
    if signal_level < 0.00001 {
        let previous_level = rms(&previous_full[radius_sampled * CORRELATION_STRIDE
            ..radius_sampled * CORRELATION_STRIDE + current_full.len()]);
        if previous_level < 0.00001 {
            // A quiet/silent shared region has no useful correlation signal.
            // The media markers still provide a safe alignment for silence.
            return Ok(0);
        }
        return Err("Neighboring PCM windows disagree around a silent segment".into());
    }
    if !refined_score.is_finite() || refined_score < 0.20 {
        return Err("Could not correlate the shared PCM audio between pieces".into());
    }
    Ok(refined_shift)
}

fn read_mono_window(
    path: &Path,
    first_frame: u64,
    frames: u64,
    stride: u64,
) -> Result<Vec<f64>, String> {
    let byte_offset = first_frame
        .checked_mul(BYTES_PER_FRAME)
        .ok_or_else(|| "PCM seek offset is out of range".to_string())?;
    let byte_count = frames
        .checked_mul(BYTES_PER_FRAME)
        .and_then(|count| usize::try_from(count).ok())
        .ok_or_else(|| "PCM correlation window is too large".to_string())?;
    let mut file =
        File::open(path).map_err(|error| format!("Could not read PCM piece: {error}"))?;
    file.seek(SeekFrom::Start(byte_offset))
        .map_err(|error| format!("Could not seek in PCM piece: {error}"))?;
    let mut bytes = vec![0u8; byte_count];
    file.read_exact(&mut bytes)
        .map_err(|error| format!("Could not read PCM overlap window: {error}"))?;
    let stride = usize::try_from(stride).unwrap_or(1).max(1);
    let mut values = Vec::with_capacity((frames as usize).div_ceil(stride));
    for frame in bytes.chunks_exact(BYTES_PER_FRAME as usize).step_by(stride) {
        let left = f32::from_le_bytes(frame[0..4].try_into().expect("left sample")) as f64;
        let right = f32::from_le_bytes(frame[4..8].try_into().expect("right sample")) as f64;
        if !left.is_finite() || !right.is_finite() {
            return Err("PCM overlap contains a non-finite audio sample".into());
        }
        values.push((left + right) * 0.5);
    }
    Ok(values)
}

fn normalized_correlation(left: &[f64], right: &[f64]) -> Option<f64> {
    if left.len() != right.len() || left.len() < 16 {
        return None;
    }
    let mean_left = left.iter().sum::<f64>() / left.len() as f64;
    let mean_right = right.iter().sum::<f64>() / right.len() as f64;
    let mut product = 0.0;
    let mut square_left = 0.0;
    let mut square_right = 0.0;
    for (&a, &b) in left.iter().zip(right) {
        let a = a - mean_left;
        let b = b - mean_right;
        product += a * b;
        square_left += a * a;
        square_right += b * b;
    }
    let denominator = (square_left * square_right).sqrt();
    (denominator > 1.0e-16).then_some(product / denominator)
}

fn rms(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    (values.iter().map(|value| value * value).sum::<f64>() / values.len() as f64).sqrt()
}

fn stitch_pieces(
    pieces: &[DecodedPiece],
    offsets: &[i64],
    max_frames: u64,
    output: &Path,
    cancelled: &AtomicBool,
    progress: &Arc<dyn Fn(f64) + Send + Sync>,
) -> Result<u64, String> {
    let first_frames = pieces[0].frames.min(max_frames);
    let mut joined = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(output)
        .map_err(|error| format!("Could not create joined PCM: {error}"))?;
    copy_pcm_range(&pieces[0].path, 0, first_frames, &mut joined, 0, cancelled)?;
    let mut output_end = first_frames as i64;

    for index in 1..pieces.len() {
        if cancelled.load(Ordering::Acquire) {
            return Err("Audio processing was cancelled".into());
        }
        let previous = &pieces[index - 1];
        let current = &pieces[index];
        let previous_offset = offsets[index - 1];
        let current_offset = offsets[index];
        let previous_end = previous_offset + previous.frames as i64;
        let current_end = current_offset + current.frames as i64;
        let overlap_start = previous_offset.max(current_offset);
        let overlap_end = previous_end.min(current_end);
        let overlap_frames = overlap_end - overlap_start;
        if overlap_frames < seconds_to_i64_frames(MIN_ALIGNMENT_OVERLAP_SECONDS)? {
            return Err("Aligned PCM pieces no longer have a usable overlap".into());
        }
        if current_offset > output_end {
            return Err("Aligned PCM pieces leave a gap in track coverage".into());
        }

        let seam = overlap_start + overlap_frames / 2;
        let blend_frames = (SAMPLE_RATE as u64 * BLEND_MILLISECONDS / 1_000) as i64;
        let blend_start = (seam - blend_frames / 2).max(overlap_start);
        let blend_end = (blend_start + blend_frames).min(overlap_end);
        if blend_end <= blend_start {
            return Err("PCM overlap is too short for the seam blend".into());
        }

        write_crossfade(
            &mut joined,
            previous,
            previous_offset,
            current,
            current_offset,
            blend_start,
            blend_end,
            cancelled,
        )?;

        let current_write_start = blend_end.max(current_offset);
        let current_write_end = current_end.min(max_frames as i64);
        if current_write_end > current_write_start {
            copy_pcm_range(
                &current.path,
                (current_write_start - current_offset) as u64,
                (current_write_end - current_write_start) as u64,
                &mut joined,
                current_write_start as u64,
                cancelled,
            )?;
        }
        output_end = output_end.max(current_end.min(max_frames as i64));
        report(
            progress,
            0.55 + 0.22 * index as f64 / (pieces.len() - 1) as f64,
        );
    }

    let output_frames = output_end.clamp(0, max_frames as i64) as u64;
    if output_frames == 0 {
        return Err("Joining PCM pieces produced no audio".into());
    }
    joined
        .set_len(output_frames * BYTES_PER_FRAME)
        .map_err(|error| format!("Could not trim joined PCM: {error}"))?;
    joined
        .sync_all()
        .map_err(|error| format!("Could not flush joined PCM: {error}"))?;
    Ok(output_frames)
}

fn write_crossfade(
    output: &mut File,
    previous: &DecodedPiece,
    previous_offset: i64,
    current: &DecodedPiece,
    current_offset: i64,
    start: i64,
    end: i64,
    cancelled: &AtomicBool,
) -> Result<(), String> {
    let frames =
        u64::try_from(end - start).map_err(|_| "Invalid PCM crossfade interval".to_string())?;
    let previous_data = read_pcm_frames(
        &previous.path,
        u64::try_from(start - previous_offset)
            .map_err(|_| "Invalid previous PCM crossfade position".to_string())?,
        frames,
    )?;
    let current_data = read_pcm_frames(
        &current.path,
        u64::try_from(start - current_offset)
            .map_err(|_| "Invalid current PCM crossfade position".to_string())?,
        frames,
    )?;
    let mut blended = Vec::with_capacity(previous_data.len());
    let denom = frames.saturating_sub(1).max(1) as f32;
    for frame in 0..frames as usize {
        if frame % 256 == 0 && cancelled.load(Ordering::Acquire) {
            return Err("Audio processing was cancelled".into());
        }
        let alpha = frame as f32 / denom;
        let base = frame * 2;
        blended.push(previous_data[base] * (1.0 - alpha) + current_data[base] * alpha);
        blended.push(previous_data[base + 1] * (1.0 - alpha) + current_data[base + 1] * alpha);
    }
    write_pcm_samples(output, start as u64, &blended)
}

fn copy_pcm_range(
    input: &Path,
    input_start_frame: u64,
    frames: u64,
    output: &mut File,
    output_start_frame: u64,
    cancelled: &AtomicBool,
) -> Result<(), String> {
    let byte_offset = input_start_frame
        .checked_mul(BYTES_PER_FRAME)
        .ok_or_else(|| "PCM input position is out of range".to_string())?;
    let byte_count = frames
        .checked_mul(BYTES_PER_FRAME)
        .ok_or_else(|| "PCM copy length is out of range".to_string())?;
    let output_offset = output_start_frame
        .checked_mul(BYTES_PER_FRAME)
        .ok_or_else(|| "PCM output position is out of range".to_string())?;
    let mut reader = File::open(input)
        .map(BufReader::new)
        .map_err(|error| format!("Could not open PCM piece for joining: {error}"))?;
    reader
        .seek(SeekFrom::Start(byte_offset))
        .map_err(|error| format!("Could not seek in PCM piece: {error}"))?;
    output
        .seek(SeekFrom::Start(output_offset))
        .map_err(|error| format!("Could not seek in joined PCM: {error}"))?;

    let mut remaining = byte_count;
    let mut buffer = vec![0u8; IO_BUFFER_BYTES];
    while remaining > 0 {
        if cancelled.load(Ordering::Acquire) {
            return Err("Audio processing was cancelled".into());
        }
        let count = remaining.min(buffer.len() as u64) as usize;
        reader
            .read_exact(&mut buffer[..count])
            .map_err(|error| format!("Could not read PCM piece: {error}"))?;
        output
            .write_all(&buffer[..count])
            .map_err(|error| format!("Could not write joined PCM: {error}"))?;
        remaining -= count as u64;
    }
    Ok(())
}

fn read_pcm_frames(path: &Path, first_frame: u64, frames: u64) -> Result<Vec<f32>, String> {
    let byte_offset = first_frame
        .checked_mul(BYTES_PER_FRAME)
        .ok_or_else(|| "PCM read position is out of range".to_string())?;
    let byte_count = frames
        .checked_mul(BYTES_PER_FRAME)
        .and_then(|count| usize::try_from(count).ok())
        .ok_or_else(|| "PCM read length is out of range".to_string())?;
    let mut file =
        File::open(path).map_err(|error| format!("Could not read PCM piece: {error}"))?;
    file.seek(SeekFrom::Start(byte_offset))
        .map_err(|error| format!("Could not seek in PCM piece: {error}"))?;
    let mut bytes = vec![0u8; byte_count];
    file.read_exact(&mut bytes)
        .map_err(|error| format!("Could not read PCM crossfade: {error}"))?;
    Ok(bytes
        .chunks_exact(4)
        .map(|sample| f32::from_le_bytes(sample.try_into().expect("four-byte sample")))
        .collect())
}

fn write_pcm_samples(output: &mut File, first_frame: u64, samples: &[f32]) -> Result<(), String> {
    let byte_offset = first_frame
        .checked_mul(BYTES_PER_FRAME)
        .ok_or_else(|| "PCM write position is out of range".to_string())?;
    output
        .seek(SeekFrom::Start(byte_offset))
        .map_err(|error| format!("Could not seek in joined PCM: {error}"))?;
    let mut writer = BufWriter::with_capacity(IO_BUFFER_BYTES, output);
    for sample in samples {
        writer
            .write_all(&sample.to_le_bytes())
            .map_err(|error| format!("Could not write the PCM seam blend: {error}"))?;
    }
    writer
        .flush()
        .map_err(|error| format!("Could not flush the PCM seam blend: {error}"))
}

fn copy_validated_output(
    source: &Path,
    destination: &Path,
    cancelled: &AtomicBool,
) -> Result<(), String> {
    let source_file = File::open(source)
        .map_err(|error| format!("Could not open the validated Opus file: {error}"))?;
    let mut reader = BufReader::with_capacity(IO_BUFFER_BYTES, source_file);
    let destination_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|error| format!("Could not create the Opus staging file: {error}"))?;
    let mut owned_output = OwnedOutput {
        path: destination.to_path_buf(),
        keep: false,
    };
    let mut writer = BufWriter::with_capacity(IO_BUFFER_BYTES, destination_file);
    let mut buffer = vec![0u8; IO_BUFFER_BYTES];
    loop {
        if cancelled.load(Ordering::Acquire) {
            return Err("Audio processing was cancelled".into());
        }
        let count = reader
            .read(&mut buffer)
            .map_err(|error| format!("Could not read the validated Opus file: {error}"))?;
        if count == 0 {
            break;
        }
        writer
            .write_all(&buffer[..count])
            .map_err(|error| format!("Could not write the Opus staging file: {error}"))?;
    }
    writer
        .flush()
        .map_err(|error| format!("Could not flush the Opus staging file: {error}"))?;
    writer
        .get_ref()
        .sync_all()
        .map_err(|error| format!("Could not sync the Opus staging file: {error}"))?;
    if cancelled.load(Ordering::Acquire) {
        return Err("Audio processing was cancelled".into());
    }
    owned_output.keep = true;
    Ok(())
}

struct OwnedOutput {
    path: PathBuf,
    keep: bool,
}

impl Drop for OwnedOutput {
    fn drop(&mut self) {
        if !self.keep {
            let _ = fs::remove_file(&self.path);
        }
    }
}

struct TempDir {
    path: PathBuf,
}

impl TempDir {
    fn new(parent: &Path) -> Result<Self, String> {
        for _ in 0..8 {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let path = parent.join(format!(".tempo-pcm-join-{}-{nonce:x}", std::process::id()));
            match fs::create_dir(&path) {
                Ok(()) => return Ok(Self { path }),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => {
                    return Err(format!(
                        "Could not create PCM join staging directory: {error}"
                    ))
                }
            }
        }
        Err("Could not allocate a unique PCM join staging directory".into())
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn duration_to_frames(seconds: f64) -> Result<u64, String> {
    let frames = seconds * SAMPLE_RATE as f64;
    if !frames.is_finite() || frames < 1.0 || frames > u64::MAX as f64 {
        return Err("Audio duration is outside supported bounds".into());
    }
    Ok(frames.round() as u64)
}

fn seconds_to_i64_frames(seconds: f64) -> Result<i64, String> {
    let frames = seconds * SAMPLE_RATE as f64;
    if !frames.is_finite() || frames < i64::MIN as f64 || frames > i64::MAX as f64 {
        return Err("PCM marker position is outside supported bounds".into());
    }
    Ok(frames.round() as i64)
}

fn check_cancelled(cancelled: &AtomicBool) -> Result<(), String> {
    if cancelled.load(Ordering::Acquire) {
        Err("Audio processing was cancelled".into())
    } else {
        Ok(())
    }
}

fn check_deadline(cancelled: &AtomicBool, deadline: Instant) -> Result<(), String> {
    check_cancelled(cancelled)?;
    if Instant::now() >= deadline {
        Err("Audio processing exceeded its time budget".into())
    } else {
        Ok(())
    }
}

fn report(progress: &Arc<dyn Fn(f64) + Send + Sync>, value: f64) {
    progress(value.clamp(0.0, 1.0));
}

fn file_size(path: &Path) -> u64 {
    fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0)
}

fn read_log_tail(path: &Path) -> String {
    let Ok(mut file) = File::open(path) else {
        return String::new();
    };
    let Ok(size) = file.metadata().map(|metadata| metadata.len()) else {
        return String::new();
    };
    let start = size.saturating_sub(4096);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return String::new();
    }
    let mut bytes = Vec::with_capacity((size - start) as usize);
    if file.read_to_end(&mut bytes).is_err() {
        return String::new();
    }
    String::from_utf8_lossy(&bytes).trim().to_string()
}
