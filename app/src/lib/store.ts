// Central app state. Fine-grained Solid stores: a status change on one of 20 sessions
// re-renders only the dots/cards bound to that session.
import { createRoot, createSignal } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import * as ipc from "./ipc";
import { allPanes, findPane, leaf, removePane, replacePane, setRatio, splitPane } from "./layout";
import { basename, uid } from "./platform";
import { projectColors } from "./theme";
import { disposeView, peekView, resetStreams } from "./terminal-host";
import type { SettingsSection } from "./settings-catalog";
import type { AgentProfile, AppState, BranchInfo, LayoutNode, Pane, Project, RecentItem, SessionInfo, SessionKind, Settings, Tab, Workspace } from "./types";

export const defaultSettings: Settings = {
  fontFamily: '"JetBrains Mono", "Cascadia Code", "Cascadia Mono", Menlo, Consolas, "Symbols Nerd Font Mono", monospace',
  fontSize: 13,
  lineHeight: 1.2,
  scrollback: 5000,
  cursorBlink: true,
  webgl: true,
  shellArgs: [],
  rightPanelWidth: 300,
  sidebarWidth: 232,
  sidebarCollapsed: false,
  notifications: true,
  shortcutHints: true,
  projectFilter: "all",
  projectSort: "manual",
  usageMeters: true,
  memoryMeter: true,
  quickCommands: [],
  theme: "dark",
  density: "comfortable",
  uiScale: 1,
  tips: true,
  tipsSeen: [],
  profiles: [
    { kind: "claude", label: "Claude Code", args: [] },
    { kind: "codex", label: "Codex", args: [] },
    { kind: "omp", label: "OMP", args: [] },
  ],
};

const emptyState = (): AppState => ({ version: 1, projects: [], activeProject: null, workspaces: {}, settings: { ...defaultSettings }, recent: [], collapsed: {}, keymap: {} });
const MAX_RECENT = 40;

export type Overlay = null | "palette" | "quickopen" | "jump" | "dashboard" | "settings" | "newsession";

