// One search box for everything: recents, sessions, projects, files, commands and settings.
// Prefixes narrow the scope (`>` commands, `@` sessions & projects, `#` files, `/` settings);
// Tab cycles the scope. Keyboard shortcuts open it pre-scoped (Go to File → files, Jump → sessions).
import { For, Show, createEffect, createMemo, createSignal, on, onMount, type JSX } from "solid-js";
import { store, sessionLabel } from "../lib/store";
import { chordOf, commands } from "../lib/commands";
import { basename, chordLabel, relTime } from "../lib/platform";
import { quickOpen, type QuickOpenHit } from "../lib/ipc";
import { settingsCatalog } from "../lib/settings-catalog";
import { quickCommandsFor, runQuickCommand } from "../lib/quick-commands";
import { Icon, KindGlyph } from "./icons";
import { KeyHints } from "./key-hints";
import { StatusDot } from "./sidebar";
import type { Project, SessionInfo } from "../lib/types";

export type SearchScope = "all" | "commands" | "sessions" | "files" | "settings";
const SCOPES: { id: SearchScope; label: string; prefix: string }[] = [
  { id: "all", label: "All", prefix: "" },
  { id: "sessions", label: "Sessions", prefix: "@" },
  { id: "files", label: "Files", prefix: "#" },
  { id: "commands", label: "Commands", prefix: ">" },
  { id: "settings", label: "Settings", prefix: "/" },
];

interface Item {
  key: string;
  label: string;
  hint?: string;
  chord?: string;
  marks?: number[];
  icon?: () => JSX.Element;
  run: () => void;
}

interface Group {
  title: string;
  items: Item[];
}

/** Subsequence fuzzy scorer for small in-memory lists. */
export function fuzzy(query: string, text: string): { score: number; marks: number[] } | null {
  if (!query) return { score: 0, marks: [] };
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const marks: number[] = [];
  let ti = 0;
  let score = 0;
  let prev = -2;
  for (const ch of q) {
    if (ch === " ") continue;
    const i = t.indexOf(ch, ti);
    if (i < 0) return null;
    marks.push(i);
    score += i === prev + 1 ? 8 : 1;
    if (i === 0 || " /-_.·".includes(t[i - 1])) score += 6;
    prev = i;
    ti = i + 1;
  }
  return { score: score - t.length * 0.02, marks };
}

function Highlight(props: { text: string; marks?: number[] }) {
  const parts = createMemo(() => {
    const set = new Set(props.marks ?? []);
    const out: { s: string; m: boolean }[] = [];
    for (let i = 0; i < props.text.length; i++) {
      const m = set.has(i);
      if (out.length && out[out.length - 1].m === m) out[out.length - 1].s += props.text[i];
      else out.push({ s: props.text[i], m });
    }
    return out;
  });
  return <For each={parts()}>{(p) => (p.m ? <mark>{p.s}</mark> : <>{p.s}</>)}</For>;
}

const projectOf = (id: string | null | undefined) => store.state.projects.find((p) => p.id === id);

function sessionItem(s: SessionInfo, marks?: number[]): Item {
  const proj = projectOf(s.project_id);
  const label = sessionLabel(s);
  return {
    key: "s" + s.id,
    label,
    marks: marks?.filter((i) => i < label.length),
    hint: `${proj?.name ?? "—"} · ${s.alive ? s.status : "exited"}${s.model ? " · " + s.model : ""} · ${relTime(s.last_activity || s.created_at)}`,
    icon: () => <><StatusDot s={s} /><KindGlyph kind={s.kind} size={16} /></>,
    run: () => store.revealSession(s.id),
  };
}

function projectItem(p: Project, marks?: number[]): Item {
  const i = store.state.projects.indexOf(p);
  const info = store.projectInfo[p.id];
  return {
    key: "p" + p.id,
    label: p.name,
    marks,
    hint: `${info?.branch ? info.branch + (info.dirty ? "*" : "") + " · " : ""}${p.path}`,
    chord: i >= 0 && i < 9 ? chordLabel(chordOf(commands.find((c) => c.id === `project.${i + 1}`)!) ?? "") : undefined,
    icon: () => <span class="project-swatch" style={{ background: p.color, width: "16px", height: "16px", "font-size": "9px" }}>{p.name[0]?.toUpperCase()}</span>,
    run: () => store.switchProject(p.id),
  };
}

function fileItem(projectId: string, path: string, indices: number[] = []): Item {
  const name = basename(path);
  const offset = path.length - name.length;
  return {
    key: "f" + projectId + path,
    label: name,
    hint: path,
    marks: indices.filter((i) => i >= offset).map((i) => i - offset),
    icon: () => <Icon name="files" size={14} />,
    run: () => store.openFile(projectId, path),
  };
}

