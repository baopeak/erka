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
#[derive(Debug, Clone, Default)]
pub struct Launch {
    pub argv: Vec<String>,
    /// First prompt to type once the program is ready (agents that take no prompt argument,
    /// startup commands of shells).
    pub typed_prompt: Option<TypedPrompt>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TypedPrompt {
    pub text: String,
    /// Deliver as a bracketed paste (agent TUIs: a multi-line prompt stays one message);
    /// otherwise as keystrokes (shells, where older line editors print the paste markers).
    pub paste: bool,
}

/// How an agent takes a first prompt at launch.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PromptMode {
    /// Trailing positional argument.
    Argv,
    /// `<flag> <prompt>`, e.g. Gemini's `-i` (prompt, then stay interactive).
    Flag(&'static str),
    /// Typed into the TUI once it is ready.
    Typed,
}

/// A coding-agent CLI Erka knows how to start. Flags come from each CLI's documentation
/// (cross-checked with Orca's agent table).
pub struct Preset {
    pub id: &'static str,
    pub label: &'static str,
    /// Executable looked up on PATH.
    pub bin: &'static str,
    /// Arguments that start the interactive UI (e.g. `chat --tui`).
    pub launch: &'static [&'static str],
    /// Skip-every-permission-prompt flags (Settings → Agents → Permissions: Yolo).
    pub yolo: &'static [&'static str],
    /// Continue the most recent conversation in the folder (restart / hibernation resume).
    pub resume_latest: &'static [&'static str],
    pub prompt: PromptMode,
}

const fn preset(id: &'static str, label: &'static str, bin: &'static str) -> Preset {
    Preset { id, label, bin, launch: &[], yolo: &[], resume_latest: &[], prompt: PromptMode::Typed }
}

pub const PRESETS: &[Preset] = &[
    Preset { yolo: &["--dangerously-skip-permissions"], resume_latest: &["--continue"], prompt: PromptMode::Argv, ..preset("claude", "Claude Code", "claude") },
    Preset { yolo: &["--dangerously-bypass-approvals-and-sandbox"], resume_latest: &["resume", "--last"], prompt: PromptMode::Argv, ..preset("codex", "Codex", "codex") },
    Preset { resume_latest: &["--continue"], prompt: PromptMode::Argv, ..preset("omp", "OMP", "omp") },
    Preset { yolo: &["--yolo"], resume_latest: &["--resume", "latest"], prompt: PromptMode::Flag("-i"), ..preset("gemini", "Gemini", "gemini") },
    Preset { yolo: &["--yolo"], resume_latest: &["--continue"], prompt: PromptMode::Argv, ..preset("cursor", "Cursor CLI", "cursor-agent") },
    Preset { resume_latest: &["--continue"], prompt: PromptMode::Flag("--prompt"), ..preset("opencode", "OpenCode", "opencode") },
    Preset { yolo: &["--yolo"], resume_latest: &["--continue"], prompt: PromptMode::Flag("-i"), ..preset("copilot", "GitHub Copilot", "copilot") },
    Preset { yolo: &["--permission-mode", "bypassPermissions"], prompt: PromptMode::Argv, ..preset("grok", "Grok", "grok") },
    Preset { yolo: &["--approval-mode", "yolo"], ..preset("qwen", "Qwen Code", "qwen") },
    Preset { yolo: &["--auto", "high"], prompt: PromptMode::Argv, ..preset("droid", "Droid", "droid") },
    Preset { yolo: &["--yes-always"], resume_latest: &["--restore-chat-history"], ..preset("aider", "Aider", "aider") },
    Preset { yolo: &["--dangerously-allow-all"], ..preset("amp", "Amp", "amp") },
    preset("goose", "Goose", "goose"),
    Preset { yolo: &["--yolo"], ..preset("kimi", "Kimi", "kimi") },
    Preset { yolo: &["--yolo"], ..preset("crush", "Crush", "crush") },
    Preset { yolo: &["--auto-approve", "true"], ..preset("cline", "Cline", "cline") },
    Preset { launch: &["chat", "--tui"], yolo: &["--trust-all-tools"], ..preset("kiro", "Kiro", "kiro-cli") },
    Preset { yolo: &["--allow", "*"], ..preset("continue", "Continue", "cn") },
    Preset { yolo: &["--permission-mode", "bypass"], prompt: PromptMode::Argv, ..preset("devin", "Devin", "devin") },
    preset("auggie", "Auggie", "auggie"),
    Preset { yolo: &["--dangerously-skip-permissions"], prompt: PromptMode::Argv, ..preset("codebuddy", "CodeBuddy", "codebuddy") },
    Preset { yolo: &["--agent", "auto-approve"], ..preset("vibe", "Mistral Vibe", "vibe") },
    Preset { prompt: PromptMode::Argv, ..preset("pi", "Pi", "pi") },
];

pub fn preset_for(kind: &str) -> Option<&'static Preset> {
    PRESETS.iter().find(|p| p.id == kind)
}

