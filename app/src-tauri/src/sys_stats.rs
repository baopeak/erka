//! Memory meter: resident memory of the app (incl. its WebView processes), the session daemon,
//! and everything the daemon runs (shells, agents and their children).

use std::collections::HashMap;
use std::sync::LazyLock;

use parking_lot::Mutex;
use serde::Serialize;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

use crate::fs_ops::{err, CmdResult};

static SYS: LazyLock<Mutex<System>> = LazyLock::new(|| Mutex::new(System::new()));

#[derive(Serialize)]
pub struct MemoryStats {
    /// App process + WebView processes, bytes.
    app: u64,
    daemon: u64,
    /// Sessions: every descendant of the daemon.
    sessions: u64,
    session_processes: u32,
}

/// Sum of memory of `root`'s descendants (not `root` itself), and their count.
fn descendants(children: &HashMap<Pid, Vec<Pid>>, mem: &HashMap<Pid, u64>, root: Pid) -> (u64, u32) {
    let (mut total, mut count) = (0, 0);
    let mut stack = children.get(&root).cloned().unwrap_or_default();
    while let Some(pid) = stack.pop() {
        total += mem.get(&pid).copied().unwrap_or(0);
        count += 1;
        if let Some(c) = children.get(&pid) {
            stack.extend(c);
        }
    }
    (total, count)
}

fn collect(daemon_pid: Option<u32>) -> MemoryStats {
    let mut sys = SYS.lock();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_memory());
    let mut children: HashMap<Pid, Vec<Pid>> = HashMap::new();
    let mut mem: HashMap<Pid, u64> = HashMap::new();
    for (pid, p) in sys.processes() {
        mem.insert(*pid, p.memory());
        if let Some(parent) = p.parent() {
            children.entry(parent).or_default().push(*pid);
        }
    }
    let me = Pid::from_u32(std::process::id());
    let daemon = daemon_pid.map(Pid::from_u32);
    // The daemon is detached from the app, but guard against counting it twice anyway.
    let (app_children, _) = descendants(&children, &mem, me);
    let (sessions, session_processes) = daemon.map_or((0, 0), |d| descendants(&children, &mem, d));
    let daemon_mem = daemon.and_then(|d| mem.get(&d).copied()).unwrap_or(0);
    let overlap = daemon.filter(|d| sys.process(*d).and_then(|p| p.parent()) == Some(me)).map_or(0, |_| daemon_mem + sessions);
    MemoryStats {
        app: mem.get(&me).copied().unwrap_or(0) + app_children - overlap,
        daemon: daemon_mem,
        sessions,
        session_processes,
    }
}

#[tauri::command]
pub async fn memory_stats(daemon_pid: Option<u32>) -> CmdResult<MemoryStats> {
    tauri::async_runtime::spawn_blocking(move || collect(daemon_pid)).await.map_err(err)
}
