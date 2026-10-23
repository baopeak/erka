//! `kelpied` — Kelpie's session daemon. Owns every PTY and agent process so closing or crashing
//! the UI never stops a running CLI.
//!
//! Usage:
//!   kelpied [serve]          run the daemon (single instance per user)
//!   kelpied hook <agent>     agent hook callback (reads payload from stdin / last argv)
//!   kelpied ping             print daemon info if running
//!   kelpied call <method> [json]  raw RPC (automation: session.list/create/input/read…)
//!   kelpied stop [--kill-sessions]  ask the daemon to exit
//!   kelpied bench [opts]     throughput / attach benchmark against a running daemon
//!   kelpied terminal list|read|send|wait …   drive sessions from a script or another agent
//!   kelpied worktree get|set …               this folder's comment / board status

mod agents;
mod askpass;
mod auth;
mod automations;
mod awake;
mod bench;
mod chat;
mod cli;
mod client;
mod daemon;
mod meta;
mod mobile;
mod oneshot;
mod persist;
mod proc_tree;
mod runs;
mod server;
mod session;
mod status;
mod vt;

use std::path::PathBuf;

use anyhow::Result;

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        None | Some("serve") => serve(),
        Some("hook") => {
            hook(&args[1..]);
            Ok(())
        }
        Some("ping") => runtime()?.block_on(async {
            let mut c = client::Client::connect().await?;
            println!("{}", serde_json::to_string_pretty(&c.call("daemon.info", serde_json::json!({})).await?)?);
            Ok(())
        }),
        Some("call") => runtime()?.block_on(async {
            let method = args.get(1).ok_or_else(|| anyhow::anyhow!("usage: kelpied call <method> [json]"))?;
            let params = match args.get(2) {
                Some(p) => serde_json::from_str(p)?,
                None => serde_json::json!({}),
            };
            let mut c = client::Client::connect().await?;
            println!("{}", serde_json::to_string_pretty(&c.call(method, params).await?)?);
            Ok(())
        }),
        Some("stop") => runtime()?.block_on(async {
            let kill = args.iter().any(|a| a == "--kill-sessions");
            let mut c = client::Client::connect().await?;
            c.call("daemon.shutdown", serde_json::json!({"kill_sessions": kill})).await?;
            Ok(())
        }),
        Some("bench-emit") => {
            bench::emit(&args[1..]);
            Ok(())
        }
        Some("bench") => runtime()?.block_on(bench::run(&args[1..])),
        Some("terminal") => runtime()?.block_on(cli::terminal(&args[1..])),
        Some("worktree") => runtime()?.block_on(cli::worktree(&args[1..])),
        Some("run") => runtime()?.block_on(cli::run(&args[1..])),
        // ssh runs its SSH_ASKPASS program with the prompt as the only argument.
        Some(prompt) if std::env::var_os("KELPIE_ASKPASS").is_some() => std::process::exit(askpass::run(prompt)),
        Some(other) => anyhow::bail!("unknown command `{other}`"),
    }
}

fn runtime() -> Result<tokio::runtime::Runtime> {
    Ok(tokio::runtime::Builder::new_multi_thread().enable_all().build()?)
}

/// Markers a parent agent injects into its children. If Kelpie (or its daemon) was started from
/// inside such an agent, every session would inherit them and e.g. Claude Code would refuse to
/// start or disable transcript saving. User configuration variables are left alone.
const PARENT_AGENT_ENV: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_AGENT_SDK_VERSION",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_EMIT_STARTUP_TIMING",
    "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_QUESTION_PREVIEW_FORMAT",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_SSE_PORT",
    "CLAUDE_EFFORT",
    "CLAUDE_PID",
    "CODEX_SANDBOX",
    "CODEX_SANDBOX_NETWORK_DISABLED",
    "CODEX_THREAD_ID",
    "KELPIE_SESSION_ID",
    "KELPIE_SESSION_TOKEN",
    "KELPIE_SESSION_ENDPOINT",
];

/// Environment an editor host (VS Code, Electron) injects into its children.
fn inherits_editor_host(key: &str) -> bool {
    key == "ELECTRON_RUN_AS_NODE" || key == "ELECTRON_NO_ATTACH_CONSOLE" || key.starts_with("VSCODE_")
}

/// The app starts us in a new process group (so its console never takes us down), and Windows
/// then marks this process as ignoring Ctrl+C — a mark every child inherits. Sessions would get
/// it too, and Ctrl+C would no longer stop `ping`, a build or a PowerShell pipeline. Clear the
/// mark so children handle Ctrl+C normally, and ignore Ctrl+C / Ctrl+Break here ourselves.
#[cfg(windows)]
fn enable_ctrl_c_for_sessions() {
    use windows_sys::Win32::System::Console::{SetConsoleCtrlHandler, CTRL_BREAK_EVENT, CTRL_C_EVENT};
    unsafe extern "system" fn ignore(kind: u32) -> windows_sys::core::BOOL {
        (kind == CTRL_C_EVENT || kind == CTRL_BREAK_EVENT) as windows_sys::core::BOOL
    }
    unsafe {
        SetConsoleCtrlHandler(None, 0);
        SetConsoleCtrlHandler(Some(ignore), 1);
    }
}

