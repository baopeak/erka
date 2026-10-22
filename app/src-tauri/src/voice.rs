//! Voice dictation: talks to the `erka-stt` helper (crates/erka-stt) over its stdin/stdout JSON
//! lines. The helper starts on first use and exits after ten idle minutes, freeing the loaded
//! model's memory. Its events (`level` while recording, `download` progress) are re-emitted to
//! the UI as `voice-event`. Models live in `<data>/speech-models`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::oneshot;

use crate::fs_ops::CmdResult;

const IDLE_EXIT: Duration = Duration::from_secs(600);

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

struct Helper {
    stdin: tokio::sync::Mutex<tokio::process::ChildStdin>,
    pending: Pending,
    next: AtomicU64,
    last_use: Mutex<Instant>,
    /// Recording or downloading: never stopped for idleness.
    busy: AtomicU64,
}

static HELPER: Mutex<Option<Arc<Helper>>> = Mutex::new(None);

fn models_dir() -> PathBuf {
    erka_proto::data_dir().join("speech-models")
}

/// `ERKA_STT_PATH`, else next to our executable; a dev build (target/debug) also finds the
/// helper in target/release, where it is built (`cargo build --release -p erka-stt`).
fn helper_path() -> Option<PathBuf> {
    let name = if cfg!(windows) { "erka-stt.exe" } else { "erka-stt" };
    if let Some(p) = std::env::var_os("ERKA_STT_PATH") {
        return Some(PathBuf::from(p));
    }
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let beside = dir.join(name);
    if beside.is_file() {
        return Some(beside);
    }
    let dev = dir.parent()?.join("release").join(name);
    (cfg!(debug_assertions) && dev.is_file()).then_some(dev)
}

fn spawn(app: &AppHandle) -> CmdResult<Arc<Helper>> {
    let exe = helper_path().filter(|p| p.is_file()).ok_or("the speech helper (erka-stt) is not installed with this build")?;
    let mut cmd = tokio::process::Command::new(exe);
    cmd.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let mut child = cmd.spawn().map_err(|e| format!("start the speech helper: {e}"))?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let helper = Arc::new(Helper {
        stdin: tokio::sync::Mutex::new(stdin),
        pending: Arc::default(),
        next: AtomicU64::new(1),
        last_use: Mutex::new(Instant::now()),
        busy: AtomicU64::new(0),
    });
    let (app2, me) = (app.clone(), Arc::downgrade(&helper));
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
            if let Some(id) = msg["id"].as_u64() {
                let Some(h) = me.upgrade() else { break };
                let waiting = h.pending.lock().remove(&id);
                if let Some(tx) = waiting {
                    let _ = tx.send(match msg.get("err") {
                        Some(e) => Err(e.as_str().unwrap_or("speech helper error").to_string()),
                        None => Ok(msg["ok"].clone()),
                    });
                }
            } else if msg.get("event").is_some() {
                let _ = app2.emit_to("main", "voice-event", msg);
            }
        }
        // Exited (or crashed): fail what was waiting and start a fresh one next time.
        if let Some(h) = me.upgrade() {
            for (_, tx) in h.pending.lock().drain() {
                let _ = tx.send(Err("the speech helper stopped".into()));
            }
            let mut slot = HELPER.lock();
            if slot.as_ref().is_some_and(|x| Arc::ptr_eq(x, &h)) {
                *slot = None;
            }
        }
        drop(child);
    });
    // Idle exit.
    let me = Arc::downgrade(&helper);
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            let Some(h) = me.upgrade() else { break };
            if h.busy.load(Ordering::Relaxed) == 0 && h.pending.lock().is_empty() && h.last_use.lock().elapsed() > IDLE_EXIT {
                let mut slot = HELPER.lock();
                if slot.as_ref().is_some_and(|x| Arc::ptr_eq(x, &h)) {
                    *slot = None; // dropping the last handle closes stdin: the helper exits
                }
                break;
            }
        }
    });
    Ok(helper)
}

