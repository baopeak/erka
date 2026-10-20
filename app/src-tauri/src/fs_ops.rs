//! File system commands for the explorer and viewer. Every path is checked against the
//! project root the UI passes in, so a crafted path can never escape the workspace.

use std::cmp::Ordering;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use base64::Engine as _;
use serde::Serialize;

pub type CmdResult<T> = Result<T, String>;

pub fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// Lexically normalises `path` and requires it to stay inside `root`.
pub fn guard(root: &str, path: &str) -> CmdResult<PathBuf> {
    let root = normalize(Path::new(root));
    let full = normalize(&root.join(path));
    if !full.starts_with(&root) {
        return Err(format!("path {path} is outside the project"));
    }
    Ok(full)
}

fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[derive(Serialize)]
pub struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
    is_symlink: bool,
    size: u64,
    /// Matched by .gitignore / .ignore (shown dimmed, still listed).
    ignored: bool,
}

/// "file9" < "file10": digit runs compare numerically, the rest case-insensitively.
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut ai, mut bi) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (ai.peek().copied(), bi.peek().copied()) {
            (None, None) => return a.cmp(b),
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let mut na = String::new();
                while let Some(c) = ai.peek().copied().filter(char::is_ascii_digit) {
                    na.push(c);
                    ai.next();
                }
                let mut nb = String::new();
                while let Some(c) = bi.peek().copied().filter(char::is_ascii_digit) {
                    nb.push(c);
                    bi.next();
                }
                let (ta, tb) = (na.trim_start_matches('0'), nb.trim_start_matches('0'));
                let ord = ta.len().cmp(&tb.len()).then_with(|| ta.cmp(tb));
                if ord != Ordering::Equal {
                    return ord;
                }
            }
            (Some(x), Some(y)) => {
                let ord = x.to_lowercase().cmp(y.to_lowercase());
                if ord != Ordering::Equal {
                    return ord;
                }
                ai.next();
                bi.next();
            }
        }
    }
}

/// Whether `path` is an existing folder (no listing, so a large folder costs nothing).
#[tauri::command]
pub fn fs_is_dir(path: String) -> bool {
    std::path::Path::new(&path).is_dir()
}

/// Async + blocking pool: listing a huge folder must never stall the UI thread.
#[tauri::command]
pub async fn fs_list_dir(root: String, path: String) -> CmdResult<Vec<DirEntry>> {
    tauri::async_runtime::spawn_blocking(move || list_dir(&root, &path)).await.map_err(err)?
}

fn list_dir(root: &str, path: &str) -> CmdResult<Vec<DirEntry>> {
    let (root, path) = (root.to_string(), path.to_string());
    let dir = guard(&root, &path)?;
    let mut entries: Vec<DirEntry> = std::fs::read_dir(&dir)
        .map_err(err)?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if name == ".git" {
                return None;
            }
            let file_type = e.file_type().ok()?;
            let is_symlink = file_type.is_symlink();
            let meta = if is_symlink { std::fs::metadata(e.path()).ok() } else { e.metadata().ok() };
            let is_dir = meta.as_ref().is_some_and(|m| m.is_dir());
            let rel = Path::new(&path).join(&name).to_string_lossy().replace('\\', "/");
            Some(DirEntry { name, path: rel.trim_start_matches("./").to_string(), is_dir, is_symlink, size: meta.map(|m| m.len()).unwrap_or(0), ignored: false })
        })
        .collect();
    // One-level, ignore-aware walk: whatever it does not yield is ignored.
    let visible: std::collections::HashSet<std::ffi::OsString> = ignore::WalkBuilder::new(&dir)
        .max_depth(Some(1))
        .hidden(false)
        .parents(true)
        .build()
        .filter_map(|e| e.ok())
        .filter(|e| e.depth() == 1)
        .map(|e| e.file_name().to_os_string())
        .collect();
    for e in &mut entries {
        e.ignored = !visible.contains(std::ffi::OsStr::new(&e.name));
    }
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| natural_cmp(&a.name, &b.name)));
    Ok(entries)
}

#[derive(Serialize)]
pub struct FileContent {
    /// UTF-8 text, or `None` for binary files.
    text: Option<String>,
    /// Base64 payload for images (when requested and small enough).
    base64: Option<String>,
    size: u64,
    mtime: u64,
    truncated: bool,
    binary: bool,
}

