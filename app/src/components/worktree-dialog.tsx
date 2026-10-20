// "New worktree" dialog: branch (suggested), base ref, folder, and whether to run the
// repository's .erka.yaml setup.
import { Show, createResource, createSignal, onMount } from "solid-js";
import { store } from "../lib/store";
import { createWorktree, loadErkaConfig, validBranch, worktreeFolder } from "../lib/worktrees";
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

export function WorktreeDialog() {
  const repo = () => store.state.projects.find((p) => p.id === repoId());
  const existing = () => store.state.projects.filter((p) => p.parentId === repoId()).map((p) => p.branch ?? "");
  const [branch, setBranch] = createSignal(suggestBranch(existing()));
  const [base, setBase] = createSignal(store.projectInfo[repoId() ?? ""]?.branch ?? "HEAD");
  const [folderEdited, setFolderEdited] = createSignal<string | null>(null);
  const folder = () => folderEdited() ?? (repo() ? worktreeFolder(repo()!, branch()) : "");
  const [runConfig, setRunConfig] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [config] = createResource(() => repo()?.path, (root) => loadErkaConfig(root).catch((e) => ({ error: String(e) })));
  let input!: HTMLInputElement;
  onMount(() => (input.focus(), input.select()));

  const create = async () => {
    const r = repo();
    if (!r || busy()) return;
    if (!validBranch(branch())) return setError(`"${branch()}" is not a valid branch name`);
    setBusy(true);
    setError(null);
    try {
      const hasConfig = !!config() && !("error" in config()!);
      await createWorktree(r, { branch: branch(), base: base().trim(), path: folder(), runConfig: hasConfig && runConfig() });
      store.setOverlay(null);
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="overlay" onPointerDown={(e) => e.target === e.currentTarget && store.setOverlay(null)}>
      <div class="modal worktree-dialog" onKeyDown={(e) => { if (e.key === "Escape") store.setOverlay(null); if (e.key === "Enter" && !(e.target as HTMLElement).matches("textarea")) void create(); }}>
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
            <Show when={!("error" in c())} fallback={<div class="form-note error">{(c() as { error: string }).error}</div>}>
              <label class="form-check">
                <input type="checkbox" checked={runConfig()} onChange={(e) => setRunConfig(e.currentTarget.checked)} />
                Run .erka.yaml ({(c() as any).setup.length} setup commands, {(c() as any).tabs.length} tabs)
              </label>
            </Show>
          )}
        </Show>
        <Show when={error()}><div class="form-note error">{error()}</div></Show>
        <div class="footer">
          <KeyHints items={[["Enter", "Create"], ["Esc", "Cancel"]]} />
          <span style={{ flex: 1 }} />
          <button class="btn" onClick={() => store.setOverlay(null)}>Cancel</button>
          <button class="btn primary" disabled={busy()} onClick={() => void create()}>{busy() ? "Creating…" : "Create worktree"}</button>
        </div>
      </div>
    </div>
  );
}
