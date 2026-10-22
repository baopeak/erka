//! erka-stt: Erka's local speech-to-text helper. A separate process so the speech engine (a large
//! native library) never shares a crash or memory with the app or the session daemon.
//!
//! Protocol: one JSON object per line. Requests on stdin `{"id": n, "cmd": "...", ...}`; replies on
//! stdout `{"id": n, "ok": value}` or `{"id": n, "err": "message"}`, plus events without an id:
//! `{"event": "level", "rms": 0.1}` while recording, `{"event": "download", "model", "done",
//! "total"}` while downloading. The process exits when stdin closes.

mod audio;
mod models;

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use sherpa_onnx::{OfflineRecognizer, OfflineRecognizerConfig, OfflineTransducerModelConfig, OfflineWhisperModelConfig};

static OUT: Mutex<()> = Mutex::new(());

fn send(v: Value) {
    let _guard = OUT.lock().unwrap();
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{v}");
    let _ = out.flush();
}

fn reply(id: &Value, r: Result<Value>) {
    send(match r {
        Ok(v) => json!({"id": id, "ok": v}),
        Err(e) => json!({"id": id, "err": format!("{e:#}")}),
    });
}

struct Recognizer {
    inner: OfflineRecognizer,
    upper_case: bool,
}

fn load(root: &Path, model: &models::Model, language: Option<&str>) -> Result<Recognizer> {
    if !model.installed(root) {
        bail!("the {} model is not downloaded", model.label);
    }
    let dir = model.dir(root);
    let p = |f: &str| Some(dir.join(f).to_string_lossy().into_owned());
    let mut cfg = OfflineRecognizerConfig::default();
    cfg.model_config.tokens = p(model.tokens);
    cfg.model_config.num_threads = std::thread::available_parallelism().map_or(2, |n| n.get().min(4)) as i32;
    match model.kind {
        models::Kind::Transducer { encoder, decoder, joiner } => {
            cfg.model_config.transducer = OfflineTransducerModelConfig { encoder: p(encoder), decoder: p(decoder), joiner: p(joiner) };
        }
        models::Kind::Whisper { encoder, decoder } => {
            cfg.model_config.whisper = OfflineWhisperModelConfig {
                encoder: p(encoder),
                decoder: p(decoder),
                // None: Whisper detects the language.
                language: language.filter(|l| !l.is_empty() && *l != "auto").map(str::to_string),
                task: Some("transcribe".into()),
                tail_paddings: -1,
                ..Default::default()
            };
        }
    }
    let inner = OfflineRecognizer::create(&cfg).ok_or_else(|| anyhow!("could not load the {} model (files damaged? delete and download it again)", model.label))?;
    Ok(Recognizer { inner, upper_case: model.upper_case })
}

/// A recording whose loudest 100 ms stays below this RMS holds no speech (room noise measures
/// about 0.005–0.015, speech 0.05 and up): decoding it only invites made-up words.
const SILENCE: f32 = 0.02;

fn loudest_window(rate: u32, samples: &[f32]) -> f32 {
    samples.chunks((rate as usize / 10).max(1)).map(|w| (w.iter().map(|v| v * v).sum::<f32>() / w.len() as f32).sqrt()).fold(0.0, f32::max)
}

fn transcribe(r: &Recognizer, rate: u32, samples: &[f32]) -> String {
    if samples.len() < rate as usize / 4 || loudest_window(rate, samples) < SILENCE {
        return String::new();
    }
    let stream = r.inner.create_stream();
    stream.accept_waveform(rate as i32, samples);
    r.inner.decode(&stream);
    tidy(&stream.get_result().map(|x| x.text).unwrap_or_default(), r.upper_case)
}

/// Single spaces, no silence markers; upper-case-only models get sentence case.
fn tidy(text: &str, upper_case: bool) -> String {
    let words: Vec<&str> = text.split_whitespace().filter(|w| !(w.starts_with('[') && w.ends_with(']'))).collect();
    let mut out = words.join(" ");
    if upper_case {
        let lower = out.to_lowercase();
        let mut chars = lower.chars();
        out = chars.next().map(|c| c.to_uppercase().chain(chars).collect()).unwrap_or_default();
    }
    out
}

#[derive(Default)]
struct State {
    recording: Option<(audio::Recording, std::time::Instant)>,
    /// Model + language of `recognizer` / of the load in progress.
    recognizer: Option<(String, Arc<Recognizer>)>,
    loading: Option<(String, JoinHandle<Result<Recognizer>>)>,
    downloads: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

fn key(model: &str, language: Option<&str>) -> String {
    format!("{model}|{}", language.unwrap_or(""))
}

impl State {
    /// Starts loading the model in the background unless it is loaded or loading.
    fn prepare(&mut self, root: &Path, model: &'static models::Model, language: Option<&str>) {
        let k = key(model.id, language);
        if self.recognizer.as_ref().is_some_and(|r| r.0 == k) || self.loading.as_ref().is_some_and(|l| l.0 == k) {
            return;
        }
        let (root, lang) = (root.to_path_buf(), language.map(str::to_string));
        self.loading = Some((k, std::thread::spawn(move || load(&root, model, lang.as_deref()))));
    }

