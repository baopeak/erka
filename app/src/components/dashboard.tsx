import { For, Show, createMemo, onCleanup, onMount } from "solid-js";
import { store, sessionLabel } from "../lib/store";
import { relTime } from "../lib/platform";
import { Icon, KindGlyph } from "./icons";
import { StatusDot } from "./sidebar";
import type { SessionInfo } from "../lib/types";

const columns: { id: string; title: string; color: string; test: (s: SessionInfo) => boolean }[] = [
  { id: "waiting", title: "Needs you", color: "var(--waiting)", test: (s) => s.alive && s.status === "waiting" },
  { id: "working", title: "Working", color: "var(--working)", test: (s) => s.alive && s.status === "working" },
  { id: "done", title: "Done · unread", color: "var(--idle)", test: (s) => s.alive && s.status === "idle" && s.unread },
  { id: "idle", title: "Idle / exited", color: "var(--text-faint)", test: (s) => !s.alive || (s.status === "idle" && !s.unread) },
];

/** Every session in every project, grouped by what it needs — without rendering a single terminal. */
export function Dashboard() {
  const all = createMemo(() => Object.values(store.sessions).sort((a, b) => b.created_at - a.created_at));
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && store.setOverlay(null);
  onMount(() => window.addEventListener("keydown", onKey));
  onCleanup(() => window.removeEventListener("keydown", onKey));
  const open = (s: SessionInfo) => {
    store.setOverlay(null);
    store.revealSession(s.id);
  };
  return (
    <div class="dashboard" tabIndex={-1} ref={(el) => queueMicrotask(() => el.focus())}>
      <div class="dash-head">
        <h2>Agents</h2>
        <span class="stats">
          {all().filter((s) => s.alive).length} running · {store.state.projects.length} projects
        </span>
        <span class="spacer" />
        <button class="icon-btn" title="Close (Esc)" onClick={() => store.setOverlay(null)}><Icon name="close" /></button>
      </div>
      <div class="dash-cols">
        <For each={columns}>
          {(col) => {
            const items = createMemo(() => all().filter(col.test));
            return (
              <div class="dash-col">
                <h3><span class="dot" style={{ background: col.color }} />{col.title}<span class="count">{items().length}</span></h3>
                <div class="dash-cards">
                  <For each={items()}>
                    {(s) => {
                      const project = () => store.state.projects.find((p) => p.id === s.project_id);
                      return (
                        <div class="card" onClick={() => open(s)}>
                          <div class="top">
                            <StatusDot s={s} />
                            <KindGlyph kind={s.kind} size={16} />
                            <span class="name">{sessionLabel(s)}</span>
                          </div>
                          <div class="meta">
                            <Show when={project()}>
                              {(p) => <span class="chip" style={{ "border-color": p().color, color: p().color }}>{p().name}</span>}
                            </Show>
                            <span>{s.alive ? s.status : `exited ${s.exit_code ?? ""}`}</span>
                            <span>· {relTime(s.created_at)}</span>
                          </div>
                        </div>
                      );
                    }}
                  </For>
                  <Show when={items().length === 0}><div class="muted">Nothing here</div></Show>
                </div>
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
}
