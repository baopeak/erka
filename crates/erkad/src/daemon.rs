//! Session registry, client registry, RPC methods and the periodic status/persistence ticker.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use parking_lot::{Mutex, RwLock};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::agents;
use crate::chat::ChatSession;
use crate::persist::{SavedSession, Store};
use crate::session::{json_out, now_millis, ClientTx, Session, SessionInfo, SessionSpec};
use crate::status::hook_event_status;

#[derive(Clone)]
pub enum Entry {
    Term(Arc<Session>),
    Chat(Arc<ChatSession>),
}

impl Entry {
    fn info(&self) -> SessionInfo {
        match self {
            Entry::Term(s) => s.info(),
            Entry::Chat(c) => c.info(),
        }
    }
    fn spec(&self) -> SessionSpec {
        match self {
            Entry::Term(s) => s.spec.lock().clone(),
            Entry::Chat(c) => c.spec.lock().clone(),
        }
    }
    fn detach(&self, client: u64) {
        match self {
            Entry::Term(s) => s.detach(client),
            Entry::Chat(c) => c.detach(client),
        }
    }
    pub fn input(&self, bytes: Vec<u8>) {
        match self {
            Entry::Term(s) => s.input(bytes),
            Entry::Chat(c) => c.input(bytes),
        }
    }
    fn kill(&self) {
        match self {
            Entry::Term(s) => s.kill(),
            Entry::Chat(c) => c.kill(),
        }
    }
}

pub struct Daemon {
    sessions: RwLock<BTreeMap<u32, Entry>>,
    next_handle: AtomicU32,
    clients: Mutex<HashMap<u64, ClientTx>>,
    store: Store,
    pub data_dir: PathBuf,
    /// Path of this executable; agents call it back as `erkad hook …`.
    pub exe: PathBuf,
    meta_dirty: AtomicBool,
    pub shutdown: tokio::sync::Notify,
}

#[derive(Deserialize)]
struct CreateParams {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default = "default_kind")]
    kind: String,
    cwd: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    #[serde(default)]
    agent_session_id: Option<String>,
    #[serde(default = "default_cols")]
    cols: u16,
    #[serde(default = "default_rows")]
    rows: u16,
    /// Chat mode: spawn this argv with piped stdio instead of a PTY.
    #[serde(default)]
    chat_argv: Option<Vec<String>>,
}

fn default_kind() -> String {
    "shell".into()
}
fn default_cols() -> u16 {
    120
}
fn default_rows() -> u16 {
    32
}

fn param<'a>(params: &'a Value, key: &str) -> Result<&'a Value> {
    params.get(key).ok_or_else(|| anyhow!("missing param `{key}`"))
}

fn handle_of(params: &Value) -> Result<u32> {
    param(params, "handle")?.as_u64().map(|h| h as u32).ok_or_else(|| anyhow!("bad handle"))
}

impl Daemon {
    pub fn new(data_dir: PathBuf, exe: PathBuf) -> Arc<Daemon> {
        Arc::new(Daemon {
            sessions: RwLock::new(BTreeMap::new()),
            next_handle: AtomicU32::new(1),
            clients: Mutex::new(HashMap::new()),
            store: Store::new(&data_dir),
            data_dir,
            exe,
            meta_dirty: AtomicBool::new(false),
            shutdown: tokio::sync::Notify::new(),
        })
    }

    pub fn register_client(&self, id: u64, tx: ClientTx) {
        self.clients.lock().insert(id, tx);
    }

    pub fn unregister_client(&self, id: u64) {
        self.clients.lock().remove(&id);
        for entry in self.sessions.read().values() {
            entry.detach(id);
        }
    }

    pub fn broadcast(&self, event: &str, params: Value) {
        let msg = json_out(&json!({"event": event, "params": params}));
        let clients = self.clients.lock();
        for tx in clients.values() {
            let _ = tx.send(crate::session::Outgoing { data: msg.data.clone(), credit: None });
        }
    }

    pub fn entry(&self, handle: u32) -> Result<Entry> {
        self.sessions.read().get(&handle).cloned().ok_or_else(|| anyhow!("no session {handle}"))
    }

