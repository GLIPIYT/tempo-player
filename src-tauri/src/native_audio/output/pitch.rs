// Upstream source: https://github.com/zxcloli666/SoundCloud-Desktop
// Adapted from SoundCloud Desktop audio/pitch.rs (MIT, Copyright (c) 2025, zxcloli666).
// Attribution and license text: LICENSE (Third-party notices).
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use rodio::source::SeekError;
use rodio::{ChannelCount, SampleRate, Source};

pub(super) const SOURCE_FRAME_SCALE: u64 = 1 << 24;
const MATCH_STEP: usize = 4;

pub(super) struct PlaybackRateSource<S> {
    source: S,
    setting: Arc<AtomicU32>,
    source_frame_advance: Arc<AtomicU64>,
    channels: ChannelCount,
    sample_rate: SampleRate,
    channel: u16,
    rate: f32,
    buffer: Option<RateBuffer>,
}

impl<S: Source<Item = f32>> PlaybackRateSource<S> {
    pub(super) fn new(
        source: S,
        setting: Arc<AtomicU32>,
        source_frame_advance: Arc<AtomicU64>,
    ) -> Self {
        Self {
            channels: source.channels(),
            sample_rate: source.sample_rate(),
            source,
            setting,
            source_frame_advance,
            channel: 0,
            rate: 1.0,
            buffer: None,
        }
    }

    fn prepare_frame(&mut self) {
        if self.buffer.as_ref().is_some_and(RateBuffer::has_output) {
            return;
        }

        // A single setting switches rate and pitch mode at the same block boundary.
        let signed_rate = f32::from_bits(self.setting.load(Ordering::Relaxed));
        let rate = signed_rate.abs();
        if rate != self.rate {
            self.rate = rate;
            let advance = (f64::from(rate) * SOURCE_FRAME_SCALE as f64).round() as u64;
            self.source_frame_advance.store(advance, Ordering::Relaxed);
        }
        if rate == 1.0 && self.buffer.as_ref().is_none_or(RateBuffer::can_bypass) {
            self.buffer = None;
            return;
        }

        let buffer = self
            .buffer
            .get_or_insert_with(|| RateBuffer::new(self.channels, self.sample_rate));
        buffer.render(
            &mut self.source,
            f64::from(rate),
            signed_rate.is_sign_positive() && rate != 1.0,
        );
    }
}

impl<S: Source<Item = f32>> Iterator for PlaybackRateSource<S> {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        if self.channel == 0 {
            self.prepare_frame();
        }
        let sample = match self.buffer.as_mut() {
            Some(buffer) => buffer.next()?,
            None => self.source.next()?,
        };
        self.channel = (self.channel + 1) % self.channels.get();
        Some(sample)
    }
}

impl<S: Source<Item = f32>> Source for PlaybackRateSource<S> {
    fn current_span_len(&self) -> Option<usize> {
        None
    }

    fn channels(&self) -> ChannelCount {
        self.channels
    }

    fn sample_rate(&self) -> SampleRate {
        self.sample_rate
    }

    fn total_duration(&self) -> Option<Duration> {
        self.source.total_duration().map(|duration| {
            let rate = f32::from_bits(self.setting.load(Ordering::Relaxed)).abs();
            duration.div_f32(rate)
        })
    }

    fn try_seek(&mut self, position: Duration) -> Result<(), SeekError> {
        self.source.try_seek(position)?;
        self.buffer = None;
        self.channel = 0;
        Ok(())
    }
}

#[derive(Clone, Copy, PartialEq)]
struct Grain {
    start: f64,
    step: f64,
}

struct RateBuffer {
    channels: usize,
    hop: usize,
    search: usize,
    fade: Vec<f32>,
    input: Vec<f32>,
    input_start: usize,
    input_ended: bool,
    position: f64,
    continuation: Option<Grain>,
    output: Vec<f32>,
    output_pos: usize,
}

