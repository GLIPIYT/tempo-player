use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use biquad::{Biquad, Coefficients, DirectForm1, Hertz, ToHertz, Type, Q_BUTTERWORTH_F32};
use rodio::source::SeekError;
use rodio::{ChannelCount, SampleRate, Source};

use super::input::AudioSource;
use super::spectrum::SpectrumBuffer;
use super::OutputSettings;

pub(super) const EQ_BANDS: usize = 10;
const EQ_FREQS: [f64; EQ_BANDS] = [
    32.0, 64.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0,
];
const EQ_Q: f64 = 1.414;
const LIMITER_THRESHOLD: f32 = 0.891_250_9;
const LIMITER_RATIO: f32 = 20.0;

#[derive(Clone, Copy)]
struct EqSnapshot {
    generation: u64,
    enabled: bool,
    coefficients: [Coefficients<f32>; EQ_BANDS],
}

pub(super) struct EffectControls {
    pub pitch_ratio: Arc<AtomicU32>,
    gain_db: AtomicU64,
    linear_gain: AtomicU32,
    eq_snapshot: RwLock<EqSnapshot>,
    eq_boost: AtomicBool,
    limiter_enabled: AtomicBool,
    sample_rate: SampleRate,
}

impl EffectControls {
    pub fn new(gain_db: f64, sample_rate: SampleRate) -> Arc<Self> {
        let gain_db = finite_gain(gain_db);
        let coefficients = std::array::from_fn(|index| make_coefficients(sample_rate, index, 0.0));
        Arc::new(Self {
            pitch_ratio: Arc::new(AtomicU32::new(1.0f32.to_bits())),
            gain_db: AtomicU64::new(gain_db.to_bits()),
            linear_gain: AtomicU32::new(db_to_linear(gain_db).to_bits()),
            eq_snapshot: RwLock::new(EqSnapshot {
                generation: 0,
                enabled: false,
                coefficients,
            }),
            eq_boost: AtomicBool::new(false),
            limiter_enabled: AtomicBool::new(gain_db > 0.01),
            sample_rate,
        })
    }

    pub fn configure(&self, settings: &OutputSettings) {
        let rate = settings.playback_rate.clamp(0.5, 2.0);
        let pitch = if settings.preserve_pitch {
            (1.0 / rate) as f32
        } else {
            1.0
        };
        self.pitch_ratio.store(pitch.to_bits(), Ordering::Release);

        let gains: [f64; EQ_BANDS] = std::array::from_fn(|index| {
            let gain = settings.equalizer_gains[index];
            if gain.is_finite() {
                gain.clamp(-18.0, 18.0)
            } else {
                0.0
            }
        });
        let coefficients =
            std::array::from_fn(|index| make_coefficients(self.sample_rate, index, gains[index]));
        let mut snapshot = self
            .eq_snapshot
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *snapshot = EqSnapshot {
            generation: snapshot.generation.wrapping_add(1),
            enabled: settings.equalizer_enabled,
            coefficients,
        };
        let eq_boost = settings.equalizer_enabled && gains.iter().any(|gain| *gain > 0.01);
        self.eq_boost.store(eq_boost, Ordering::Release);
        let gain_db = f64::from_bits(self.gain_db.load(Ordering::Acquire));
        self.limiter_enabled
            .store(eq_boost || gain_db > 0.01, Ordering::Release);
    }

    pub fn set_track_gain_db(&self, gain_db: f64) {
        let gain_db = finite_gain(gain_db);
        self.gain_db.store(gain_db.to_bits(), Ordering::Release);
        self.linear_gain
            .store(db_to_linear(gain_db).to_bits(), Ordering::Release);
        self.limiter_enabled.store(
            gain_db > 0.01 || self.eq_boost.load(Ordering::Acquire),
            Ordering::Release,
        );
    }

    fn linear_gain(&self) -> f32 {
        f32::from_bits(self.linear_gain.load(Ordering::Acquire))
    }

    fn limiter_enabled(&self) -> bool {
        self.limiter_enabled.load(Ordering::Acquire)
    }
}

fn finite_gain(gain_db: f64) -> f64 {
    if gain_db.is_finite() {
        gain_db.clamp(-36.0, 36.0)
    } else {
        0.0
    }
}

fn db_to_linear(gain_db: f64) -> f32 {
    (10.0f64.powf(gain_db / 20.0)) as f32
}

pub(super) fn process_source(
    source: AudioSource,
    controls: Arc<EffectControls>,
    spectrum: Arc<SpectrumBuffer>,
) -> AudioSource {
    let gained = GainSource::new(source, controls.clone());
    let pitched = super::pitch::PitchSource::new(gained, controls.pitch_ratio.clone());
    let equalized = EqSource::new(pitched, controls.clone());
    let compressed = CompressorSource::new(equalized, controls.clone());
    Box::new(SpectrumSource::new(compressed, spectrum))
}

