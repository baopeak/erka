//! Turns a session spec (kind + user args) into the argv actually spawned on the PTY.
//!
//! - Injects status hooks: Claude Code via `--settings <file>`, Codex via `-c notify=[...]`.
//! - Adds resume flags when an agent session id is known (restart / chat → terminal switch).
//! - Resolves executables the way the user's shell would: Windows PATH+PATHEXT with npm
//!   `.cmd` shims unwrapped to `node <script>`, Unix via a login shell (GUI apps on macOS do not
//!   inherit the shell PATH).

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

/// Fully resolved spawn description.
#[derive(Debug, Clone)]
pub struct Launch {
    pub argv: Vec<String>,
}

/// Default interactive shell for plain terminal sessions.
pub fn default_shell() -> Vec<String> {
    if cfg!(windows) {
        for candidate in ["pwsh.exe", "powershell.exe"] {
            if let Some(p) = which(candidate) {
                return vec![p.to_string_lossy().into_owned(), "-NoLogo".into()];
            }
        }
        vec![std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into())]
    } else {
        vec![std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into()), "-l".into()]
    }
}

/// Builds the argv for `kind`. `user_args` are extra flags from the user/profile.
pub fn build_launch(
    kind: &str,
    user_args: &[String],
    resume_id: Option<&str>,
    hook_exe: &Path,
    data_dir: &Path,
) -> Result<Launch> {
    let mut argv: Vec<String> = match kind {
        "shell" => return Ok(Launch { argv: if user_args.is_empty() { default_shell() } else { resolve(user_args)? } }),
        "custom" => {
            anyhow::ensure!(!user_args.is_empty(), "custom session needs a command");
            return Ok(Launch { argv: wrap_for_platform(user_args.to_vec())? });
        }
        "claude" => {
            let settings = write_claude_hook_settings(hook_exe, data_dir)?;
            let mut a = vec!["claude".to_string(), "--settings".into(), settings.to_string_lossy().into_owned()];
            if let Some(id) = resume_id {
                a.push("--resume".into());
                a.push(id.into());
            }
            a
        }
        "codex" => {
            let exe = hook_exe.to_string_lossy().replace('\\', "/");
            let mut a = vec!["codex".to_string(), "-c".into(), format!("notify=['{exe}','hook','codex']")];
            if let Some(id) = resume_id {
                a.push("resume".into());
                a.push(id.into());
            }
            a
        }
        "omp" => {
            let mut a = vec!["omp".to_string()];
            if let Some(id) = resume_id {
                a.push("--resume".into());
                a.push(id.into());
            }
            a
        }
        other => anyhow::bail!("unknown session kind {other}"),
    };
    argv.extend(user_args.iter().cloned());
    Ok(Launch { argv: wrap_for_platform(argv)? })
}

/// Claude Code merges `--settings` hooks with the user's own settings, so we never touch
/// `~/.claude/settings.json`. One command handles every event (name comes in the payload).
fn write_claude_hook_settings(hook_exe: &Path, data_dir: &Path) -> Result<PathBuf> {
    let exe = hook_exe.to_string_lossy().replace('\\', "/");
    let command = format!("\"{exe}\" hook claude");
    let entry = serde_json::json!([{ "hooks": [{ "type": "command", "command": command, "timeout": 5 }] }]);
    let mut hooks = serde_json::Map::new();
    for event in [
        "SessionStart",
        "UserPromptSubmit",
        "PreToolUse",
        "PostToolUse",
        "PermissionRequest",
        "Notification",
        "Stop",
        "StopFailure",
        "SubagentStart",
        "PostCompact",
    ] {
        hooks.insert(event.into(), entry.clone());
    }
    let settings = serde_json::json!({ "hooks": hooks });
    let path = data_dir.join("claude-hooks.json");
    let body = serde_json::to_vec_pretty(&settings)?;
    if std::fs::read(&path).ok().as_deref() != Some(&body[..]) {
        std::fs::create_dir_all(data_dir)?;
        std::fs::write(&path, body).with_context(|| format!("write {}", path.display()))?;
    }
    Ok(path)
}

/// Platform-correct argv for a non-PTY child (chat mode) or a PTY agent.
pub fn platform_argv(argv: Vec<String>) -> Result<Vec<String>> {
    wrap_for_platform(argv)
}

#[cfg(windows)]
fn wrap_for_platform(argv: Vec<String>) -> Result<Vec<String>> {
    resolve(&argv)
}

/// Runs the agent through the user's login shell so PATH (nvm, bun, homebrew…) matches what
/// they get in Terminal.app. `exec` keeps the agent as the PTY's direct child.
#[cfg(unix)]
fn wrap_for_platform(argv: Vec<String>) -> Result<Vec<String>> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let joined = argv.iter().map(|a| shell_quote(a)).collect::<Vec<_>>().join(" ");
    Ok(vec![shell, "-l".into(), "-c".into(), format!("exec {joined}")])
}

