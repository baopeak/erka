//! One terminal session: PTY + headless VT state + subscribers.
//!
//! Threading model (per session):
//! - reader thread: blocking PTY read → [`Session::ingest`] (parse, ring, fan-out). Never
//!   blocks on consumers: a subscriber that falls behind its byte budget is marked stalled and
//!   told to resync, the PTY keeps draining.
//! - writer thread: owns the PTY master; serialises input writes and resizes so a large paste
//!   can never deadlock against the reader (ConPTY requires separate read/write threads).
//! - waiter thread: blocks on child exit, then closes the PTY.

use std::collections::{BTreeMap, VecDeque};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use base64::Engine as _;
use erka_proto::Frame;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::agents::Launch;
use crate::proc_tree::ProcTree;
use crate::status::{Activity, Status, MIN_WORK_FOR_UNREAD};
use crate::vt::{Vt, VtEvent};

/// Raw output kept for cheap, exact replays.
pub const RING_CAP: usize = 1 << 20;
/// Above this many bytes behind, a snapshot is cheaper than a replay.
pub const REPLAY_LIMIT: u64 = 256 * 1024;
/// Unsent bytes allowed per subscriber before it must resync.
pub const SUB_BUDGET: usize = 4 << 20;
pub const SCROLLBACK: usize = 5000;
pub const SNAPSHOT_HISTORY: usize = 2000;


#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SessionSpec {
    pub id: String,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    /// shell | claude | codex | omp | custom
    pub kind: String,
    pub cwd: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// Agent-side conversation id (Claude session id, Codex thread id…) used for resume.
    #[serde(default)]
    pub agent_session_id: Option<String>,
    /// Model the agent runs (from `--model`, hooks or the chat protocol), for display.
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SessionInfo {
    pub handle: u32,
    #[serde(flatten)]
    pub spec: SessionSpec,
    pub title: Option<String>,
    pub status: Status,
    pub unread: bool,
    pub alive: bool,
    pub exit_code: Option<i32>,
    pub pid: Option<u32>,
    pub cols: u16,
    pub rows: u16,
    pub seq: u64,
    /// Not a terminal session: a structured chat process (see `chat.rs`).
    pub chat: bool,
    /// Wall-clock ms of the last output or input (0 = never). Not a broadcast trigger.
    pub last_activity: u64,
}

/// One queued write to a client socket. `credit` is decremented once written.
pub struct Outgoing {
    pub data: Arc<[u8]>,
    pub credit: Option<Arc<AtomicUsize>>,
}

pub type ClientTx = tokio::sync::mpsc::UnboundedSender<Outgoing>;

pub fn json_out(value: &Value) -> Outgoing {
    Outgoing { data: Frame::json(value).encode().into(), credit: None }
}

struct Sub {
    client: u64,
    tx: ClientTx,
    credit: Arc<AtomicUsize>,
    interactive: bool,
    stalled: bool,
}

enum Ctl {
    Input(Vec<u8>),
    Resize(u16, u16),
    Close,
}

struct Pty {
    ctl: std::sync::mpsc::Sender<Ctl>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    tree: Option<ProcTree>,
    pid: Option<u32>,
}

struct Ring {
    buf: VecDeque<u8>,
}

impl Ring {
    fn push(&mut self, bytes: &[u8]) {
        if bytes.len() >= RING_CAP {
            self.buf.clear();
            self.buf.extend(&bytes[bytes.len() - RING_CAP..]);
            return;
        }
        let overflow = (self.buf.len() + bytes.len()).saturating_sub(RING_CAP);
        self.buf.drain(..overflow);
        self.buf.extend(bytes);
    }

    /// Bytes after stream offset `from`, given the stream is currently at `seq`.
    fn since(&self, from: u64, seq: u64) -> Option<Vec<u8>> {
        let start = seq - self.buf.len() as u64;
        if from < start || from > seq {
            return None;
        }
        let skip = (from - start) as usize;
        Some(self.buf.iter().skip(skip).copied().collect())
    }
}

struct Inner {
    vt: Vt,
    ring: Ring,
    seq: u64,
    /// Raw replay from before this offset would be rendered at the wrong size.
    replay_floor: u64,
    subs: Vec<Sub>,
    activity: Activity,
    focused: bool,
    unread: bool,
    last_status: Status,
    exit_code: Option<i32>,
    pty: Option<Pty>,
    generation: u64,
    persisted_seq: u64,
    last_broadcast: Option<SessionInfo>,
    working_since: Option<Instant>,
    last_activity: u64,
    /// `last_activity` as of the last broadcast; output alone re-broadcasts at most every 30 s.
    broadcast_activity: u64,
}