struct GainSource<S: Source<Item = f32>> {
    source: S,
    controls: Arc<EffectControls>,
    channels: ChannelCount,
    channel: u16,
    gain: f32,
}

impl<S: Source<Item = f32>> GainSource<S> {
    fn new(source: S, controls: Arc<EffectControls>) -> Self {
        let channels = source.channels();
        Self {
            source,
            controls: controls.clone(),
            channels,
            channel: 0,
            gain: controls.linear_gain(),
        }
    }
}

impl<S: Source<Item = f32>> Iterator for GainSource<S> {
    type Item = f32;

    fn next(&mut self) -> Option<Self::Item> {
        let sample = self.source.next()?;
        if self.channel == 0 {
            self.gain = self.controls.linear_gain();
        }
        self.channel = (self.channel + 1) % self.channels.get();
        // Keep headroom for the EQ stage. Peak protection happens afterward.
        Some(sample * self.gain)
    }
}

impl<S: Source<Item = f32>> Source for GainSource<S> {
    fn current_span_len(&self) -> Option<usize> {
        self.source.current_span_len()
    }

    fn channels(&self) -> ChannelCount {
        self.channels
    }

    fn sample_rate(&self) -> SampleRate {
        self.source.sample_rate()
    }

    fn total_duration(&self) -> Option<Duration> {
        self.source.total_duration()
    }

    fn try_seek(&mut self, position: Duration) -> Result<(), SeekError> {
        self.source.try_seek(position)
    }
}

struct EqSource<S: Source<Item = f32>> {
    source: S,
    controls: Arc<EffectControls>,
    filters: [Vec<DirectForm1<f32>>; 2],
    channels: ChannelCount,
    sample_rate: SampleRate,
    channel: u16,
    generation: u64,
    enabled: bool,
}

impl<S: Source<Item = f32>> EqSource<S> {
    fn new(source: S, controls: Arc<EffectControls>) -> Self {
        let sample_rate = source.sample_rate();
        let channels = source.channels();
        let snapshot = *controls
            .eq_snapshot
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let filters = std::array::from_fn(|channel| {
            if channel > 1 {
                return Vec::new();
            }
            snapshot
                .coefficients
                .iter()
                .copied()
                .map(DirectForm1::<f32>::new)
                .collect()
        });
        Self {
            source,
            controls,
            filters,
            channels,
            sample_rate,
            channel: 0,
            generation: snapshot.generation,
            enabled: snapshot.enabled,
        }
    }

    fn refresh(&mut self) {
        // Audio callbacks never wait behind settings changes. A missed update
        // stays pending until the lock is free on a later frame boundary.
        let Ok(snapshot) = self.controls.eq_snapshot.try_read() else {
            return;
        };
        if snapshot.generation == self.generation {
            return;
        }
        if snapshot.enabled && !self.enabled {
            for channel in &mut self.filters {
                for filter in channel {
                    filter.reset_state();
                }
            }
        }
        for channel in &mut self.filters {
            for (index, filter) in channel.iter_mut().enumerate() {
                filter.update_coefficients(snapshot.coefficients[index]);
            }
        }
        self.enabled = snapshot.enabled;
        self.generation = snapshot.generation;
    }
}

impl<S: Source<Item = f32>> Iterator for EqSource<S> {
    type Item = f32;

    fn next(&mut self) -> Option<Self::Item> {
        let sample = self.source.next()?;
        if self.channel == 0 {
            self.refresh();
        }
        let current = self.channel;
        self.channel = (self.channel + 1) % self.channels.get();
        if !self.enabled || current > 1 {
            return Some(sample);
        }
        let mut output = sample;
        for filter in &mut self.filters[current as usize] {
            output = filter.run(output);
        }
        Some(output)
    }
}

impl<S: Source<Item = f32>> Source for EqSource<S> {
    fn current_span_len(&self) -> Option<usize> {
        self.source.current_span_len()
    }

    fn channels(&self) -> ChannelCount {
        self.channels
    }

    fn sample_rate(&self) -> SampleRate {
        self.sample_rate
    }

    fn total_duration(&self) -> Option<Duration> {
        self.source.total_duration()
    }

    fn try_seek(&mut self, position: Duration) -> Result<(), SeekError> {
        self.source.try_seek(position)?;
        for channel in &mut self.filters {
            for filter in channel {
                filter.reset_state();
            }
        }
        Ok(())
    }
}

fn make_coefficients(sample_rate: SampleRate, index: usize, gain_db: f64) -> Coefficients<f32> {
    let nyquist = sample_rate.get() as f64 * 0.5;
    let frequency = EQ_FREQS[index].min(nyquist * 0.95).max(1.0);
    let gain_db = gain_db as f32;
    let filter_type = if index == 0 {
        Type::LowShelf(gain_db)
    } else if index == EQ_BANDS - 1 {
        Type::HighShelf(gain_db)
    } else {
        Type::PeakingEQ(gain_db)
    };
    let q = if index == 0 || index == EQ_BANDS - 1 {
        Q_BUTTERWORTH_F32 as f64
    } else {
        EQ_Q
    } as f32;
    let fs: Hertz<f32> = (sample_rate.get() as f32).hz();
    let freq: Hertz<f32> = (frequency as f32).hz();
    Coefficients::<f32>::from_params(filter_type, fs, freq, q)
        .unwrap_or_else(|_| Coefficients::from_params(Type::PeakingEQ(0.0), fs, freq, q).unwrap())
}

