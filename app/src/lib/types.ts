/** Mirrors `SessionInfo` from erkad (crates/erkad/src/session.rs). */
export type SessionStatus = "idle" | "working" | "waiting" | "exited";
/** shell | custom | claude | codex | omp, or a preset agent id from `agent.presets` (gemini, cursor…). */
export type SessionKind = string;

export interface SessionInfo {
  handle: number;
  id: string;
  project_id: string | null;
  name: string | null;
  kind: SessionKind;
  cwd: string;
  args: string[];
  env: Record<string, string>;
  agent_session_id: string | null;
  model: string | null;
  created_at: number;
  title: string | null;
  status: SessionStatus;
  unread: boolean;
  alive: boolean;
  exit_code: number | null;
  pid: number | null;
  cols: number;
  rows: number;
  seq: number;
  chat: boolean;
  /** Wall-clock ms of the last output/input (0 = never). */
  last_activity: number;
}

export type WorkStatus = "todo" | "progress" | "review" | "done";

export interface Project {
  id: string;
  name: string;
  path: string;
  color: string;
  /** Set for a git worktree shown under its repository's project. */
  parentId?: string;
  branch?: string;
  /** Workspace board column (default todo) and pin. */
  status?: WorkStatus;
  pinned?: boolean;
}

export interface Worktree {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  prunable: boolean;
}

export type PaneKind = "terminal" | "chat" | "file" | "diff" | "empty";

export interface Pane {
  id: string;
  kind: PaneKind;
  /** Daemon session id (stable across daemon restarts), for terminal/chat panes. */
  sessionId?: string;
  /** Project-relative path for file/diff panes. */
  path?: string;
  staged?: boolean;
  line?: number;
}

export interface LeafNode {
  type: "leaf";
  id: string;
  pane: Pane;
}

export interface SplitNode {
  type: "split";
  id: string;
  /** row = side by side, col = stacked */
  dir: "row" | "col";
  ratio: number;
  a: LayoutNode;
  b: LayoutNode;
}

export type LayoutNode = LeafNode | SplitNode;

export interface Tab {
  id: string;
  root: LayoutNode;
  focus: string; // pane id
}

export type RightPanel = "files" | "git" | "search" | "history" | null;

export interface Workspace {
  tabs: Tab[];
  activeTab: string | null;
  rightPanel: RightPanel;
}

export interface AgentProfile {
  kind: SessionKind;
  label: string;
  args: string[];
  /** Extra environment for this agent's sessions. */
  env?: Record<string, string>;
  /** Claude `--permission-mode` / Codex `approval_policy`; empty = the agent's own default. */
  permission?: string;
}

export interface Settings {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  scrollback: number;
  cursorBlink: boolean;
  webgl: boolean;
  shellArgs: string[];
  rightPanelWidth: number;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  notifications: boolean;
  /** Toast once per shortcut when Erka keeps a key from the focused terminal. */
  shortcutHints: boolean;
  projectFilter: "all" | "running" | "attention";
  projectSort: "manual" | "recent";
  profiles: AgentProfile[];
  /** Claude / Codex subscription usage in the status bar (reads the agents' own sign-in). */
  usageMeters: boolean;
  memoryMeter: boolean;
  quickCommands: QuickCommand[];
  theme: "dark" | "light";
  density: "comfortable" | "compact";
  /** Interface (not terminal) text scale, 0.9 – 1.2. */
  uiScale: number;
  /** First-run tips; `tipsSeen` holds the ids already dismissed. */
  tips: boolean;
  tipsSeen: string[];
  /** manual: each agent asks as it normally does; yolo: launch with its skip-permission flags. */
  agentPermissions: "manual" | "yolo";
  /** Agent kinds left out of launchers. */
  hiddenAgents: string[];
  /** Stop finished background agents after `hibernateMinutes` idle; resume when shown again. */
  hibernate: boolean;
  hibernateMinutes: number;
  /** Prevent idle sleep: never, while an agent works, or always. */
  keepAwake: "off" | "agents" | "always";
  /** A short chime with desktop notifications. */
  notificationSound: boolean;
  /** Terminal colour theme id (lib/terminal-themes.ts); "default" follows the app theme. */
  terminalTheme: string;
  /** Editor soft wrap. */
  wordWrap: boolean;
  /** Agent for AI actions (commit message, pull request text). */
  aiAgent: "claude" | "codex";
  /** Global floating terminal (not tied to a project). */
  floatingTerminal: boolean;
}

