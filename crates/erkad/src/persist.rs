//! Durable session metadata (`sessions.json`) and last-screen snapshots (`snapshots/<id>.ansi`).
//! All writes are atomic (temp file + rename) so a crash never leaves a torn file.

use std::path::{Path, PathBuf};

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::session::SessionSpec;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedSession {
    pub spec: SessionSpec,
    #[serde(default)]
    pub title: Option<String>,
    pub cols: u16,
    pub rows: u16,
    #[serde(default)]
    pub chat: bool,
    #[serde(default)]
    pub last_activity: u64,
    /// Running (or interrupted and not yet resumed) when saved. Files from before this field
    /// count every session as running.
    #[serde(default = "yes")]
    pub alive: bool,
}

fn yes() -> bool {
    true
}

pub struct Store {
    dir: PathBuf,
}

impl Store {
    pub fn new(dir: &Path) -> Store {
        let _ = std::fs::create_dir_all(dir.join("snapshots"));
        Store { dir: dir.to_path_buf() }
    }

    pub fn load_sessions(&self) -> Vec<SavedSession> {
        std::fs::read(self.dir.join("sessions.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    pub fn save_sessions(&self, sessions: &[SavedSession]) -> Result<()> {
        write_atomic(&self.dir.join("sessions.json"), &serde_json::to_vec_pretty(sessions)?)
    }

    fn snapshot_path(&self, id: &str) -> PathBuf {
        let safe: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
        self.dir.join("snapshots").join(format!("{safe}.ansi"))
    }

    pub fn save_snapshot(&self, id: &str, data: &[u8]) -> Result<()> {
        write_atomic(&self.snapshot_path(id), data)
    }

    pub fn load_snapshot(&self, id: &str) -> Option<Vec<u8>> {
        std::fs::read(self.snapshot_path(id)).ok()
    }

    pub fn remove_snapshot(&self, id: &str) {
        let _ = std::fs::remove_file(self.snapshot_path(id));
    }
}

pub fn write_atomic(path: &Path, data: &[u8]) -> Result<()> {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    // Unique temp name: concurrent writers (ticker vs shutdown) never share a temp file.
    let tmp = path.with_extension(format!("{}.{n}.tmp", std::process::id()));
    std::fs::write(&tmp, data)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sessions_saved_before_alive_existed_count_as_running() {
        let old = r#"[{"spec":{"id":"a","kind":"shell","cwd":"."},"cols":80,"rows":24}]"#;
        let saved: Vec<SavedSession> = serde_json::from_str(old).unwrap();
        assert!(saved[0].alive);
        let stopped = r#"[{"spec":{"id":"a","kind":"shell","cwd":"."},"cols":80,"rows":24,"alive":false}]"#;
        let saved: Vec<SavedSession> = serde_json::from_str(stopped).unwrap();
        assert!(!saved[0].alive);
    }
}
