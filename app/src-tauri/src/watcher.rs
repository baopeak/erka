//! Recursive file watching for the projects the user is looking at (active + recent).
//!
//! Raw notify events are filtered (dependency/build dirs, `.git` internals except the files
//! that change git status) and coalesced for 150 ms, then emitted as one `fs-changed` event
//! per root with the set of affected directories, so the explorer reloads only those.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use serde_json::json;
use tauri::{AppHandle, Emitter};

use crate::fs_ops::{err, CmdResult};
use crate::search::FileIndex;

const IGNORED_DIRS: &[&str] = &["node_modules", "target", "dist", "build", ".next", ".venv", "__pycache__", ".cache", ".turbo"];
const DEBOUNCE: Duration = Duration::from_millis(150);

#[derive(Default)]
struct Pending {
    dirs: BTreeSet<String>,
    git: bool,
    structural: bool,
}

pub struct Watchers {
    app: AppHandle,
    index: Arc<FileIndex>,
    active: Mutex<HashMap<String, RecommendedWatcher>>,
    pending: Arc<Mutex<HashMap<String, Pending>>>,
    wake: Arc<tokio::sync::Notify>,
}

impl Watchers {
    pub fn new(app: AppHandle, index: Arc<FileIndex>) -> Arc<Watchers> {
        let w = Arc::new(Watchers {
            app,
            index,
            active: Mutex::new(HashMap::new()),
            pending: Arc::new(Mutex::new(HashMap::new())),
            wake: Arc::new(tokio::sync::Notify::new()),
        });
        tauri::async_runtime::spawn(w.clone().flush_loop());
        w
    }

    async fn flush_loop(self: Arc<Self>) {
        loop {
            self.wake.notified().await;
            tokio::time::sleep(DEBOUNCE).await;
            let batch: Vec<(String, Pending)> = self.pending.lock().drain().collect();
            for (root, p) in batch {
                if p.structural {
                    self.index.invalidate(&root);
                }
                let _ = self.app.emit("fs-changed", json!({"root": root, "dirs": p.dirs, "git": p.git}));
            }
        }
    }

    pub fn watch(&self, root: &str) -> CmdResult<()> {
        if self.active.lock().contains_key(root) {
            return Ok(());
        }
        let root_path = PathBuf::from(root);
        let (pending, wake, key) = (self.pending.clone(), self.wake.clone(), root.to_string());
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            let Ok(event) = res else { return };
            if matches!(event.kind, EventKind::Access(_)) {
                return;
            }
            let structural = matches!(event.kind, EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(notify::event::ModifyKind::Name(_)));
            let mut changed = false;
            let mut guard = pending.lock();
            let entry = guard.entry(key.clone()).or_default();
            for path in &event.paths {
                match classify(&root_path, path) {
                    Change::Ignored => {}
                    Change::Git => {
                        entry.git = true;
                        changed = true;
                    }
                    Change::Dir(dir) => {
                        entry.dirs.insert(dir);
                        entry.structural |= structural;
                        // Working-tree edits change `git status` too.
                        entry.git = true;
                        changed = true;
                    }
                }
            }
            if changed {
                drop(guard);
                wake.notify_one();
            }
        })
        .map_err(err)?;
        watcher.watch(Path::new(root), RecursiveMode::Recursive).map_err(err)?;
        self.active.lock().insert(root.to_string(), watcher);
        Ok(())
    }

    pub fn unwatch(&self, root: &str) {
        self.active.lock().remove(root);
    }
}

enum Change {
    Ignored,
    Git,
    /// Parent directory (relative, `/`-separated, "" for root) of the changed entry.
    Dir(String),
}

fn classify(root: &Path, path: &Path) -> Change {
    let Ok(rel) = path.strip_prefix(root) else { return Change::Ignored };
    let parts: Vec<String> = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
    if parts.first().map(String::as_str) == Some(".git") {
        let interesting = matches!(parts.get(1).map(String::as_str), Some("HEAD" | "index" | "refs" | "MERGE_HEAD" | "REBASE_HEAD"));
        return if interesting { Change::Git } else { Change::Ignored };
    }
    if parts.iter().any(|p| IGNORED_DIRS.contains(&p.as_str())) {
        return Change::Ignored;
    }
    Change::Dir(parts[..parts.len().saturating_sub(1)].join("/"))
}

// Creating or dropping a recursive watcher on a large tree can take a long time on Windows;
// off the main thread, a project switch never waits for it.
#[tauri::command]
pub async fn fs_watch(watchers: tauri::State<'_, Arc<Watchers>>, root: String) -> CmdResult<()> {
    // Remote projects have no local folder to watch (their views refresh on demand).
    if crate::remote::is_remote(&root) {
        return Ok(());
    }
    let w = watchers.inner().clone();
    crate::fs_ops::blocking(move || w.watch(&root)).await
}

#[tauri::command]
pub async fn fs_unwatch(watchers: tauri::State<'_, Arc<Watchers>>, root: String) -> CmdResult<()> {
    let w = watchers.inner().clone();
    crate::fs_ops::blocking(move || {
        w.unwatch(&root);
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_paths() {
        let root = Path::new("/p");
        assert!(matches!(classify(root, Path::new("/p/src/a.rs")), Change::Dir(d) if d == "src"));
        assert!(matches!(classify(root, Path::new("/p/a.rs")), Change::Dir(d) if d.is_empty()));
        assert!(matches!(classify(root, Path::new("/p/.git/index")), Change::Git));
        assert!(matches!(classify(root, Path::new("/p/.git/objects/ab/cd")), Change::Ignored));
        assert!(matches!(classify(root, Path::new("/p/web/node_modules/x/y.js")), Change::Ignored));
    }
}