    fn by_id(&self, id: &str) -> Option<Entry> {
        self.sessions.read().values().find(|e| e.spec().id == id).cloned()
    }

    /// Restores sessions recorded by a previous daemon run as exited-but-restartable entries
    /// whose screens show the last persisted snapshot.
    pub fn restore(&self) {
        for saved in self.store.load_sessions() {
            if saved.chat {
                continue; // chat processes are re-created from the agent transcript instead
            }
            let handle = self.next_handle.fetch_add(1, Ordering::Relaxed);
            let session = Session::new(handle, saved.spec.clone(), saved.cols, saved.rows);
            if let Some(snapshot) = self.store.load_snapshot(&saved.spec.id) {
                session.ingest(&snapshot);
                session.ingest(b"\r\n\x1b[0;2m[session ended when Erka's daemon stopped - restart to continue]\x1b[0m\r\n");
            }
            self.sessions.write().insert(handle, Entry::Term(session));
        }
    }

    pub fn create(&self, params: Value) -> Result<SessionInfo> {
        let p: CreateParams = serde_json::from_value(params).context("session.create params")?;
        let spec = SessionSpec {
            id: p.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            project_id: p.project_id,
            name: p.name,
            kind: p.kind,
            cwd: p.cwd,
            args: p.args,
            env: p.env,
            agent_session_id: p.agent_session_id,
            created_at: now_millis(),
        };
        if self.by_id(&spec.id).is_some() {
            bail!("session id {} already exists", spec.id);
        }
        let handle = self.next_handle.fetch_add(1, Ordering::Relaxed);
        let entry = if let Some(argv) = p.chat_argv {
            anyhow::ensure!(!argv.is_empty(), "chat_argv is empty");
            let chat = ChatSession::new(handle, spec);
            chat.spawn(&agents::platform_argv(argv)?)?;
            Entry::Chat(chat)
        } else {
            let launch = agents::build_launch(
                &spec.kind,
                &spec.args,
                spec.agent_session_id.as_deref(),
                &self.exe,
                &self.data_dir,
            )?;
            let session = Session::new(handle, spec, p.cols, p.rows);
            session.spawn(&launch)?;
            Entry::Term(session)
        };
        let info = entry.info();
        self.sessions.write().insert(handle, entry);
        self.meta_dirty.store(true, Ordering::Relaxed);
        self.broadcast("session.updated", serde_json::to_value(&info)?);
        Ok(info)
    }

    pub fn restart(&self, handle: u32) -> Result<SessionInfo> {
        let Entry::Term(session) = self.entry(handle)? else { bail!("chat sessions cannot be restarted") };
        anyhow::ensure!(!session.is_alive(), "session is still running");
        let spec = session.spec.lock().clone();
        let launch = agents::build_launch(
            &spec.kind,
            &spec.args,
            spec.agent_session_id.as_deref(),
            &self.exe,
            &self.data_dir,
        )?;
        session.ingest(b"\x1b[0m\x1b[2J\x1b[3J\x1b[H");
        session.spawn(&launch)?;
        Ok(session.info())
    }

    pub fn close(&self, handle: u32) -> Result<()> {
        let entry = self.sessions.write().remove(&handle).ok_or_else(|| anyhow!("no session {handle}"))?;
        entry.kill();
        self.store.remove_snapshot(&entry.spec().id);
        self.meta_dirty.store(true, Ordering::Relaxed);
        self.broadcast("session.closed", json!({"handle": handle}));
        Ok(())
    }

    pub fn update_spec(&self, handle: u32, params: &Value) -> Result<SessionInfo> {
        let entry = self.entry(handle)?;
        let spec_lock = match &entry {
            Entry::Term(s) => &s.spec,
            Entry::Chat(c) => &c.spec,
        };
        {
            let mut spec = spec_lock.lock();
            if let Some(name) = params.get("name") {
                spec.name = name.as_str().map(str::to_string);
            }
            if let Some(project) = params.get("project_id") {
                spec.project_id = project.as_str().map(str::to_string);
            }
            if let Some(id) = params.get("agent_session_id") {
                spec.agent_session_id = id.as_str().map(str::to_string);
            }
            if let Some(args) = params.get("args").and_then(Value::as_array) {
                spec.args = args.iter().filter_map(|a| a.as_str().map(str::to_string)).collect();
            }
        }
        self.meta_dirty.store(true, Ordering::Relaxed);
        Ok(entry.info())
    }

