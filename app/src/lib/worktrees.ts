// Git worktrees as child projects: create (with the repository's `.erka.yaml` setup), find
// existing ones, and remove one cleanly (its sessions stop first; the branch is kept).
import { parse as parseYaml } from "yaml";
import { store } from "./store";
import * as ipc from "./ipc";
import { basename } from "./platform";
import { disposeView } from "./terminal-host";
import type { Project, SessionKind } from "./types";

/** `.erka.yaml` in a repository root. */
export interface ErkaConfig {
  /** Commands typed into a "setup" terminal of every new worktree. */
  setup: string[];
  /** Sessions opened in every new worktree: an agent/shell kind, or `{ command }`. */
  tabs: ({ kind: SessionKind } | { command: string })[];
}

const KINDS: SessionKind[] = ["claude", "codex", "omp", "shell"];

/** Reads `.erka.yaml`; null when there is none. Throws with a readable message when invalid. */
export async function loadErkaConfig(root: string): Promise<ErkaConfig | null> {
  const file = await ipc.readFile(root, ".erka.yaml", 64 * 1024).catch(() => null);
  if (!file?.text) return null;
  let raw: any;
  try {
    raw = parseYaml(file.text) ?? {};
  } catch (e) {
    throw new Error(`.erka.yaml: ${String(e).split("\n")[0]}`);
  }
  const list = (v: unknown) => (v == null ? [] : Array.isArray(v) ? v : [v]);
  const setup = list(raw.setup).map(String).filter((c) => c.trim());
  const tabs: ErkaConfig["tabs"] = [];
  for (const t of list(raw.tabs)) {
    if (typeof t === "string" && KINDS.includes(t as SessionKind)) tabs.push({ kind: t as SessionKind });
    else if (t && typeof t === "object" && typeof t.command === "string") tabs.push({ command: t.command });
    else throw new Error(`.erka.yaml: unknown tab ${JSON.stringify(t)} (use claude, codex, omp, shell or { command: … })`);
  }
  return { setup, tabs };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs `.erka.yaml` for a project: setup commands in a "setup" terminal, then default tabs. */
export async function applyErkaConfig(project: Project, config: ErkaConfig) {
  if (config.setup.length) {
    const s = await store.newSession(project.id, "shell", { name: "setup" });
    // One command per line, as if typed; the shell runs them in order.
    if (s) await ipc.sendInput(s.handle, config.setup.join("\r") + "\r");
  }
  for (const t of config.tabs) {
    if ("kind" in t) await store.newSession(project.id, t.kind);
    else await store.newSession(project.id, "custom", { args: t.command.match(/"[^"]*"|\S+/g)!.map((a) => a.replace(/^"|"$/g, "")), name: t.command });
  }
}

const BRANCH_RE = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)[A-Za-z0-9._\/-]+(?<![./])$/;
export const validBranch = (b: string) => BRANCH_RE.test(b);

/** Suggested folder for a worktree: `<repo parent>/<repo>-worktrees/<branch>`. */
export function worktreeFolder(repo: Project, branch: string): string {
  const sep = repo.path.includes("\\") ? "\\" : "/";
  const parent = repo.path.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]+$/, "");
  return [parent, `${basename(repo.path)}-worktrees`, branch.replace(/[\\/]/g, "-")].join(sep);
}

export async function createWorktree(repo: Project, opts: { branch: string; base?: string; path: string; runConfig: boolean }) {
  if (!validBranch(opts.branch)) throw new Error(`"${opts.branch}" is not a valid branch name`);
  await ipc.gitWorktreeAdd(repo.path, opts.path, opts.branch, opts.base || undefined);
  const id = store.addProject(opts.path, { parentId: repo.id, branch: opts.branch, name: opts.branch });
  const project = store.state.projects.find((p) => p.id === id)!;
  if (opts.runConfig) {
    // The new worktree has the repository's committed `.erka.yaml`.
    const config = await loadErkaConfig(project.path);
    if (config) await applyErkaConfig(project, config);
  }
  return project;
}

/** Adds the repository's other worktrees that are not in the sidebar yet; returns how many. */
export async function addExistingWorktrees(repo: Project): Promise<number> {
  const list = await ipc.gitWorktrees(repo.path);
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  let added = 0;
  for (const w of list) {
    if (w.bare || norm(w.path) === norm(repo.path) || store.state.projects.some((p) => norm(p.path) === norm(w.path))) continue;
    store.addProject(w.path, { parentId: repo.id, branch: w.branch ?? undefined, name: w.branch ?? basename(w.path), open: false });
    added++;
  }
  return added;
}

/** Stops every session of a project and waits until the daemon reports them gone. */
async function stopSessions(projectId: string, timeoutMs = 8000) {
  const mine = () => Object.values(store.sessions).filter((s) => s.project_id === projectId);
  for (const s of mine()) {
    disposeView(s.id);
    await ipc.daemon("session.close", { handle: s.handle }).catch(() => {});
  }
  const end = Date.now() + timeoutMs;
  while (mine().length && Date.now() < end) await sleep(150);
  return mine().length === 0;
}

/**
 * Removes a worktree: leaves it (so Erka stops watching its folder), stops its sessions, then
 * `git worktree remove`. The branch is never deleted. Windows refuses to remove a folder a
 * process still uses, so removal is retried briefly while processes finish exiting.
 */
export async function removeWorktree(wt: Project, opts: { force?: boolean } = {}): Promise<"removed" | "dirty"> {
  const repo = store.state.projects.find((p) => p.id === wt.parentId);
  if (!repo) throw new Error("This worktree's repository is not in the sidebar");
  if (store.state.activeProject === wt.id) store.switchProject(repo.id);
  if (!(await stopSessions(wt.id))) throw new Error("Some sessions of this worktree did not stop");
  for (let attempt = 0; ; attempt++) {
    try {
      await ipc.gitWorktreeRemove(repo.path, wt.path, !!opts.force);
      break;
    } catch (e) {
      const msg = String(e);
      if (/modified or untracked|contains modified|is dirty|use --force/i.test(msg) && !opts.force) return "dirty";
      if (attempt >= 5) throw e;
      await sleep(400);
    }
  }
  store.removeProject(wt.id);
  return "removed";
}