function createAppStore() {
  const [state, setState] = createStore<AppState>(emptyState());
  /** Daemon sessions keyed by stable session id. */
  const [sessions, setSessions] = createStore<Record<string, SessionInfo>>({});
  /** Branch / dirty summary per project (sidebar subtitle). */
  const [projectInfo, setProjectInfo] = createStore<Record<string, BranchInfo>>({});
  const [connected, setConnected] = createSignal(false);
  const [overlay, setOverlay] = createSignal<Overlay>(null);
  const [loaded, setLoaded] = createSignal(false);
  const [toast, setToast] = createSignal<Toast | null>(null);
  /** Per-tab zoomed pane (transient, not persisted). */
  const [zoomed, setZoomed] = createSignal<Record<string, string>>({});
  const [lastSwitchMs, setLastSwitchMs] = createSignal<number | null>(null);
  const [settingsSection, setSettingsSection] = createSignal<SettingsSection>("agents");
  /** Setting row to scroll to and highlight when the page opens (from search). */
  const [settingsItem, setSettingsItem] = createSignal<string | null>(null);

  // ---------- persistence ----------
  let saveTimer = 0;
  const persist = () => {
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void ipc.saveState(JSON.parse(JSON.stringify(state))).catch(() => {}), 400);
  };
  const update = (fn: (s: AppState) => void) => {
    setState(produce(fn));
    persist();
  };

  function notify(text: string, action?: Toast["action"], ms = 3500) {
    const t: Toast = { text, action };
    setToast(t);
    setTimeout(() => setToast((cur) => (cur === t ? null : cur)), ms);
  }

  function toggleZoom(tabId: string, paneId: string) {
    setZoomed((z) => {
      const next = { ...z };
      if (next[tabId] === paneId) delete next[tabId];
      else next[tabId] = paneId;
      return next;
    });
  }

  // ---------- recents & per-project git summary ----------
  function recordRecent(kind: RecentItem["kind"], id: string, projectId: string) {
    update((s) => {
      // A file's id is project-relative, so the project is part of its identity.
      const same = (r: RecentItem) => r.kind === kind && r.id === id && r.projectId === projectId;
      s.recent = [{ kind, id, projectId, at: Date.now() }, ...(s.recent ?? []).filter((r) => !same(r))].slice(0, MAX_RECENT);
    });
  }

  // Branch summaries: debounced and single-flight per project. Watcher events arrive every
  // ~150 ms while an agent writes files; each would otherwise queue a `git status`.
  const infoJobs = new Map<string, { timer: number; running: boolean; again: boolean }>();
  function refreshProjectInfo(projectId: string, delay = 300) {
    let job = infoJobs.get(projectId);
    if (!job) infoJobs.set(projectId, (job = { timer: 0, running: false, again: false }));
    clearTimeout(job.timer);
    job.timer = window.setTimeout(() => void runProjectInfo(projectId), delay);
  }
  async function runProjectInfo(projectId: string) {
    const job = infoJobs.get(projectId)!;
    if (job.running) {
      job.again = true;
      return;
    }
    const p = state.projects.find((x) => x.id === projectId);
    if (!p) return;
    job.running = true;
    try {
      const info = await ipc.gitBranchInfo(p.path).catch(() => null);
      if (info && state.projects.some((x) => x.id === projectId)) setProjectInfo(projectId, reconcile(info));
    } finally {
      job.running = false;
      if (job.again) {
        job.again = false;
        void runProjectInfo(projectId);
      }
    }
  }

  /** An older daemon left running across an app upgrade lacks newer RPCs: offer a restart. */
  async function checkDaemonApi() {
    const [info, app] = await Promise.all([ipc.daemon<{ api?: number }>("daemon.info", {}), ipc.platformInfo()]).catch(() => [null, null]);
    if (!info || !app || (info.api ?? 1) >= app.api) return;
    notify("The session daemon is older than this app; some features are unavailable until it restarts.", {
      label: "Restart daemon",
      run: () => {
        if (confirm("Restart the session daemon? Running sessions stop; their screens are kept and they can be restarted.")) {
          void ipc.daemon("daemon.shutdown", { kill_sessions: true }).catch(() => {});
        }
      },
    }, 15000);
  }

  // ---------- sessions ----------
  const byHandle = (handle: number) => Object.values(sessions).find((s) => s.handle === handle);

  async function refreshSessions() {
    const list = await ipc.listSessions();
    const map: Record<string, SessionInfo> = {};
    for (const s of list) map[s.id] = s;
    setSessions(reconcile(map));
  }

  async function maybeNotify(prev: SessionInfo | undefined, next: SessionInfo) {
    if (!state.settings.notifications || !prev || prev.status !== "working") return;
    if (next.status !== "idle" && next.status !== "waiting") return;
    const visible = document.hasFocus() && isSessionVisible(next.id);
    if (visible) return;
    const project = state.projects.find((p) => p.id === next.project_id);
    const title = `${sessionLabel(next)}${project ? " · " + project.name : ""}`;
    const body = next.status === "waiting" ? "Needs your input" : "Finished";
    try {
      let ok = await isPermissionGranted();
      if (!ok) ok = (await requestPermission()) === "granted";
      if (ok) sendNotification({ title, body });
    } catch {
      /* notifications unavailable */
    }
  }

  function onDaemonEvent(msg: { event: string; params: any }) {
    const p = msg.params;
    switch (msg.event) {
      case "session.updated": {
        const prev = sessions[p.id];
        setSessions(p.id, reconcile(p as SessionInfo));
        void maybeNotify(prev, p);
        // Background projects are not watched: an agent finishing a turn may have committed
        // or switched branch, so refresh that project's subtitle.
        if (prev?.status === "working" && p.status !== "working" && p.project_id) refreshProjectInfo(p.project_id, 1000);
        break;
      }
      case "session.closed": {
        const s = byHandle(p.handle);
        if (s) {
          setSessions(produce((m) => delete m[s.id]));
          if (state.recent?.some((r) => r.kind === "session" && r.id === s.id)) update((st) => (st.recent = st.recent.filter((r) => !(r.kind === "session" && r.id === s.id))));
        }
        break;
      }
      case "session.resync": {
        const s = byHandle(p.handle);
        if (s?.chat) {
          window.dispatchEvent(new CustomEvent("erka:chat-resync", { detail: s.id }));
          break;
        }
        const v = s && peekView(s.id);
        if (v && v.handle === p.handle) void v.attach(p.handle);
        break;
      }
      case "session.clipboard": {
        // OSC 52: only the terminal the user is looking at may set the clipboard, and we say so.
        const s = byHandle(p.handle);
        if (s && document.hasFocus() && isSessionVisible(s.id) && typeof p.text === "string") {
          void writeText(p.text);
          notify(`Clipboard set by ${sessionLabel(s)}`);
        }
        break;
      }
    }
  }

  // ---------- projects & workspaces ----------
  const activeProject = () => state.projects.find((p) => p.id === state.activeProject) ?? null;
  const workspace = (projectId: string): Workspace => state.workspaces[projectId] ?? { tabs: [], activeTab: null, rightPanel: null };

  function ensureWorkspace(projectId: string) {
    if (!state.workspaces[projectId]) update((s) => (s.workspaces[projectId] = { tabs: [], activeTab: null, rightPanel: "files" }));
  }

  function addProject(path: string) {
    const existing = state.projects.find((p) => p.path.toLowerCase() === path.toLowerCase());
    if (existing) return switchProject(existing.id);
    const project: Project = { id: uid(), name: basename(path), path, color: projectColors[state.projects.length % projectColors.length] };
    update((s) => s.projects.push(project));
    ensureWorkspace(project.id);
    switchProject(project.id);
  }

  function removeProject(id: string) {
    update((s) => {
      s.projects = s.projects.filter((p) => p.id !== id);
      delete s.workspaces[id];
      if (s.collapsed) delete s.collapsed[id];
      s.recent = (s.recent ?? []).filter((r) => r.projectId !== id && !(r.kind === "project" && r.id === id));
      if (s.activeProject === id) s.activeProject = s.projects[0]?.id ?? null;
    });
    setProjectInfo(produce((m) => delete m[id]));
  }

  function renameProject(id: string, name: string) {
    update((s) => {
      const p = s.projects.find((x) => x.id === id);
      if (p) p.name = name;
    });
  }

  function moveProject(id: string, delta: number) {
    update((s) => {
      const i = s.projects.findIndex((p) => p.id === id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= s.projects.length) return;
      const [p] = s.projects.splice(i, 1);
      s.projects.splice(j, 0, p);
    });
  }

  function switchProject(id: string) {
    if (state.activeProject === id) return;
    const t0 = performance.now();
    setLastSwitchMs(null);
    ensureWorkspace(id);
    update((s) => (s.activeProject = id));
    recordRecent("project", id, id);
    void refreshProjectInfo(id);
    // Measure until the new project's panes have painted.
    requestAnimationFrame(() => requestAnimationFrame(() => setLastSwitchMs(Math.round(performance.now() - t0))));
  }

  // ---------- tabs & panes ----------
  const activeTab = (projectId: string): Tab | undefined => {
    const ws = state.workspaces[projectId];
    return ws?.tabs.find((t) => t.id === ws.activeTab) ?? ws?.tabs[0];
  };

  function addTab(projectId: string, pane: Pane) {
    ensureWorkspace(projectId);
    const tab: Tab = { id: uid(), root: leaf(pane), focus: pane.id };
    update((s) => {
      const ws = s.workspaces[projectId];
      ws.tabs.push(tab);
      ws.activeTab = tab.id;
    });
    return tab;
  }

  function setTabRoot(projectId: string, tabId: string, root: LayoutNode, focus?: string) {
    update((s) => {
      const tab = s.workspaces[projectId]?.tabs.find((t) => t.id === tabId);
      if (!tab) return;
      tab.root = root;
      if (focus) tab.focus = focus;
    });
  }

  function selectTab(projectId: string, tabId: string) {
    update((s) => (s.workspaces[projectId].activeTab = tabId));
  }

  function cycleTab(delta: 1 | -1) {
    const pid = state.activeProject;
    if (!pid) return;
    const ws = workspace(pid);
    if (!ws.tabs.length) return;
    const i = ws.tabs.findIndex((t) => t.id === ws.activeTab);
    selectTab(pid, ws.tabs[(i + delta + ws.tabs.length) % ws.tabs.length].id);
  }

  function focusPane(projectId: string, tabId: string, paneId: string) {
    // Focus must never point at a pane hidden by another pane's maximize.
    const z = zoomed()[tabId];
    if (z && z !== paneId) toggleZoom(tabId, z);
    const ws = state.workspaces[projectId];
    const tab = ws?.tabs.find((t) => t.id === tabId);
    if (!tab || (tab.focus === paneId && ws.activeTab === tabId)) return;
    update((s) => {
      const w = s.workspaces[projectId];
      w.activeTab = tabId;
      const t = w.tabs.find((x) => x.id === tabId);
      if (t) t.focus = paneId;
    });
  }

  /** Places a pane: split the focused pane, or a new tab. */
  function placePane(projectId: string, pane: Pane, where: "tab" | "right" | "down" = "tab") {
    const tab = activeTab(projectId);
    if (where === "tab" || !tab) return addTab(projectId, pane);
    // Splitting while a pane is maximized would hide the new pane: restore the layout first.
    if (zoomed()[tab.id]) toggleZoom(tab.id, zoomed()[tab.id]);
    setTabRoot(projectId, tab.id, splitPane(tab.root, tab.focus, pane, where === "right" ? "row" : "col"), pane.id);
  }

  function paneLocation(sessionId: string): { projectId: string; tabId: string; paneId: string } | null {
    for (const [projectId, ws] of Object.entries(state.workspaces)) {
      for (const tab of ws.tabs) {
        const pane = allPanes(tab.root).find((p) => p.sessionId === sessionId);
        if (pane) return { projectId, tabId: tab.id, paneId: pane.id };
      }
    }
    return null;
  }

  function isSessionVisible(sessionId: string) {
    const loc = paneLocation(sessionId);
    if (!loc || loc.projectId !== state.activeProject) return false;
    return activeTab(loc.projectId)?.id === loc.tabId;
  }

  async function newSession(projectId: string, kind: SessionKind, opts: { where?: "tab" | "right" | "down"; args?: string[]; name?: string; agentSessionId?: string; cwd?: string } = {}) {
    const project = state.projects.find((p) => p.id === projectId);
    if (!project) return;
    const launch = profileLaunch(kind);
    try {
      const info = await ipc.createSession({
        kind,
        // Resuming must use the conversation's own folder: agents look transcripts up by cwd.
        cwd: opts.cwd ?? project.path,
        project_id: projectId,
        name: opts.name,
        args: opts.args ?? (kind === "shell" ? state.settings.shellArgs : launch.args),
        env: launch.env,
        agent_session_id: opts.agentSessionId,
        cols: 120,
        rows: 32,
      });
      setSessions(info.id, info);
      placePane(projectId, { id: uid(), kind: "terminal", sessionId: info.id }, opts.where ?? "tab");
      return info;
    } catch (e) {
      notify(`Could not start ${kind}: ${e}`);
    }
  }

  /** Reveals a session: switches project/tab, or opens it in a new tab if not in any layout. */
  function revealSession(sessionId: string) {
    const loc = paneLocation(sessionId);
    recordRecent("session", sessionId, sessions[sessionId]?.project_id ?? loc?.projectId ?? state.activeProject ?? "");
    if (loc) {
      switchProject(loc.projectId);
      focusPane(loc.projectId, loc.tabId, loc.paneId);
      return;
    }
    const s = sessions[sessionId];
    const projectId = s?.project_id && state.projects.some((p) => p.id === s.project_id) ? s.project_id : state.activeProject;
    if (!projectId) return;
    switchProject(projectId);
    addTab(projectId, { id: uid(), kind: s?.chat ? "chat" : "terminal", sessionId });
  }

  function openFile(projectId: string, path: string, opts: { line?: number; diff?: boolean; staged?: boolean } = {}) {
    const kind = opts.diff ? "diff" : "file";
    if (!opts.diff) recordRecent("file", path, projectId);
    const ws = workspace(projectId);
    for (const tab of ws.tabs) {
      const pane = allPanes(tab.root).find((p) => p.kind === kind && p.path === path && !!p.staged === !!opts.staged);
      if (pane) {
        if (opts.line) setTabRoot(projectId, tab.id, replacePane(tab.root, pane.id, { ...pane, line: opts.line }));
        focusPane(projectId, tab.id, pane.id);
        return;
      }
    }
    addTab(projectId, { id: uid(), kind, path, line: opts.line, staged: opts.staged });
  }

  /** Closes a pane. Terminal sessions are killed only when `kill` (default for exited ones). */
  async function closePane(projectId: string, tabId: string, paneId: string, kill = true) {
    const ws = state.workspaces[projectId];
    const tab = ws?.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const pane = findPane(tab.root, paneId);
    if (pane?.sessionId && kill) {
      const s = sessions[pane.sessionId];
      disposeView(pane.sessionId);
      if (s) await ipc.daemon("session.close", { handle: s.handle }).catch(() => {});
    }
    const root = removePane(tab.root, paneId);
    update((st) => {
      const w = st.workspaces[projectId];
      if (!root) {
        w.tabs = w.tabs.filter((t) => t.id !== tabId);
        if (w.activeTab === tabId) w.activeTab = w.tabs[w.tabs.length - 1]?.id ?? null;
      } else {
        const t = w.tabs.find((x) => x.id === tabId)!;
        t.root = root;
        if (t.focus === paneId) t.focus = allPanes(root)[0].id;
      }
    });
  }

  function replacePaneIn(projectId: string, tabId: string, paneId: string, pane: Pane) {
    const tab = workspace(projectId).tabs.find((t) => t.id === tabId);
    if (tab) setTabRoot(projectId, tabId, replacePane(tab.root, paneId, pane), pane.id);
  }

  function resizeSplit(projectId: string, tabId: string, splitId: string, ratio: number) {
    const tab = workspace(projectId).tabs.find((t) => t.id === tabId);
    if (tab) setTabRoot(projectId, tabId, setRatio(tab.root, splitId, ratio));
  }

  function setRightPanel(panel: Workspace["rightPanel"]) {
    const pid = state.activeProject;
    if (!pid) return;
    ensureWorkspace(pid);
    update((s) => {
      const ws = s.workspaces[pid];
      ws.rightPanel = ws.rightPanel === panel ? null : panel;
    });
  }

  function openSettings(section?: SettingsSection, item?: string) {
    if (section) setSettingsSection(section);
    setSettingsItem(item ?? null);
    setOverlay("settings");
  }

  function setCollapsed(projectId: string, folded: boolean) {
    update((s) => {
      s.collapsed ??= {};
      if (folded) s.collapsed[projectId] = true;
      else delete s.collapsed[projectId];
    });
  }

  async function markUnread(sessionId: string, unread: boolean) {
    const s = sessions[sessionId];
    if (s) await ipc.daemon("session.set_unread", { handle: s.handle, unread }).catch((e) => notify(String(e)));
  }

  async function renameSession(sessionId: string, name: string | null) {
    const s = sessions[sessionId];
    if (s) await ipc.daemon("session.update", { handle: s.handle, name }).catch((e) => notify(String(e)));
  }

  /** Shows a right-panel view without toggling it off when already shown. */
  function showRightPanel(panel: NonNullable<Workspace["rightPanel"]>) {
    const pid = state.activeProject;
    if (!pid) return;
    ensureWorkspace(pid);
    update((s) => (s.workspaces[pid].rightPanel = panel));
  }

  function setSettings(patch: Partial<Settings>) {
    update((s) => Object.assign(s.settings, patch));
  }

  /** Launch arguments and environment of an agent profile, permission mode included. */
  function profileLaunch(kind: SessionKind): { args: string[]; env?: Record<string, string> } {
    const p = state.settings.profiles.find((x) => x.kind === kind);
    const args = [...(p?.args ?? [])];
    if (p?.permission && kind === "claude") args.push("--permission-mode", p.permission);
    if (p?.permission && kind === "codex") args.push("-c", `approval_policy="${p.permission}"`);
    return { args, env: p?.env && Object.keys(p.env).length ? { ...p.env } : undefined };
  }

  /** Edits an agent profile in place (rows bound to it stay mounted). */
  function setProfile(kind: SessionKind, patch: Partial<AgentProfile>) {
    update((s) => {
      const p = s.settings.profiles.find((x) => x.kind === kind);
      if (p) Object.assign(p, patch);
    });
  }

  /** Sets (chord) or clears ("") a shortcut override; `null` restores the default. */
  function setShortcut(commandId: string, chord: string | null) {
    update((s) => {
      s.keymap ??= {};
      if (chord === null) delete s.keymap[commandId];
      else s.keymap[commandId] = chord;
    });
  }

  // ---------- boot ----------
  async function init() {
    const saved = (await ipc.loadState().catch(() => null)) as AppState | null;
    if (saved && saved.version === 1) {
      setState(reconcile({ ...emptyState(), ...saved, settings: { ...defaultSettings, ...saved.settings } }));
    }
    setLoaded(true);
    // Sidebar subtitles; git calls are capped at 3 in flight by the backend.
    for (const p of state.projects) refreshProjectInfo(p.id, 0);
    void ipc.onEvent<{ root: string; git: boolean }>("fs-changed", (e) => {
      if (!e.git) return;
      const p = state.projects.find((x) => x.path === e.root);
      if (p) refreshProjectInfo(p.id);
    });
    await ipc.onEvent("daemon-event", onDaemonEvent);
    await ipc.onEvent<{ connected: boolean; error?: string }>("daemon-status", async (s) => {
      if (!s.connected) {
        // Views must forget their stream before anything can re-attach.
        resetStreams();
        setConnected(false);
        if (s.error) notify(s.error);
        return;
      }
      resetStreams();
      // Fresh handles first, then flip `connected` so panes attach to the right sessions.
      await refreshSessions().catch(() => {});
      setConnected(true);
      void checkDaemonApi();
    });
    // The connection may predate our listener.
    try {
      await refreshSessions();
      setConnected(true);
      void checkDaemonApi();
    } catch {
      /* connection event will follow */
    }
  }

  return {
    state, sessions, connected, overlay, setOverlay, loaded, toast, notify, lastSwitchMs,
    init, activeProject, workspace, activeTab, addProject, removeProject, renameProject, moveProject, switchProject,
    addTab, selectTab, cycleTab, focusPane, placePane, newSession, revealSession, openFile, closePane,
    replacePaneIn, resizeSplit, setRightPanel, showRightPanel, setSettings, zoomed, toggleZoom,
    projectInfo, refreshProjectInfo, recordRecent, setCollapsed, markUnread, renameSession, profileLaunch, setShortcut, setProfile,
    settingsSection, setSettingsSection, settingsItem, openSettings, paneLocation, isSessionVisible, refreshSessions, setSessions,
  };
}

export interface Toast {
  text: string;
  action?: { label: string; run: () => void };
}

export const store = createRoot(createAppStore);

export function sessionLabel(s: SessionInfo): string {
  if (s.name) return s.name;
  const title = s.title?.replace(/^[⠀-⣿✳✶✻✽·*◐◑◒◓⠂⠐]\s*/u, "").trim();
  const kind = { shell: "Terminal", claude: "Claude", codex: "Codex", omp: "OMP", custom: "Command" }[s.kind] ?? s.kind;
  if (title && title.length < 48 && !/^[A-Z]:\\|\.exe$/i.test(title)) return s.kind === "shell" ? title : `${kind} · ${title}`;
  return kind;
}