    /// `erkad hook` reports from Claude Code / Codex running inside a session.
    pub fn hook(&self, params: &Value) -> Result<()> {
        let session_id = param(params, "session_id")?.as_str().unwrap_or_default();
        let agent = params.get("agent").and_then(Value::as_str).unwrap_or("");
        let payload = params.get("payload").cloned().unwrap_or(Value::Null);
        let Some(Entry::Term(session)) = self.by_id(session_id) else { return Ok(()) };
        let event = payload
            .get("hook_event_name")
            .or_else(|| payload.get("type"))
            .and_then(Value::as_str)
            .unwrap_or("");
        tracing::debug!(session_id, agent, event, "hook");
        let agent_conv = match agent {
            "claude" => payload.get("session_id"),
            "codex" => payload.get("thread-id").or_else(|| payload.get("thread_id")),
            _ => None,
        }
        .and_then(Value::as_str);
        if let Some(conv) = agent_conv {
            let mut spec = session.spec.lock();
            if spec.agent_session_id.as_deref() != Some(conv) {
                spec.agent_session_id = Some(conv.to_string());
                self.meta_dirty.store(true, Ordering::Relaxed);
            }
        }
        if let Some(status) = hook_event_status(agent, event, &payload) {
            session.set_hook_status(status);
        }
        Ok(())
    }

    pub fn list(&self) -> Vec<SessionInfo> {
        self.sessions.read().values().map(Entry::info).collect()
    }

    fn saved_sessions(&self) -> Vec<SavedSession> {
        self.sessions
            .read()
            .values()
            .map(|e| {
                let info = e.info();
                SavedSession { spec: info.spec, title: info.title, cols: info.cols, rows: info.rows, chat: info.chat }
            })
            .collect()
    }

    /// Persists metadata (when dirty) and screen snapshots (when changed or `force`).
    pub fn persist(&self, force: bool) {
        if force || self.meta_dirty.swap(false, Ordering::Relaxed) {
            if let Err(e) = self.store.save_sessions(&self.saved_sessions()) {
                tracing::warn!("save sessions: {e:#}");
            }
        }
        let terms: Vec<Arc<Session>> = self
            .sessions
            .read()
            .values()
            .filter_map(|e| if let Entry::Term(s) = e { Some(s.clone()) } else { None })
            .collect();
        for s in terms {
            if let Some(snapshot) = s.snapshot_if_changed(force) {
                let id = s.spec.lock().id.clone();
                if let Err(e) = self.store.save_snapshot(&id, &snapshot) {
                    tracing::warn!("save snapshot {id}: {e:#}");
                }
            }
        }
    }

    /// Status changes are coalesced here (250 ms) instead of being pushed per output chunk,
    /// so 20 busy agents cost the UI at most a few small events per second.
    pub async fn ticker(self: Arc<Self>) {
        let mut interval = tokio::time::interval(Duration::from_millis(250));
        let mut last_persist = Instant::now();
        loop {
            interval.tick().await;
            let now = Instant::now();
            let entries: Vec<Entry> = self.sessions.read().values().cloned().collect();
            for entry in entries {
                let changed = match &entry {
                    Entry::Term(s) => s.tick(now),
                    Entry::Chat(c) => c.tick(now),
                };
                if let Some(info) = changed {
                    if let Ok(v) = serde_json::to_value(&info) {
                        self.broadcast("session.updated", v);
                    }
                }
            }
            if now.duration_since(last_persist) > Duration::from_secs(30) || self.meta_dirty.load(Ordering::Relaxed) {
                let me = self.clone();
                let full = now.duration_since(last_persist) > Duration::from_secs(30);
                if full {
                    last_persist = now;
                }
                let _ = tokio::task::spawn_blocking(move || {
                    if full {
                        me.persist(false)
                    } else if me.meta_dirty.swap(false, Ordering::Relaxed) {
                        let _ = me.store.save_sessions(&me.saved_sessions());
                    }
                })
                .await;
            }
        }
    }