#[cfg(unix)]
fn shell_quote(arg: &str) -> String {
    if !arg.is_empty() && arg.chars().all(|c| c.is_ascii_alphanumeric() || "-_./=:@%+,".contains(c)) {
        arg.to_string()
    } else {
        format!("'{}'", arg.replace('\'', "'\\''"))
    }
}

/// Windows: resolve argv[0] through PATH/PATHEXT; unwrap npm cmd-shims to `node script.js`;
/// other batch files go through `cmd.exe /d /c`.
#[cfg(windows)]
fn resolve(argv: &[String]) -> Result<Vec<String>> {
    let program = &argv[0];
    let Some(path) = which(program) else {
        anyhow::bail!("`{program}` not found on PATH");
    };
    let ext = path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    let rest = argv[1..].iter().cloned();
    if ext == "cmd" || ext == "bat" {
        if let Some((node, script)) = parse_npm_shim(&path) {
            return Ok([node, script].into_iter().chain(rest).collect());
        }
        let comspec = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into());
        return Ok([comspec, "/d".into(), "/c".into(), path.to_string_lossy().into_owned()].into_iter().chain(rest).collect());
    }
    Ok(std::iter::once(path.to_string_lossy().into_owned()).chain(rest).collect())
}

#[cfg(unix)]
fn resolve(argv: &[String]) -> Result<Vec<String>> {
    Ok(argv.to_vec())
}

/// Recognises the standard npm `cmd-shim` output:
/// `"%_prog%"  "%dp0%\node_modules\pkg\bin\cli.js" %*`
#[cfg(windows)]
fn parse_npm_shim(path: &Path) -> Option<(String, String)> {
    let text = std::fs::read_to_string(path).ok()?;
    let dir = path.parent()?;
    let script = dir.join(npm_shim_script(&text)?);
    if !script.exists() {
        return None;
    }
    let local_node = dir.join("node.exe");
    let node = if local_node.exists() { local_node } else { which("node")? };
    Some((node.to_string_lossy().into_owned(), script.to_string_lossy().into_owned()))
}

/// The script is the last `"%dp0%\…"` token ending in a JS extension; earlier tokens point at
/// `node.exe`.
#[cfg_attr(not(windows), allow(dead_code))]
fn npm_shim_script(text: &str) -> Option<&str> {
    text.rmatch_indices("\"%dp0%\\").find_map(|(start, m)| {
        let rest = &text[start + m.len()..];
        let rel = &rest[..rest.find('"')?];
        [".js", ".mjs", ".cjs"].iter().any(|ext| rel.ends_with(ext)).then_some(rel)
    })
}

/// PATH lookup honouring PATHEXT on Windows (extension-less files are skipped there because
/// npm/bun also drop POSIX shell scripts next to the real shims).
pub fn which(program: &str) -> Option<PathBuf> {
    let candidate = Path::new(program);
    if candidate.is_absolute() || program.contains(['/', '\\']) {
        return candidate.exists().then(|| candidate.to_path_buf());
    }
    let path = std::env::var_os("PATH")?;
    let exts: Vec<String> = if cfg!(windows) {
        let has_ext = candidate.extension().is_some();
        let mut list: Vec<String> = std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
            .split(';')
            .filter(|e| !e.is_empty())
            .map(|e| e.to_ascii_lowercase())
            .collect();
        if has_ext {
            list.insert(0, String::new());
        }
        list
    } else {
        vec![String::new()]
    };
    for dir in std::env::split_paths(&path) {
        for ext in &exts {
            let full = dir.join(format!("{program}{ext}"));
            if full.is_file() {
                return Some(full);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_gets_hook_settings_and_resume() {
        let dir = std::env::temp_dir().join("erka-agents-test");
        let launch = build_launch("claude", &["--model".into(), "opus".into()], Some("abc"), Path::new("/x/erkad"), &dir);
        if let Ok(l) = launch {
            let joined = l.argv.join(" ");
            assert!(joined.contains("--settings"));
            assert!(joined.contains("--resume abc"));
            assert!(joined.contains("--model opus"));
            let settings = std::fs::read_to_string(dir.join("claude-hooks.json")).unwrap();
            assert!(settings.contains("hook claude"));
        }
    }

    #[test]
    fn finds_npm_shim_script() {
        let shim = "IF EXIST \"%dp0%\\node.exe\" (\r\n  SET \"_prog=%dp0%\\node.exe\"\r\n)\r\n\
                    \"%_prog%\"  \"%dp0%\\pkgs\\@openai\\codex\\bin\\codex.js\" %*\r\n";
        assert_eq!(npm_shim_script(shim), Some("pkgs\\@openai\\codex\\bin\\codex.js"));
        assert_eq!(npm_shim_script("\"%dp0%\\node.exe\""), None);
    }

    #[test]
    fn default_shell_is_not_empty() {
        assert!(!default_shell().is_empty());
    }
}
