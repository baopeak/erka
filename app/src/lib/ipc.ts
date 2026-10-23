// Typed wrappers around the Tauri commands in app/src-tauri/src.
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AttachReply, BranchInfo, Worktree, DirEntry, FileContent, GitStatus, HistoryItem, MemoryStats, SessionInfo, UsageReport } from "./types";

export const daemon = <T = unknown>(method: string, params: object = {}) =>
  invoke<T>("daemon_call", { method, params });

export const listSessions = () => daemon<SessionInfo[]>("session.list");

export interface CreateSession {
  kind: string;
  cwd: string;
  project_id?: string;
  name?: string;
  args?: string[];
  env?: Record<string, string>;
  agent_session_id?: string;
  cols?: number;
  rows?: number;
  chat_argv?: string[];
  /** First message for an agent (argument or typed once ready). */
  prompt?: string;
  /** Runs on another machine over SSH (cwd is a path there). */
  remote?: { dest: string; port?: number; config?: string; tmux: boolean };
}
export const createSession = (p: CreateSession) => daemon<SessionInfo>("session.create", p);

export function attachTerminal(handle: number, since: number | null, onData: (seq: number, data: Uint8Array) => void) {
  const channel = new Channel<ArrayBuffer>();
  channel.onmessage = (msg) => {
    const buf = msg instanceof ArrayBuffer ? msg : (msg as unknown as ArrayBuffer);
    const view = new DataView(buf);
    const seq = Number(view.getBigUint64(0, true));
    onData(seq, new Uint8Array(buf, 8));
  };
  return invoke<AttachReply>("term_attach", { handle, since, channel });
}

export const detachTerminal = (handle: number) => invoke<void>("term_detach", { handle });
export const sendInput = (handle: number, data: string, binary = false) =>
  invoke<void>("term_input", { handle, data, binary });

export const loadState = () => invoke<unknown>("state_load");
export const saveState = (state: unknown) => invoke<void>("state_save", { state });
export const stateBackup = (label: string) => invoke<string | null>("state_backup", { label });
/** `text` with recognisable credentials masked (`kelpie_proto::redact`): for anything Kelpie
 *  sends out of a session. */
export const redact = (text: string) => invoke<string[]>("redact_batch", { texts: [text] }).then((r) => r[0] ?? "");
export const platformInfo = () => invoke<{ os: string; home: string; data_dir: string; api: number; version: string; security: number; e2e: boolean }>("platform_info");

export const canonicalPath = (path: string) => invoke<string>("fs_canonical", { path });
export const isDir = (path: string) => invoke<boolean>("fs_is_dir", { path });
export const listDir = (root: string, path: string) => invoke<DirEntry[]>("fs_list_dir", { root, path });
export const readFile = (root: string, path: string, maxBytes?: number, asBase64 = false) =>
  invoke<FileContent>("fs_read_file", { root, path, maxBytes, asBase64 });
export const writeFile = (root: string, path: string, content: string, expectedMtime?: number, force = false) =>
  invoke<{ ok: boolean; conflict: boolean; mtime: number }>("fs_write_file", { root, path, content, expectedMtime, force });
export const createEntry = (root: string, path: string, dir: boolean) => invoke<void>("fs_create", { root, path, dir });
export const renameEntry = (root: string, from: string, to: string) => invoke<void>("fs_rename", { root, from, to });
export const deleteEntry = (root: string, path: string) => invoke<void>("fs_delete", { root, path });
export const revealEntry = (root: string, path: string) => invoke<void>("fs_reveal", { root, path });
export const watchRoot = (root: string) => invoke<void>("fs_watch", { root });
export const unwatchRoot = (root: string) => invoke<void>("fs_unwatch", { root });

export interface QuickOpenHit { path: string; score: number; indices: number[] }
export const quickOpen = (root: string, query: string, limit = 60) => invoke<QuickOpenHit[]>("quick_open", { root, query, limit });

export interface TextHit { path: string; line: number; column: number; text: string }
export const searchText = (root: string, query: string, regex: boolean, caseSensitive: boolean, folder?: string) =>
  invoke<{ hits: TextHit[]; truncated: boolean; files_searched: number }>("search_text", { root, query, regex, caseSensitive, folder });