    /// Handles one JSON-RPC style request. Returns `None` when the method already replied
    /// (attach replies inline to preserve ordering with the output stream).
    pub fn dispatch(self: &Arc<Self>, client: u64, tx: &ClientTx, id: &Value, method: &str, params: Value) -> Result<Option<Value>> {
        Ok(Some(match method {
            "daemon.info" => json!({
                "version": env!("CARGO_PKG_VERSION"),
                "protocol": erka_proto::PROTOCOL_VERSION,
                "pid": std::process::id(),
                "data_dir": self.data_dir,
                "endpoint": erka_proto::endpoint().display(),
                "sessions": self.sessions.read().len(),
            }),
            "daemon.shutdown" => {
                if params.get("kill_sessions").and_then(Value::as_bool).unwrap_or(false) {
                    for e in self.sessions.read().values() {
                        e.kill();
                    }
                    // Unix kills escalate to SIGKILL after 1.5 s; stay alive until then.
                    std::thread::sleep(std::time::Duration::from_millis(1700));
                }
                self.shutdown.notify_one();
                json!(true)
            }
            "session.list" => serde_json::to_value(self.list())?,
            "session.create" => serde_json::to_value(self.create(params)?)?,
            "session.attach" => {
                let handle = handle_of(&params)?;
                match self.entry(handle)? {
                    Entry::Term(s) => {
                        let since = params.get("since_seq").and_then(Value::as_u64);
                        let interactive = params.get("interactive").and_then(Value::as_bool).unwrap_or(true);
                        s.attach(client, tx, id, since, interactive);
                    }
                    Entry::Chat(c) => c.attach(client, tx, id),
                }
                return Ok(None);
            }
            "session.detach" => {
                self.entry(handle_of(&params)?)?.detach(client);
                json!(true)
            }
            "session.input" => {
                let data = param(&params, "data")?.as_str().unwrap_or_default();
                self.entry(handle_of(&params)?)?.input(data.as_bytes().to_vec());
                json!(true)
            }
            "session.resize" => {
                let cols = param(&params, "cols")?.as_u64().unwrap_or(80) as u16;
                let rows = param(&params, "rows")?.as_u64().unwrap_or(24) as u16;
                if let Entry::Term(s) = self.entry(handle_of(&params)?)? {
                    s.resize(cols.clamp(2, 1000), rows.clamp(1, 500));
                }
                json!(true)
            }
            "session.focus" => {
                let focused = params.get("focused").and_then(Value::as_bool).unwrap_or(true);
                match self.entry(handle_of(&params)?)? {
                    Entry::Term(s) => s.set_focus(focused),
                    Entry::Chat(c) => c.set_focus(focused),
                }
                json!(true)
            }
            "session.kill" => {
                self.entry(handle_of(&params)?)?.kill();
                json!(true)
            }
            "session.close" => {
                self.close(handle_of(&params)?)?;
                json!(true)
            }
            "session.restart" => serde_json::to_value(self.restart(handle_of(&params)?)?)?,
            "session.update" => serde_json::to_value(self.update_spec(handle_of(&params)?, &params)?)?,
            "session.read" => match self.entry(handle_of(&params)?)? {
                Entry::Term(s) => json!({"text": s.screen_text(), "title": s.title()}),
                Entry::Chat(_) => bail!("session.read is for terminal sessions"),
            },
            "chat.close_stdin" => {
                if let Entry::Chat(c) = self.entry(handle_of(&params)?)? {
                    c.close_stdin();
                }
                json!(true)
            }
            "hook.report" => {
                self.hook(&params)?;
                json!(true)
            }
            other => bail!("unknown method {other}"),
        }))
    }
}
