// Remote projects over SSH (backend: app/src-tauri/src/remote.rs; sessions: the daemon runs
// `ssh -t`, see crates/erkad/src/agents.rs). A remote project's `path` is its root
// `ssh://[user@]host[:port]/abs/path`; its `remote` field says how to reach it.
import { invoke } from "@tauri-apps/api/core";
import { store } from "./store";
import type { Project } from "./types";

export interface HostCheck {
  os: string;
  home: string;
  git: boolean;
  tmux: boolean;
  agents: string[];
}

export const remoteConfigure = (config: string | null) => invoke<void>("remote_configure", { config });
export const remoteHosts = () => invoke<string[]>("remote_hosts");
export const remoteCheck = (dest: string, agents: string[]) => invoke<HostCheck>("remote_check", { dest, agents });
export const remoteFolders = (dest: string, path: string) => invoke<string[]>("remote_folders", { dest, path });

export const isRemote = (p: Pick<Project, "remote"> | undefined | null) => !!p?.remote;

/** `host` as typed ("user@host:2222" or an alias) → destination and port. */
export function splitHost(host: string): { dest: string; port?: number } {
  const m = host.trim().match(/^(.*?)(?::(\d+))?$/);
  return { dest: m?.[1] ?? host.trim(), port: m?.[2] ? Number(m[2]) : undefined };
}

export function remoteRoot(dest: string, port: number | undefined, path: string): string {
  const clean = "/" + path.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return `ssh://${dest}${port ? `:${port}` : ""}${clean === "/" ? "/" : clean}`;
}

/** Erka's generated ssh config (saved hosts + an include of the user's config); every remote
 *  session reads it. Set at startup (`loadSshConfigPath`). */
let sshConfigPath: string | undefined;
export async function loadSshConfigPath() {
  sshConfigPath = (await invoke<{ config: string }>("ssh_paths")).config;
}

/** The `remote` part of a session for a project on another machine. */
export function sessionRemote(p: Project) {
  if (!p.remote) return undefined;
  return { dest: p.remote.dest, port: p.remote.port, config: sshConfigPath ?? (store.state.settings.sshConfig?.trim() || undefined), tmux: p.remote.tmux };
}

/** Environment that lets a session's ssh log in with a saved password / key passphrase. */
export const sessionEnv = (p: Project) => (p.remote ? invoke<Record<string, string>>("ssh_session_env", { alias: p.remote.dest }).catch(() => ({})) : Promise.resolve({}));

export const hostLabel = (p: Project) => (p.remote ? `${p.remote.dest}${p.remote.port ? `:${p.remote.port}` : ""}` : "");
