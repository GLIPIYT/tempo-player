//! LRCLIB's public publish flow: request a one-use challenge, solve its
//! SHA-256 proof of work off the async executor, then publish lyrics.
//!
//! API references (checked 2026-09-26):
//! - https://github.com/tranxuanthang/lrclib/blob/main/ARCHITECTURE.md
//! - https://github.com/tranxuanthang/lrclib/blob/main/server/src/routes/request_challenge.rs
//! - https://github.com/tranxuanthang/lrclib/blob/main/server/src/routes/publish_lyrics.rs
//! - https://github.com/tranxuanthang/lrclib/blob/main/server/src/utils.rs

use std::error::Error;
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use reqwest::{redirect::Policy, Client, Response};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const CHALLENGE_URL: &str = "https://lrclib.net/api/request-challenge";
const PUBLISH_URL: &str = "https://lrclib.net/api/publish";
const CLIENT_ID: &str = concat!(
    "Tempo/",
    env!("CARGO_PKG_VERSION"),
    " (+https://github.com/GLIPIYT/tempo-player)"
);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
// Challenges expire after five minutes. Reserve time for the publish request
// and network variance rather than letting the solver use the entire TTL.
const PROOF_TIMEOUT: Duration = Duration::from_secs(4 * 60);

/// Body accepted by `POST /api/publish`.
///
/// LRCLIB requires the four metadata fields even when the album is unknown
/// (use an empty string in that case). At least one non-empty lyrics field is
/// required. `duration` is measured in seconds and must be between 1 and 3600.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LrclibPublishRequest {
    pub track_name: String,
    pub artist_name: String,
    pub album_name: String,
    pub duration: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plain_lyrics: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub synced_lyrics: Option<String>,
    /// Optional raw LRCLIB Lyricsfile YAML. Current LRCLIB prefers this over
    /// the legacy lyric fields when it is non-empty.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lyricsfile: Option<String>,
}

/// Challenge returned by `POST /api/request-challenge`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LrclibChallengeResponse {
    pub prefix: String,
    pub target: String,
}

/// LRCLIB's successful publish response is an empty `201 Created` body, so the
/// response DTO carries the verified HTTP status rather than invented fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LrclibPublishResponse {
    pub status: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LrclibPublishStage {
    Client,
    Challenge,
    ProofOfWork,
    Publish,
}

impl fmt::Display for LrclibPublishStage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Client => f.write_str("client setup"),
            Self::Challenge => f.write_str("challenge request"),
            Self::ProofOfWork => f.write_str("proof of work"),
            Self::Publish => f.write_str("lyrics submission"),
        }
    }
}

/// Stable error categories suitable for mapping to user-facing messages.
#[derive(Debug)]
pub enum LrclibPublishError {
    InvalidInput(&'static str),
    Timeout(LrclibPublishStage),
    Network {
        stage: LrclibPublishStage,
        message: String,
    },
    HttpStatus {
        stage: LrclibPublishStage,
        status: u16,
        retry_after_seconds: Option<u64>,
    },
    InvalidChallenge,
    ProofOfWorkExhausted,
    Cancelled,
    WorkerFailed,
}

impl fmt::Display for LrclibPublishError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidInput(message) => write!(f, "Invalid LRCLIB publish input: {message}"),
            Self::Timeout(stage) => write!(f, "LRCLIB {stage} timed out"),
            Self::Network { stage, message } => write!(f, "LRCLIB {stage} failed: {message}"),
            Self::HttpStatus {
                stage,
                status,
                retry_after_seconds,
            } => {
                if let Some(seconds) = retry_after_seconds {
                    write!(
                        f,
                        "LRCLIB {stage} returned HTTP {status} (retry after {seconds}s)"
                    )
                } else {
                    write!(f, "LRCLIB {stage} returned HTTP {status}")
                }
            }
            Self::InvalidChallenge => {
                f.write_str("LRCLIB returned an invalid proof-of-work challenge")
            }
            Self::ProofOfWorkExhausted => f.write_str("LRCLIB proof-of-work nonce space exhausted"),
            Self::Cancelled => f.write_str("LRCLIB proof-of-work was cancelled"),
            Self::WorkerFailed => f.write_str("LRCLIB proof-of-work worker failed"),
        }
    }
}

impl Error for LrclibPublishError {}

/// Validate fields that the LRCLIB endpoint requires before spending CPU on a
/// challenge. Album may be blank when unknown; duration must be 1–3600 seconds.
pub fn validate_publish_request(request: &LrclibPublishRequest) -> Result<(), LrclibPublishError> {
    if request.track_name.trim().is_empty() {
        return Err(LrclibPublishError::InvalidInput("trackName is required"));
    }
    if request.artist_name.trim().is_empty() {
        return Err(LrclibPublishError::InvalidInput("artistName is required"));
    }
    if !request.duration.is_finite() || !(1.0..=3600.0).contains(&request.duration) {
        return Err(LrclibPublishError::InvalidInput(
            "duration must be between 1 and 3600 seconds",
        ));
    }
    let has_lyrics = request
        .plain_lyrics
        .as_deref()
        .is_some_and(|text| !text.trim().is_empty())
        || request
            .synced_lyrics
            .as_deref()
            .is_some_and(|text| !text.trim().is_empty())
        || request
            .lyricsfile
            .as_deref()
            .is_some_and(|text| !text.trim().is_empty());
    if !has_lyrics {
        return Err(LrclibPublishError::InvalidInput(
            "plainLyrics, syncedLyrics, or lyricsfile is required",
        ));
    }
    Ok(())
}

