//! Git integration via the `git` CLI (same behaviour as the user's terminal, hooks included).
//! At most `GIT_CONCURRENCY` git processes run at once so a burst of watcher events across
//! projects can never fork-bomb the machine.

use std::path::Path;
use std::process::Stdio;
use std::sync::LazyLock;

use serde::Serialize;
use tokio::sync::Semaphore;

use crate::fs_ops::{err, guard, CmdResult};

const GIT_CONCURRENCY: usize = 3;
static GIT_SLOTS: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(GIT_CONCURRENCY));

pub struct GitOutput {
    pub ok: bool,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

pub async fn git(cwd: &Path, args: &[&str]) -> CmdResult<GitOutput> {
    let _slot = GIT_SLOTS.acquire().await.map_err(err)?;
    let mut cmd = tokio::process::Command::new("git");
    cmd.args(["-c", "core.quotepath=off", "-c", "color.ui=false"])
        .args(args)
        .current_dir(cwd)
        .env("GIT_OPTIONAL_LOCKS", "0") // never fight the user's own git for index.lock
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flash from a GUI app
    let out = cmd.output().await.map_err(|e| format!("git: {e}"))?;
    Ok(GitOutput { ok: out.status.success(), stdout: out.stdout, stderr: String::from_utf8_lossy(&out.stderr).into_owned() })
}

async fn git_ok(cwd: &Path, args: &[&str]) -> CmdResult<String> {
    let out = git(cwd, args).await?;
    if !out.ok {
        return Err(out.stderr.trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[derive(Serialize, Default)]
pub struct GitStatus {
    is_repo: bool,
    branch: Option<String>,
    upstream: Option<String>,
    ahead: i64,
    behind: i64,
    files: Vec<GitFile>,
    truncated: bool,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct GitFile {
    path: String,
    orig_path: Option<String>,
    /// Index (staged) status letter, '.' when unchanged; '?' untracked; 'U' conflict.
    index: char,
    /// Working tree status letter.
    worktree: char,
}

const MAX_STATUS_FILES: usize = 5000;

/// Parses `git status --porcelain=v2 -z --branch`.
pub fn parse_status(raw: &[u8]) -> GitStatus {
    let mut st = GitStatus { is_repo: true, ..Default::default() };
    let text = String::from_utf8_lossy(raw);
    let mut records = text.split('\0').peekable();
    while let Some(rec) = records.next() {
        if rec.is_empty() {
            continue;
        }
        if let Some(rest) = rec.strip_prefix("# ") {
            let mut parts = rest.splitn(2, ' ');
            let (key, value) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
            match key {
                "branch.head" if value != "(detached)" => st.branch = Some(value.to_string()),
                "branch.upstream" => st.upstream = Some(value.to_string()),
                "branch.ab" => {
                    for n in value.split(' ') {
                        if let Some(a) = n.strip_prefix('+') {
                            st.ahead = a.parse().unwrap_or(0);
                        } else if let Some(b) = n.strip_prefix('-') {
                            st.behind = b.parse().unwrap_or(0);
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        if st.files.len() >= MAX_STATUS_FILES {
            st.truncated = true;
            break;
        }
        let kind = rec.as_bytes()[0];
        let fields: Vec<&str> = rec.splitn(match kind { b'1' => 9, b'2' => 10, b'u' => 11, _ => 2 }, ' ').collect();
        match kind {
            b'1' | b'2' | b'u' => {
                let xy: Vec<char> = fields.get(1).map(|s| s.chars().collect()).unwrap_or_default();
                let path = fields.last().copied().unwrap_or("").to_string();
                // Renames carry the original path as the next NUL-separated record.
                let orig_path = if kind == b'2' { records.next().map(str::to_string) } else { None };
                let (index, worktree) = if kind == b'u' { ('U', 'U') } else { (xy.first().copied().unwrap_or('.'), xy.get(1).copied().unwrap_or('.')) };
                st.files.push(GitFile { path, orig_path, index, worktree });
            }
            b'?' => st.files.push(GitFile { path: rec[2..].to_string(), orig_path: None, index: '?', worktree: '?' }),
            _ => {}
        }
    }
    st
}

#[tauri::command]
pub async fn git_status(root: String) -> CmdResult<GitStatus> {
    let dir = guard(&root, "")?;
    let out = git(&dir, &["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"]).await?;
    if !out.ok {
        return Ok(GitStatus::default()); // not a repository
    }
    Ok(parse_status(&out.stdout))
}

#[derive(Serialize)]
pub struct BranchInfo {
    is_repo: bool,
    branch: Option<String>,
    /// Tracked files changed (untracked files are not scanned: this runs for every project).
    dirty: bool,
    ahead: i64,
    behind: i64,
}

/// Cheap per-project summary for the sidebar (`-uno` skips the untracked walk).
#[tauri::command]
pub async fn git_branch_info(root: String) -> CmdResult<BranchInfo> {
    let dir = guard(&root, "")?;
    let out = git(&dir, &["status", "--porcelain=v2", "-z", "--branch", "-uno"]).await?;
    if !out.ok {
        return Ok(BranchInfo { is_repo: false, branch: None, dirty: false, ahead: 0, behind: 0 });
    }
    let st = parse_status(&out.stdout);
    Ok(BranchInfo { is_repo: true, dirty: !st.files.is_empty(), branch: st.branch, ahead: st.ahead, behind: st.behind })
}

#[derive(Serialize)]
pub struct FileVersions {
    /// Content at HEAD (None when the file is new).
    original: Option<String>,
    /// Working tree (or index when `staged`) content (None when deleted).
    modified: Option<String>,
}

#[tauri::command]
pub async fn git_file_versions(root: String, path: String, staged: bool) -> CmdResult<FileVersions> {
    let dir = guard(&root, "")?;
    let full = guard(&root, &path)?;
    let head = git(&dir, &["show", &format!("HEAD:{path}")]).await?;
    let original = head.ok.then(|| String::from_utf8_lossy(&head.stdout).into_owned());
    let modified = if staged {
        let idx = git(&dir, &["show", &format!(":{path}")]).await?;
        idx.ok.then(|| String::from_utf8_lossy(&idx.stdout).into_owned())
    } else {
        std::fs::read(&full).ok().map(|b| String::from_utf8_lossy(&b).into_owned())
    };
    Ok(FileVersions { original, modified })
}

#[tauri::command]
pub async fn git_stage(root: String, paths: Vec<String>, stage: bool) -> CmdResult<()> {
    let dir = guard(&root, "")?;
    for p in &paths {
        guard(&root, p)?;
    }
    let mut args: Vec<&str> = if stage { vec!["add", "--"] } else { vec!["restore", "--staged", "--"] };
    args.extend(paths.iter().map(String::as_str));
    git_ok(&dir, &args).await.map(|_| ())
}

/// Discards working-tree changes. Untracked files go to the OS trash.
#[tauri::command]
pub async fn git_discard(root: String, paths: Vec<String>, untracked: Vec<String>) -> CmdResult<()> {
    let dir = guard(&root, "")?;
    for p in &untracked {
        trash::delete(guard(&root, p)?).map_err(err)?;
    }
    if paths.is_empty() {
        return Ok(());
    }
    for p in &paths {
        guard(&root, p)?;
    }
    let mut args = vec!["restore", "--worktree", "--"];
    args.extend(paths.iter().map(String::as_str));
    git_ok(&dir, &args).await.map(|_| ())
}

#[tauri::command]
pub async fn git_commit(root: String, message: String, amend: bool) -> CmdResult<String> {
    let dir = guard(&root, "")?;
    let mut args = vec!["commit", "-m", message.as_str()];
    if amend {
        args.push("--amend");
    }
    git_ok(&dir, &args).await
}

#[derive(Serialize)]
pub struct Worktree {
    path: String,
    head: Option<String>,
    branch: Option<String>,
    bare: bool,
    detached: bool,
}

#[tauri::command]
pub async fn git_worktrees(root: String) -> CmdResult<Vec<Worktree>> {
    let dir = guard(&root, "")?;
    let out = git_ok(&dir, &["worktree", "list", "--porcelain"]).await?;
    let mut list = Vec::new();
    for block in out.split("\n\n") {
        let mut wt = Worktree { path: String::new(), head: None, branch: None, bare: false, detached: false };
        for line in block.lines() {
            if let Some(p) = line.strip_prefix("worktree ") {
                wt.path = p.to_string();
            } else if let Some(h) = line.strip_prefix("HEAD ") {
                wt.head = Some(h.to_string());
            } else if let Some(b) = line.strip_prefix("branch ") {
                wt.branch = Some(b.trim_start_matches("refs/heads/").to_string());
            } else if line == "bare" {
                wt.bare = true;
            } else if line == "detached" {
                wt.detached = true;
            }
        }
        if !wt.path.is_empty() {
            list.push(wt);
        }
    }
    Ok(list)
}

/// Creates `branch` from `base` in a new worktree at `path` (absolute).
#[tauri::command]
pub async fn git_worktree_add(root: String, path: String, branch: String, base: Option<String>) -> CmdResult<()> {
    let dir = guard(&root, "")?;
    let mut args = vec!["worktree", "add", "-b", branch.as_str(), path.as_str()];
    if let Some(b) = base.as_deref() {
        args.push(b);
    }
    git_ok(&dir, &args).await.map(|_| ())
}

#[tauri::command]
pub async fn git_worktree_remove(root: String, path: String, force: bool) -> CmdResult<()> {
    let dir = guard(&root, "")?;
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(path.as_str());
    git_ok(&dir, &args).await.map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_v2() {
        let raw = b"# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0\
1 .M N... 100644 100644 100644 aaa bbb src/a b.rs\0\
2 R. N... 100644 100644 100644 aaa bbb R100 new.rs\0old.rs\0\
u UU N... 100644 100644 100644 100644 a b c conflict.rs\0\
? notes.txt\0";
        let st = parse_status(raw);
        assert_eq!(st.branch.as_deref(), Some("main"));
        assert_eq!((st.ahead, st.behind), (2, 1));
        assert_eq!(st.files.len(), 4);
        assert_eq!(st.files[0], GitFile { path: "src/a b.rs".into(), orig_path: None, index: '.', worktree: 'M' });
        assert_eq!(st.files[1].orig_path.as_deref(), Some("old.rs"));
        assert_eq!(st.files[1].path, "new.rs");
        assert_eq!(st.files[2].index, 'U');
        assert_eq!(st.files[3].path, "notes.txt");
    }
}
