// "New worktree" dialog: branch (suggested), base ref, folder, and — when the base commit has
// one — the `.erka.yaml` it would run, shown in full. Running it is opt-in unless the user
// approved that exact file for this repository before.
import { For, Show, createEffect, createResource, createSignal, on, onMount } from "solid-js";
import { store } from "../lib/store";
import { configAtRef, configApproved, createWorktree, validBranch, worktreeFolder, type ErkaConfig } from "../lib/worktrees";
import { KeyHints } from "./key-hints";

const [repoId, setRepoId] = createSignal<string | null>(null);

export function openWorktreeDialog(repo: string) {
  setRepoId(repo);
  store.setOverlay("worktree");
}

const WORDS = ["amber", "brisk", "cedar", "delta", "ember", "fable", "grove", "harbor", "iris", "juniper", "kite", "lumen", "maple", "nova", "orbit", "pine", "quartz", "river", "sage", "tide"];

function suggestBranch(existing: string[]): string {
  for (let i = 0; i < 50; i++) {
    const name = `wt/${WORDS[Math.floor(Math.random() * WORDS.length)]}-${Math.floor(Math.random() * 90 + 10)}`;
    if (!existing.includes(name)) return name;
  }
  return `wt/${Date.now().toString(36)}`;
}

type ConfigState = { config: ErkaConfig | null } | { error: string };

export function WorktreeDialog() {
  const repo = () => store.state.projects.find((p) => p.id === repoId());
  const existing = () => store.state.projects.filter((p) => p.parentId === repoId()).map((p) => p.branch ?? "");
  const [branch, setBranch] = createSignal(suggestBranch(existing()));
  const [base, setBase] = createSignal(store.projectInfo[repoId() ?? ""]?.branch ?? "HEAD");
  const [folderEdited, setFolderEdited] = createSignal<string | null>(null);
  const folder = () => folderEdited() ?? (repo() ? worktreeFolder(repo()!, branch()) : "");
  const [runConfig, setRunConfig] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  // The config of the base commit (debounced while the base is being typed).
  const [baseRef, setBaseRef] = createSignal(base());
  let timer = 0;
  createEffect(on(base, (b) => {
    clearTimeout(timer);
    timer = window.setTimeout(() => setBaseRef(b.trim() || "HEAD"), 300);
  }));
  const [config] = createResource(
    () => (repo() ? { root: repo()!, ref: baseRef() } : null),
    (k): Promise<ConfigState> => configAtRef(k.root, k.ref).then((config) => ({ config }), (e) => ({ error: String(e).replace(/^Error: /, "") })),
  );
  const loaded = () => {
    const c = config();
    return c && "config" in c ? c.config : null;
  };
  // Approved before (same file, same repository) → ticked; otherwise the user opts in.
  createEffect(on(loaded, (c) => setRunConfig(!!c && !!repo() && configApproved(repo()!, c))));

  let input!: HTMLInputElement;
  onMount(() => (input.focus(), input.select()));

  const create = async () => {
    const r = repo();
    if (!r || busy()) return;
    if (!validBranch(branch())) return setError(`"${branch()}" is not a valid branch name`);
    setBusy(true);
    setError(null);
    try {
      await createWorktree(r, { branch: branch(), base: base(), path: folder(), config: runConfig() ? loaded() : null });
      if (store.overlay() === "worktree") store.setOverlay(null);
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="overlay" onPointerDown={(e) => e.target === e.currentTarget && !busy() && store.setOverlay(null)}>
      <div class="modal worktree-dialog" onKeyDown={(e) => {
        if (e.key === "Escape" && !busy()) store.setOverlay(null);
        if (e.key === "Enter" && !(e.target as HTMLElement).matches("textarea, input[type=checkbox]")) void create();
      }}>
        <h2>New worktree of {repo()?.name}</h2>
        <div class="form-row">
          <label>Branch</label>
          <input ref={input} class="text-input" value={branch()} onInput={(e) => setBranch(e.currentTarget.value.trim())} />
        </div>
        <div class="form-row">
          <label>From</label>
          <input class="text-input" value={base()} placeholder="HEAD" onInput={(e) => setBase(e.currentTarget.value)} />
        </div>
        <div class="form-row">
          <label>Folder</label>
          <input class="text-input mono" value={folder()} onInput={(e) => setFolderEdited(e.currentTarget.value)} />
        </div>
        <Show when={config()}>
          {(c) => (
            <Show when={"config" in c()} fallback={<div class="form-note error">{(c() as { error: string }).error}</div>}>
              <Show when={loaded()}>
                {(cfg) => (
                  <div class="erka-config">
                    <label class="form-check">
                      <input type="checkbox" checked={runConfig()} onChange={(e) => setRunConfig(e.currentTarget.checked)} />
                      Run .erka.yaml from {baseRef()}
                    </label>
                    <div class="erka-config-body">
                      <For each={cfg().setup}>{(cmd) => <div class="mono">$ {cmd}</div>}</For>
                      <For each={cfg().tabs}>{(t) => <div class="mono">+ tab: {"kind" in t ? t.kind : t.command}</div>}</For>
                    </div>
                  </div>
                )}
              </Show>
            </Show>
          )}
        </Show>
        <Show when={error()}><div class="form-note error">{error()}</div></Show>
        <div class="footer">
          <KeyHints items={[["Enter", "Create"], ["Esc", "Cancel"]]} />
          <span style={{ flex: 1 }} />
          <button class="btn" disabled={busy()} onClick={() => store.setOverlay(null)}>Cancel</button>
          <button class="btn primary" disabled={busy()} onClick={() => void create()}>{busy() ? "Creating…" : "Create worktree"}</button>
        </div>
      </div>
    </div>
  );
}
