use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};

const FFT_SIZE: usize = 1024;
const RING_CAPACITY: usize = 4096;
const NUM_BINS: usize = 64;
const MIN_FREQ_HZ: f32 = 50.0;
const ANALYSIS_MIN_DB: f32 = -85.0;
const ANALYSIS_MAX_DB: f32 = -15.0;

pub(super) struct SpectrumBuffer {
    samples: [AtomicU32; RING_CAPACITY],
    written: AtomicU64,
    pub enabled: AtomicBool,
    sample_rate: AtomicU32,
    fft: Arc<dyn Fft<f32>>,
    visual: Mutex<VisualState>,
}

struct VisualState {
    magnitudes: [f32; FFT_SIZE / 2],
    bins: Vec<f32>,
    written: u64,
    at: Option<Instant>,
    last_sample_at: Option<Instant>,
    sample_rate: u32,
}

impl SpectrumBuffer {
    pub fn new() -> Arc<Self> {
        let mut planner = FftPlanner::<f32>::new();
        Arc::new(Self {
            samples: std::array::from_fn(|_| AtomicU32::new(0)),
            written: AtomicU64::new(0),
            enabled: AtomicBool::new(false),
            sample_rate: AtomicU32::new(48_000),
            fft: planner.plan_fft_forward(FFT_SIZE),
            visual: Mutex::new(VisualState {
                magnitudes: [0.0; FFT_SIZE / 2],
                bins: vec![0.0; NUM_BINS],
                written: 0,
                at: None,
                last_sample_at: None,
                sample_rate: 48_000,
            }),
        })
    }

    pub fn push(&self, sample: f32, sample_rate: u32) {
        self.sample_rate.store(sample_rate, Ordering::Relaxed);
        // The single output callback publishes a complete sample before its
        // index. FFT readers cannot make the callback drop chunks of audio.
        let written = self.written.load(Ordering::Relaxed);
        self.samples[written as usize % RING_CAPACITY].store(sample.to_bits(), Ordering::Relaxed);
        self.written
            .store(written.wrapping_add(1), Ordering::Release);
    }

    fn transformed_snapshot(&self, blackman: bool) -> Option<(Vec<Complex<f32>>, u32, u64)> {
        if !self.enabled.load(Ordering::Acquire) {
            return None;
        }
        let written = self.written.load(Ordering::Acquire);
        if written < FFT_SIZE as u64 {
            return None;
        }
        let sample_rate = self.sample_rate.load(Ordering::Relaxed);
        let snapshot = (written - FFT_SIZE as u64..written)
            .map(|index| {
                f32::from_bits(self.samples[index as usize % RING_CAPACITY].load(Ordering::Relaxed))
            })
            .collect::<Vec<_>>();
        // If this reader was descheduled long enough for the window to be
        // overwritten, retain the last display frame rather than emit a spike.
        if self.written.load(Ordering::Acquire).saturating_sub(written)
            > (RING_CAPACITY - FFT_SIZE) as u64
        {
            return None;
        }

        let mut values = snapshot
            .into_iter()
            .enumerate()
            .map(|(index, sample)| {
                let phase = 2.0 * std::f32::consts::PI * index as f32 / FFT_SIZE as f32;
                let window = if blackman {
                    0.42 - 0.5 * phase.cos() + 0.08 * (2.0 * phase).cos()
                } else {
                    0.5 * (1.0 - phase.cos())
                };
                Complex::new(sample * window, 0.0)
            })
            .collect::<Vec<_>>();
        self.fft.process(&mut values);
        Some((values, sample_rate, written))
    }

    pub fn bins(&self) -> Vec<f32> {
        let mut visual = self
            .visual
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some((values, sample_rate, written)) = self.transformed_snapshot(true) else {
            return visual.bins.clone();
        };
        let now = Instant::now();
        let fresh = written != visual.written;
        if fresh {
            visual.last_sample_at = Some(now);
        } else if visual
            .last_sample_at
            .is_some_and(|at| now.duration_since(at).as_millis() < 120)
        {
            // Reading the same callback block twice is not a silent audio
            // frame. Preserve it across scheduler/callback timing jitter.
            return visual.bins.clone();
        }
        let elapsed = visual
            .at
            .map_or(1.0 / 60.0, |at| now.duration_since(at).as_secs_f32());
        let keep = 0.8f32.powf(elapsed.min(0.25) * 60.0);
        if sample_rate != visual.sample_rate {
            visual.magnitudes.fill(0.0);
        }
        visual.at = Some(now);
        visual.written = written;
        visual.sample_rate = sample_rate;

        let nyquist = (sample_rate as f32 * 0.5).max(1.0);
        let min_hz = MIN_FREQ_HZ.min(nyquist * 0.5).max(1.0);
        let log_min = min_hz.ln();
        let log_max = nyquist.ln();
        let log_range = (log_max - log_min).max(1e-3);
        let mut magnitudes = [0.0f32; NUM_BINS];
        for (index, value) in values.iter().take(FFT_SIZE / 2).enumerate() {
            // Match the former AnalyserNode: normalized FFT magnitude,
            // temporal smoothing, then its -85..-15 dB display range.
            let target = if fresh {
                value.norm() / FFT_SIZE as f32
            } else {
                0.0
            };
            let magnitude = visual.magnitudes[index] * keep + target * (1.0 - keep);
            visual.magnitudes[index] = magnitude;
            let frequency = index as f32 * nyquist / (FFT_SIZE / 2) as f32;
            if frequency < min_hz {
                continue;
            }
            let position = ((frequency.ln() - log_min) / log_range).clamp(0.0, 0.999);
            let bin = (position * NUM_BINS as f32) as usize;
            let decibels = 20.0 * magnitude.max(1e-12).log10();
            let level = ((decibels - ANALYSIS_MIN_DB) / (ANALYSIS_MAX_DB - ANALYSIS_MIN_DB))
                .clamp(0.0, 1.0);
            magnitudes[bin] = magnitudes[bin].max(level);
        }

        let log_scale = 1.0 / 10.0f32.ln();
        visual.bins = magnitudes
            .into_iter()
            .map(|magnitude| (1.0 + magnitude.clamp(0.0, 1.0) * 9.0).ln() * log_scale)
            .collect();
        visual.bins.clone()
    }

    /// Returns byte-scaled, linear-frequency FFT magnitudes for vocal analysis.
    /// Bins map to `sample_rate / 1024` Hz, matching a 1024-point analyser.
    pub fn analysis_bins(&self) -> Option<(Vec<u8>, u32)> {
        let (values, sample_rate, _) = self.transformed_snapshot(false)?;
        let db_range = ANALYSIS_MAX_DB - ANALYSIS_MIN_DB;
        let scale = 4.0 / FFT_SIZE as f32;
        let bins = values
            .into_iter()
            .take(FFT_SIZE / 2)
            .map(|value| {
                let magnitude = value.norm() * scale;
                let decibels =
                    (20.0 * magnitude.max(1e-12).log10()).clamp(ANALYSIS_MIN_DB, ANALYSIS_MAX_DB);
                (((decibels - ANALYSIS_MIN_DB) / db_range) * 255.0)
                    .round()
                    .clamp(0.0, 255.0) as u8
            })
            .collect();
        Some((bins, sample_rate))
    }
}
