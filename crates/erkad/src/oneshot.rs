//! One-shot, non-interactive agent runs (`agent.run`): a prompt in, the agent's answer out.
//! Used for AI actions such as drafting a commit message from the staged diff. Runs on its own
//! thread and replies later, so a slow model never blocks the client's other requests.

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};

use crate::agents;

/// Argv for a headless run that reads the prompt from stdin and prints only the answer.
fn headless_argv(kind: &str) -> Result<Vec<String>> {
    let argv: &[&str] = match kind {
        "claude" => &["claude", "-p", "--output-format", "text"],
        "codex" => &["codex", "exec", "--skip-git-repo-check", "--color", "never", "-"],
        other => bail!("{other} cannot run one-shot prompts; choose Claude Code or Codex"),
    };
    Ok(argv.iter().map(|s| s.to_string()).collect())
}

/// `env`: extra variables, e.g. the account's `CLAUDE_CONFIG_DIR` / `CODEX_HOME`.
pub fn run(kind: &str, prompt: &str, cwd: &str, env: &std::collections::BTreeMap<String, String>, timeout: Duration) -> Result<String> {
    let argv = agents::platform_argv(headless_argv(kind)?)?;
    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..]).envs(env).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if std::path::Path::new(cwd).is_dir() {
        cmd.current_dir(cwd);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().with_context(|| format!("start {kind}"))?;
    let mut stdin = child.stdin.take().context("stdin")?;
    let prompt = prompt.to_string();
    // Write on a thread: a large prompt could fill the pipe before the agent reads it.
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(prompt.as_bytes());
    });
    let mut stdout = child.stdout.take().context("stdout")?;
    let mut stderr = child.stderr.take().context("stderr")?;
    let out = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stdout.read_to_string(&mut s);
        s
    });
    let err = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if started.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            bail!("{kind} did not answer within {} s", timeout.as_secs());
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let _ = writer.join();
    let text = out.join().unwrap_or_default();
    let stderr = err.join().unwrap_or_default();
    if !status.success() {
        let detail = stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
        bail!("{kind} exited with {status}{}{detail}", if detail.is_empty() { "" } else { ": " });
    }
    Ok(text.trim().to_string())
}
