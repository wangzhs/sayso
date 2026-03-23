/// Audio recorder using cpal.
///
/// - Format: WAV, 16kHz, mono, 16-bit PCM
/// - Max duration: 60 seconds (auto-truncate)
/// - Min duration: 0.3 seconds (returns RecordingTooShort if below)
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, SampleRate, StreamConfig};
use hound::{WavSpec, WavWriter};
use std::io::Cursor;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use anyhow::{Context, Result};
use log::{debug, info, warn};

use crate::error::SaysoError;

const TARGET_SAMPLE_RATE: u32 = 16_000;
const MAX_DURATION_SECS: f64 = 60.0;
const MIN_DURATION_SECS: f64 = 0.3;

pub struct AudioRecorder {
    samples: Arc<Mutex<Vec<i16>>>,
    start_time: Option<Instant>,
}

impl AudioRecorder {
    pub fn new() -> Self {
        Self {
            samples: Arc::new(Mutex::new(Vec::new())),
            start_time: None,
        }
    }

    /// Start recording from the default input device.
    /// Returns a handle that stops recording when dropped.
    pub fn start(&mut self) -> Result<RecordingHandle, SaysoError> {
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or(SaysoError::AudioDeviceNotFound)?;

        let config = choose_config(&device)?;
        debug!(
            "Audio: recording on '{}' at {}Hz, {} ch",
            device.name().unwrap_or_default(),
            config.sample_rate.0,
            config.channels
        );

        let samples = Arc::clone(&self.samples);
        samples.lock().unwrap().clear();
        self.start_time = Some(Instant::now());

        let start = Instant::now();
        let samples_for_stream = Arc::clone(&samples);

        let err_fn = |e: cpal::StreamError| {
            warn!("Audio stream error: {}", e);
        };

        let stream = device
            .build_input_stream(
                &config,
                move |data: &[f32], _| {
                    // Auto-truncate at MAX_DURATION_SECS
                    if start.elapsed().as_secs_f64() > MAX_DURATION_SECS {
                        return;
                    }
                    let mut buf = samples_for_stream.lock().unwrap();
                    // Convert f32 PCM → i16, downsample if needed (simple pass for now)
                    for &sample in data {
                        let s = (sample * 32767.0).clamp(-32768.0, 32767.0) as i16;
                        buf.push(s);
                    }
                },
                err_fn,
                None,
            )
            .map_err(|e| SaysoError::AudioRecordingFailed(e.to_string()))?;

        stream.play().map_err(|e| SaysoError::AudioRecordingFailed(e.to_string()))?;
        info!("Audio recording started");

        Ok(RecordingHandle { _stream: stream })
    }

    /// Call after stopping the RecordingHandle. Returns WAV bytes.
    pub fn finish(&self, actual_sample_rate: u32) -> Result<Vec<u8>, SaysoError> {
        let samples = self.samples.lock().unwrap().clone();
        let duration_secs = samples.len() as f64 / actual_sample_rate as f64;

        if duration_secs < MIN_DURATION_SECS {
            return Err(SaysoError::RecordingTooShort);
        }

        // Resample to 16kHz if needed (linear interpolation)
        let resampled = if actual_sample_rate != TARGET_SAMPLE_RATE {
            resample(&samples, actual_sample_rate, TARGET_SAMPLE_RATE)
        } else {
            samples.clone()
        };

        encode_wav(&resampled, TARGET_SAMPLE_RATE)
            .map_err(|e| SaysoError::AudioRecordingFailed(e.to_string()))
    }

    pub fn elapsed(&self) -> Duration {
        self.start_time
            .map(|t| t.elapsed())
            .unwrap_or_default()
    }
}

pub struct RecordingHandle {
    _stream: cpal::Stream,
}

// cpal::Stream contains a raw pointer internally and is thus !Send by default.
// In practice the stream is only ever started/stopped from a single thread (the
// hotkey handler), and the audio callback runs on a separate OS audio thread
// that cpal manages safely. Wrapping in Mutex<Option<RecordingHandle>> ensures
// exclusive access, so this is safe to send across threads.
unsafe impl Send for RecordingHandle {}

impl Drop for RecordingHandle {
    fn drop(&mut self) {
        info!("Audio recording stopped");
    }
}

fn choose_config(device: &cpal::Device) -> Result<StreamConfig, SaysoError> {
    let supported = device
        .supported_input_configs()
        .map_err(|e| SaysoError::AudioRecordingFailed(e.to_string()))?;

    // Prefer f32 mono at or near 16kHz
    let mut best: Option<cpal::SupportedStreamConfigRange> = None;
    for cfg in supported {
        if cfg.sample_format() == SampleFormat::F32 {
            if best.is_none() {
                best = Some(cfg.clone());
            } else if cfg.channels() == 1 {
                best = Some(cfg);
            }
        }
    }

    if let Some(cfg) = best {
        let rate = if cfg.min_sample_rate().0 <= TARGET_SAMPLE_RATE
            && cfg.max_sample_rate().0 >= TARGET_SAMPLE_RATE
        {
            SampleRate(TARGET_SAMPLE_RATE)
        } else {
            cfg.max_sample_rate()
        };
        Ok(cfg.with_sample_rate(rate).into())
    } else {
        Err(SaysoError::AudioDeviceNotFound)
    }
}

fn resample(samples: &[i16], from: u32, to: u32) -> Vec<i16> {
    if from == to {
        return samples.to_vec();
    }
    let ratio = from as f64 / to as f64;
    let out_len = (samples.len() as f64 / ratio) as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let pos = i as f64 * ratio;
        let idx = pos as usize;
        let frac = pos - idx as f64;
        let a = *samples.get(idx).unwrap_or(&0) as f64;
        let b = *samples.get(idx + 1).unwrap_or(&0) as f64;
        out.push((a + (b - a) * frac) as i16);
    }
    out
}

pub fn encode_wav_pub(samples: &[i16], sample_rate: u32) -> Result<Vec<u8>> {
    encode_wav(samples, sample_rate)
}

fn encode_wav(samples: &[i16], sample_rate: u32) -> Result<Vec<u8>> {
    let spec = WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut buf = Cursor::new(Vec::new());
    {
        let mut writer = WavWriter::new(&mut buf, spec)
            .context("Failed to create WAV writer")?;
        for &s in samples {
            writer.write_sample(s).context("Failed to write sample")?;
        }
        writer.finalize().context("Failed to finalize WAV")?;
    }
    Ok(buf.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resample_passthrough() {
        let samples: Vec<i16> = (0..100).map(|i| i as i16).collect();
        let result = resample(&samples, 16000, 16000);
        assert_eq!(result, samples);
    }

    #[test]
    fn test_encode_wav_valid() {
        let samples: Vec<i16> = vec![0i16; 16000]; // 1 second of silence
        let wav = encode_wav(&samples, 16000).unwrap();
        // WAV magic bytes: RIFF
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
    }
}