export interface QuickCommand {
  id: string;
  label: string;
  text: string;
  /** terminal: type into the focused shell (or a new one); agent: send as a prompt to the focused agent. */
  action: "terminal" | "agent";
  enter: boolean;
  /** null = every project. */
  projectId: string | null;
}

export interface HistoryItem {
  agent: "claude" | "codex" | "omp";
  id: string;
  /** Folder as the agent recorded it; resume launches here. */
  cwd: string;
  /** `cwd` in canonical form (long names), for matching projects. */
  folder: string;
  title: string | null;
  first_prompt: string | null;
  updated_at: number;
  /** null until the background count reaches this transcript. */
  turns: number | null;
}

export interface UsageWindow {
  label: string;
  used_percent: number;
  resets_at: number | null;
}

export interface ProviderUsage {
  windows: UsageWindow[];
  error: string | null;
}

export interface UsageReport {
  claude: ProviderUsage;
  codex: ProviderUsage;
}

export interface MemoryStats {
  app: number;
  daemon: number;
  sessions: number;
  session_processes: number;
}

/** Notification inbox / activity feed entry. */
export interface InboxItem {
  id: string;
  at: number;
  kind: "finished" | "waiting" | "automation" | "worktree" | "error";
  title: string;
  body: string;
  sessionId?: string;
  projectId?: string;
  read: boolean;
}

/** A review note on a diff line, sent to an agent in a batch. */
export interface ReviewNote {
  id: string;
  path: string;
  /** 1-based line number on `side`. */
  line: number;
  side: "new" | "old";
  /** The line as it read when the note was made (context for the agent). */
  text: string;
  note: string;
  at: number;
}

/** Folder comment / board status shared with agents through the daemon (`meta.*`). */
export interface WorkspaceMeta {
  path: string;
  comment: string | null;
  status: WorkStatus | null;
  updated_at: number;
}

export interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  kind: string;
  prompt: string;
  cwd: string;
  project_id: string | null;
  args: string[];
  every: "hourly" | "daily" | "weekdays" | "weekly";
  /** HH:MM local time (hourly: the minute). */
  time: string;
  /** 0 = Sunday. */
  weekday: number;
  last_run: number;
  last_session: string | null;
  last_error: string | null;
  next_run: number;
}

export interface RecentItem {
  kind: "session" | "project" | "file";
  /** Session id, project id, or project-relative path for files. */
  id: string;
  projectId: string;
  at: number;
}

export interface AppState {
  /** 2: projects may be worktrees (parentId/branch) with a board status. */
  version: 2;
  projects: Project[];
  activeProject: string | null;
  workspaces: Record<string, Workspace>;
  settings: Settings;
  recent: RecentItem[];
  /** Projects whose session list is folded in the sidebar. */
  collapsed: Record<string, boolean>;
  /** Shortcut overrides by command id: a chord like "mod+alt+p", or "" for none. */
  keymap: Record<string, string>;
  /** `.erka.yaml` contents (hash) the user agreed to run, by repository path. */
  approvedSetups: Record<string, string>;
  /** Sessions Erka stopped to save memory (hibernation, sleeping worktrees): resumed when shown. */
  hibernated: string[];
  inbox: InboxItem[];
  /** Diff review notes by project id. */
  reviewNotes: Record<string, ReviewNote[]>;
  /** Floating terminal: its sessions (tab order) and the one shown. */
  floating: { sessions: string[]; active: string | null; open: boolean };
}

export interface BranchInfo {
  is_repo: boolean;
  branch: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
}

export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_symlink: boolean;
  size: number;
  ignored: boolean;
}

export interface FileContent {
  text: string | null;
  base64: string | null;
  size: number;
  mtime: number;
  truncated: boolean;
  binary: boolean;
}

export interface GitFile {
  path: string;
  orig_path: string | null;
  index: string;
  worktree: string;
}

export interface GitStatus {
  is_repo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFile[];
  truncated: boolean;
}

export interface AttachReply {
  mode: "delta" | "reset";
  raw: boolean;
  seq: number;
  cols: number;
  rows: number;
  data: string; // base64
}