/// Which preset agents are installed (on PATH; through the login shell on Unix).
pub fn installed_presets() -> Vec<&'static str> {
    #[cfg(windows)]
    {
        PRESETS.iter().filter(|p| which(p.bin).is_some()).map(|p| p.id).collect()
    }
    #[cfg(unix)]
    {
        let bins: Vec<&str> = PRESETS.iter().map(|p| p.bin).collect();
        let script = format!("for b in {}; do command -v \"$b\" >/dev/null 2>&1 && echo \"$b\"; done", bins.join(" "));
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let found = std::process::Command::new(shell).args(["-l", "-c", &script]).output().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default();
        let found: Vec<&str> = found.lines().collect();
        PRESETS.iter().filter(|p| found.contains(&p.bin)).map(|p| p.id).collect()
    }
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

/// What to resume when (re)starting an agent.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Resume<'a> {
    None,
    /// The agent's own conversation id (from hooks / transcripts).
    Id(&'a str),
    /// The most recent conversation in the folder, for agents that report no id.
    Latest,
}

/// Builds the argv for `kind`. `user_args` are extra flags from the user/profile; `prompt` is
/// an optional first message (ignored when resuming).
pub fn build_launch(
    kind: &str,
    user_args: &[String],
    resume: Resume,
    prompt: Option<&str>,
    hook_exe: &Path,
    data_dir: &Path,
) -> Result<Launch> {
    // Shells and plain commands take `prompt` as a startup command, typed as plain keys.
    let startup = || prompt.filter(|t| !t.trim().is_empty()).map(|t| TypedPrompt { text: t.to_string(), paste: false });
    let mut argv: Vec<String> = match kind {
        "shell" => return Ok(Launch { argv: if user_args.is_empty() { default_shell() } else { resolve(user_args)? }, typed_prompt: startup() }),
        "custom" => {
            anyhow::ensure!(!user_args.is_empty(), "custom session needs a command");
            return Ok(Launch { argv: wrap_for_platform(user_args.to_vec())?, typed_prompt: startup() });
        }
        "claude" => {
            let settings = write_claude_hook_settings(hook_exe, data_dir)?;
            vec!["claude".to_string(), "--settings".into(), settings.to_string_lossy().into_owned()]
        }
        "codex" => {
            let exe = hook_exe.to_string_lossy().replace('\\', "/");
            vec!["codex".to_string(), "-c".into(), format!("notify=['{exe}','hook','codex']")]
        }
        other => {
            let p = preset_for(other).ok_or_else(|| anyhow::anyhow!("unknown session kind {other}"))?;
            std::iter::once(p.bin).chain(p.launch.iter().copied()).map(str::to_string).collect()
        }
    };
    let preset = preset_for(kind);
    match resume {
        Resume::Id(id) => match kind {
            "codex" => argv.extend(["resume".to_string(), id.to_string()]),
            _ => argv.extend(["--resume".to_string(), id.to_string()]),
        },
        Resume::Latest => argv.extend(preset.map_or(&[][..], |p| p.resume_latest).iter().map(|a| a.to_string())),
        Resume::None => {}
    }
    argv.extend(user_args.iter().cloned());
    let mut typed_prompt = None;
    if let Some(text) = prompt.filter(|t| !t.trim().is_empty() && resume == Resume::None) {
        // A long prompt (a hand-off transcript) is typed instead: Windows command lines stop at
        // 32 K characters, and batch-file launchers mangle newlines.
        let fits = text.len() <= 8000;
        match preset.map_or(PromptMode::Typed, |p| p.prompt) {
            // A prompt that looks like an option would be parsed as one.
            PromptMode::Argv if fits && !text.starts_with('-') => argv.push(text.to_string()),
            PromptMode::Flag(flag) if fits => argv.extend([flag.to_string(), text.to_string()]),
            _ => typed_prompt = Some(TypedPrompt { text: text.to_string(), paste: true }),
        }
    }
    Ok(Launch { argv: wrap_for_platform(argv)?, typed_prompt })
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
        let launch = build_launch("claude", &["--model".into(), "opus".into()], Resume::Id("abc"), None, Path::new("/x/erkad"), &dir);
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
    fn presets_take_prompts_and_resume() {
        let dir = std::env::temp_dir().join("erka-agents-test");
        let exe = Path::new("/x/erkad");
        // Unix wraps argv in `$SHELL -l -c "exec …"`, Windows needs the binary on PATH: compare
        // the joined command line either way, and skip when the CLI is not installed.
        let joined = |kind: &str, resume, prompt| build_launch(kind, &[], resume, prompt, exe, &dir).map(|l| (l.argv.join(" "), l.typed_prompt));
        if let Ok((argv, typed)) = joined("gemini", Resume::None, Some("fix it")) {
            assert!(argv.contains("-i") && argv.contains("fix it"), "{argv}");
            assert!(typed.is_none());
        }
        if let Ok((argv, typed)) = joined("aider", Resume::None, Some("fix it")) {
            assert!(!argv.contains("fix it"));
            assert_eq!(typed, Some(TypedPrompt { text: "fix it".into(), paste: true }));
        }
        if let Ok((argv, typed)) = joined("opencode", Resume::Latest, Some("ignored")) {
            assert!(argv.contains("--continue") && !argv.contains("ignored"));
            assert!(typed.is_none());
        }
        assert!(build_launch("nope", &[], Resume::None, None, exe, &dir).is_err());
        assert!(PRESETS.iter().all(|p| !p.id.is_empty() && !p.bin.is_empty()));
    }

    #[test]
    fn default_shell_is_not_empty() {
        assert!(!default_shell().is_empty());
    }
}