fn mtime_of(meta: &std::fs::Metadata) -> u64 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Reads up to `max_bytes`. `as_base64` is for image viewers.
#[tauri::command]
pub fn fs_read_file(root: String, path: String, max_bytes: Option<u64>, as_base64: Option<bool>) -> CmdResult<FileContent> {
    use std::io::Read;
    let full = guard(&root, &path)?;
    let meta = std::fs::metadata(&full).map_err(err)?;
    let limit = max_bytes.unwrap_or(8 << 20);
    let mut buf = Vec::with_capacity(meta.len().min(limit) as usize);
    std::fs::File::open(&full).map_err(err)?.take(limit).read_to_end(&mut buf).map_err(err)?;
    let truncated = meta.len() > limit;
    if as_base64.unwrap_or(false) {
        return Ok(FileContent {
            text: None,
            base64: Some(base64::engine::general_purpose::STANDARD.encode(&buf)),
            size: meta.len(),
            mtime: mtime_of(&meta),
            truncated,
            binary: true,
        });
    }
    let sniff = &buf[..buf.len().min(8192)];
    let binary = sniff.contains(&0);
    let text = if binary {
        None
    } else {
        Some(match String::from_utf8(buf) {
            Ok(s) => s,
            Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
        })
    };
    Ok(FileContent { text, base64: None, size: meta.len(), mtime: mtime_of(&meta), truncated, binary })
}

#[derive(Serialize)]
pub struct WriteResult {
    ok: bool,
    /// Set when the file changed on disk since `expected_mtime` (nothing was written).
    conflict: bool,
    mtime: u64,
}

#[tauri::command]
pub fn fs_write_file(root: String, path: String, content: String, expected_mtime: Option<u64>, force: Option<bool>) -> CmdResult<WriteResult> {
    let full = guard(&root, &path)?;
    if let (Some(expected), false) = (expected_mtime, force.unwrap_or(false)) {
        if let Ok(meta) = std::fs::metadata(&full) {
            let current = mtime_of(&meta);
            if current != expected {
                return Ok(WriteResult { ok: false, conflict: true, mtime: current });
            }
        }
    }
    // Write through symlinks to their target, and keep the file's permissions (exec bit…).
    let full = std::fs::canonicalize(&full).unwrap_or(full);
    let tmp = full.with_extension(format!("{}.erka-tmp", full.extension().and_then(|e| e.to_str()).unwrap_or("")));
    std::fs::write(&tmp, content.as_bytes()).map_err(err)?;
    if let Ok(meta) = std::fs::metadata(&full) {
        let _ = std::fs::set_permissions(&tmp, meta.permissions());
    }
    std::fs::rename(&tmp, &full).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        err(e)
    })?;
    let mtime = std::fs::metadata(&full).map(|m| mtime_of(&m)).unwrap_or(0);
    Ok(WriteResult { ok: true, conflict: false, mtime })
}

#[tauri::command]
pub fn fs_create(root: String, path: String, dir: bool) -> CmdResult<()> {
    let full = guard(&root, &path)?;
    if full.exists() {
        return Err(format!("{path} already exists"));
    }
    if dir {
        std::fs::create_dir_all(&full).map_err(err)
    } else {
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).map_err(err)?;
        }
        std::fs::write(&full, b"").map_err(err)
    }
}

#[tauri::command]
pub fn fs_rename(root: String, from: String, to: String) -> CmdResult<()> {
    let (a, b) = (guard(&root, &from)?, guard(&root, &to)?);
    if b.exists() {
        return Err(format!("{to} already exists"));
    }
    std::fs::rename(a, b).map_err(err)
}

/// Moves to the OS trash (recoverable) rather than deleting.
#[tauri::command]
pub fn fs_delete(root: String, path: String) -> CmdResult<()> {
    let full = guard(&root, &path)?;
    if full == normalize(Path::new(&root)) {
        return Err("refusing to delete the project root".into());
    }
    trash::delete(&full).map_err(err)
}

/// Shows the item in Explorer / Finder.
#[tauri::command]
pub fn fs_reveal(root: String, path: String) -> CmdResult<()> {
    let full = guard(&root, &path)?;
    #[cfg(windows)]
    let result = std::process::Command::new("explorer").arg(format!("/select,{}", full.display())).spawn();
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg("-R").arg(&full).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = std::process::Command::new("xdg-open").arg(full.parent().unwrap_or(&full)).spawn();
    result.map(|_| ()).map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn natural_order() {
        let mut v = vec!["file10", "file9", "File2", "a", "file09b"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(v, vec!["a", "File2", "file9", "file09b", "file10"]);
    }

    #[test]
    fn guard_blocks_escape() {
        let root = if cfg!(windows) { "C:\\proj" } else { "/proj" };
        assert!(guard(root, "src/main.rs").is_ok());
        assert!(guard(root, "../etc/passwd").is_err());
        assert!(guard(root, "src/../../x").is_err());
        assert!(guard(root, "").is_ok());
    }
}
