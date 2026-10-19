// Typed wrappers around the Tauri commands in app/src-tauri/src.
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AttachReply, DirEntry, FileContent, GitStatus, SessionInfo } from "./types";

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
export const platformInfo = () => invoke<{ os: string; home: string; data_dir: string }>("platform_info");

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
export const searchText = (root: string, query: string, regex: boolean, caseSensitive: boolean) =>
  invoke<{ hits: TextHit[]; truncated: boolean; files_searched: number }>("search_text", { root, query, regex, caseSensitive });

export const gitStatus = (root: string) => invoke<GitStatus>("git_status", { root });
export const gitFileVersions = (root: string, path: string, staged: boolean) =>
  invoke<{ original: string | null; modified: string | null }>("git_file_versions", { root, path, staged });
export const gitStage = (root: string, paths: string[], stage: boolean) => invoke<void>("git_stage", { root, paths, stage });
export const gitDiscard = (root: string, paths: string[], untracked: string[]) => invoke<void>("git_discard", { root, paths, untracked });
export const gitCommit = (root: string, message: string, amend = false) => invoke<string>("git_commit", { root, message, amend });

export const agentLatestSession = (kind: string, cwd: string) =>
  invoke<{ id: string; path: string } | null>("agent_latest_session", { kind, cwd });
export const claudeTranscript = (sessionId: string, cwd?: string) =>
  invoke<string[]>("agent_claude_transcript", { sessionId, cwd });

export function onEvent<T>(name: string, cb: (payload: T) => void): Promise<UnlistenFn> {
  return listen<T>(name, (e) => cb(e.payload));
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
