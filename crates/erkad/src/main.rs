//! `erkad` — Erka's session daemon. Owns every PTY and agent process so closing or crashing
//! the UI never stops a running CLI.
//!
//! Usage:
//!   erkad [serve]          run the daemon (single instance per user)
//!   erkad hook <agent>     agent hook callback (reads payload from stdin / last argv)
//!   erkad ping             print daemon info if running
//!   erkad call <method> [json]  raw RPC (automation: session.list/create/input/read…)
//!   erkad stop [--kill-sessions]  ask the daemon to exit
//!   erkad bench [opts]     throughput / attach benchmark against a running daemon

mod agents;
mod bench;
mod chat;
mod client;
mod daemon;
mod persist;
mod proc_tree;
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
            let method = args.get(1).ok_or_else(|| anyhow::anyhow!("usage: erkad call <method> [json]"))?;
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
        Some(other) => anyhow::bail!("unknown command `{other}`"),
    }
}

fn runtime() -> Result<tokio::runtime::Runtime> {
    Ok(tokio::runtime::Builder::new_multi_thread().enable_all().build()?)
}

/// Markers a parent agent injects into its children. If Erka (or its daemon) was started from
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
    "ERKA_SESSION_ID",
];

fn serve() -> Result<()> {
    // Single-threaded at this point, so mutating the process environment is sound.
    for key in PARENT_AGENT_ENV {
        std::env::remove_var(key);
    }
    let data_dir = erka_proto::data_dir();
    std::fs::create_dir_all(data_dir.join("logs"))?;
    let _lock = match acquire_lock(&data_dir.join("erkad.lock")) {
        Some(lock) => lock,
        None => {
            eprintln!("erkad already running");
            return Ok(());
        }
    };
    init_logging(&data_dir);
    let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("erkad"));
    let daemon = daemon::Daemon::new(data_dir, exe);
    daemon.restore();
    tracing::info!(pid = std::process::id(), "erkad {} starting", env!("CARGO_PKG_VERSION"));
    let rt = runtime()?;
    let result = rt.block_on(async {
        tokio::spawn(daemon.clone().ticker());
        server::serve(daemon.clone(), erka_proto::endpoint()).await
    });
    daemon.persist(true);
    tracing::info!("erkad stopped");
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
    let path = data_dir.join("logs").join("erkad.log");
    if std::fs::metadata(&path).map(|m| m.len() > 5 << 20).unwrap_or(false) {
        let _ = std::fs::rename(&path, path.with_extension("log.1"));
    }
    let file = std::fs::OpenOptions::new().create(true).append(true).open(&path);
    let filter = tracing_subscriber::EnvFilter::try_from_env("ERKA_LOG").unwrap_or_else(|_| "info".into());
    if let Ok(file) = file {
        tracing_subscriber::fmt().with_env_filter(filter).with_ansi(false).with_writer(std::sync::Mutex::new(file)).init();
    }
}

/// Called by agents' hook machinery. Must be fast, print nothing to stdout (Claude feeds
/// SessionStart stdout into the model context) and never fail the agent.
fn hook(args: &[String]) {
    let agent = args.first().cloned().unwrap_or_default();
    let Ok(session_id) = std::env::var("ERKA_SESSION_ID") else { return };
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
