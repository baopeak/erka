// Saved SSH hosts, keys, known hosts, port forwards and file transfer (the Hosts page).
// Backend: app/src-tauri/src/ssh_hosts.rs. A saved host is an alias in Erka's generated ssh
// config, so connecting to it is opening a remote project on it (lib/remote.ts): terminals and
// agents run there in tmux, files / git / search work, and sessions resume like local ones.
import { invoke } from "@tauri-apps/api/core";
import { createSignal } from "solid-js";
import { store } from "./store";
import { CORE_AGENTS, agentPresets } from "./agents";
import { remoteCheck, remoteRoot, type HostCheck } from "./remote";
import type { SessionKind } from "./types";

export interface SshHost {
  id: string;
  label: string;
  alias: string;
  group: string;
  tags: string[];
  hostname: string;
  port: number | null;
  user: string;
  auth: "key" | "password";
  identityFile: string;
  jump: string;
  forwardAgent: boolean;
  keepalive: number;
  env: Record<string, string>;
  startup: string;
  folder: string;
  tmux: boolean;
  notes: string;
  color: string;
  lastConnected: number;
}

export interface SshForward {
  id: string;
  hostId: string;
  label: string;
  kind: "local" | "remote" | "dynamic";
  bindAddress: string;
  bindPort: number;
  destHost: string;
  destPort: number;
  autoStart: boolean;
}

export interface Vault {
  version: number;
  hosts: SshHost[];
  forwards: SshForward[];
}

export interface SshKey {
  path: string;
  name: string;
  kind: string;
  bits: number;
  fingerprint: string;
  comment: string;
  public: string;
  encrypted: boolean;
  passphraseSaved: boolean;
}

export interface KnownHost { line: number; hosts: string; hashed: boolean; kind: string; fingerprint: string; marker: string }
export interface HostKeys { name: string; keys: { kind: string; fingerprint: string; line: string }[]; known: boolean; matches: boolean }
export interface AgentState { running: boolean; keys: string[]; error: string }
export interface ForwardState { running: boolean; error: string }

export const newHost = (over: Partial<SshHost> = {}): SshHost => ({
  id: "", label: "", alias: "", group: "", tags: [], hostname: "", port: null, user: "", auth: "key", identityFile: "", jump: "",
  forwardAgent: false, keepalive: 30, env: {}, startup: "", folder: "", tmux: true, notes: "", color: "", lastConnected: 0, ...over,
});

export const newForward = (hostId: string): SshForward => ({ id: "", hostId, label: "", kind: "local", bindAddress: "", bindPort: 0, destHost: "localhost", destPort: 0, autoStart: false });

// ---------- backend ----------

export const sshPaths = () => invoke<{ config: string; known_hosts: string; ssh_dir: string }>("ssh_paths");
const vaultLoad = () => invoke<Vault>("ssh_vault_load");
const vaultSave = (vault: Vault) => invoke<Vault>("ssh_vault_save", { vault });
export const importSshConfig = () => invoke<SshHost[]>("ssh_import_config");
export const setSecret = (kind: "password" | "passphrase", target: string, value: string) => invoke<void>("ssh_secret_set", { kind, target, value });
export const hasSecret = (kind: "password" | "passphrase", target: string) => invoke<boolean>("ssh_secret_has", { kind, target });
export const listKeys = () => invoke<SshKey[]>("ssh_keys_list");
export const generateKey = (name: string, kind: string, passphrase: string, comment: string, savePassphrase: boolean) => invoke<string>("ssh_key_generate", { name, kind, passphrase, comment, savePassphrase });
export const importKey = (source: string, name: string, passphrase: string) => invoke<string>("ssh_key_import", { source, name, passphrase });
export const deleteKey = (path: string) => invoke<void>("ssh_key_delete", { path });
export const installKey = (alias: string, keyPath: string) => invoke<void>("ssh_key_install", { alias, keyPath });
export const agentList = () => invoke<AgentState>("ssh_agent_list");
export const agentAdd = (keyPath: string) => invoke<void>("ssh_agent_add", { keyPath });
export const knownHosts = () => invoke<KnownHost[]>("ssh_known_hosts_list");
export const removeKnownHosts = (lines: number[]) => invoke<void>("ssh_known_hosts_remove", { lines });
export const hostKeys = (alias: string) => invoke<HostKeys>("ssh_host_keys", { alias });
export const trustHost = (lines: string[]) => invoke<void>("ssh_host_trust", { lines });
export const transfer = (alias: string, upload: boolean, sources: string[], target: string) => invoke<void>("ssh_transfer", { alias, upload, sources, target });
export const forwardStart = (id: string) => invoke<void>("ssh_forward_start", { id });
export const forwardStop = (id: string) => invoke<void>("ssh_forward_stop", { id });
export const forwardStatus = () => invoke<Record<string, ForwardState>>("ssh_forward_status");