    fn recognizer(&mut self, root: &Path, model: &'static models::Model, language: Option<&str>) -> Result<Arc<Recognizer>> {
        self.prepare(root, model, language);
        let k = key(model.id, language);
        if let Some((lk, handle)) = self.loading.take() {
            let loaded = handle.join().map_err(|_| anyhow!("the speech engine crashed while loading"))?;
            if lk == k {
                // A failed load is reported now and retried next time.
                self.recognizer = Some((lk, Arc::new(loaded?)));
            } else if let Ok(r) = loaded {
                self.recognizer = Some((lk, Arc::new(r)));
            }
        }
        match &self.recognizer {
            Some((rk, r)) if *rk == k => Ok(r.clone()),
            _ => Ok(Arc::new(load(root, model, language)?)),
        }
    }
}

fn arg<'a>(req: &'a Value, name: &str) -> Result<&'a str> {
    req[name].as_str().with_context(|| format!("missing {name:?}"))
}

fn handle(state: &mut State, req: &Value) -> Result<Option<Value>> {
    let root = || arg(req, "dir").map(PathBuf::from);
    let model = || arg(req, "model").and_then(models::find);
    let language = req["language"].as_str();
    Ok(Some(match arg(req, "cmd")? {
        "ping" => json!("pong"),
        "models" => json!(models::list(&root()?)),
        "devices" => json!(audio::devices().into_iter().map(|(name, default)| json!({"name": name, "default": default})).collect::<Vec<_>>()),
        "download" => {
            let (root, model, id) = (root()?, model()?, req["id"].clone());
            let cancel = Arc::new(AtomicBool::new(false));
            {
                let mut d = state.downloads.lock().unwrap();
                if d.contains_key(model.id) {
                    bail!("already downloading");
                }
                d.insert(model.id.to_string(), cancel.clone());
            }
            let downloads = state.downloads.clone();
            std::thread::spawn(move || {
                let mut last = std::time::Instant::now();
                let r = models::install(model, &root, &cancel, &mut |done, total| {
                    if last.elapsed().as_millis() >= 200 || done == total {
                        last = std::time::Instant::now();
                        send(json!({"event": "download", "model": model.id, "done": done, "total": total}));
                    }
                });
                downloads.lock().unwrap().remove(model.id);
                reply(&id, r.map(|_| json!(true)));
            });
            return Ok(None);
        }
        "download_cancel" => {
            if let Some(c) = state.downloads.lock().unwrap().get(arg(req, "model")?) {
                c.store(true, Ordering::Relaxed);
            }
            json!(true)
        }
        "delete" => {
            let model = model()?;
            if state.recognizer.as_ref().is_some_and(|r| r.0.starts_with(&format!("{}|", model.id))) {
                state.recognizer = None;
            }
            let dir = model.dir(&root()?);
            if dir.exists() {
                std::fs::remove_dir_all(&dir).with_context(|| format!("delete {}", dir.display()))?;
            }
            json!(true)
        }
        "start" => {
            if state.recording.is_some() {
                bail!("already recording");
            }
            let (root, model) = (root()?, model()?);
            if !model.installed(&root) {
                bail!("the {} model is not downloaded", model.label);
            }
            let level: audio::LevelFn = Arc::new(|rms| send(json!({"event": "level", "rms": rms})));
            let rec = audio::start(req["device"].as_str(), level)?;
            state.recording = Some((rec, std::time::Instant::now()));
            // Loads while the user speaks.
            state.prepare(&root, model, language);
            json!(true)
        }
        "stop" => {
            let (rec, since) = state.recording.take().context("not recording")?;
            let audio = rec.finish();
            let r = state.recognizer(&root()?, model()?, language)?;
            let text = transcribe(&r, audio.rate, &audio.samples);
            json!({"text": text, "seconds": since.elapsed().as_secs_f32()})
        }
        "cancel" => {
            if let Some((rec, _)) = state.recording.take() {
                rec.finish();
            }
            json!(true)
        }
        "transcribe" => {
            let path = arg(req, "path")?;
            let wave = sherpa_onnx::Wave::read(path).with_context(|| format!("cannot read {path}"))?;
            let r = state.recognizer(&root()?, model()?, language)?;
            let started = std::time::Instant::now();
            let text = transcribe(&r, wave.sample_rate() as u32, wave.samples());
            json!({"text": text, "decode_seconds": started.elapsed().as_secs_f32()})
        }
        "unload" => {
            state.recognizer = None;
            json!(true)
        }
        other => bail!("unknown command {other:?}"),
    }))
}

fn main() {
    let mut state = State::default();
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let req: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                send(json!({"id": null, "err": format!("bad request: {e}")}));
                continue;
            }
        };
        match handle(&mut state, &req) {
            Ok(Some(v)) => reply(&req["id"], Ok(v)),
            Ok(None) => {}
            Err(e) => reply(&req["id"], Err(e)),
        }
    }
    // Stdin closed: the app is gone. Stop downloads (their partial files are removed).
    for c in state.downloads.lock().unwrap().values() {
        c.store(true, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tidies_text() {
        assert_eq!(tidy("  NHỮNG NƠI   ĐÃ KHỐNG CHẾ ", true), "Những nơi đã khống chế");
        assert_eq!(tidy(" Please open the project. [BLANK_AUDIO]", false), "Please open the project.");
        assert_eq!(tidy("", true), "");
    }

    #[test]
    fn silence_gate_uses_the_loudest_window() {
        let rate = 16_000;
        let mut audio = vec![0.005f32; rate as usize * 2];
        assert!(loudest_window(rate, &audio) < SILENCE, "room noise");
        for (i, v) in audio[8000..9600].iter_mut().enumerate() {
            *v = if i % 2 == 0 { 0.2 } else { -0.2 };
        }
        assert!(loudest_window(rate, &audio) > SILENCE, "a short loud word");
    }
}