fn helper(app: &AppHandle) -> CmdResult<Arc<Helper>> {
    let mut slot = HELPER.lock();
    if let Some(h) = slot.as_ref() {
        return Ok(h.clone());
    }
    let h = spawn(app)?;
    *slot = Some(h.clone());
    Ok(h)
}

async fn call(app: &AppHandle, cmd: &str, mut args: Value, timeout: Option<Duration>) -> CmdResult<Value> {
    let h = helper(app)?;
    *h.last_use.lock() = Instant::now();
    let id = h.next.fetch_add(1, Ordering::Relaxed);
    args["id"] = json!(id);
    args["cmd"] = json!(cmd);
    args["dir"] = json!(models_dir());
    let (tx, rx) = oneshot::channel();
    h.pending.lock().insert(id, tx);
    {
        let mut stdin = h.stdin.lock().await;
        let line = format!("{args}\n");
        if let Err(e) = stdin.write_all(line.as_bytes()).await {
            h.pending.lock().remove(&id);
            return Err(format!("speech helper: {e}"));
        }
        let _ = stdin.flush().await;
    }
    let out = match timeout {
        Some(t) => tokio::time::timeout(t, rx).await.map_err(|_| {
            h.pending.lock().remove(&id);
            format!("the speech helper did not answer {cmd} in time")
        })?,
        None => rx.await,
    };
    *h.last_use.lock() = Instant::now();
    out.map_err(|_| "the speech helper stopped".to_string())?
}

const SHORT: Option<Duration> = Some(Duration::from_secs(20));
/// Loading a model and decoding a long recording can take a while on a slow machine.
const LONG: Option<Duration> = Some(Duration::from_secs(300));

fn busy(delta: i64) {
    if let Some(h) = HELPER.lock().as_ref() {
        if delta > 0 {
            h.busy.fetch_add(1, Ordering::Relaxed);
        } else {
            let _ = h.busy.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |v| v.checked_sub(1));
        }
    }
}

#[tauri::command]
pub fn voice_available() -> bool {
    helper_path().is_some_and(|p| p.is_file())
}

#[tauri::command]
pub async fn voice_models(app: AppHandle) -> CmdResult<Value> {
    call(&app, "models", json!({}), SHORT).await
}

#[tauri::command]
pub async fn voice_devices(app: AppHandle) -> CmdResult<Value> {
    call(&app, "devices", json!({}), SHORT).await
}

#[tauri::command]
pub async fn voice_download(app: AppHandle, model: String) -> CmdResult<Value> {
    helper(&app)?;
    busy(1);
    let r = call(&app, "download", json!({"model": model}), None).await;
    busy(-1);
    r
}

#[tauri::command]
pub async fn voice_download_cancel(app: AppHandle, model: String) -> CmdResult<Value> {
    call(&app, "download_cancel", json!({"model": model}), SHORT).await
}

#[tauri::command]
pub async fn voice_delete(app: AppHandle, model: String) -> CmdResult<Value> {
    call(&app, "delete", json!({"model": model}), SHORT).await
}

#[tauri::command]
pub async fn voice_start(app: AppHandle, model: String, language: Option<String>, device: Option<String>) -> CmdResult<Value> {
    let r = call(&app, "start", json!({"model": model, "language": language, "device": device}), SHORT).await;
    if r.is_ok() {
        busy(1);
    }
    r
}

#[tauri::command]
pub async fn voice_stop(app: AppHandle, model: String, language: Option<String>) -> CmdResult<Value> {
    let r = call(&app, "stop", json!({"model": model, "language": language}), LONG).await;
    busy(-1);
    r
}

#[tauri::command]
pub async fn voice_cancel(app: AppHandle) -> CmdResult<Value> {
    let r = call(&app, "cancel", json!({}), SHORT).await;
    busy(-1);
    r
}

#[tauri::command]
pub async fn voice_transcribe(app: AppHandle, model: String, language: Option<String>, path: String) -> CmdResult<Value> {
    call(&app, "transcribe", json!({"model": model, "language": language, "path": path}), LONG).await
}