const sessionOrder = { waiting: 0, working: 1, idle: 2, exited: 3 } as const;

export function Palette(props: { scope: SearchScope }) {
  let input!: HTMLInputElement;
  let list!: HTMLDivElement;
  const [raw, setRaw] = createSignal(SCOPES.find((s) => s.id === props.scope)?.prefix ?? "");
  const [sel, setSel] = createSignal(0);
  const [files, setFiles] = createSignal<QuickOpenHit[]>([]);
  const project = () => store.activeProject();
  onMount(() => {
    input.focus();
    input.setSelectionRange(raw().length, raw().length);
  });

  // Scope from the prefix, query without it.
  const scope = createMemo<SearchScope>(() => SCOPES.find((s) => s.prefix && raw().startsWith(s.prefix))?.id ?? "all");
  const query = createMemo(() => {
    const p = SCOPES.find((s) => s.id === scope())?.prefix ?? "";
    return raw().slice(p.length).trim();
  });

  let seq = 0;
  createEffect(on([query, scope], ([q, sc]) => {
    const p = project();
    if (!p || (sc !== "files" && sc !== "all") || (sc === "all" && !q)) return setFiles([]);
    const mine = ++seq;
    void quickOpen(p.path, q, sc === "files" ? 60 : 8).then((hits) => mine === seq && setFiles(hits)).catch(() => mine === seq && setFiles([]));
  }));

  const groups = createMemo<Group[]>(() => {
    const q = query();
    const sc = scope();
    const out: Group[] = [];

    if (sc === "all" && !q) {
      const recent: Item[] = [];
      for (const r of store.state.recent ?? []) {
        if (recent.length >= 8) break;
        if (r.kind === "session" && store.sessions[r.id]) recent.push(sessionItem(store.sessions[r.id]));
        else if (r.kind === "project" && projectOf(r.id) && r.id !== store.state.activeProject) recent.push(projectItem(projectOf(r.id)!));
        else if (r.kind === "file" && r.projectId === store.state.activeProject) recent.push(fileItem(r.projectId, r.id));
      }
      if (recent.length) out.push({ title: "Recent", items: recent });
      const attention = Object.values(store.sessions).filter((s) => s.alive && (s.status === "waiting" || s.unread));
      if (attention.length) out.push({ title: "Needs attention", items: attention.map((s) => sessionItem(s)) });
      out.push({ title: "Commands", items: commandItems("").slice(0, 6) });
      return out;
    }

    if (sc === "all" || sc === "sessions") {
      const ranked: (Item & { score: number })[] = [];
      for (const s of Object.values(store.sessions)) {
        const proj = projectOf(s.project_id);
        const label = sessionLabel(s);
        const m = fuzzy(q, `${label} ${proj?.name ?? ""} ${s.model ?? ""}`);
        if (m) ranked.push({ ...sessionItem(s, m.marks), score: m.score - sessionOrder[s.alive ? s.status : "exited"] * 0.5 });
      }
      ranked.sort((a, b) => b.score - a.score);
      if (ranked.length) out.push({ title: "Sessions", items: ranked.slice(0, sc === "all" ? 5 : 50) });
      const projects = store.state.projects
        .map((p) => ({ p, m: fuzzy(q, p.name) }))
        .filter((x) => x.m)
        .sort((a, b) => b.m!.score - a.m!.score)
        .map((x) => projectItem(x.p, x.m!.marks));
      if (projects.length) out.push({ title: "Projects", items: projects.slice(0, sc === "all" ? 5 : 50) });
    }
    if ((sc === "all" || sc === "files") && project()) {
      const items = files().map((h) => fileItem(project()!.id, h.path, h.indices));
      if (items.length) out.push({ title: `Files in ${project()!.name}`, items });
    }
    if (sc === "all" || sc === "commands") {
      const items = commandItems(q);
      if (items.length) out.push({ title: "Commands", items: sc === "all" ? items.slice(0, 6) : items });
    }
    if (sc === "all" || sc === "settings") {
      const items = settingsCatalog
        .map((c) => ({ c, m: fuzzy(q, `${c.label} ${c.keywords}`) }))
        .filter((x) => x.m)
        .sort((a, b) => b.m!.score - a.m!.score)
        .map(({ c, m }) => ({
          key: "st" + c.label,
          label: c.label,
          marks: m!.marks.filter((i) => i < c.label.length),
          hint: "Settings",
          icon: () => <Icon name="settings" size={14} />,
          run: () => store.openSettings(c.section),
        }));
      if (items.length) out.push({ title: "Settings", items: sc === "all" ? items.slice(0, 4) : items });
    }
    return out;
  });

  function commandItems(q: string): Item[] {
    const ranked: (Item & { score: number })[] = [];
    for (const c of commands) {
      if (c.when && !c.when()) continue;
      const m = fuzzy(q, c.label);
      if (!m) continue;
      const k = chordOf(c);
      ranked.push({ key: c.id, label: c.label, chord: k ? chordLabel(k) : undefined, marks: m.marks, score: m.score, run: c.run, icon: () => <Icon name="bolt" size={14} /> });
    }
    for (const c of quickCommandsFor(store.state.activeProject)) {
      const m = fuzzy(q, `Run: ${c.label}`);
      if (!m) continue;
      ranked.push({
        key: `qc${c.id}`, label: `Run: ${c.label}`, hint: c.action === "agent" ? "Quick prompt" : "Quick command", marks: m.marks, score: m.score,
        run: () => void runQuickCommand(c), icon: () => <Icon name={c.action === "agent" ? "chat" : "terminal"} size={14} />,
      });
    }
    return q ? ranked.sort((a, b) => b.score - a.score) : ranked;
  }

  const flat = createMemo(() => groups().flatMap((g) => g.items));
  // Results rebuild whenever any of 20 agents changes status: keep the highlight on the same
  // item (by key) so Enter never opens something the user did not pick. New queries start at
  // the top.
  let selKey: string | undefined;
  createEffect(() => (selKey = flat()[sel()]?.key));
  createEffect(on(flat, (items) => {
    const i = selKey ? items.findIndex((x) => x.key === selKey) : -1;
    setSel(i >= 0 ? i : 0);
  }, { defer: true }));
  createEffect(on([query, scope], () => setSel(0), { defer: true }));
  createEffect(() => list?.querySelector(`[data-index="${sel()}"]`)?.scrollIntoView({ block: "nearest" }));

  const choose = (item?: Item) => {
    if (!item) return;
    store.setOverlay(null);
    item.run();
  };

  const setScope = (id: SearchScope) => {
    const next = SCOPES.find((s) => s.id === id)!;
    setRaw(next.prefix + query());
    input.focus();
  };
  const cycleScope = (delta: number) => {
    const i = SCOPES.findIndex((s) => s.id === scope());
    setScope(SCOPES[(i + delta + SCOPES.length) % SCOPES.length].id);
  };

  const placeholder = () =>
    ({
      all: "Search sessions, projects, files, commands and settings…",
      sessions: "Jump to a session or project…",
      files: `Go to file in ${project()?.name ?? "project"}…`,
      commands: "Run a command…",
      settings: "Find a setting…",
    })[scope()];

  return (
    <div class="overlay" onPointerDown={(e) => e.target === e.currentTarget && store.setOverlay(null)}>
      <div class="palette">
        <div class="palette-input">
          <Icon name="search" size={15} />
          <input
            ref={input}
            placeholder={placeholder()}
            value={raw()}
            onInput={(e) => setRaw(e.currentTarget.value)}
            onKeyDown={(e) => {
              const n = flat().length;
              if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => (s + 1) % Math.max(1, n)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => (s - 1 + n) % Math.max(1, n)); }
              else if (e.key === "Enter") { e.preventDefault(); choose(flat()[sel()]); }
              else if (e.key === "Escape") { e.preventDefault(); store.setOverlay(null); }
              else if (e.key === "Tab") { e.preventDefault(); cycleScope(e.shiftKey ? -1 : 1); }
            }}
          />
        </div>
        <div class="scopes">
          <For each={SCOPES}>
            {(s) => (
              <button class={`scope${scope() === s.id ? " on" : ""}`} onPointerDown={(e) => { e.preventDefault(); setScope(s.id); }}>
                {s.label}{s.prefix ? <span class="pfx">{s.prefix}</span> : null}
              </button>
            )}
          </For>
        </div>
        <div class="items" ref={list}>
          <For each={groups()}>
            {(g) => (
              <>
                <div class="group">{g.title}</div>
                <For each={g.items}>
                  {(item) => {
                    const i = () => flat().indexOf(item);
                    return (
                      <div class={`item${i() === sel() ? " sel" : ""}`} data-index={i()} onPointerMove={() => setSel(i())} onClick={() => choose(item)}>
                        <Show when={item.icon}>{item.icon!()}</Show>
                        <span class="label"><Highlight text={item.label} marks={item.marks} /></span>
                        <Show when={item.hint}><span class="hint">{item.hint}</span></Show>
                        <Show when={item.chord}><span class="kbd">{item.chord}</span></Show>
                      </div>
                    );
                  }}
                </For>
              </>
            )}
          </For>
          <Show when={flat().length === 0}>
            <div class="muted">{scope() === "files" && !query() ? "Type to search files" : "No matches"}</div>
          </Show>
        </div>
        <KeyHints items={[["Enter", "Open"], ["Esc", "Close"], ["↑↓", "Move"], ["Tab", "Scope"]]} />
      </div>
    </div>
  );
}
