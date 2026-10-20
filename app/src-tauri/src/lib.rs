//! Erka desktop app (Tauri). The UI process owns no PTYs: terminals and agent processes
//! live in `erkad`; this crate relays them to the webview and serves file/git/search
//! commands for the workbench.

mod agent_history;
mod daemon_client;
mod fs_ops;
mod git;
mod search;
mod sys_stats;
mod usage;
mod watcher;

use std::sync::Arc;

use daemon_client::DaemonClient;
use fs_ops::{err, CmdResult};
use serde_json::Value;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{Manager, State};

#[tauri::command]
async fn daemon_call(client: State<'_, Arc<DaemonClient>>, method: String, params: Value) -> CmdResult<Value> {
    client.call(&method, params).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn term_attach(client: State<'_, Arc<DaemonClient>>, handle: u32, since: Option<u64>, channel: Channel<InvokeResponseBody>) -> CmdResult<Value> {
    client.attach(handle, since, channel).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn term_detach(client: State<'_, Arc<DaemonClient>>, handle: u32) -> CmdResult<()> {
    client.detach(handle).await.map_err(|e| e.to_string())
}

/// Keystrokes / paste / chat JSON lines. Sent as a binary frame, never JSON-wrapped.
/// `binary`: xterm "binary strings" (one byte per char, e.g. legacy mouse reports).
#[tauri::command]
fn term_input(client: State<'_, Arc<DaemonClient>>, handle: u32, data: String, binary: Option<bool>) -> CmdResult<()> {
    let bytes = if binary.unwrap_or(false) { data.chars().map(|c| c as u32 as u8).collect() } else { data.into_bytes() };
    client.input(handle, bytes).map_err(|e| e.to_string())
}

/// App UI state (projects, layouts, settings) — a single JSON document owned by the UI.
#[tauri::command]
fn state_load() -> CmdResult<Value> {
    let path = erka_proto::data_dir().join("app-state.json");
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(err),
        Err(_) => Ok(Value::Null),
    }
}

#[tauri::command]
fn state_save(state: Value) -> CmdResult<()> {
    let dir = erka_proto::data_dir();
    std::fs::create_dir_all(&dir).map_err(err)?;
    let path = dir.join("app-state.json");
    let tmp = dir.join("app-state.json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&state).map_err(err)?).map_err(err)?;
    std::fs::rename(&tmp, &path).map_err(err)
}

#[tauri::command]
fn platform_info() -> Value {
    serde_json::json!({
        "os": std::env::consts::OS,
        "home": std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default(),
        "data_dir": erka_proto::data_dir(),
        // The daemon feature level this app was built against.
        "api": erka_proto::API_LEVEL,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let index = Arc::new(search::FileIndex::default());
            app.manage(DaemonClient::start(app.handle().clone()));
            app.manage(watcher::Watchers::new(app.handle().clone(), index.clone()));
            app.manage(index);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            daemon_call,
            term_attach,
            term_detach,
            term_input,
            state_load,
            state_save,
            platform_info,
            fs_ops::fs_list_dir,
            fs_ops::fs_read_file,
            fs_ops::fs_write_file,
            fs_ops::fs_create,
            fs_ops::fs_rename,
            fs_ops::fs_delete,
            fs_ops::fs_reveal,
            search::quick_open,
            search::search_text,
            watcher::fs_watch,
            watcher::fs_unwatch,
            git::git_status,
            git::git_branch_info,
            git::git_file_versions,
            git::git_stage,
            git::git_discard,
            git::git_commit,
            git::git_worktrees,
            git::git_worktree_add,
            git::git_worktree_remove,
            agent_history::agent_latest_session,
            agent_history::agent_claude_transcript,
            agent_history::agent_history_list,
            usage::usage_fetch,
            sys_stats::memory_stats,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Erka");
}
