/** Mirrors `SessionInfo` from erkad (crates/erkad/src/session.rs). */
export type SessionStatus = "idle" | "working" | "waiting" | "exited";
export type SessionKind = "shell" | "claude" | "codex" | "omp" | "custom";

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
}

export interface Project {
  id: string;
  name: string;
  path: string;
  color: string;
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

export type RightPanel = "files" | "git" | "search" | null;

export interface Workspace {
  tabs: Tab[];
  activeTab: string | null;
  rightPanel: RightPanel;
}

export interface AgentProfile {
  kind: SessionKind;
  label: string;
  args: string[];
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
  profiles: AgentProfile[];
}

export interface AppState {
  version: 1;
  projects: Project[];
  activeProject: string | null;
  workspaces: Record<string, Workspace>;
  settings: Settings;
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
