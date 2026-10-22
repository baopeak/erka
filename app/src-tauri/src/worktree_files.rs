//! Brings gitignored files into a new worktree, which starts as a clean checkout:
//! - **copy**: `.worktreeinclude` lines and `.kelpie.yaml` `copy:` entries (e.g. `.env`) get a
//!   private copy;
//! - **link**: `.kelpie.yaml` `link:` directories (e.g. `node_modules`) are shared with the
//!   repository through a symlink (a junction on Windows: no admin rights needed).
//!
//! Only literal, repository-relative paths that exist in the repository and are ignored by
//! git qualify; anything else is reported as skipped. Copies are bounded.

use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use crate::fs_ops::{blocking, guard, CmdResult};

const MAX_COPY_BYTES: u64 = 2 << 30;
const MAX_COPY_ENTRIES: u64 = 50_000;

#[derive(Serialize, Default)]
pub struct Materialized {
    copied: Vec<String>,
    linked: Vec<String>,
    skipped: Vec<Skipped>,
}

#[derive(Serialize)]
struct Skipped {
    path: String,
    reason: String,
}

/// `a/b` with no absolute, `..`, `.` or `.git` parts.
fn clean_rel(raw: &str) -> Option<String> {
    let p = raw.trim().replace('\\', "/");
    let p = p.trim_start_matches("./").trim_end_matches('/');
    if p.is_empty() || p.contains(['*', '?']) || p.starts_with('!') {
        return None;
    }
    let path = Path::new(p);
    let ok = path.components().all(|c| matches!(c, Component::Normal(s) if s != ".git"))
        && p.split('/').all(|s| !s.is_empty() && s != "." && s != "..");
    ok.then(|| p.to_string())
}

fn is_ignored(repo: &Path, rel: &str) -> bool {
    // check-ignore does not look at the disk: a folder needs its trailing slash to match
    // directory-only patterns such as `node_modules/`.
    let spec = if repo.join(rel).is_dir() { format!("{rel}/") } else { rel.to_string() };
    let mut cmd = std::process::Command::new("git");
    cmd.args(["check-ignore", "-q", "--", &spec]).current_dir(repo);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd.status().map(|s| s.success()).unwrap_or(false)
}

/// Bytes and entries under `p` (stops counting past the budget).
fn measure(p: &Path, bytes: &mut u64, entries: &mut u64) {
    *entries += 1;
    if *entries > MAX_COPY_ENTRIES || *bytes > MAX_COPY_BYTES {
        return;
    }
    match std::fs::symlink_metadata(p) {
        Ok(m) if m.is_dir() => {
            for e in std::fs::read_dir(p).into_iter().flatten().flatten() {
                measure(&e.path(), bytes, entries);
            }
        }
        Ok(m) => *bytes += m.len(),
        Err(_) => {}
    }
}

fn copy_tree(src: &Path, dst: &Path) -> std::io::Result<()> {
    let meta = std::fs::metadata(src)?;
    if meta.is_dir() {
        std::fs::create_dir_all(dst)?;
        for e in std::fs::read_dir(src)? {
            let e = e?;
            copy_tree(&e.path(), &dst.join(e.file_name()))?;
        }
        Ok(())
    } else {
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(src, dst).map(|_| ())
    }
}

fn link_dir(src: &Path, dst: &Path) -> Result<(), String> {
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // A junction needs no Developer Mode / admin rights, unlike a directory symlink.
        // mklink rejects forward slashes ("syntax of the command is incorrect").
        let native = |p: &Path| p.to_string_lossy().replace('/', "\\");
        let out = std::process::Command::new("cmd")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(native(dst))
            .arg(native(src))
            .creation_flags(0x0800_0000)
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Ok(())
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(src, dst).map_err(|e| e.to_string())
    }
}