impl RateBuffer {
    fn new(channels: ChannelCount, sample_rate: SampleRate) -> Self {
        let channels = channels.get() as usize;
        let samples_per_second = sample_rate.get() as usize;
        let hop = (samples_per_second / 40).max(64);
        let search = (samples_per_second * 12 / 1000).max(16);
        let overlap = (samples_per_second / 125).max(8);
        let fade = (0..overlap)
            .map(|frame| {
                let phase = std::f32::consts::FRAC_PI_2 * (frame + 1) as f32 / overlap as f32;
                phase.sin().powi(2)
            })
            .collect();
        Self {
            channels,
            hop,
            search,
            fade,
            input: Vec::with_capacity((hop * 3 + search * 2) * channels),
            input_start: 0,
            input_ended: false,
            position: 0.0,
            continuation: None,
            output: Vec::with_capacity(hop * channels),
            output_pos: 0,
        }
    }

    fn has_output(&self) -> bool {
        self.output_pos < self.output.len()
    }

    fn can_bypass(&self) -> bool {
        self.continuation.is_none() && self.position == self.input_end() as f64
    }

    fn next(&mut self) -> Option<f32> {
        let sample = *self.output.get(self.output_pos)?;
        self.output_pos += 1;
        Some(sample)
    }

    fn input_end(&self) -> usize {
        self.input_start + self.input.len() / self.channels
    }

    fn read_until(&mut self, source: &mut impl Source<Item = f32>, end: usize) {
        while !self.input_ended && self.input_end() < end {
            let start = self.input.len();
            self.input.extend(source.by_ref().take(self.channels));
            if self.input.len() - start < self.channels {
                self.input.truncate(start);
                self.input_ended = true;
            }
        }
    }

    fn render(&mut self, source: &mut impl Source<Item = f32>, rate: f64, stretch: bool) {
        self.output.clear();
        self.output_pos = 0;

        if rate == 1.0 {
            self.position = self.position.round();
        }
        let target = self.position.round() as usize;
        let previous = self.continuation;
        let step = if stretch { 1.0 } else { rate };
        let mut grain = Grain {
            start: if stretch {
                target as f64
            } else {
                self.position
            },
            step,
        };
        let search = if stretch && previous.is_some_and(|tail| tail.step == 1.0) {
            self.search
        } else {
            0
        };
        let seam_end = previous.map_or(0, |tail| {
            (tail.start + tail.step * self.fade.len() as f64).ceil() as usize
        });
        let grain_end = (grain.start + step * self.hop as f64).ceil() as usize + search;
        let block_end = (self.position + rate * self.hop as f64).ceil() as usize;
        let span_end = grain_end.max(block_end);
        let input_end = if rate == 1.0 && previous.is_none() {
            span_end.min(self.input_end())
        } else {
            span_end.max(seam_end)
        };
        self.read_until(source, input_end);

        let mut frames = self.hop;
        if self.input_ended || (rate == 1.0 && previous.is_none()) {
            frames = frames
                .min(((self.input_end() as f64 - self.position).max(0.0) / rate).ceil() as usize);
        }
        if frames == 0 {
            return;
        }

        if stretch {
            // Match overlapping grains in the original PCM. Resampling up and
            // then playing slowly would discard any frequencies above the
            // intermediate Nyquist limit, even with the pitch restored.
            let high = (target + search).min(self.input_end().saturating_sub(frames));
            let low = target.saturating_sub(search).max(self.input_start);
            let center = target.min(high).max(self.input_start);
            grain.start = if let Some(tail) = previous.filter(|_| search > 0 && high > low) {
                self.best_match(tail.start as usize, low, high, center, frames) as f64
            } else {
                center as f64
            };
        }

        let tail = previous.filter(|tail| *tail != grain);
        for frame in 0..frames {
            let position = grain.start + step * frame as f64;
            let fade = tail.zip(self.fade.get(frame));
            for channel in 0..self.channels {
                let mut sample = self.sample(position, channel);
                if let Some((tail, &mix)) = fade {
                    let from = self.sample(tail.start + tail.step * frame as f64, channel);
                    sample = from + (sample - from) * mix;
                }
                self.output.push(sample);
            }
        }
        self.position += rate * frames as f64;
        self.continuation = (rate != 1.0).then_some(Grain {
            start: grain.start + step * frames as f64,
            step,
        });
        let keep = (self.position as usize)
            .saturating_sub(if rate == 1.0 { 0 } else { self.search })
            .min(
                self.continuation
                    .map_or(usize::MAX, |tail| tail.start as usize),
            )
            .min(self.input_end());
        if keep > self.input_start {
            self.input
                .drain(..(keep - self.input_start) * self.channels);
            self.input_start = keep;
        }
    }