pub struct Session {
    pub handle: u32,
    pub spec: Mutex<SessionSpec>,
    inner: Mutex<Inner>,
}

/// How stale a broadcast `last_activity` may get while a session keeps printing.
pub const ACTIVITY_REBROADCAST_MS: u64 = 30_000;

pub fn now_millis() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl Session {
    pub fn new(handle: u32, spec: SessionSpec, cols: u16, rows: u16) -> Arc<Session> {
        Arc::new(Session {
            handle,
            spec: Mutex::new(spec),
            inner: Mutex::new(Inner {
                vt: Vt::new(cols, rows, SCROLLBACK),
                ring: Ring { buf: VecDeque::with_capacity(64 * 1024) },
                seq: 0,
                replay_floor: 0,
                subs: Vec::new(),
                activity: Activity { alive: false, ..Default::default() },
                focused: false,
                unread: false,
                last_status: Status::Exited,
                exit_code: None,
                pty: None,
                generation: 0,
                persisted_seq: 0,
                last_broadcast: None,
                working_since: None,
                last_activity: 0,
                broadcast_activity: 0,
            }),
        })
    }

    pub fn spawn(self: &Arc<Self>, launch: &Launch) -> Result<()> {
        let spec = self.spec.lock().clone();
        let (cols, rows) = self.inner.lock().vt.size();
        let pair = native_pty_system()
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .context("open pty")?;
        let mut cmd = CommandBuilder::new(&launch.argv[0]);
        cmd.args(&launch.argv[1..]);
        if std::path::Path::new(&spec.cwd).is_dir() {
            cmd.cwd(&spec.cwd);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "Erka");
        cmd.env("ERKA_SESSION_ID", &spec.id);
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        let mut child = pair.slave.spawn_command(cmd).with_context(|| format!("spawn {:?}", launch.argv))?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader()?;
        let mut writer = pair.master.take_writer()?;
        let master = pair.master;
        let pid = child.process_id();
        let tree = pid.and_then(|p| ProcTree::adopt(p).map_err(|e| tracing::warn!("job object: {e}")).ok());
        let killer = child.clone_killer();
        let (ctl_tx, ctl_rx) = std::sync::mpsc::channel::<Ctl>();

        let generation = {
            let mut g = self.inner.lock();
            if g.pty.is_some() {
                // Lost a race with another spawn/restart: never run two processes in one session.
                drop(g);
                let _ = child.kill();
                anyhow::bail!("session is already running");
            }
            g.generation += 1;
            g.exit_code = None;
            g.activity = Activity { alive: true, ..Default::default() };
            g.last_status = Status::Idle;
            g.pty = Some(Pty { ctl: ctl_tx.clone(), killer, tree, pid });
            g.generation
        };

        let name = format!("erka-pty-{}", self.handle);
        std::thread::Builder::new().name(format!("{name}-w")).spawn(move || {
            while let Ok(msg) = ctl_rx.recv() {
                match msg {
                    Ctl::Input(bytes) => {
                        if writer.write_all(&bytes).and_then(|_| writer.flush()).is_err() {
                            break;
                        }
                    }
                    Ctl::Resize(cols, rows) => {
                        let _ = master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
                    }
                    Ctl::Close => break,
                }
            }
            // Dropping the master closes the pseudoconsole, which unblocks the reader.
            drop(writer);
            drop(master);
        })?;

        let me = Arc::clone(self);
        std::thread::Builder::new().name(format!("{name}-r")).spawn(move || {
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => me.ingest(&buf[..n]),
                }
            }
        })?;

        let me = Arc::clone(self);
        std::thread::Builder::new().name(format!("{name}-x")).spawn(move || {
            let code = child.wait().map(|s| s.exit_code() as i32).unwrap_or(-1);
            let _ = ctl_tx.send(Ctl::Close);
            me.on_exit(generation, code);
        })?;
        Ok(())
    }

    fn on_exit(&self, generation: u64, code: i32) {
        {
            let mut g = self.inner.lock();
            if g.generation != generation {
                return;
            }
            // Dropping the job kills anything the process left running in its tree.
            g.pty = None;
            g.exit_code = Some(code);
            g.activity.alive = false;
        }
        // Give the reader a moment to deliver the final output before the marker.
        std::thread::sleep(std::time::Duration::from_millis(50));
        self.ingest(format!("\r\n\x1b[0;2m[process exited · code {code}]\x1b[0m\r\n").as_bytes());
    }

    /// Parse in order, remember, fan out. Hot path: called for every PTY chunk.
    pub fn ingest(&self, bytes: &[u8]) {
        let now = Instant::now();
        let mut g = self.inner.lock();
        let events = g.vt.feed(bytes);
        g.seq += bytes.len() as u64;
        g.ring.push(bytes);
        g.activity.on_output(now);
        g.last_activity = now_millis();
        let handle = self.handle;
        if !g.subs.is_empty() {
            let frame: Arc<[u8]> = Frame::Output { handle, seq: g.seq, data: bytes.to_vec() }.encode().into();
            let len = frame.len();
            g.subs.retain_mut(|s| {
                if s.stalled {
                    return true;
                }
                if s.credit.load(Ordering::Relaxed) + len > SUB_BUDGET {
                    s.stalled = true;
                    return s.tx.send(json_out(&json!({"event": "session.resync", "params": {"handle": handle}}))).is_ok();
                }
                s.credit.fetch_add(len, Ordering::Relaxed);
                s.tx.send(Outgoing { data: frame.clone(), credit: Some(s.credit.clone()) }).is_ok()
            });
        }
        if events.is_empty() {
            return;
        }
        let interactive = g.subs.iter().any(|s| s.interactive && !s.stalled);
        for ev in events {
            match ev {
                // An attached xterm answers queries itself; answering twice corrupts input.
                VtEvent::Reply(reply) if !interactive => {
                    if let Some(pty) = &g.pty {
                        let _ = pty.ctl.send(Ctl::Input(reply.into_bytes()));
                    }
                }
                VtEvent::Bell => g.activity.bell = Some(now),
                VtEvent::Clipboard(text) => {
                    let msg = json!({"event": "session.clipboard", "params": {"handle": handle, "text": text}});
                    for s in g.subs.iter().filter(|s| s.interactive) {
                        let _ = s.tx.send(json_out(&msg));
                    }
                }
                _ => {}
            }
        }
    }

    /// Subscribes `client` and sends the attach reply (inline, under the lock, so no output
    /// frame can slip between the reply's `seq` and the live stream).
    pub fn attach(&self, client: u64, tx: &ClientTx, req_id: &Value, since: Option<u64>, interactive: bool) {
        let mut g = self.inner.lock();
        g.subs.retain(|s| s.client != client);
        let seq = g.seq;
        let delta = since
            .filter(|&s| s >= g.replay_floor && seq.saturating_sub(s) <= REPLAY_LIMIT)
            .and_then(|s| g.ring.since(s, seq));
        let (mode, raw, data) = if let Some(bytes) = delta {
            ("delta", true, bytes)
        } else if g.replay_floor == 0 && seq <= REPLAY_LIMIT && g.ring.buf.len() as u64 == seq {
            ("reset", true, g.ring.buf.iter().copied().collect())
        } else {
            ("reset", false, g.vt.snapshot(SNAPSHOT_HISTORY))
        };
        let (cols, rows) = g.vt.size();
        let reply = json!({"id": req_id, "result": {
            "mode": mode, "raw": raw, "seq": seq, "cols": cols, "rows": rows,
            "data": base64::engine::general_purpose::STANDARD.encode(&data),
        }});
        let _ = tx.send(json_out(&reply));
        g.subs.push(Sub { client, tx: tx.clone(), credit: Arc::new(AtomicUsize::new(0)), interactive, stalled: false });
        if interactive {
            g.focused = true;
            g.unread = false;
        }
    }

    pub fn detach(&self, client: u64) {
        let mut g = self.inner.lock();
        g.subs.retain(|s| s.client != client);
        if !g.subs.iter().any(|s| s.interactive) {
            g.focused = false;
        }
    }

    pub fn input(&self, bytes: Vec<u8>) {
        let mut g = self.inner.lock();
        g.activity.last_input = Some(Instant::now());
        g.last_activity = now_millis();
        g.activity.bell = None;
        if let Some(pty) = &g.pty {
            let _ = pty.ctl.send(Ctl::Input(bytes));
        }
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        let mut g = self.inner.lock();
        if g.vt.size() == (cols, rows) {
            return;
        }
        g.vt.resize(cols, rows);
        g.replay_floor = g.seq;
        if let Some(pty) = &g.pty {
            let _ = pty.ctl.send(Ctl::Resize(cols, rows));
        }
    }

    pub fn set_unread(&self, unread: bool) {
        let mut g = self.inner.lock();
        g.unread = unread;
        // Force the next tick to broadcast.
        g.last_broadcast = None;
    }

    /// Restored sessions keep the activity time of their previous life, not the replay's.
    pub fn set_last_activity(&self, at: u64) {
        let mut g = self.inner.lock();
        g.last_activity = at;
        g.broadcast_activity = at;
    }

    pub fn set_focus(&self, focused: bool) {
        let mut g = self.inner.lock();
        g.focused = focused;
        if focused {
            g.unread = false;
        }
    }

    pub fn kill(&self) {
        let g = self.inner.lock();
        if let Some(pty) = &g.pty {
            match &pty.tree {
                Some(tree) => tree.kill(),
                None => {
                    let mut killer = pty.killer.clone_killer();
                    let _ = killer.kill();
                }
            }
        }
    }

    pub fn is_alive(&self) -> bool {
        self.inner.lock().pty.is_some()
    }

    pub fn set_hook_status(&self, status: Status) {
        self.inner.lock().activity.hook = Some((status, Instant::now()));
    }

    pub fn screen_text(&self) -> String {
        self.inner.lock().vt.screen_text()
    }

    pub fn info(&self) -> SessionInfo {
        let g = self.inner.lock();
        self.info_locked(&g, g.last_status)
    }

    fn info_locked(&self, g: &Inner, status: Status) -> SessionInfo {
        let (cols, rows) = g.vt.size();
        SessionInfo {
            handle: self.handle,
            spec: self.spec.lock().clone(),
            title: g.vt.title().map(str::to_string),
            status,
            unread: g.unread,
            alive: g.pty.is_some(),
            exit_code: g.exit_code,
            pid: g.pty.as_ref().and_then(|p| p.pid),
            cols,
            rows,
            seq: g.seq,
            chat: false,
            last_activity: g.last_activity,
        }
    }

    /// Recomputes status; returns the new info when anything user-visible changed.
    pub fn tick(&self, now: Instant) -> Option<SessionInfo> {
        let mut g = self.inner.lock();
        let status = g.activity.status(now);
        if status == Status::Working && g.last_status != Status::Working {
            g.working_since = Some(now);
        }
        if g.last_status == Status::Working && matches!(status, Status::Idle | Status::Waiting) && !g.focused {
            // A shell printing its prompt is not "work finished"; require a real stretch.
            let worked = g.working_since.is_some_and(|t| now.duration_since(t) >= MIN_WORK_FOR_UNREAD);
            g.unread |= worked || status == Status::Waiting || g.activity.hook.is_some();
        }
        g.last_status = status;
        let mut info = self.info_locked(&g, status);
        // seq / activity time change constantly; not a reason to broadcast
        info.seq = 0;
        info.last_activity = 0;
        if g.last_broadcast.as_ref() == Some(&info) && g.last_activity < g.broadcast_activity + ACTIVITY_REBROADCAST_MS {
            return None;
        }
        g.last_broadcast = Some(info.clone());
        g.broadcast_activity = g.last_activity;
        info.seq = g.seq;
        info.last_activity = g.last_activity;
        Some(info)
    }

    /// Snapshot for persistence when output arrived since the last one.
    pub fn snapshot_if_changed(&self, force: bool) -> Option<Vec<u8>> {
        let mut g = self.inner.lock();
        if !force && g.seq == g.persisted_seq {
            return None;
        }
        g.persisted_seq = g.seq;
        Some(g.vt.snapshot(SNAPSHOT_HISTORY))
    }

    pub fn title(&self) -> Option<String> {
        self.inner.lock().vt.title().map(str::to_string)
    }
}

static NEXT_CLIENT: AtomicU64 = AtomicU64::new(1);

pub fn next_client_id() -> u64 {
    NEXT_CLIENT.fetch_add(1, Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_since_bounds() {
        let mut r = Ring { buf: VecDeque::new() };
        r.push(b"hello");
        r.push(b" world");
        assert_eq!(r.since(5, 11).unwrap(), b" world");
        assert_eq!(r.since(11, 11).unwrap(), b"");
        assert!(r.since(12, 11).is_none());
        let big = vec![b'x'; RING_CAP + 10];
        r.push(&big);
        let seq = 11 + big.len() as u64;
        assert!(r.since(0, seq).is_none());
        assert_eq!(r.since(seq - 3, seq).unwrap(), b"xxx");
    }
}