struct CompressorSource<S: Source<Item = f32>> {
    source: S,
    controls: Arc<EffectControls>,
    channels: ChannelCount,
    channel: usize,
    envelope: Vec<f32>,
    gain: Vec<f32>,
    attack: f32,
    release: f32,
}

impl<S: Source<Item = f32>> CompressorSource<S> {
    fn new(source: S, controls: Arc<EffectControls>) -> Self {
        let channels = source.channels();
        let sample_rate = source.sample_rate().get() as f32;
        Self {
            source,
            controls,
            channels,
            channel: 0,
            envelope: vec![0.0; channels.get() as usize],
            gain: vec![1.0; channels.get() as usize],
            attack: (-1.0 / (sample_rate * 0.003)).exp(),
            release: (-1.0 / (sample_rate * 0.14)).exp(),
        }
    }
}

impl<S: Source<Item = f32>> Iterator for CompressorSource<S> {
    type Item = f32;

    fn next(&mut self) -> Option<Self::Item> {
        let sample = self.source.next()?;
        let channel = self.channel;
        self.channel = (self.channel + 1) % self.channels.get() as usize;
        if !self.controls.limiter_enabled() {
            return Some(sample.clamp(-1.0, 1.0));
        }
        let peak = sample.abs();
        let coefficient = if peak > self.envelope[channel] {
            self.attack
        } else {
            self.release
        };
        self.envelope[channel] = coefficient * self.envelope[channel] + (1.0 - coefficient) * peak;
        let target = if self.envelope[channel] > LIMITER_THRESHOLD {
            let compressed =
                LIMITER_THRESHOLD + (self.envelope[channel] - LIMITER_THRESHOLD) / LIMITER_RATIO;
            compressed / self.envelope[channel].max(f32::MIN_POSITIVE)
        } else {
            1.0
        };
        let coefficient = if target < self.gain[channel] {
            self.attack
        } else {
            self.release
        };
        self.gain[channel] = coefficient * self.gain[channel] + (1.0 - coefficient) * target;
        Some((sample * self.gain[channel]).clamp(-1.0, 1.0))
    }
}

impl<S: Source<Item = f32>> Source for CompressorSource<S> {
    fn current_span_len(&self) -> Option<usize> {
        self.source.current_span_len()
    }
    fn channels(&self) -> ChannelCount {
        self.channels
    }
    fn sample_rate(&self) -> SampleRate {
        self.source.sample_rate()
    }
    fn total_duration(&self) -> Option<Duration> {
        self.source.total_duration()
    }
    fn try_seek(&mut self, position: Duration) -> Result<(), SeekError> {
        self.source.try_seek(position)?;
        self.envelope.fill(0.0);
        self.gain.fill(1.0);
        Ok(())
    }
}

struct SpectrumSource<S: Source<Item = f32>> {
    source: S,
    spectrum: Arc<SpectrumBuffer>,
    channels: ChannelCount,
    channel: u16,
    frame_sum: f32,
    sample_rate: SampleRate,
}

impl<S: Source<Item = f32>> SpectrumSource<S> {
    fn new(source: S, spectrum: Arc<SpectrumBuffer>) -> Self {
        Self {
            channels: source.channels(),
            sample_rate: source.sample_rate(),
            source,
            spectrum,
            channel: 0,
            frame_sum: 0.0,
        }
    }
}

impl<S: Source<Item = f32>> Iterator for SpectrumSource<S> {
    type Item = f32;

    fn next(&mut self) -> Option<Self::Item> {
        let sample = self.source.next()?;
        self.frame_sum += sample;
        self.channel += 1;
        if self.channel >= self.channels.get() {
            if self.spectrum.enabled.load(Ordering::Acquire) {
                self.spectrum.push(
                    self.frame_sum / self.channels.get() as f32,
                    self.sample_rate.get(),
                );
            }
            self.channel = 0;
            self.frame_sum = 0.0;
        }
        Some(sample)
    }
}

impl<S: Source<Item = f32>> Source for SpectrumSource<S> {
    fn current_span_len(&self) -> Option<usize> {
        self.source.current_span_len()
    }
    fn channels(&self) -> ChannelCount {
        self.channels
    }
    fn sample_rate(&self) -> SampleRate {
        self.sample_rate
    }
    fn total_duration(&self) -> Option<Duration> {
        self.source.total_duration()
    }
    fn try_seek(&mut self, position: Duration) -> Result<(), SeekError> {
        self.source.try_seek(position)
    }
}
