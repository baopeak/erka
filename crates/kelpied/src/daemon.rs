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

use crate::agents::{self, Resume};
use crate::automations::{Automation, Automations};
use crate::awake::{self, Awake};
use crate::chat::ChatSession;
use crate::meta::MetaStore;
use crate::status::Status;
use crate::persist::{write_atomic, SavedSession, Store};
use crate::runs::{self, Action, NewRun, Runs, SessionView, TaskStatus};
use crate::session::{json_out, now_millis, ClientTx, Session, SessionInfo, SessionSpec};
use crate::status::{hook_event_failed, hook_event_status, turn_event};

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
    /// Path of this executable; agents call it back as `kelpied hook …`.
    pub exe: PathBuf,
    meta_dirty: AtomicBool,
    pub shutdown: tokio::sync::Notify,
    workspace_meta: Mutex<MetaStore>,
    automations: Mutex<Automations>,
    runs: Mutex<Runs>,
    pub mobile: crate::mobile::Mobile,
    awake: Awake,
    awake_mode: Mutex<awake::Mode>,
    /// Sessions no view shows run below normal CPU priority (`daemon.set_priority`).
    prioritize: AtomicBool,
    /// Programs in a session may script other sessions (`daemon.set_policy`, saved in
    /// `policy.json` so it holds while the app is closed).
    agents_control_others: AtomicBool,
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
    /// First message for an agent (as an argument, or typed once it is ready).
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    remote: Option<crate::session::RemoteSpec>,
    /// Its programs may act only on this session through `kelpied` (see `auth`).
    #[serde(default)]
    restricted: bool,
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

/// `--model X`, `--model=X` or `-m X` in an agent's extra arguments.
fn model_from_args(args: &[String]) -> Option<String> {
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == "--model" || a == "-m" {
            return it.next().cloned();
        }
        if let Some(m) = a.strip_prefix("--model=") {
            return Some(m.to_string());
        }
    }
    None
}

fn param<'a>(params: &'a Value, key: &str) -> Result<&'a Value> {
    params.get(key).ok_or_else(|| anyhow!("missing param `{key}`"))
}

fn handle_of(params: &Value) -> Result<u32> {
    param(params, "handle")?.as_u64().map(|h| h as u32).ok_or_else(|| anyhow!("bad handle"))
}

impl Daemon {
    pub fn new(data_dir: PathBuf, exe: PathBuf) -> Arc<Daemon> {
        // `prioritize` starts on (until the app says otherwise).
        crate::proc_tree::set_daemon_priority(true);
        Arc::new(Daemon {
            sessions: RwLock::new(BTreeMap::new()),
            next_handle: AtomicU32::new(1),
            clients: Mutex::new(HashMap::new()),
            store: Store::new(&data_dir),
            workspace_meta: Mutex::new(MetaStore::load(&data_dir)),
            automations: Mutex::new(Automations::load(&data_dir)),
            runs: Mutex::new(Runs::load(&data_dir)),
            mobile: crate::mobile::Mobile::load(&data_dir),
            awake: Awake::new(),
            awake_mode: Mutex::new(awake::Mode::Off),
            prioritize: AtomicBool::new(true),
            agents_control_others: AtomicBool::new(load_policy(&data_dir)),
            data_dir,
            exe,
            meta_dirty: AtomicBool::new(false),
            shutdown: tokio::sync::Notify::new(),
        })
    }

    /// A new Claude Code conversation gets its id from Kelpie (`claude --session-id <id>`): known
    /// from the first moment, so a restart resumes exactly it even when no hook reported it
    /// (hooks off, Claude stopped before its first hook, a host over SSH where hooks never run).
    /// Hooks still follow it when it changes (`/clear`, `/resume` inside Claude). True when an
    /// id was given.
    fn preset_conversation(spec: &mut SessionSpec) -> bool {
        if spec.kind != "claude" || spec.agent_session_id.is_some() || agents::claude_args_pick_conversation(&spec.args) {
            return false;
        }
        spec.agent_session_id = Some(uuid::Uuid::new_v4().to_string());
        true
    }

    /// What `restart` resumes: the known conversation, else (agents that report no id) the
    /// folder's most recent one.
    /// The command line of a session: local, or over SSH for a remote one.
    fn launch_for(spec: &SessionSpec, resume: Resume, prompt: Option<&str>, exe: &std::path::Path, data_dir: &std::path::Path) -> Result<agents::Launch> {
        match &spec.remote {
            Some(r) => agents::build_remote_launch(&spec.kind, &spec.args, resume, prompt, r, &spec.cwd, &spec.id),
            None => agents::build_launch(&spec.kind, &spec.args, resume, prompt, exe, data_dir),
        }
    }