/// Request a fresh challenge and publish the supplied lyrics.
///
/// The proof search runs on Tokio's blocking pool, never on the UI/event-loop
/// executor. Redirects are disabled so the one-use publish token cannot be
/// forwarded to another origin. Both HTTP requests have a bounded timeout.
pub async fn publish_lyrics(
    request: LrclibPublishRequest,
) -> Result<LrclibPublishResponse, LrclibPublishError> {
    validate_publish_request(&request)?;

    let client = Client::builder()
        .user_agent(CLIENT_ID)
        .redirect(Policy::none())
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| LrclibPublishError::Network {
            stage: LrclibPublishStage::Client,
            message: error.to_string(),
        })?;

    let challenge_response = client
        .post(CHALLENGE_URL)
        .header("Lrclib-Client", CLIENT_ID)
        .send()
        .await
        .map_err(|error| reqwest_error(LrclibPublishStage::Challenge, error))?;
    let challenge_response = require_success(challenge_response, LrclibPublishStage::Challenge)?;
    let challenge: LrclibChallengeResponse = challenge_response.json().await.map_err(|error| {
        if error.is_timeout() {
            LrclibPublishError::Timeout(LrclibPublishStage::Challenge)
        } else if error.is_decode() {
            LrclibPublishError::InvalidChallenge
        } else {
            reqwest_error(LrclibPublishStage::Challenge, error)
        }
    })?;
    let target = decode_target(&challenge.target)?;
    if challenge.prefix.is_empty() {
        return Err(LrclibPublishError::InvalidChallenge);
    }

    let prefix = challenge.prefix.clone();
    let deadline = Instant::now() + PROOF_TIMEOUT;
    let cancelled = Arc::new(AtomicBool::new(false));
    let worker_cancelled = Arc::clone(&cancelled);
    let _cancel_on_drop = CancelProofOnDrop(cancelled);
    let nonce = tokio::task::spawn_blocking(move || {
        solve_nonce(&prefix, &target, deadline, &worker_cancelled)
    })
    .await
    .map_err(|_| LrclibPublishError::WorkerFailed)??;
    let publish_token = format!("{}:{nonce}", challenge.prefix);

    let publish_response = client
        .post(PUBLISH_URL)
        .header("Lrclib-Client", CLIENT_ID)
        .header("X-Publish-Token", publish_token)
        .json(&request)
        .send()
        .await
        .map_err(|error| reqwest_error(LrclibPublishStage::Publish, error))?;
    let publish_response = require_success(publish_response, LrclibPublishStage::Publish)?;
    Ok(LrclibPublishResponse {
        status: publish_response.status().as_u16(),
    })
}

fn require_success(
    response: Response,
    stage: LrclibPublishStage,
) -> Result<Response, LrclibPublishError> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    Err(LrclibPublishError::HttpStatus {
        stage,
        status: status.as_u16(),
        retry_after_seconds: retry_after_seconds(&response),
    })
}

fn retry_after_seconds(response: &Response) -> Option<u64> {
    response
        .headers()
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .parse()
        .ok()
}

fn reqwest_error(stage: LrclibPublishStage, error: reqwest::Error) -> LrclibPublishError {
    if error.is_timeout() {
        LrclibPublishError::Timeout(stage)
    } else {
        LrclibPublishError::Network {
            stage,
            message: error.without_url().to_string(),
        }
    }
}

fn decode_target(target: &str) -> Result<[u8; 32], LrclibPublishError> {
    let bytes = target.as_bytes();
    if bytes.len() != 64 {
        return Err(LrclibPublishError::InvalidChallenge);
    }
    let mut decoded = [0_u8; 32];
    for (index, pair) in bytes.chunks_exact(2).enumerate() {
        let high = hex_nibble(pair[0]).ok_or(LrclibPublishError::InvalidChallenge)?;
        let low = hex_nibble(pair[1]).ok_or(LrclibPublishError::InvalidChallenge)?;
        decoded[index] = (high << 4) | low;
    }
    Ok(decoded)
}

struct CancelProofOnDrop(Arc<AtomicBool>);

impl Drop for CancelProofOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn solve_nonce(
    prefix: &str,
    target: &[u8; 32],
    deadline: Instant,
    cancelled: &AtomicBool,
) -> Result<String, LrclibPublishError> {
    let mut prefix_hash = Sha256::new();
    prefix_hash.update(prefix.as_bytes());
    let mut nonce_buffer = [0_u8; 20];
    let mut nonce = 0_u64;

    loop {
        // Check every 16k hashes to keep the inner SHA-256 loop inexpensive,
        // while still respecting the challenge TTL with a short cancellation lag.
        if nonce & 0x3fff == 0 && Instant::now() >= deadline {
            return Err(LrclibPublishError::Timeout(LrclibPublishStage::ProofOfWork));
        }
        if nonce & 0x3fff == 0 && cancelled.load(Ordering::Relaxed) {
            return Err(LrclibPublishError::Cancelled);
        }

        let nonce_bytes = write_decimal(nonce, &mut nonce_buffer);
        let mut hasher = prefix_hash.clone();
        hasher.update(nonce_bytes);
        let digest = hasher.finalize();
        if digest.as_slice() <= target.as_slice() {
            return String::from_utf8(nonce_bytes.to_vec())
                .map_err(|_| LrclibPublishError::WorkerFailed);
        }

        nonce = nonce
            .checked_add(1)
            .ok_or(LrclibPublishError::ProofOfWorkExhausted)?;
    }
}

fn write_decimal(mut value: u64, buffer: &mut [u8; 20]) -> &[u8] {
    let mut index = buffer.len();
    loop {
        index -= 1;
        buffer[index] = b'0' + (value % 10) as u8;
        value /= 10;
        if value == 0 {
            break;
        }
    }
    &buffer[index..]
}
