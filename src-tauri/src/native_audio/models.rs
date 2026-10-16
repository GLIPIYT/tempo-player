use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_QUEUE_ITEMS: usize = 10_000;
pub const NATIVE_STATE_SETTING: &str = "native_audio_state_v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum RepeatMode {
    #[default]
    Off,
    One,
    All,
}

impl RepeatMode {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "off" => Some(Self::Off),
            "one" => Some(Self::One),
            "all" => Some(Self::All),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct NativeSettings {
    pub volume: f32,
    pub playback_rate: f32,
    pub preserve_pitch: bool,
    pub repeat: RepeatMode,
    pub shuffle: bool,
    pub crossfade_sec: f64,
    pub normalize: bool,
    pub equalizer_enabled: bool,
    pub equalizer_gains: [f64; 10],
    pub cache_before_play: bool,
    pub ytdlp_path: String,
}

impl Default for NativeSettings {
    fn default() -> Self {
        Self {
            volume: 0.8,
            playback_rate: 1.0,
            preserve_pitch: true,
            repeat: RepeatMode::Off,
            shuffle: false,
            crossfade_sec: 0.0,
            normalize: false,
            equalizer_enabled: false,
            equalizer_gains: [0.0; 10],
            cache_before_play: false,
            ytdlp_path: String::new(),
        }
    }
}

impl NativeSettings {
    pub fn normalized(mut self) -> Self {
        self.volume = finite_or_f32(self.volume, 0.8).clamp(0.0, 1.0);
        self.playback_rate = finite_or_f32(self.playback_rate, 1.0).clamp(0.5, 2.0);
        self.crossfade_sec = finite_or(self.crossfade_sec, 0.0).clamp(0.0, 12.0);
        for gain in &mut self.equalizer_gains {
            *gain = finite_or(*gain, 0.0).clamp(-18.0, 18.0);
        }
        self.ytdlp_path = self.ytdlp_path.trim().chars().take(2048).collect();
        self
    }
}

fn finite_or_f32(value: f32, fallback: f32) -> f32 {
    if value.is_finite() {
        value
    } else {
        fallback
    }
}

fn finite_or(value: f64, fallback: f64) -> f64 {
    if value.is_finite() {
        value
    } else {
        fallback
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct NativePersistedState {
    pub version: u32,
    pub initialized: bool,
    pub queue: super::queue::NativeQueue,
    pub settings: NativeSettings,
    pub position: f64,
    pub reservoir_revision: Option<i64>,
    pub reservoir_consumed: Vec<String>,
}

impl Default for NativePersistedState {
    fn default() -> Self {
        Self {
            version: 1,
            initialized: false,
            queue: super::queue::NativeQueue::default(),
            settings: NativeSettings::default(),
            position: 0.0,
            reservoir_revision: None,
            reservoir_consumed: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerSnapshot {
    pub current_track: Option<Value>,
    pub queue: Vec<Value>,
    pub queue_index: i64,
    pub is_playing: bool,
    pub position: f64,
    pub duration: f64,
    pub volume: f32,
    pub playback_rate: f32,
    pub preserve_pitch: bool,
    pub repeat: RepeatMode,
    pub shuffle: bool,
    pub buffer_pct: Option<f64>,
    pub buffering: bool,
    pub preparing: bool,
    pub version: u64,
    pub error: Option<String>,
    pub initialized: bool,
}

/// Validated access to the full frontend track object. The original JSON is
/// retained so optional provenance and metadata survive native round-trips.
#[derive(Debug, Clone)]
pub struct TrackPayload(pub Value);

impl TrackPayload {
    pub fn parse(value: Value) -> Result<Self, String> {
        let object = value.as_object().ok_or("track must be an object")?;
        let source = object
            .get("source")
            .and_then(Value::as_str)
            .ok_or("track source is missing")?;
        if !matches!(source, "local" | "soundcloud" | "youtube") {
            return Err(format!("unsupported audio source: {source}"));
        }
        let source_id = object
            .get("sourceId")
            .and_then(Value::as_str)
            .ok_or("track sourceId is missing")?;
        if source_id.is_empty() || source_id.len() > 230 || source_id.contains('\0') {
            return Err("invalid track sourceId".into());
        }
        if object.get("title").and_then(Value::as_str).is_none() {
            return Err("track title is missing".into());
        }
        if serde_json::to_vec(&value).map_err(|e| e.to_string())?.len() > 64 * 1024 {
            return Err("track payload exceeds 64 KiB".into());
        }
        Ok(Self(value))
    }

    pub fn string(&self, key: &str) -> Option<&str> {
        self.0.get(key).and_then(Value::as_str)
    }

    pub fn number(&self, key: &str) -> Option<f64> {
        self.0
            .get(key)
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
    }

    pub fn source(&self) -> &str {
        self.string("source").unwrap_or_default()
    }

    pub fn source_id(&self) -> &str {
        self.string("sourceId").unwrap_or_default()
    }

    pub fn identity_key(&self) -> String {
        format!("{}:{}", self.source(), self.source_id())
    }

    pub fn recommendation_key(&self) -> String {
        let id = if self.source() == "local" {
            self.0
                .get("dbId")
                .and_then(Value::as_i64)
                .map(|value| value.to_string())
                .unwrap_or_else(|| self.source_id().to_string())
        } else {
            self.source_id().to_string()
        };
        format!("{}:{id}", self.source())
    }

    /// Stable IDs and recommendation recording aliases used to avoid adding
    /// the same published recording twice from native autoplay.
    pub fn reservoir_keys(&self) -> Vec<String> {
        let mut keys = vec![self.identity_key(), self.recommendation_key()];
        if let Some(provenance) = self.0.get("provenance") {
            for field in ["recordingGroup", "recordingKey"] {
                if let Some(group) = provenance
                    .get(field)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    let key = format!("group:{group}");
                    if !keys.iter().any(|existing| existing == &key) {
                        keys.push(key);
                    }
                }
            }
        }
        keys
    }

    pub fn duration(&self) -> Option<f64> {
        // A zero duration is how some legacy/partial provider records encode
        // unknown length. Let the decoder report its probed duration instead.
        self.number("durationSec").filter(|value| *value > 0.0)
    }

    pub fn gain_db(&self, normalize: bool) -> f64 {
        if !normalize {
            return 0.0;
        }
        self.number("gainDb").unwrap_or(0.0).clamp(-36.0, 36.0)
    }
}