    fn resume_for(spec: &SessionSpec) -> Resume<'_> {
        if spec.remote.is_some() {
            // No hooks reach us from another host: the conversation id is rarely known, and
            // the folder's latest conversation is the one this session had.
            return match spec.agent_session_id.as_deref() {
                Some(id) => Resume::Id(id),
                None if agents::preset_for(&spec.kind).is_some_and(|p| !p.resume_latest.is_empty()) => Resume::Latest,
                None => Resume::None,
            };
        }
        match spec.agent_session_id.as_deref() {
            // Claude saves a conversation only with its first turn: `--resume` of one never
            // saved fails, so that session starts it under the same id.
            Some(id) if spec.kind == "claude" && !agents::claude_conversation_saved(id, &spec.env) => {
                if agents::claude_args_pick_conversation(&spec.args) { Resume::None } else { Resume::New(id) }
            }
            Some(id) => Resume::Id(id),
            None if !matches!(spec.kind.as_str(), "claude" | "codex")
                && agents::preset_for(&spec.kind).is_some_and(|p| !p.resume_latest.is_empty()) =>
            {
                Resume::Latest
            }
            None => Resume::None,
        }
    }

    /// Starts the automation's agent with its prompt and records the run.
    pub fn run_automation(&self, id: &str) -> Result<SessionInfo> {
        let a = self.automations.lock().list.iter().find(|a| a.id == id).cloned().ok_or_else(|| anyhow!("no automation {id}"))?;
        let result = self.create(json!({
            "kind": a.kind,
            "cwd": a.cwd,
            "project_id": a.project_id,
            "name": a.name,
            "args": a.args,
            "env": a.env,
            "prompt": a.prompt,
        }));
        let (session, error) = match &result {
            Ok(info) => (Some(info.spec.id.clone()), None),
            Err(e) => (None, Some(format!("{e:#}"))),
        };
        self.automations.lock().record(id, now_millis(), session.clone(), error.clone());
        self.broadcast("automation.ran", json!({"id": id, "name": a.name, "session_id": session, "error": error}));
        result
    }

    /// Answers on `tx` once the one-shot run finishes (see `oneshot.rs`).
    fn agent_run(&self, tx: &ClientTx, id: &Value, params: &Value) -> Result<()> {
        let kind = params.get("kind").and_then(Value::as_str).unwrap_or("claude").to_string();
        let prompt = param(params, "prompt")?.as_str().unwrap_or_default().to_string();
        let cwd = params.get("cwd").and_then(Value::as_str).unwrap_or(".").to_string();
        let timeout = Duration::from_secs(params.get("timeout_s").and_then(Value::as_u64).unwrap_or(180).clamp(5, 900));
        let env: BTreeMap<String, String> = params.get("env").cloned().and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
        let (tx, id) = (tx.clone(), id.clone());
        std::thread::Builder::new().name("kelpie-oneshot".into()).spawn(move || {
            let reply = match crate::oneshot::run(&kind, &prompt, &cwd, &env, timeout) {
                Ok(text) => json!({"id": id, "result": {"text": text}}),
                Err(e) => json!({"id": id, "error": {"message": format!("{e:#}")}}),
            };
            let _ = tx.send(json_out(&reply));
        })?;
        Ok(())
    }

    /// Holds the wake request while the mode asks for it (called from the ticker).
    fn update_awake(&self) {
        let want = match *self.awake_mode.lock() {
            awake::Mode::Off => false,
            awake::Mode::Always => true,
            awake::Mode::Agents => self.sessions.read().values().any(|e| {
                let info = e.info();
                info.status == Status::Working && info.spec.kind != "shell"
            }),
        };
        self.awake.set(want);
    }

    // ---------- orchestration runs (see runs.rs) ----------

    /// Saves runs and tells clients about the ones that changed.
    fn runs_changed(&self, ids: &[String]) {
        if ids.is_empty() {
            return;
        }
        let runs = self.runs.lock();
        if let Err(e) = runs.save() {
            tracing::warn!("save runs: {e:#}");
        }
        for id in ids {
            if let Some(r) = runs.get(id) {
                self.broadcast("run.updated", json!(r));
            }
        }
    }

    /// One engine step: finish, skip and start tasks (called every second by the ticker).
    fn run_tick(self: &Arc<Self>) {
        let view = |sid: &str| {
            self.by_id(sid).map(|e| {
                let i = e.info();
                SessionView { alive: i.alive, working: i.status == Status::Working, idle: i.status == Status::Idle, exit_code: i.exit_code, last_activity: i.last_activity }
            })
        };
        let (actions, changed) = self.runs.lock().step(now_millis(), view);
        self.runs_changed(&changed);
        for a in actions {
            let me = self.clone();
            // Worktrees and process starts take a moment: never on the ticker itself.
            tokio::task::spawn_blocking(move || match a {
                Action::Start { run, task } => me.start_task(&run, &task),
                Action::Capture { run, task, session } => me.capture_task(&run, &task, &session),
            });
        }
    }

    /// Creates the task's worktree (when asked) and starts its agent with the task prompt.
    fn start_task(&self, run_id: &str, task_id: &str) {
        let Some((run, task)) = self.runs.lock().get(run_id).and_then(|r| r.tasks.iter().find(|t| t.id == task_id).cloned().map(|t| (r.clone(), t))) else { return };
        let prepared = if task.worktree { create_task_worktree(&run, &task).map(|(p, b)| (p, Some(b))) } else { Ok((run.cwd.clone(), None)) };
        // The session id is the task's before its process starts: an agent that reports at once
        // must find its task.
        let sid = uuid::Uuid::new_v4().to_string();
        if let Ok((t, _)) = self.runs.lock().task_mut(run_id, task_id) {
            t.session_id = Some(sid.clone());
        }
        let started = prepared.and_then(|(cwd, branch)| {
            let prompt = runs::task_prompt(&run, &task, &self.exe);
            let info = self.create(json!({
                "id": sid,
                "kind": task.kind,
                "cwd": cwd,
                "project_id": run.project_id,
                "name": format!("{} · {}", run.name, task.title),
                "args": task.args,
                "env": task.env,
                "prompt": prompt,
            }))?;
            Ok((info.spec.id, cwd, branch))
        });
        {
            let mut runs = self.runs.lock();
            let Ok((t, _)) = runs.task_mut(run_id, task_id) else { return };
            match started {
                Ok((sid, cwd, branch)) => {
                    // A report may already have finished it.
                    if t.status == TaskStatus::Starting {
                        t.status = TaskStatus::Running;
                    }
                    t.session_id = Some(sid);
                    t.cwd = Some(cwd);
                    t.branch = branch;
                    t.started_at = now_millis();
                }
                Err(e) => {
                    t.status = TaskStatus::Failed;
                    t.error = Some(format!("{e:#}"));
                    t.finished_at = now_millis();
                }
            }
        }
        self.runs_changed(&[run_id.to_string()]);
    }

    /// Keeps the end of a finished task's output when its agent reported no summary.
    fn capture_task(&self, run_id: &str, task_id: &str, session: &str) {
        let tail = match self.by_id(session) {
            Some(Entry::Term(s)) => s.text_tail(40),
            _ => return,
        };
        let text: Vec<&str> = tail.lines().map(str::trim_end).filter(|l| !l.trim().is_empty()).collect();
        let tail = text[text.len().saturating_sub(12)..].join("\n");
        {
            let mut runs = self.runs.lock();
            let Ok((t, _)) = runs.task_mut(run_id, task_id) else { return };
            if t.summary.is_some() || tail.is_empty() {
                return;
            }
            t.summary = Some(tail.chars().take(2000).collect());
        }
        self.runs_changed(&[run_id.to_string()]);
    }

    fn run_rpc(&self, method: &str, params: &Value) -> Result<Value> {
        let id = || params.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
        let task = || params.get("task").and_then(Value::as_str).unwrap_or_default().to_string();
        let mut kill: Vec<String> = Vec::new();
        let result = match method {
            "run.list" => return Ok(json!(self.runs.lock().list)),
            "run.get" => return Ok(json!(self.runs.lock().get(&id()).ok_or_else(|| anyhow!("no run {}", id()))?)),
            "run.create" => {
                let new: NewRun = serde_json::from_value(params.clone()).context("run.create params")?;
                let run = runs::build_run(new, uuid::Uuid::new_v4().to_string(), now_millis())?;
                let out = json!(run);
                let rid = run.id.clone();
                self.runs.lock().list.insert(0, run);
                self.runs_changed(&[rid]);
                return Ok(out);
            }
            "run.approve" => {
                let mut runs = self.runs.lock();
                let (t, rid) = runs.task_mut(&id(), &task())?;
                t.approved = true;
                if t.status == TaskStatus::WaitingApproval {
                    t.status = TaskStatus::Pending;
                }
                rid
            }
            "run.retry" => {
                let mut runs = self.runs.lock();
                let r = runs.get_mut(&id()).ok_or_else(|| anyhow!("no run {}", id()))?;
                let tid = task();
                let t = r.tasks.iter_mut().find(|t| t.id == tid).ok_or_else(|| anyhow!("no task {tid}"))?;
                anyhow::ensure!(matches!(t.status, TaskStatus::Failed | TaskStatus::Skipped | TaskStatus::Cancelled), "only a failed, skipped or cancelled task can be retried");
                // It and the tasks skipped because of it run again.
                for t in r.tasks.iter_mut().filter(|t| t.id == tid || t.status == TaskStatus::Skipped) {
                    t.status = TaskStatus::Pending;
                    t.session_id = None;
                    t.error = None;
                    t.summary = None;
                    t.finished_at = 0;
                    t.worked = false;
                }
                r.status = runs::RunStatus::Running;
                r.finished_at = 0;
                r.id.clone()
            }
            "run.task_done" | "run.task_skip" => {
                let mut runs = self.runs.lock();
                let (t, rid) = runs.task_mut(&id(), &task())?;
                anyhow::ensure!(!t.status.finished(), "the task has already finished");
                if let Some(sid) = t.session_id.clone().filter(|_| t.status == TaskStatus::Running && method == "run.task_skip") {
                    kill.push(sid);
                }
                t.status = if method == "run.task_done" { TaskStatus::Done } else { TaskStatus::Skipped };
                if let Some(s) = params.get("summary").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
                    t.summary = Some(s.trim().to_string());
                }
                t.finished_at = now_millis();
                rid
            }
            "run.cancel" => {
                let mut runs = self.runs.lock();
                let r = runs.get_mut(&id()).ok_or_else(|| anyhow!("no run {}", id()))?;
                for t in r.tasks.iter_mut().filter(|t| !t.status.finished()) {
                    if let Some(sid) = t.session_id.clone().filter(|_| t.status == TaskStatus::Running) {
                        kill.push(sid);
                    }
                    t.status = TaskStatus::Cancelled;
                    t.finished_at = now_millis();
                }
                if r.status == runs::RunStatus::Running {
                    r.status = runs::RunStatus::Cancelled;
                    r.finished_at = now_millis();
                }
                r.id.clone()
            }
            "run.delete" => {
                let mut runs = self.runs.lock();
                let rid = runs.get(&id()).map(|r| r.id.clone()).ok_or_else(|| anyhow!("no run {}", id()))?;
                anyhow::ensure!(runs.get(&rid).is_some_and(|r| r.status != runs::RunStatus::Running), "cancel the run before deleting it");
                runs.list.retain(|r| r.id != rid);
                runs.save()?;
                self.broadcast("run.deleted", json!({"id": rid}));
                return Ok(json!(true));
            }
            "run.report" => {
                let sid = params.get("session_id").and_then(Value::as_str).unwrap_or_default().to_string();
                let failed = params.get("status").and_then(Value::as_str) == Some("failed");
                let summary = params.get("summary").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
                let mut runs = self.runs.lock();
                let (r, i) = runs.by_session(&sid).ok_or_else(|| anyhow!("this session is not running a task of any run"))?;
                let t = &mut r.tasks[i];
                t.status = if failed { TaskStatus::Failed } else { TaskStatus::Done };
                if failed {
                    t.error = summary.clone().or_else(|| Some("reported as failed".into()));
                }
                t.summary = summary;
                t.finished_at = now_millis();
                let out = json!({"run": r.id, "task": t.id});
                let rid = r.id.clone();
                drop(runs);
                self.runs_changed(&[rid]);
                return Ok(out);
            }
            other => bail!("unknown method {other}"),
        };
        for sid in kill {
            if let Some(e) = self.by_id(&sid) {
                e.kill();
            }
        }
        self.runs_changed(std::slice::from_ref(&result));
        Ok(json!(self.runs.lock().get(&result)))
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

    /// For `auth`: whether session `id` is restricted and its folder; `None` if it is gone.
    pub fn session_policy(&self, id: &str) -> Option<(bool, String)> {
        self.by_id(id).map(|e| {
            let spec = e.spec();
            (spec.restricted, spec.cwd)
        })
    }

    pub fn session_id_of(&self, handle: u32) -> Option<String> {
        self.sessions.read().get(&handle).map(|e| e.spec().id)
    }

    pub fn agents_control_others(&self) -> bool {
        self.agents_control_others.load(Ordering::Relaxed)
    }

    /// Restores sessions recorded by a previous daemon run as exited-but-restartable entries
    /// whose screens show the last persisted snapshot. Sessions that were running are flagged
    /// `interrupted`: the app resumes them (agents into the same conversation) when shown, at
    /// once, or on request (`resumeSessions` setting). Chat sessions come back without a
    /// process; the app starts a chat front-end resuming the conversation in the same pane.
    pub fn restore(&self) {
        // Plugin agents first: restored sessions may be theirs.
        if let Some(defs) = std::fs::read(self.data_dir.join("custom-agents.json")).ok().and_then(|b| serde_json::from_slice::<Vec<agents::AgentDef>>(&b).ok()) {
            if let Err(e) = agents::set_custom(&defs) {
                tracing::warn!("plugin agents: {e:#}");
            }
        }
        for saved in self.store.load_sessions() {
            let handle = self.next_handle.fetch_add(1, Ordering::Relaxed);
            if saved.chat {
                let chat = ChatSession::new(handle, saved.spec.clone());
                if saved.alive {
                    chat.mark_interrupted(saved.last_activity);
                }
                self.sessions.write().insert(handle, Entry::Chat(chat));
                continue;
            }
            let session = Session::new(handle, saved.spec.clone(), saved.cols, saved.rows);
            if let Some(snapshot) = self.store.load_snapshot(&saved.spec.id) {
                session.ingest(&snapshot);
                if saved.alive {
                    session.ingest(b"\r\n\x1b[0;2m[stopped when Kelpie's session daemon stopped]\x1b[0m\r\n");
                }
            }
            session.set_last_activity(saved.last_activity);
            if saved.alive {
                session.mark_interrupted(saved.last_activity);
            }
            self.sessions.write().insert(handle, Entry::Term(session));
        }
    }

    pub fn create(&self, params: Value) -> Result<SessionInfo> {
        let p: CreateParams = serde_json::from_value(params).context("session.create params")?;
        let model = model_from_args(&p.args);
        let mut spec = SessionSpec {
            id: p.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            project_id: p.project_id,
            name: p.name,
            kind: p.kind,
            cwd: p.cwd,
            args: p.args,
            env: p.env,
            model,
            agent_session_id: p.agent_session_id,
            created_at: now_millis(),
            remote: p.remote,
            restricted: p.restricted,
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
            let fresh = Self::preset_conversation(&mut spec);
            let resume = match spec.agent_session_id.as_deref() {
                Some(id) if fresh => Resume::New(id),
                Some(id) => Resume::Id(id),
                None => Resume::None,
            };
            let launch = Self::launch_for(&spec, resume, p.prompt.as_deref(), &self.exe, &self.data_dir)?;
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
        // A local session from before ids were preset, whose conversation the app could not
        // find either, starts a new one with a known id. One over SSH keeps resuming the
        // folder's latest conversation, which is the one it had.
        let spec = {
            let mut spec = session.spec.lock();
            if spec.remote.is_none() && Self::preset_conversation(&mut spec) {
                self.meta_dirty.store(true, Ordering::Relaxed);
            }
            spec.clone()
        };
        let launch = Self::launch_for(&spec, Self::resume_for(&spec), None, &self.exe, &self.data_dir)?;
        // The program starts below the old output, which stays readable above it. A resumed agent
        // redraws only the latest part of its conversation (Claude Code shows about a screenful),
        // so clearing the scrollback here would lose everything said before the restart.
        if matches!(spec.kind.as_str(), "shell" | "custom") {
            session.ingest(b"\x1b[0m\r\n\x1b[2m--- restarted ---\x1b[0m\r\n");
        } else {
            session.ingest(b"\x1b[0m\r\n\x1b[2m--- resumed ---\x1b[0m\r\n");
        }
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
            if let Some(model) = params.get("model") {
                spec.model = model.as_str().map(str::to_string);
            }
        }
        self.meta_dirty.store(true, Ordering::Relaxed);
        // Spec changes are user-visible: broadcast now (via tick, so the 250 ms ticker does not
        // send the same change a second time).
        let ticked = match &entry {
            Entry::Term(s) => s.tick(Instant::now()),
            Entry::Chat(c) => c.tick(Instant::now()),
        };
        if let Some(v) = ticked.and_then(|i| serde_json::to_value(&i).ok()) {
            self.broadcast("session.updated", v);
        }
        Ok(entry.info())
    }

    /// `kelpied hook` reports from Claude Code / Codex running inside a session.
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
        tracing::debug!(session_id, agent, event, keys = ?payload.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>()), "hook");
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
        // Claude's SessionStart carries the model (string or {id, display_name}).
        let model = payload.get("model").and_then(|m| m.as_str().map(str::to_string).or_else(|| {
            m.get("display_name").or_else(|| m.get("id")).and_then(Value::as_str).map(str::to_string)
        }));
        if let Some(model) = model {
            let mut spec = session.spec.lock();
            if spec.model.as_deref() != Some(model.as_str()) {
                spec.model = Some(model);
                self.meta_dirty.store(true, Ordering::Relaxed);
            }
        }
        if let Some(status) = hook_event_status(agent, event, &payload) {
            session.set_hook_status(status, hook_event_failed(event));
        }
        // The app reads the conversation's usage when a turn moves on (it debounces).
        if !event.is_empty() {
            self.broadcast("session.turn", turn_event(session_id, event, &payload, agent_conv));
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
                SavedSession {
                    spec: info.spec,
                    title: info.title,
                    cols: info.cols,
                    rows: info.rows,
                    chat: info.chat,
                    last_activity: info.last_activity,
                    alive: info.alive || info.interrupted,
                }
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
        let mut last_schedule = Instant::now();
        let mut last_alive: HashMap<u32, bool> = HashMap::new();
        let mut last_status: HashMap<u32, Status> = HashMap::new();
        let mut last_run_tick = Instant::now();
        loop {
            interval.tick().await;
            let now = Instant::now();
            if now.duration_since(last_run_tick) >= Duration::from_secs(1) {
                last_run_tick = now;
                self.run_tick();
            }
            if now.duration_since(last_schedule) >= Duration::from_secs(10) {
                last_schedule = now;
                self.update_awake();
                let due = self.automations.lock().due(now_millis());
                for id in due {
                    let me = self.clone();
                    let _ = tokio::task::spawn_blocking(move || {
                        if let Err(e) = me.run_automation(&id) {
                            tracing::warn!("automation {id}: {e:#}");
                        }
                    })
                    .await;
                }
            }
            let entries: Vec<Entry> = self.sessions.read().values().cloned().collect();
            let prioritize = self.prioritize.load(Ordering::Relaxed);
            let priorities: Vec<_> = entries
                .iter()
                .filter_map(|e| match e {
                    Entry::Term(s) => s.priority(prioritize),
                    Entry::Chat(c) => c.priority(prioritize),
                })
                .collect();
            // Process snapshots and per-process calls block: keep them off the async workers.
            if !priorities.is_empty() {
                tokio::task::spawn_blocking(move || {
                    for (tree, p) in priorities {
                        tree.set_priority(p);
                    }
                });
            }
            for entry in entries {
                let changed = match &entry {
                    Entry::Term(s) => s.tick(now),
                    Entry::Chat(c) => c.tick(now),
                };
                if let Some(info) = changed {
                    // Started or stopped: `sessions.json` records which sessions were running,
                    // so a later restart resumes only those (see `restore`).
                    if last_alive.insert(info.handle, info.alive) != Some(info.alive) {
                        self.meta_dirty.store(true, Ordering::Relaxed);
                    }
                    if let Ok(v) = serde_json::to_value(&info) {
                        self.broadcast("session.updated", v);
                    }
                    // A turn ended (also for agents without hooks): the app reads the usage.
                    let prev = if info.alive { last_status.insert(info.handle, info.status) } else { last_status.remove(&info.handle) };
                    if prev == Some(Status::Working) && matches!(info.status, Status::Idle | Status::Waiting) && !info.chat {
                        self.broadcast("session.turn", turn_event(&info.spec.id, "turn_end", &Value::Null, info.spec.agent_session_id.as_deref()));
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
                "protocol": kelpie_proto::PROTOCOL_VERSION,
                "api": kelpie_proto::API_LEVEL,
                "security": kelpie_proto::DAEMON_SECURITY_LEVEL,
                "pid": std::process::id(),
                // Where it runs from: a copy outside the install folder survives updates.
                "exe": self.exe,
                "data_dir": self.data_dir,
                "endpoint": kelpie_proto::endpoint().display(),
                "sessions": self.sessions.read().len(),
            }),
            "daemon.policy" => json!({"agents_control_others": self.agents_control_others()}),
            "daemon.set_policy" => {
                if let Some(on) = params.get("agents_control_others").and_then(Value::as_bool) {
                    self.agents_control_others.store(on, Ordering::Relaxed);
                    save_policy(&self.data_dir, on);
                }
                json!({"agents_control_others": self.agents_control_others()})
            }
            "daemon.set_theme" => {
                let light = params.get("theme").and_then(Value::as_str) == Some("light");
                match params.get("palette").filter(|p| p.is_object()) {
                    Some(palette) => crate::vt::set_palette(light, palette),
                    None => crate::vt::set_light_theme(light),
                }
                json!({})
            }
            "daemon.set_priority" => {
                let enabled = params.get("enabled").and_then(Value::as_bool).unwrap_or(true);
                self.prioritize.store(enabled, Ordering::Relaxed);
                crate::proc_tree::set_daemon_priority(enabled);
                json!({"enabled": enabled})
            }
            "daemon.set_awake" => {
                *self.awake_mode.lock() = awake::Mode::parse(params.get("mode").and_then(Value::as_str).unwrap_or("off"));
                self.update_awake();
                json!({"held": self.awake.held()})
            }
            "agent.presets" => {
                let installed = agents::installed_presets();
                json!(agents::all_presets()
                    .into_iter()
                    .map(|p| json!({
                        "id": p.id,
                        "label": p.label,
                        "bin": p.bin,
                        "yolo": p.yolo,
                        "resume_latest": !p.resume_latest.is_empty(),
                        "acp": p.acp,
                        "installed": installed.contains(&p.id),
                    }))
                    .collect::<Vec<_>>())
            }
            "agent.run" => {
                self.agent_run(tx, id, &params)?;
                return Ok(None);
            }
            "agent.set_custom" => {
                let defs: Vec<agents::AgentDef> = serde_json::from_value(params.get("agents").cloned().unwrap_or_else(|| json!([]))).context("agents")?;
                agents::set_custom(&defs)?;
                // Kept for the next start: restored sessions of plugin agents must still resume.
                write_atomic(&self.data_dir.join("custom-agents.json"), &serde_json::to_vec_pretty(&defs)?)?;
                json!(true)
            }
            "mobile.status" => self.mobile.status(),
            "mobile.enable" => {
                // Binding the listener is async: answer when it is up (or failed).
                let (me, tx, id) = (self.clone(), tx.clone(), id.clone());
                tokio::spawn(async move {
                    let reply = match crate::mobile::enable(me.clone(), params).await {
                        Ok(v) => json!({"id": id, "result": v}),
                        Err(e) => json!({"id": id, "error": {"message": format!("{e:#}")}}),
                    };
                    let _ = tx.send(json_out(&reply));
                    me.broadcast("mobile.updated", json!({}));
                });
                return Ok(None);
            }
            "mobile.disable" => {
                self.mobile.disable();
                self.broadcast("mobile.updated", json!({}));
                json!(true)
            }
            "mobile.pair_start" => self.mobile.pair_start()?,
            "mobile.approve" => {
                let v = self.mobile.approve(&params)?;
                self.broadcast("mobile.updated", json!({}));
                v
            }
            "mobile.revoke" => {
                let v = self.mobile.revoke(param(&params, "id")?.as_str().unwrap_or_default())?;
                self.broadcast("mobile.updated", json!({}));
                v
            }
            "mobile.set_write" => {
                let v = self.mobile.set_write(param(&params, "id")?.as_str().unwrap_or_default(), params.get("can_write").and_then(Value::as_bool).unwrap_or(false))?;
                self.broadcast("mobile.updated", json!({}));
                v
            }
            "mobile.set_projects" => {
                self.mobile.set_projects(&params);
                json!(true)
            }
            "meta.list" => serde_json::to_value(&self.workspace_meta.lock().map)?,
            "meta.get" => {
                let path = param(&params, "path")?.as_str().unwrap_or_default();
                match self.workspace_meta.lock().find(path) {
                    Some((key, m)) => json!({"path": key, "comment": m.comment, "status": m.status, "updated_at": m.updated_at}),
                    None => Value::Null,
                }
            }
            "meta.set" => {
                let path = param(&params, "path")?.as_str().unwrap_or_default();
                let opt = |k: &str| params.get(k).map(|v| v.as_str().unwrap_or(""));
                let (key, m) = self.workspace_meta.lock().set(path, opt("comment"), opt("status"))?;
                let v = json!({"path": key, "comment": m.comment, "status": m.status, "updated_at": m.updated_at});
                self.broadcast("meta.updated", v.clone());
                v
            }
            "automation.list" => serde_json::to_value(&self.automations.lock().list)?,
            "automation.save" => {
                let a: Automation = serde_json::from_value(params).context("automation")?;
                let saved = self.automations.lock().upsert(a)?;
                self.broadcast("automation.changed", json!({}));
                serde_json::to_value(saved)?
            }
            "automation.delete" => {
                self.automations.lock().remove(param(&params, "id")?.as_str().unwrap_or_default())?;
                self.broadcast("automation.changed", json!({}));
                json!(true)
            }
            m if m.starts_with("run.") => self.run_rpc(m, &params)?,
            "automation.run" => serde_json::to_value(self.run_automation(param(&params, "id")?.as_str().unwrap_or_default())?)?,
            "daemon.shutdown" => {
                // A hand-over to a newer daemon: only when nothing runs any more (checked here,
                // not from a session list the app read a moment ago).
                if params.get("if_idle").and_then(Value::as_bool) == Some(true) && self.sessions.read().values().any(|e| e.info().alive) {
                    return Ok(Some(json!(false)));
                }
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
            // An answer to the prompt a session waits on, from a quick-answer popover: typed only
            // while it still waits on that same prompt (`waiting_since`), so an answer given
            // elsewhere meanwhile (phone, terminal) or a prompt that changed never gets stray keys.
            "session.answer" => {
                let Entry::Term(s) = self.entry(handle_of(&params)?)? else { bail!("session.answer is for terminal sessions") };
                let since = params.get("waiting_since").and_then(Value::as_u64);
                // `key`: Esc or Enter alone (text goes through `typed_text`, which drops controls).
                let bytes = match params.get("key").and_then(Value::as_str) {
                    Some("esc") => b"\x1b".to_vec(),
                    Some("enter") => b"\r".to_vec(),
                    Some(other) => bail!("unknown key {other}"),
                    None => crate::session::typed_text(param(&params, "data")?.as_str().unwrap_or_default()).into_bytes(),
                };
                if !s.answer(since, bytes) {
                    bail!("the session no longer waits on that prompt");
                }
                if params.get("enter").and_then(Value::as_bool) == Some(true) {
                    // A separate write (TUIs take an Enter in the same write as text as part of
                    // it), off this client's request worker.
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(120));
                        s.input(b"\r".to_vec());
                    });
                }
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
            "session.set_unread" => {
                let unread = params.get("unread").and_then(Value::as_bool).unwrap_or(true);
                match self.entry(handle_of(&params)?)? {
                    Entry::Term(s) => s.set_unread(unread),
                    Entry::Chat(c) => c.set_unread(unread),
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
                Entry::Term(s) => {
                    // `lines`: that many lines including scrollback; default the visible screen.
                    let text = match params.get("lines").and_then(Value::as_u64) {
                        Some(n) => s.text_tail(n.clamp(1, crate::session::SCROLLBACK as u64) as usize),
                        None => s.screen_text(),
                    };
                    // `waiting_since` with the screen: an answer names the prompt it was shown.
                    json!({"text": text, "title": s.title(), "prompt": s.screen_prompt(), "waiting_since": s.info().waiting_since})
                }
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

const POLICY_FILE: &str = "policy.json";

/// Scripting other sessions is allowed unless the user turned it off.
fn load_policy(data_dir: &std::path::Path) -> bool {
    std::fs::read(data_dir.join(POLICY_FILE))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v.get("agents_control_others").and_then(Value::as_bool))
        .unwrap_or(true)
}

fn save_policy(data_dir: &std::path::Path, agents_control_others: bool) {
    if let Err(e) = std::fs::write(data_dir.join(POLICY_FILE), json!({"agents_control_others": agents_control_others}).to_string()) {
        tracing::warn!("save {POLICY_FILE}: {e}");
    }
}

/// A new git worktree for a task: branch `kelpie/<run>-<id>-<task>` from the run folder's HEAD, in
/// `<repo>-worktrees/` next to the repository (where Kelpie's worktree dialog puts them).
fn create_task_worktree(run: &runs::Run, task: &runs::Task) -> Result<(String, String)> {
    let git = |args: &[&str]| -> Result<String> {
        let mut cmd = std::process::Command::new("git");
        cmd.args(args).stdin(std::process::Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        let out = cmd.output().context("run git")?;
        if !out.status.success() {
            bail!("git {}: {}", args.first().unwrap_or(&""), String::from_utf8_lossy(&out.stderr).trim());
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    };
    let top = git(&["-C", &run.cwd, "rev-parse", "--show-toplevel"]).map_err(|_| anyhow!("a task worktree needs the run folder to be a git repository"))?;
    let top = PathBuf::from(top);
    let name = top.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "repo".into());
    let short: String = run.id.chars().take(6).collect();
    let leaf = format!("{}-{short}-{}", runs::slug(&run.name), task.id);
    let branch = format!("kelpie/{leaf}");
    let path = top.parent().unwrap_or(&top).join(format!("{name}-worktrees")).join(&leaf);
    let path_s = path.to_string_lossy().into_owned();
    git(&["-C", &top.to_string_lossy(), "worktree", "add", "-b", &branch, &path_s, "HEAD"])?;
    Ok((path_s, branch))
}
