// Git worktrees as child projects: create (with the repository's `.erka.yaml` setup), find
// existing ones, and remove one cleanly (its sessions stop first; the branch is kept).
import { parse as parseYaml } from "yaml";
import { store } from "./store";
import * as ipc from "./ipc";
import { t } from "./i18n";
import { basename, normPath } from "./platform";
import { disposeView } from "./terminal-host";
import type { Project, SessionKind } from "./types";

/** `.erka.yaml` in a repository root. */
export interface ErkaConfig {
  /** Commands typed into a "setup" terminal of every new worktree. */
  setup: string[];
  /** Sessions opened in every new worktree: an agent/shell kind, or `{ command }`. */
  tabs: ({ kind: SessionKind } | { command: string })[];
  /** Ignored files copied from the repository into every new worktree (like `.worktreeinclude`). */
  copy: string[];
  /** Ignored folders shared with the repository through a link (e.g. node_modules). */
  link: string[];
  /** Hash of the file's text: what the user approved to run. */
  hash: string;
}

/** shell, a core agent or any preset agent id (checked when the tab starts). */
const KIND_RE = /^[a-z][a-z0-9-]*$/;
const MAX_CONFIG = 64 * 1024;

function hashText(text: string): string {
  let h = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16) + ":" + text.length;
}

/** Parses `.erka.yaml` text. Throws a readable message when it is invalid. */
export function parseErkaConfig(text: string): ErkaConfig {
  if (text.length > MAX_CONFIG) throw new Error(t(".erka.yaml is larger than 64 KB"));
  let raw: any;
  try {
    raw = parseYaml(text) ?? {};
  } catch (e) {
    throw new Error(t(".erka.yaml: {error}", { error: String(e).split("\n")[0] }));
  }
  const list = (v: unknown) => (v == null ? [] : Array.isArray(v) ? v : [v]);
  const setup = list(raw.setup).map(String).filter((c) => c.trim());
  const tabs: ErkaConfig["tabs"] = [];
  for (const tab of list(raw.tabs)) {
    if (typeof tab === "string" && KIND_RE.test(tab) && tab !== "custom") tabs.push({ kind: tab as SessionKind });
    else if (tab && typeof tab === "object" && typeof tab.command === "string" && tab.command.trim()) tabs.push({ command: tab.command.trim() });
    else throw new Error(t(".erka.yaml: unknown tab {tab} (use an agent such as claude, shell, or { command: … })", { tab: JSON.stringify(tab) }));
  }
  const paths = (v: unknown) => list(v).map(String).map((x) => x.trim()).filter(Boolean);
  return { setup, tabs, copy: paths(raw.copy), link: paths(raw.link), hash: hashText(text) };
}

/**
 * The `.erka.yaml` a new worktree based on `base` will contain — read from that commit, not
 * from the repository's working copy, so what the user reviews is what would run.
 */
export async function configAtRef(repo: Project, base: string): Promise<ErkaConfig | null> {
  const text = await ipc.gitShowFile(repo.path, base || "HEAD", ".erka.yaml");
  return text === null ? null : parseErkaConfig(text);
}