export const gitStatus = (root: string) => invoke<GitStatus>("git_status", { root });
export const gitWorktrees = (root: string) => invoke<Worktree[]>("git_worktrees", { root });
export const gitWorktreeAdd = (root: string, path: string, branch: string, base?: string) => invoke<void>("git_worktree_add", { root, path, branch, base });
export const gitWorktreePrune = (root: string) => invoke<void>("git_worktree_prune", { root });
export const gitShowFile = (root: string, rev: string, path: string) => invoke<string | null>("git_show_file", { root, rev, path });
export const gitOrphanCommits = (root: string) => invoke<number>("git_orphan_commits", { root });
export const processesAlive = (pids: number[]) => invoke<number[]>("processes_alive", { pids });
export const gitWorktreeRemove = (root: string, path: string, force = false) => invoke<void>("git_worktree_remove", { root, path, force });
export const gitBranchInfo = (root: string) => invoke<BranchInfo>("git_branch_info", { root });
export const gitFileVersions = (root: string, path: string, staged: boolean) =>
  invoke<{ original: string | null; modified: string | null }>("git_file_versions", { root, path, staged });
export const gitStage = (root: string, paths: string[], stage: boolean) => invoke<void>("git_stage", { root, paths, stage });
export const gitDiscard = (root: string, paths: string[], untracked: string[]) => invoke<void>("git_discard", { root, paths, untracked });
export const gitCommit = (root: string, message: string, amend = false) => invoke<string>("git_commit", { root, message, amend });

export type RemoteAction = "push" | "pull" | "sync" | "force_push";
export const gitRemote = (root: string, action: RemoteAction) => invoke<string>("git_remote", { root, action });
export const gitRepoState = (root: string) => invoke<{ operation: "merge" | "rebase" | "cherry-pick" | "revert" | null; has_remote: boolean }>("git_repo_state", { root });
export const gitAbort = (root: string) => invoke<string>("git_abort", { root });
export const gitBranchDelete = (root: string, branch: string, force = false) => invoke<void>("git_branch_delete", { root, branch, force });
export const gitRefs = (root: string) => invoke<{ name: string; kind: "local" | "remote" | "tag" }[]>("git_refs", { root });
export const gitContext = (root: string, kind: "staged" | "branch", base?: string, max?: number) => invoke<string>("git_context", { root, kind, base, max });
export interface PullRequest { number: number; title: string; url: string; state: "OPEN" | "CLOSED" | "MERGED"; draft: boolean; base: string; checks: "passing" | "failing" | "pending" | "none"; provider?: "github" | "gitlab" }
export const ghPrStatus = (root: string) => invoke<PullRequest | null>("gh_pr_status", { root });
export const ghDefaultBranch = (root: string) => invoke<string | null>("gh_default_branch", { root });
export const ghPrCreate = (root: string, title: string, body: string, base: string, draft: boolean) => invoke<string>("gh_pr_create", { root, title, body, base, draft });
export const worktreeMaterialize = (root: string, worktree: string, copy: string[], link: string[]) =>
  invoke<{ copied: string[]; linked: string[]; skipped: { path: string; reason: string }[] }>("worktree_materialize", { root, worktree, copy, link });
export const editorsList = () => invoke<{ id: string; label: string }[]>("editors_list");
export const editorOpen = (editor: string, path: string) => invoke<void>("editor_open", { editor, path });
/** One-shot agent answer (no terminal), e.g. a commit message. */
export const agentRun = (kind: string, prompt: string, cwd: string, env?: Record<string, string>, timeoutS?: number) =>
  daemon<{ text: string }>("agent.run", { kind, prompt, cwd, env, timeout_s: timeoutS }).then((r) => r.text);

/** `count`: also refresh prompt counts in the background (`agent-history-counted` when done). */
export const agentHistoryList = (count = true, homes?: { claude: string[]; codex: string[] }) => invoke<HistoryItem[]>("agent_history_list", { count, homes });
/** Usage of the given accounts (config homes; absent = the agents' default sign-in). */
export const usageFetch = (claudeDir?: string, codexDir?: string) => invoke<UsageReport>("usage_fetch", { claudeDir, codexDir });
export const memoryStats = (daemonPid: number | null) => invoke<MemoryStats>("memory_stats", { daemonPid });
export const agentLatestSession = (kind: string, cwd: string, home?: string) =>
  invoke<{ id: string; path: string } | null>("agent_latest_session", { kind, cwd, home });
export const claudeTranscript = (sessionId: string, cwd?: string, home?: string) =>
  invoke<string[]>("agent_claude_transcript", { sessionId, cwd, home });

export function onEvent<T>(name: string, cb: (payload: T) => void): Promise<UnlistenFn> {
  return listen<T>(name, (e) => cb(e.payload));
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