fn materialize(repo: PathBuf, worktree: PathBuf, copy: Vec<String>, link: Vec<String>) -> Materialized {
    let mut out = Materialized::default();
    let skip = |path: &str, reason: &str, out: &mut Materialized| out.skipped.push(Skipped { path: path.into(), reason: reason.into() });
    let include = std::fs::read_to_string(repo.join(".worktreeinclude")).unwrap_or_default();
    let mut copy_list: Vec<String> = include.lines().filter(|l| !l.trim().is_empty() && !l.trim_start().starts_with('#')).map(str::to_string).collect();
    copy_list.extend(copy);
    let (mut budget_bytes, mut budget_entries) = (0u64, 0u64);
    let mut seen = std::collections::HashSet::new();
    for (raw, linked) in link.iter().map(|l| (l, true)).chain(copy_list.iter().map(|c| (c, false))) {
        let Some(rel) = clean_rel(raw) else {
            skip(raw.trim(), "not a plain relative path", &mut out);
            continue;
        };
        if !seen.insert(rel.clone()) {
            continue;
        }
        let src = repo.join(&rel);
        let dst = worktree.join(&rel);
        if !src.exists() {
            skip(&rel, "missing in the repository", &mut out);
        } else if dst.exists() {
            skip(&rel, "already in the worktree", &mut out);
        } else if !is_ignored(&repo, &rel) {
            skip(&rel, "not ignored by git (tracked files are already checked out)", &mut out);
        } else if linked {
            if !src.is_dir() {
                skip(&rel, "only folders can be linked", &mut out);
            } else {
                match link_dir(&src, &dst) {
                    Ok(()) => out.linked.push(rel),
                    Err(e) => skip(&rel, &format!("link failed: {e}"), &mut out),
                }
            }
        } else {
            let (mut bytes, mut entries) = (0, 0);
            measure(&src, &mut bytes, &mut entries);
            if budget_bytes + bytes > MAX_COPY_BYTES || budget_entries + entries > MAX_COPY_ENTRIES {
                skip(&rel, "too large to copy (2 GiB / 50,000 files per worktree); link it instead", &mut out);
                continue;
            }
            budget_bytes += bytes;
            budget_entries += entries;
            match copy_tree(&src, &dst) {
                Ok(()) => out.copied.push(rel),
                Err(e) => skip(&rel, &format!("copy failed: {e}"), &mut out),
            }
        }
    }
    out
}

#[tauri::command]
pub async fn worktree_materialize(root: String, worktree: String, copy: Vec<String>, link: Vec<String>) -> CmdResult<Materialized> {
    let repo = guard(&root, "")?;
    let wt = PathBuf::from(worktree.trim());
    if !wt.is_absolute() || !wt.is_dir() {
        return Err("the worktree folder does not exist".into());
    }
    blocking(move || Ok(materialize(repo, wt, copy, link))).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_paths_only() {
        assert_eq!(clean_rel("./.env").as_deref(), Some(".env"));
        assert_eq!(clean_rel(".vscode\\settings.json").as_deref(), Some(".vscode/settings.json"));
        assert_eq!(clean_rel("node_modules/").as_deref(), Some("node_modules"));
        for bad in ["../x", "/etc/passwd", "a/.git/config", "*.env", "!keep", "", "a/./b"] {
            assert!(clean_rel(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn copies_links_and_skips_tracked() {
        let base = std::env::temp_dir().join(format!("kelpie-wtfiles-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        // Forward slashes on purpose: the app passes such paths on Windows too.
        let repo = PathBuf::from(base.join("repo").to_string_lossy().replace('\\', "/"));
        let wt = PathBuf::from(base.join("wt").to_string_lossy().replace('\\', "/"));
        std::fs::create_dir_all(repo.join("deps/pkg")).unwrap();
        std::fs::create_dir_all(&wt).unwrap();
        let git = |args: &[&str]| assert!(std::process::Command::new("git").args(args).current_dir(&repo).status().unwrap().success());
        git(&["init", "-q"]);
        std::fs::write(repo.join(".gitignore"), "deps/\n.env\n").unwrap();
        std::fs::write(repo.join(".worktreeinclude"), "# copies\n.env\n").unwrap();
        std::fs::write(repo.join(".env"), "X=1").unwrap();
        std::fs::write(repo.join("deps/pkg/a.js"), "1").unwrap();
        std::fs::write(repo.join("tracked.txt"), "t").unwrap();
        let out = materialize(repo.clone(), wt.clone(), vec!["tracked.txt".into(), "../x".into()], vec!["deps".into()]);
        assert_eq!(out.copied, vec![".env"]);
        assert_eq!(out.linked, vec!["deps"]);
        assert!(wt.join(".env").is_file());
        assert!(wt.join("deps/pkg/a.js").is_file(), "link resolves");
        assert_eq!(out.skipped.len(), 2, "tracked file and traversal are skipped");
        let _ = std::fs::remove_dir_all(&base);
    }
}
