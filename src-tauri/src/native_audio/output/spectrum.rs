use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};

const FFT_SIZE: usize = 1024;
const RING_CAPACITY: usize = 4096;
const NUM_BINS: usize = 64;
const MIN_FREQ_HZ: f32 = 50.0;
const ANALYSIS_MIN_DB: f32 = -85.0;
const ANALYSIS_MAX_DB: f32 = -15.0;

pub(super) struct SpectrumBuffer {
    samples: Mutex<VecDeque<f32>>,
    pub enabled: AtomicBool,
    sample_rate: AtomicU32,
    fft: Arc<dyn Fft<f32>>,
}

impl SpectrumBuffer {
    pub fn new() -> Arc<Self> {
        let mut planner = FftPlanner::<f32>::new();
        Arc::new(Self {
            samples: Mutex::new(VecDeque::with_capacity(RING_CAPACITY)),
            enabled: AtomicBool::new(false),
            sample_rate: AtomicU32::new(48_000),
            fft: planner.plan_fft_forward(FFT_SIZE),
        })
    }

    pub fn push(&self, sample: f32, sample_rate: u32) {
        self.sample_rate.store(sample_rate, Ordering::Relaxed);
        if let Ok(mut samples) = self.samples.try_lock() {
            if samples.len() == RING_CAPACITY {
                samples.pop_front();
            }
            samples.push_back(sample);
        }
    }

    fn transformed_snapshot(&self) -> Option<(Vec<Complex<f32>>, u32)> {
        if !self.enabled.load(Ordering::Acquire) {
            return None;
        }
        let (snapshot, sample_rate) = {
            let Ok(samples) = self.samples.try_lock() else {
                return None;
            };
            if samples.len() < FFT_SIZE {
                return None;
            }
            (
                samples
                    .iter()
                    .skip(samples.len() - FFT_SIZE)
                    .copied()
                    .collect::<Vec<_>>(),
                self.sample_rate.load(Ordering::Relaxed),
            )
        };

        let mut values = snapshot
            .into_iter()
            .enumerate()
            .map(|(index, sample)| {
                let window = 0.5
                    * (1.0
                        - (2.0 * std::f32::consts::PI * index as f32 / (FFT_SIZE - 1) as f32)
                            .cos());
                Complex::new(sample * window, 0.0)
            })
            .collect::<Vec<_>>();
        self.fft.process(&mut values);
        Some((values, sample_rate))
    }

    pub fn bins(&self) -> Vec<f32> {
        let Some((values, sample_rate)) = self.transformed_snapshot() else {
            return vec![0.0; NUM_BINS];
        };

        let nyquist = (sample_rate as f32 * 0.5).max(1.0);
        let min_hz = MIN_FREQ_HZ.min(nyquist * 0.5).max(1.0);
        let log_min = min_hz.ln();
        let log_max = nyquist.ln();
        let log_range = (log_max - log_min).max(1e-3);
        let mut magnitudes = [0.0f32; NUM_BINS];
        for (index, value) in values.iter().take(FFT_SIZE / 2).enumerate() {
            let frequency = index as f32 * nyquist / (FFT_SIZE / 2) as f32;
            if frequency < min_hz {
                continue;
            }
            let position = ((frequency.ln() - log_min) / log_range).clamp(0.0, 0.999);
            let bin = (position * NUM_BINS as f32) as usize;
            let magnitude = value.norm() / 32.0;
            magnitudes[bin] = magnitudes[bin].max(magnitude);
        }

        let log_scale = 1.0 / 10.0f32.ln();
        magnitudes
            .into_iter()
            .map(|magnitude| (1.0 + magnitude.clamp(0.0, 1.0) * 9.0).ln() * log_scale)
            .collect()
    }

    /// Returns byte-scaled, linear-frequency FFT magnitudes for vocal analysis.
    /// Bins map to `sample_rate / 1024` Hz, matching a 1024-point analyser.
    pub fn analysis_bins(&self) -> Option<(Vec<u8>, u32)> {
        let (values, sample_rate) = self.transformed_snapshot()?;
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
