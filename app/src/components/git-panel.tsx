import { For, Show, createMemo, createSignal } from "solid-js";
import { store } from "../lib/store";
import { gitCommit, gitDiscard, gitStage } from "../lib/ipc";
import { gitState } from "../lib/git-state";
import { isMac } from "../lib/platform";
import { Icon } from "./icons";
import type { GitFile, Project } from "../lib/types";

function split(path: string) {
  const i = path.lastIndexOf("/");
  return { name: path.slice(i + 1), dir: i > 0 ? path.slice(0, i) : "" };
}

export function GitPanel(props: { project: Project }) {
  const [message, setMessage] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const st = () => gitState.status();
  const staged = createMemo(() => (st()?.files ?? []).filter((f) => f.index !== "." && f.index !== "?" && f.index !== "U"));
  const changes = createMemo(() => (st()?.files ?? []).filter((f) => f.worktree !== "." || f.index === "?" || f.index === "U"));
  const root = () => props.project.path;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      store.notify(String(e));
    } finally {
      setBusy(false);
      void gitState.refresh();
    }
  };

  const commit = () =>
    run(async () => {
      if (!message().trim()) throw new Error("Enter a commit message");
      if (!staged().length) await gitStage(root(), changes().map((f) => f.path), true);
      await gitCommit(root(), message().trim());
      setMessage("");
      store.notify("Committed");
    });

  const discard = (files: GitFile[]) => {
    if (!confirm(`Discard changes in ${files.length} file(s)? Untracked files go to the trash.`)) return;
    void run(() => gitDiscard(root(), files.filter((f) => f.index !== "?").map((f) => f.path), files.filter((f) => f.index === "?").map((f) => f.path)));
  };

  const Row = (p: { f: GitFile; staged: boolean }) => {
    const letter = () => (p.staged ? p.f.index : p.f.index === "?" ? "U" : p.f.index === "U" ? "C" : p.f.worktree);
    const parts = split(p.f.path);
    return (
      <div class="list-row" onClick={() => store.openFile(props.project.id, p.f.path, { diff: true, staged: p.staged })} title={p.f.path}>
        <span class={`ficon g-${letter()}`} style={{ "font-family": "var(--font-mono)", "font-size": "11px" }}>{letter()}</span>
        <span class="name">{parts.name}</span>
        <span class="dir">{parts.dir}</span>
        <span class="row-actions">
          <button class="icon-btn" title="Open file" onClick={(e) => { e.stopPropagation(); store.openFile(props.project.id, p.f.path); }}><Icon name="files" size={13} /></button>
          <Show when={!p.staged}>
            <button class="icon-btn" title="Discard" onClick={(e) => { e.stopPropagation(); discard([p.f]); }}><Icon name="undo" size={13} /></button>
          </Show>
          <button class="icon-btn" title={p.staged ? "Unstage" : "Stage"} onClick={(e) => { e.stopPropagation(); void run(() => gitStage(root(), [p.f.path], !p.staged)); }}>
            <Icon name={p.staged ? "minus" : "plus"} size={13} />
          </button>
        </span>
      </div>
    );
  };

  return (
    <Show when={st()?.is_repo !== false} fallback={<div class="muted">Not a git repository.</div>}>
      <div class="git-head">
        <div class="branch">
          <Icon name="git" size={14} />
          <span>{st()?.branch ?? "…"}</span>
          <Show when={st()?.upstream}><span style={{ color: "var(--text-faint)" }}>↑{st()!.ahead} ↓{st()!.behind}</span></Show>
          <span style={{ flex: 1 }} />
          <button class="icon-btn" title="Refresh" onClick={() => void gitState.refresh()}><Icon name="refresh" size={14} /></button>
        </div>
        <textarea
          class="commit-box"
          placeholder={`Commit message (${isMac ? "⌘" : "Ctrl"}+Enter to commit${staged().length ? "" : " all changes"})`}
          value={message()}
          onInput={(e) => setMessage(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (isMac ? e.metaKey : e.ctrlKey)) void commit(); }}
        />
        <button class="btn primary" disabled={busy() || (!staged().length && !changes().length)} onClick={() => void commit()}>
          <Icon name="check" size={14} /> Commit{staged().length ? ` ${staged().length} staged` : " all"}
        </button>
      </div>
      <div class="list">
        <Show when={staged().length}>
          <div class="group-label">Staged <span class="spacer" />
            <button class="icon-btn" style={{ width: "20px", height: "20px" }} title="Unstage all" onClick={() => void run(() => gitStage(root(), staged().map((f) => f.path), false))}><Icon name="minus" size={13} /></button>
          </div>
          <For each={staged()}>{(f) => <Row f={f} staged />}</For>
        </Show>
        <div class="group-label">Changes <span style={{ "text-transform": "none" }}>{changes().length}</span><span class="spacer" />
          <Show when={changes().length}>
            <button class="icon-btn" style={{ width: "20px", height: "20px" }} title="Discard all" onClick={() => discard(changes())}><Icon name="undo" size={13} /></button>
            <button class="icon-btn" style={{ width: "20px", height: "20px" }} title="Stage all" onClick={() => void run(() => gitStage(root(), changes().map((f) => f.path), true))}><Icon name="plus" size={13} /></button>
          </Show>
        </div>
        <For each={changes()}>{(f) => <Row f={f} staged={false} />}</For>
        <Show when={st() && !changes().length && !staged().length}><div class="muted">Working tree clean.</div></Show>
        <Show when={st()?.truncated}><div class="muted">Showing the first 5000 changes.</div></Show>
      </div>
    </Show>
  );
}