fn serve() -> Result<()> {
    // Single-threaded at this point, so mutating the process environment is sound.
    for key in PARENT_AGENT_ENV {
        std::env::remove_var(key);
    }
    // Launched from VS Code (or any Electron host)? Its IPC hooks and run-as-node switch would
    // leak into every session and break `code .` or Electron apps started from a terminal.
    let mut inherited: Vec<String> = std::env::vars_os()
        .filter_map(|(k, _)| k.into_string().ok())
        .filter(|k| inherits_editor_host(k))
        .collect();
    // VS Code's GIT_ASKPASS script calls its VSCODE_GIT_ASKPASS_* helpers; without them every
    // git credential prompt would fail, so drop it too and let git use its own helper.
    if inherited.iter().any(|k| k.starts_with("VSCODE_GIT_ASKPASS")) {
        inherited.push("GIT_ASKPASS".into());
    }
    if std::env::var("TERM_PROGRAM").is_ok_and(|v| v == "vscode") {
        inherited.push("TERM_PROGRAM_VERSION".into());
    }
    for key in inherited {
        std::env::remove_var(key);
    }
    #[cfg(windows)]
    enable_ctrl_c_for_sessions();
    if let Err(e) = kelpie_proto::migrate_legacy_data_dir() {
        eprintln!("kelpied: could not move data from the Erka folder: {e}");
    }
    let data_dir = kelpie_proto::data_dir();
    std::fs::create_dir_all(data_dir.join("logs"))?;
    let _lock = match acquire_lock(&data_dir.join("kelpied.lock")) {
        Some(lock) => lock,
        None => {
            eprintln!("kelpied already running");
            return Ok(());
        }
    };
    init_logging(&data_dir);
    // Before any session spawns: their environment carries tokens derived from this daemon's secret.
    auth::init(&kelpie_proto::endpoint())?;
    let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("kelpied"));
    let daemon = daemon::Daemon::new(data_dir, exe);
    daemon.restore();
    tracing::info!(pid = std::process::id(), "kelpied {} starting", env!("CARGO_PKG_VERSION"));
    let rt = runtime()?;
    let result = rt.block_on(async {
        tokio::spawn(daemon.clone().ticker());
        tokio::spawn(mobile::autostart(daemon.clone()));
        server::serve(daemon.clone(), kelpie_proto::endpoint()).await
    });
    // Stop the ticker before the final save so the two never persist concurrently.
    rt.shutdown_timeout(std::time::Duration::from_secs(2));
    daemon.persist(true);
    tracing::info!("kelpied stopped");
    result
}

/// Exclusive lock held for the daemon's lifetime: guarantees one instance per user even when
/// named pipes would happily accept a second server.
fn acquire_lock(path: &std::path::Path) -> Option<std::fs::File> {
    let file = {
        let mut opts = std::fs::OpenOptions::new();
        opts.create(true).truncate(false).write(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            opts.share_mode(0);
        }
        opts.open(path).ok()?
    };
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return None;
        }
    }
    // Record our pid for tooling (`scripts/dev-daemon.sh`, diagnostics); the lock file itself
    // is opened without sharing on Windows, so it cannot carry it.
    let _ = std::fs::write(path.with_extension("pid"), std::process::id().to_string());
    Some(file)
}

fn init_logging(data_dir: &std::path::Path) {
    let path = data_dir.join("logs").join("kelpied.log");
    if std::fs::metadata(&path).map(|m| m.len() > 5 << 20).unwrap_or(false) {
        let _ = std::fs::rename(&path, path.with_extension("log.1"));
    }
    let file = std::fs::OpenOptions::new().create(true).append(true).open(&path);
    let filter = tracing_subscriber::EnvFilter::try_from_env("KELPIE_LOG").unwrap_or_else(|_| "info".into());
    if let Ok(file) = file {
        tracing_subscriber::fmt().with_env_filter(filter).with_ansi(false).with_writer(std::sync::Mutex::new(file)).init();
    }
}

/// Called by agents' hook machinery. Must be fast, print nothing to stdout (Claude feeds
/// SessionStart stdout into the model context) and never fail the agent.
fn hook(args: &[String]) {
    let agent = args.first().cloned().unwrap_or_default();
    let Ok(session_id) = std::env::var("KELPIE_SESSION_ID") else { return };
    // Codex passes the JSON as the last argv; Claude writes it to stdin.
    let payload: serde_json::Value = match args.get(1) {
        Some(arg) => serde_json::from_str(arg).unwrap_or(serde_json::Value::Null),
        None => {
            use std::io::Read;
            let mut buf = String::new();
            let _ = std::io::stdin().take(1 << 20).read_to_string(&mut buf);
            serde_json::from_str(&buf).unwrap_or(serde_json::Value::Null)
        }
    };
    let Ok(rt) = tokio::runtime::Builder::new_current_thread().enable_all().build() else { return };
    rt.block_on(async {
        let send = async {
            let mut c = client::Client::connect().await?;
            c.call("hook.report", serde_json::json!({"session_id": session_id, "agent": agent, "payload": payload})).await
        };
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), send).await;
    });
}

#[cfg(test)]
mod tests {
    use super::inherits_editor_host;

    #[test]
    fn scrubs_editor_host_env() {
        assert!(inherits_editor_host("ELECTRON_RUN_AS_NODE"));
        assert!(inherits_editor_host("VSCODE_IPC_HOOK"));
        assert!(!inherits_editor_host("PATH"));
        assert!(!inherits_editor_host("TERM_PROGRAM"));
    }
}