// ---------- the vault ----------

const [vault, setVault] = createSignal<Vault>({ version: 1, hosts: [], forwards: [] });
export { vault };

export async function loadVault() {
  setVault(await vaultLoad());
  return vault();
}

/** Saves the whole vault; the backend fills ids and aliases and rejects unsafe values. */
export async function saveVault(next: Vault) {
  const saved = await vaultSave(next);
  setVault(saved);
  return saved;
}

export async function saveHost(host: SshHost) {
  const hosts = host.id ? vault().hosts.map((h) => (h.id === host.id ? host : h)) : [...vault().hosts, host];
  const saved = await saveVault({ ...vault(), hosts });
  // A new host is the one whose id was empty: the last one.
  return host.id ? saved.hosts.find((h) => h.id === host.id)! : saved.hosts[saved.hosts.length - 1];
}

export async function removeHost(id: string) {
  for (const f of vault().forwards.filter((f) => f.hostId === id)) await forwardStop(f.id).catch(() => {});
  await setSecret("password", id, "").catch(() => {});
  await saveVault({ ...vault(), hosts: vault().hosts.filter((h) => h.id !== id), forwards: vault().forwards.filter((f) => f.hostId !== id) });
}

export async function saveForward(f: SshForward) {
  const forwards = f.id ? vault().forwards.map((x) => (x.id === f.id ? f : x)) : [...vault().forwards, f];
  await saveVault({ ...vault(), forwards });
}

export async function removeForward(id: string) {
  await forwardStop(id).catch(() => {});
  await saveVault({ ...vault(), forwards: vault().forwards.filter((f) => f.id !== id) });
}

export const hostById = (id: string) => vault().hosts.find((h) => h.id === id);
export const hostByAlias = (alias: string) => vault().hosts.find((h) => h.alias === alias);
export const hostAddress = (h: SshHost) => `${h.user ? `${h.user}@` : ""}${h.hostname}${h.port && h.port !== 22 ? `:${h.port}` : ""}`;

/** "Host key verification failed" and friends: the user should compare fingerprints first. */
export const isHostKeyError = (e: unknown) => /host key verification failed|remote host identification has changed|no matching host key|host key for .* has changed/i.test(String(e));

// ---------- connecting ----------

/** What the host has (git, tmux, agent CLIs); records the connection time. */
export async function checkHost(host: SshHost): Promise<HostCheck> {
  const bins = agentPresets().length ? agentPresets().map((p) => p.bin) : CORE_AGENTS;
  const check = await remoteCheck(host.alias, [...new Set(bins)]);
  void invoke<Vault>("ssh_host_touch", { id: host.id }).then(setVault, () => {});
  return check;
}

/** The remote project for a host's folder (created on first use). */
export async function hostProject(host: SshHost, check?: HostCheck): Promise<string> {
  const c = check ?? (await checkHost(host));
  const folder = host.folder.trim() || c.home || "/";
  const root = remoteRoot(host.alias, undefined, folder);
  const path = root.slice(root.indexOf("/", "ssh://".length));
  const agents = c.agents.map((bin) => agentPresets().find((p) => p.bin === bin)?.id ?? bin);
  const leaf = path.split("/").filter(Boolean).pop() ?? "/";
  return store.addProject(root, { name: `${host.label} · ${leaf}`, remote: { dest: host.alias, path, tmux: host.tmux && c.tmux, agents } });
}

/** Opens a terminal (or an agent) on the host, in its remote project. A new shell types the
 *  host's startup command. */
export async function connectHost(host: SshHost, kind: SessionKind = "shell", opts: { prompt?: string; check?: HostCheck } = {}) {
  const projectId = await hostProject(host, opts.check);
  store.switchProject(projectId);
  const prompt = opts.prompt ?? (kind === "shell" && host.startup.trim() ? host.startup : undefined);
  return store.newSession(projectId, kind, { prompt });
}

/** Termius' "run snippet on hosts": one terminal per host, each typing `command`. */
export async function runOnHosts(hosts: SshHost[], command: string) {
  const failed: string[] = [];
  for (const h of hosts) {
    try {
      await connectHost(h, "shell", { prompt: command });
    } catch {
      failed.push(h.label);
    }
  }
  return failed;
}

/** Forwards marked auto-start, once the vault is loaded. */
export async function startAutoForwards() {
  for (const f of vault().forwards.filter((f) => f.autoStart)) await forwardStart(f.id).catch(() => {});
}

/** Loads the vault and starts the auto-start forwards (app start). */
export async function initSshHosts() {
  await loadVault().catch(() => {});
  await startAutoForwards();
}

/** Official installer for Claude Code on Linux / macOS hosts (typed into a terminal there). */
export const CLAUDE_INSTALL = "curl -fsSL https://claude.ai/install.sh | bash"; // i18n-ignore
