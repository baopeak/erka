//! Read access to agents' own on-disk session stores, used when switching a CLI session to
//! chat mode (history + resume id discovery). These formats are internal to each agent, so
//! everything here is defensive: unknown lines are passed through for the UI to skip.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::Serialize;

use crate::fs_ops::{err, CmdResult};

fn home() -> PathBuf {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from).unwrap_or_default()
}

fn claude_dir() -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from).unwrap_or_else(|| home().join(".claude"))
}

/// Claude Code names project dirs after the cwd with every non-alphanumeric char → '-'.
fn claude_project_dir(cwd: &str) -> PathBuf {
    let escaped: String = cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    claude_dir().join("projects").join(escaped)
}

fn newest(files: impl Iterator<Item = PathBuf>) -> Option<PathBuf> {
    files
        .filter_map(|p| Some((std::fs::metadata(&p).ok()?.modified().ok()?, p)))
        .max_by_key(|(t, _)| *t)
        .map(|(_, p)| p)
}

fn jsonl_in(dir: &Path) -> impl Iterator<Item = PathBuf> {
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|e| e == "jsonl"))
}

#[derive(Serialize)]
pub struct AgentSessionRef {
    id: String,
    /// Session file (OMP resumes by path).
    path: String,
}

/// Most recent session of `kind` started in `cwd` (Claude / OMP; Codex uses `thread/list`).
#[tauri::command]
pub fn agent_latest_session(kind: String, cwd: String) -> CmdResult<Option<AgentSessionRef>> {
    match kind.as_str() {
        "claude" => Ok(newest(jsonl_in(&claude_project_dir(&cwd))).map(|p| AgentSessionRef {
            id: p.file_stem().unwrap_or_default().to_string_lossy().into_owned(),
            path: p.to_string_lossy().into_owned(),
        })),
        "omp" => {
            let root = home().join(".omp/agent/sessions");
            let mut files: Vec<(SystemTime, PathBuf)> = std::fs::read_dir(&root)
                .map_err(err)?
                .filter_map(|e| e.ok())
                .flat_map(|d| jsonl_in(&d.path()).collect::<Vec<_>>())
                .filter_map(|p| Some((std::fs::metadata(&p).ok()?.modified().ok()?, p)))
                .collect();
            files.sort_by(|a, b| b.0.cmp(&a.0));
            let want = normalize_cwd(&cwd);
            for (_, path) in files.into_iter().take(300) {
                let Ok(file) = std::fs::File::open(&path) else { continue };
                for line in BufReader::new(file).lines().take(4).map_while(Result::ok) {
                    let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
                    if v["type"] == "session" && v["cwd"].as_str().map(normalize_cwd) == Some(want.clone()) {
                        return Ok(Some(AgentSessionRef {
                            id: v["id"].as_str().unwrap_or_default().to_string(),
                            path: path.to_string_lossy().into_owned(),
                        }));
                    }
                }
            }
            Ok(None)
        }
        _ => Ok(None),
    }
}

fn normalize_cwd(p: &str) -> String {
    let s = p.replace('\\', "/");
    let s = s.trim_end_matches('/');
    if cfg!(windows) { s.to_lowercase() } else { s.to_string() }
}

/// Raw JSONL lines of a Claude Code transcript (tail, capped), for rendering chat history.
#[tauri::command]
pub fn agent_claude_transcript(session_id: String, cwd: Option<String>) -> CmdResult<Vec<String>> {
    let file_name = format!("{session_id}.jsonl");
    if file_name.contains(['/', '\\']) {
        return Err("invalid session id".into());
    }
    let direct = cwd.map(|c| claude_project_dir(&c).join(&file_name)).filter(|p| p.exists());
    let path = match direct {
        Some(p) => p,
        None => std::fs::read_dir(claude_dir().join("projects"))
            .map_err(err)?
            .filter_map(|e| e.ok())
            .map(|d| d.path().join(&file_name))
            .find(|p| p.exists())
            .ok_or_else(|| format!("transcript {session_id} not found"))?,
    };
    let file = std::fs::File::open(path).map_err(err)?;
    let mut lines: Vec<String> = BufReader::new(file).lines().map_while(Result::ok).collect();
    const MAX_LINES: usize = 6000;
    if lines.len() > MAX_LINES {
        lines.drain(..lines.len() - MAX_LINES);
    }
    Ok(lines)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_like_claude() {
        let p = claude_project_dir("C:\\Windows\\System32");
        assert!(p.ends_with("C--Windows-System32"));
    }
}
