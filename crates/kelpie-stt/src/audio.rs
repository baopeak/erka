//! Microphone capture: the device's own format, mixed down to mono f32 (the recognizer resamples).
//! `KELPIE_STT_TEST_INPUT=<wav>` replaces the microphone with that recording, played at real-time
//! pace — the end-to-end tests speak through it on machines without a microphone.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::Mutex;

/// Longest recording kept (10 minutes at 48 kHz); later audio is dropped.
const MAX_SAMPLES: usize = 48_000 * 600;

pub struct Buffer {
    pub samples: Vec<f32>,
    pub rate: u32,
}

/// What a level callback receives: RMS of the last ~100 ms, 0..1.
pub type LevelFn = Arc<dyn Fn(f32) + Send + Sync>;

pub struct Recording {
    pub buffer: Arc<Mutex<Buffer>>,
    stream: Option<cpal::Stream>,
    stop: Arc<AtomicBool>,
}

impl Recording {
    /// Stops capturing and returns the audio.
    pub fn finish(self) -> Buffer {
        self.stop.store(true, Ordering::Relaxed);
        drop(self.stream);
        let mut b = self.buffer.lock().unwrap();
        Buffer { samples: std::mem::take(&mut b.samples), rate: b.rate }
    }
}

pub fn devices() -> Vec<(String, bool)> {
    let host = cpal::default_host();
    let default = host.default_input_device().and_then(|d| d.description().ok()).map(|d| d.name().to_string());
    host.input_devices()
        .map(|list| list.filter_map(|d| d.description().ok().map(|x| x.name().to_string())).map(|n| (n.clone(), Some(&n) == default.as_ref())).collect())
        .unwrap_or_default()
}

/// Pushes interleaved frames as mono and reports the level every ~100 ms.
struct Sink {
    buffer: Arc<Mutex<Buffer>>,
    channels: usize,
    level: LevelFn,
    acc: f32,
    acc_n: usize,
}

impl Sink {
    fn push(&mut self, frame_values: impl Iterator<Item = f32>) {
        let mut b = self.buffer.lock().unwrap();
        let mut sum = 0.0;
        let mut n = 0;
        let mut frame = 0.0;
        for (i, v) in frame_values.enumerate() {
            frame += v;
            if (i + 1) % self.channels == 0 {
                let m = frame / self.channels as f32;
                frame = 0.0;
                if b.samples.len() < MAX_SAMPLES {
                    b.samples.push(m);
                }
                sum += m * m;
                n += 1;
            }
        }
        let rate = b.rate as usize;
        drop(b);
        self.acc += sum;
        self.acc_n += n;
        if self.acc_n >= rate / 10 {
            (self.level)((self.acc / self.acc_n as f32).sqrt().min(1.0));
            self.acc = 0.0;
            self.acc_n = 0;
        }
    }
}

pub fn start(device: Option<&str>, level: LevelFn) -> Result<Recording> {
    let stop = Arc::new(AtomicBool::new(false));
    if let Some(path) = std::env::var_os("KELPIE_STT_TEST_INPUT") {
        let wave = sherpa_onnx::Wave::read(&path.to_string_lossy()).ok_or_else(|| anyhow!("cannot read test input {:?}", path))?;
        let rate = wave.sample_rate() as u32;
        let samples = wave.samples().to_vec();
        let buffer = Arc::new(Mutex::new(Buffer { samples: Vec::new(), rate }));
        let mut sink = Sink { buffer: buffer.clone(), channels: 1, level, acc: 0.0, acc_n: 0 };
        let stop2 = stop.clone();
        std::thread::spawn(move || {
            for chunk in samples.chunks(rate as usize / 10) {
                if stop2.load(Ordering::Relaxed) {
                    return;
                }
                sink.push(chunk.iter().copied());
                std::thread::sleep(Duration::from_millis(100));
            }
            // Then silence, like a microphone in a quiet room.
            while !stop2.load(Ordering::Relaxed) {
                sink.push(std::iter::repeat_n(0.0, rate as usize / 10));
                std::thread::sleep(Duration::from_millis(100));
            }
        });
        return Ok(Recording { buffer, stream: None, stop });
    }

    let host = cpal::default_host();
    let dev = match device.filter(|d| !d.is_empty()) {
        Some(name) => host
            .input_devices()?
            .find(|d| d.description().is_ok_and(|x| x.name() == name))
            .or_else(|| host.default_input_device())
            .ok_or_else(|| anyhow!("no microphone found"))?,
        None => host.default_input_device().ok_or_else(|| anyhow!("no microphone found (check the system's sound and privacy settings)"))?,
    };
    let supported = dev.default_input_config().context("microphone format")?;
    let format = supported.sample_format();
    let config = supported.config();
    let buffer = Arc::new(Mutex::new(Buffer { samples: Vec::with_capacity(config.sample_rate as usize * 30), rate: config.sample_rate }));
    let mut sink = Sink { buffer: buffer.clone(), channels: config.channels.max(1) as usize, level, acc: 0.0, acc_n: 0 };
    let stream = dev
        .build_input_stream_raw(
            config,
            format,
            move |data: &cpal::Data, _: &cpal::InputCallbackInfo| {
                use cpal::SampleFormat as F;
                match data.sample_format() {
                    F::F32 => sink.push(data.as_slice::<f32>().unwrap_or(&[]).iter().copied()),
                    F::I16 => sink.push(data.as_slice::<i16>().unwrap_or(&[]).iter().map(|&v| v as f32 / 32768.0)),
                    F::U16 => sink.push(data.as_slice::<u16>().unwrap_or(&[]).iter().map(|&v| (v as f32 - 32768.0) / 32768.0)),
                    F::I32 => sink.push(data.as_slice::<i32>().unwrap_or(&[]).iter().map(|&v| v as f32 / 2_147_483_648.0)),
                    F::F64 => sink.push(data.as_slice::<f64>().unwrap_or(&[]).iter().map(|&v| v as f32)),
                    F::I8 => sink.push(data.as_slice::<i8>().unwrap_or(&[]).iter().map(|&v| v as f32 / 128.0)),
                    F::U8 => sink.push(data.as_slice::<u8>().unwrap_or(&[]).iter().map(|&v| (v as f32 - 128.0) / 128.0)),
                    _ => {}
                }
            },
            |e| eprintln!("microphone: {e}"),
            None,
        )
        .context("open the microphone")?;
    stream.play().context("start the microphone")?;
    Ok(Recording { buffer, stream: Some(stream), stop })
}