    fn sample(&self, position: f64, channel: usize) -> f32 {
        let frame = position as usize;
        let before = self.sample_at(frame, channel);
        let fraction = (position - frame as f64) as f32;
        if fraction == 0.0 {
            return before;
        }
        before + (self.sample_at(frame + 1, channel) - before) * fraction
    }

    fn sample_at(&self, frame: usize, channel: usize) -> f32 {
        let frame = frame.clamp(self.input_start, self.input_end() - 1);
        self.input[(frame - self.input_start) * self.channels + channel]
    }

    fn best_match(
        &self,
        reference: usize,
        low: usize,
        high: usize,
        target: usize,
        frames: usize,
    ) -> usize {
        let overlap = self
            .fade
            .len()
            .min(frames)
            .min(self.input_end().saturating_sub(reference));
        if overlap == 0 {
            return target;
        }
        let overlap_samples = overlap * self.channels;
        let start = (reference - self.input_start) * self.channels;
        let reference = &self.input[start..start + overlap_samples];
        let mut channel = 0;
        let mut energy = 0.0;
        // An antiphase stereo recording can cancel in a mono sum.
        for candidate in 0..self.channels {
            let power = reference[candidate..]
                .iter()
                .step_by(MATCH_STEP * self.channels)
                .map(|sample| sample * sample)
                .sum::<f32>();
            if power > energy {
                channel = candidate;
                energy = power;
            }
        }
        if energy < 1e-9 {
            return target;
        }

        let score = |offset: usize, stride: usize| -> f32 {
            let start = (offset - self.input_start) * self.channels;
            let window = &self.input[start + channel..start + overlap_samples];
            let reference = reference[channel..].iter().step_by(stride);
            let (correlation, energy) = reference
                .zip(window.iter().step_by(stride))
                .fold((0.0, 1e-9), |(correlation, energy), (a, b)| {
                    (correlation + a * b, energy + b * b)
                });
            correlation / energy.sqrt()
        };
        let full_energy = reference[channel..]
            .iter()
            .step_by(self.channels)
            .map(|sample| sample * sample)
            .sum::<f32>();
        let penalty = |offset: usize| 0.02 * offset.abs_diff(target) as f32 / self.search as f32;
        let coarse_stride = MATCH_STEP * self.channels;
        let coarse_norm = energy.sqrt().recip();
        let mut best = target;
        let mut best_score = score(best, coarse_stride) * coarse_norm;
        for offset in low..=high {
            let value = score(offset, coarse_stride) * coarse_norm - penalty(offset);
            if value > best_score {
                best = offset;
                best_score = value;
            }
        }
        let fine_norm = full_energy.sqrt().recip();
        best_score = score(best, self.channels) * fine_norm - penalty(best);
        for offset in
            best.saturating_sub(MATCH_STEP - 1).max(low)..=(best + MATCH_STEP - 1).min(high)
        {
            let value = score(offset, self.channels) * fine_norm - penalty(offset);
            if value > best_score {
                best = offset;
                best_score = value;
            }
        }
        best
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rodio::buffer::SamplesBuffer;
    use std::f64::consts::TAU;

    fn tone(frame: usize, frequency: f64, sample_rate: SampleRate) -> f32 {
        (TAU * frame as f64 * frequency / f64::from(sample_rate.get())).sin() as f32
    }

    fn amplitude(samples: &[f32], frequency: f64, sample_rate: SampleRate) -> f64 {
        let (real, imaginary) =
            samples
                .iter()
                .enumerate()
                .fold((0.0, 0.0), |(re, im), (frame, sample)| {
                    let phase = TAU * frame as f64 * frequency / f64::from(sample_rate.get());
                    (
                        re + f64::from(*sample) * phase.cos(),
                        im + f64::from(*sample) * phase.sin(),
                    )
                });
        2.0 * real.hypot(imaginary) / samples.len() as f64
    }

    fn mono_rate_source(
        samples: Vec<f32>,
        sample_rate: SampleRate,
        rate: f32,
    ) -> PlaybackRateSource<SamplesBuffer> {
        let input = SamplesBuffer::new(ChannelCount::MIN, sample_rate, samples);
        PlaybackRateSource::new(
            input,
            Arc::new(AtomicU32::new(rate.to_bits())),
            Arc::new(AtomicU64::new(SOURCE_FRAME_SCALE)),
        )
    }

    #[test]
    fn stretching_keeps_bass_and_treble_at_the_original_pitch() {
        for sample_rate in [44_100, 48_000].map(|rate| SampleRate::new(rate).unwrap()) {
            let frames = sample_rate.get() as usize;
            let samples: Vec<_> = (0..frames)
                .map(|frame| {
                    0.3 * tone(frame, 750.0, sample_rate) + 0.2 * tone(frame, 15_000.0, sample_rate)
                })
                .collect();
            for rate in [0.5f32, 0.75, 1.5, 2.0] {
                let output: Vec<_> = mono_rate_source(samples.clone(), sample_rate, rate).collect();
                assert_eq!(
                    output.len(),
                    (frames as f64 / f64::from(rate)).ceil() as usize
                );
                let middle = &output[frames / 8..output.len() - frames / 8];
                for (frequency, expected) in [(750.0, 0.3), (15_000.0, 0.2)] {
                    let measured = amplitude(middle, frequency, sample_rate);
                    assert!(
                        (measured - expected).abs() < 0.03,
                        "{sample_rate} Hz, {rate}x, tone {frequency} Hz: {measured}"
                    );
                }
            }
        }
    }

    #[test]
    fn disabling_pitch_preservation_still_changes_pitch() {
        let sample_rate = SampleRate::new(48_000).unwrap();
        let samples = (0..48_000)
            .map(|frame| tone(frame, 1000.0, sample_rate))
            .collect();
        let output: Vec<_> = mono_rate_source(samples, sample_rate, -0.5).collect();
        assert_eq!(output.len(), 96_000);
        assert!(amplitude(&output, 500.0, sample_rate) > 0.98);
        assert!(amplitude(&output, 1000.0, sample_rate) < 0.01);
    }

    #[test]
    fn acceleration_stops_at_the_end_of_a_partial_block() {
        let sample_rate = SampleRate::new(48_000).unwrap();
        let output: Vec<_> = mono_rate_source(vec![0.125; 1_700], sample_rate, 2.0).collect();
        assert_eq!(output, vec![0.125; 850]);
    }

    #[test]
    fn changing_mode_and_seeking_discards_stale_audio_and_keeps_stereo_aligned() {
        let sample_rate = SampleRate::new(48_000).unwrap();
        let samples: Vec<_> = (0..48_000)
            .flat_map(|frame| {
                let sample =
                    tone(frame, 1000.0, sample_rate) * if frame < 24_000 { 0.5 } else { 0.25 };
                [sample, -sample]
            })
            .collect();
        let setting = Arc::new(AtomicU32::new(0.5f32.to_bits()));
        let input = SamplesBuffer::new(ChannelCount::new(2).unwrap(), sample_rate, samples.clone());
        let mut source = PlaybackRateSource::new(
            input,
            setting.clone(),
            Arc::new(AtomicU64::new(SOURCE_FRAME_SCALE)),
        );
        for rate in [0.75f32, -1.5, 1.0] {
            setting.store(rate.to_bits(), Ordering::Relaxed);
            for _ in 0..2000 {
                let left = source.next().unwrap();
                assert_eq!(source.next().unwrap(), -left);
            }
        }
        source.try_seek(Duration::from_millis(500)).unwrap();
        assert_eq!(source.collect::<Vec<_>>(), samples[48_000..]);
    }
}
