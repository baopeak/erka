// Past agent conversations (Claude / Codex / OMP transcripts on disk), scoped to this folder,
// this project tree, or everything; resumable in a terminal or the chat view.
import { For, Show, createMemo, createResource, createSignal, onCleanup } from "solid-js";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { store } from "../lib/store";
import { agentHistoryList, onEvent } from "../lib/ipc";
import { relTimeShort } from "../lib/platform";
import { newChat, supportsChat } from "../chat/mode-switch";
import { Icon, KindGlyph } from "./icons";
import type { HistoryItem, Project } from "../lib/types";

type Scope = "folder" | "project" | "all";
const PAGE = 150;

/** Comparable path: forward slashes, no trailing slash, case-folded on Windows drives. */
const norm = (p: string) => {
  const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:/i.test(s) ? s.toLowerCase() : s;
};
const within = (path: string, root: string) => path === root || path.startsWith(root + "/");

function dayLabel(ms: number): string {
  const d = new Date(ms);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const days = Math.floor((start.getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function resumeCommand(it: HistoryItem): string {
  const run = { claude: `claude --resume ${it.id}`, codex: `codex resume ${it.id}`, omp: `omp --resume ${it.id}` }[it.agent];
  return it.cwd ? `cd "${it.cwd}" && ${run}` : run;
}

/** The sidebar project owning `cwd` (deepest match), adding the folder as a project if none. */
function projectFor(cwd: string): string | null {
  const c = norm(cwd);
  const owner = store.state.projects
    .filter((p) => within(c, norm(p.path)))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (owner) return owner.id;
  if (!cwd) return null;
  store.addProject(cwd);
  return store.state.activeProject;
}

export function HistoryPanel(props: { project: Project }) {
  const [scope, setScope] = createSignal<Scope>("folder");
  const [query, setQuery] = createSignal("");
  const [limit, setLimit] = createSignal(PAGE);
  const [items, { refetch, mutate }] = createResource(() => agentHistoryList());
  // Prompt counts arrive later from a background pass; re-list without starting another one.
  const unlisten = onEvent("agent-history-counted", () => void agentHistoryList(false).then(mutate).catch(() => {}));
  onCleanup(() => void unlisten.then((f) => f()));

  const live = createMemo(() => {
    const m = new Map<string, string>();
    for (const s of Object.values(store.sessions)) if (s.alive && s.agent_session_id) m.set(s.agent_session_id, s.id);
    return m;
  });

  const filtered = createMemo(() => {
    const root = norm(props.project.path);
    const words = query().toLowerCase().split(/\s+/).filter(Boolean);
    return (items() ?? []).filter((it) => {
      const cwd = norm(it.cwd);
      if (scope() === "folder" && cwd !== root) return false;
      if (scope() === "project" && !within(cwd, root)) return false;
      if (!words.length) return true;
      const hay = `${it.title ?? ""} ${it.first_prompt ?? ""} ${it.cwd} ${it.agent}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  });

  const groups = createMemo(() => {
    const out: { day: string; items: HistoryItem[] }[] = [];
    for (const it of filtered().slice(0, limit())) {
      const day = dayLabel(it.updated_at);
      if (out[out.length - 1]?.day !== day) out.push({ day, items: [] });
      out[out.length - 1].items.push(it);
    }
    return out;
  });

  const resume = (it: HistoryItem, chat: boolean) => {
    const running = live().get(it.id);
    if (running) return store.revealSession(running);
    const pid = projectFor(it.cwd);
    if (!pid) return store.notify("This conversation has no folder to resume in");
    if (chat) void newChat(pid, it.agent, "tab", { resume: it.id, cwd: it.cwd || undefined });
    else void store.newSession(pid, it.agent, { agentSessionId: it.id, cwd: it.cwd || undefined });
  };

  return (
    <div class="history">
      <div class="explorer-tools">
        <input class="text-input" placeholder="Search conversations" value={query()} onInput={(e) => { setQuery(e.currentTarget.value); setLimit(PAGE); }}
          onKeyDown={(e) => e.key === "Escape" && setQuery("")} />
        <div class="history-scope">
          <div class="seg">
            <button class={scope() === "folder" ? "on" : ""} title={props.project.path} onClick={() => setScope("folder")}>This folder</button>
            <button class={scope() === "project" ? "on" : ""} title="This folder and every folder inside it" onClick={() => setScope("project")}>Project</button>
            <button class={scope() === "all" ? "on" : ""} onClick={() => setScope("all")}>All</button>
          </div>
          <button class="icon-btn" title="Rescan transcripts" onClick={() => void refetch()}><Icon name="refresh" size={14} /></button>
        </div>
      </div>
      <div class="list history-list">
        <Show when={!items.loading || items()} fallback={<div class="muted">Reading transcripts…</div>}>
          <Show when={!items.error} fallback={<div class="muted">Could not read transcripts: {String(items.error)}</div>}>
            <For each={groups()} fallback={<div class="muted">{query() ? "No matching conversations" : "No conversations here yet"}</div>}>
              {(g) => (
                <>
                  <div class="history-day">{g.day}</div>
                  <For each={g.items}>
                    {(it) => (
                      <div class={`history-row${live().has(it.id) ? " running" : ""}`} title={[it.title, it.first_prompt, it.cwd].filter(Boolean).join("\n")} onDblClick={() => resume(it, false)}>
                        <KindGlyph kind={it.agent} size={14} />
                        <div class="history-text">
                          <div class="history-title">{it.title ?? it.first_prompt ?? "(no prompt)"}</div>
                          <div class="history-sub">
                            <Show when={scope() !== "folder" && it.cwd}><span class="history-dir">{it.cwd.split(/[\\/]/).pop()}</span></Show>
                            <span>{relTimeShort(it.updated_at)}</span>
                            <Show when={it.turns}><span>{it.turns} {it.turns === 1 ? "prompt" : "prompts"}</span></Show>
                            <Show when={live().has(it.id)}><span class="history-live">open</span></Show>
                          </div>
                        </div>
                        <div class="row-actions">
                          <button class="icon-btn" title={live().has(it.id) ? "Show the running session" : "Resume in terminal"} onClick={() => resume(it, false)}><Icon name="terminal" size={13} /></button>
                          <Show when={supportsChat(it.agent) && !live().has(it.id)}>
                            <button class="icon-btn" title="Open in chat view" onClick={() => resume(it, true)}><Icon name="chat" size={13} /></button>
                          </Show>
                          <button class="icon-btn" title="Copy resume command" onClick={() => void writeText(resumeCommand(it)).then(() => store.notify("Resume command copied"))}><Icon name="copy" size={13} /></button>
                        </div>
                      </div>
                    )}
                  </For>
                </>
              )}
            </For>
            <Show when={filtered().length > limit()}>
              <button class="btn history-more" onClick={() => setLimit((l) => l + PAGE)}>Show more ({filtered().length - limit()})</button>
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  );
}