/** Whether this exact config was approved for the repository before. */
export const configApproved = (repo: Project, config: ErkaConfig) => store.state.approvedSetups?.[normPath(repo.path)] === config.hash;

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
    else await store.newSession(project.id, "custom", { args: (t.command.match(/"[^"]*"|\S+/g) ?? []).map((a) => a.replace(/^"|"$/g, "")), name: t.command });
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

/**
 * Creates the worktree and its project. `config` (already shown to and approved by the user)
 * runs afterwards; its failures are reported, not thrown — the worktree exists by then.
 */
export async function createWorktree(repo: Project, opts: { branch: string; base?: string; path: string; config: ErkaConfig | null }) {
  if (!validBranch(opts.branch)) throw new Error(t("\"{name}\" is not a valid branch name", { name: opts.branch }));
  await ipc.gitWorktreeAdd(repo.path, opts.path.trim(), opts.branch, opts.base?.trim() || undefined);
  // Ignored files a checkout lacks (.env, node_modules): before setup runs, which may need them.
  const files = await ipc.worktreeMaterialize(repo.path, opts.path.trim(), opts.config?.copy ?? [], opts.config?.link ?? []).catch((e) => {
    store.notify(t("Copying ignored files failed: {error}", { error: String(e) }), undefined, 8000);
    return null;
  });
  const id = store.addProject(opts.path.trim(), { parentId: repo.id, branch: opts.branch, name: opts.branch });
  const project = store.state.projects.find((p) => p.id === id)!;
  const parts = [files?.copied.length ? t("copied {files}", { files: files.copied.join(", ") }) : "", files?.linked.length ? t("linked {files}", { files: files.linked.join(", ") }) : ""].filter(Boolean);
  store.addInbox({ kind: "worktree", title: t("Worktree {name}", { name: opts.branch }), body: parts.length ? t("Created in {repo} · {details}", { repo: repo.name, details: parts.join(" · ") }) : t("Created in {repo}", { repo: repo.name }), projectId: id });
  if (files?.skipped.length) store.notify(t("Not brought into the worktree: {files}", { files: files.skipped.map((x) => `${x.path} (${x.reason})`).join("; ") }), undefined, 12000);
  if (opts.config) {
    store.approveSetup(repo.path, opts.config.hash);
    void applyErkaConfig(project, opts.config).catch((e) => store.notify(t(".erka.yaml: {error}", { error: String(e) })));
  }
  return project;
}

/** Adds the repository's other worktrees that are not in the sidebar yet; returns how many. */
export async function addExistingWorktrees(repo: Project): Promise<number> {
  const list = await ipc.gitWorktrees(repo.path);
  // The first entry is always the main worktree: only a project that *is* the main worktree
  // gets the others as children (not a subfolder of the repository, not a linked worktree).
  // Compare canonical forms: the project may be spelled with 8.3 short names.
  const canon = async (p: string) => normPath(await ipc.canonicalPath(p).catch(() => p));
  if (!list.length || (await canon(list[0].path)) !== (await canon(repo.path))) return 0;
  const known = await Promise.all(store.state.projects.map((p) => canon(p.path)));
  let added = 0;
  for (const w of list.slice(1)) {
    if (w.bare || w.prunable || known.includes(await canon(w.path))) continue;
    store.addProject(w.path, { parentId: repo.id, branch: w.branch ?? undefined, name: w.branch ?? basename(w.path), open: false });
    added++;
  }
  return added;
}

export interface RemovalCheck {
  /** Live branch (null when HEAD is detached). */
  branch: string | null;
  /** Uncommitted or untracked files. */
  changes: number;
  /** Commits only this worktree's HEAD reaches (lost with it). */
  orphanCommits: number;
}

/** What removing `wt` would lose, before anything is stopped. */
export async function checkRemoval(wt: Project): Promise<RemovalCheck> {
  const status = await ipc.gitStatus(wt.path);
  const branch = status.branch ?? null;
  const orphanCommits = branch ? 0 : await ipc.gitOrphanCommits(wt.path).catch(() => 0);
  return { branch, changes: status.files.length, orphanCommits };
}

/**
 * Stops every session belonging to the worktree or running inside its folder, and waits for
 * their processes to exit (Windows refuses to delete a folder a process still uses).
 */
async function stopSessions(wt: Project, timeoutMs = 10_000) {
  const root = normPath(wt.path);
  const inside = (cwd: string) => normPath(cwd) === root || normPath(cwd).startsWith(root + "/");
  const mine = () => Object.values(store.sessions).filter((s) => s.project_id === wt.id || inside(s.cwd));
  const pids = mine().map((s) => s.pid).filter((p): p is number => typeof p === "number");
  for (const s of mine()) {
    disposeView(s.id);
    await ipc.daemon("session.close", { handle: s.handle }).catch(() => {});
  }
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const alive = pids.length ? await ipc.processesAlive(pids).catch(() => []) : [];
    if (!mine().length && !alive.length) return true;
    await sleep(200);
  }
  return false;
}

/**
 * Removes a worktree the user confirmed (see `checkRemoval`): leaves it (so Erka stops
 * watching its folder), stops its sessions, then `git worktree remove`. The branch is never
 * deleted. If git already deleted the worktree but could not delete a folder still in use,
 * the record is pruned and the leftover folder reported.
 */
export async function removeWorktree(wt: Project, opts: { force: boolean }): Promise<{ leftover: boolean }> {
  const repo = store.state.projects.find((p) => p.id === wt.parentId);
  if (!repo) throw new Error(t("This worktree's repository is not in the sidebar"));
  if (store.state.activeProject === wt.id) store.switchProject(repo.id);
  if (!(await stopSessions(wt))) throw new Error(t("Some processes in this worktree did not stop; close them and try again"));
  for (let attempt = 0; ; attempt++) {
    try {
      await ipc.gitWorktreeRemove(repo.path, wt.path, opts.force);
      break;
    } catch (e) {
      const msg = String(e);
      if (/is not a working tree|not a working tree/i.test(msg)) {
        // An earlier attempt got as far as deleting git's record: finish its cleanup.
        await ipc.gitWorktreePrune(repo.path).catch(() => {});
        break;
      }
      if (attempt >= 5) throw e;
      await sleep(500);
    }
  }
  store.removeProject(wt.id);
  return { leftover: await ipc.isDir(wt.path).catch(() => false) };
}
