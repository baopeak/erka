import { For, Show, createEffect, createMemo, createSignal, on, onMount } from "solid-js";
import { store, sessionLabel } from "../lib/store";
import { chordOf, commands } from "../lib/commands";
import { chordLabel, relTime } from "../lib/platform";
import { quickOpen, type QuickOpenHit } from "../lib/ipc";
import { KindGlyph } from "./icons";
import { StatusDot } from "./sidebar";

type Mode = "palette" | "quickopen" | "jump";

interface Item {
  key: string;
  label: string;
  hint?: string;
  chord?: string;
  /** Highlighted char indices in label. */
  marks?: number[];
  icon?: () => any;
  run: () => void;
}

/** Simple subsequence fuzzy scorer for small in-memory lists (commands, sessions). */
function fuzzy(query: string, text: string): { score: number; marks: number[] } | null {
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

export function Palette(props: { mode: Mode }) {
  let input!: HTMLInputElement;
  let list!: HTMLDivElement;
  const [query, setQuery] = createSignal(props.mode === "palette" ? "" : "");
  const [sel, setSel] = createSignal(0);
  const [files, setFiles] = createSignal<QuickOpenHit[]>([]);
  const project = () => store.activeProject();
  onMount(() => input.focus());

  let seq = 0;
  createEffect(on(query, (q) => {
    if (props.mode !== "quickopen" || !project()) return;
    const mine = ++seq;
    void quickOpen(project()!.path, q).then((hits) => mine === seq && setFiles(hits)).catch(() => setFiles([]));
  }));

  const items = createMemo<Item[]>(() => {
    const q = query().trim();
    if (props.mode === "quickopen") {
      const p = project();
      return files().map((h) => ({
        key: h.path,
        label: h.path.split("/").pop()!,
        hint: h.path,
        marks: (() => {
          const offset = h.path.length - h.path.split("/").pop()!.length;
          return h.indices.filter((i) => i >= offset).map((i) => i - offset);
        })(),
        run: () => p && store.openFile(p.id, h.path),
      }));
    }
    if (props.mode === "jump") {
      const out: (Item & { score: number })[] = [];
      const order = { waiting: 0, working: 1, idle: 2, exited: 3 } as const;
      const sessions = Object.values(store.sessions).sort(
        (a, b) => (order[a.alive ? a.status : "exited"] - order[b.alive ? b.status : "exited"]) || Number(b.unread) - Number(a.unread) || b.created_at - a.created_at,
      );
      for (const s of sessions) {
        const proj = store.state.projects.find((p) => p.id === s.project_id);
        const label = sessionLabel(s);
        const m = fuzzy(q, `${label} ${proj?.name ?? ""}`);
        if (!m) continue;
        out.push({
          key: "s" + s.id, label, hint: `${proj?.name ?? "—"} · ${s.alive ? s.status : "exited"} · ${relTime(s.created_at)}`,
          marks: m.marks.filter((i) => i < label.length), score: m.score,
          icon: () => <><StatusDot s={s} /><KindGlyph kind={s.kind} size={16} /></>,
          run: () => store.revealSession(s.id),
        });
      }
      store.state.projects.forEach((p, i) => {
        const m = fuzzy(q, p.name);
        if (!m) return;
        out.push({
          key: "p" + p.id, label: p.name, hint: p.path, marks: m.marks, score: m.score - 1,
          chord: i < 9 ? `${i + 1}` : undefined,
          icon: () => <span class="project-swatch" style={{ background: p.color, width: "16px", height: "16px", "font-size": "9px" }}>{p.name[0]?.toUpperCase()}</span>,
          run: () => store.switchProject(p.id),
        });
      });
      return q ? out.sort((a, b) => b.score - a.score) : out;
    }
    const out: (Item & { score: number })[] = [];
    for (const c of commands) {
      if (c.when && !c.when()) continue;
      const m = fuzzy(q, c.label);
      if (!m) continue;
      const k = chordOf(c);
      out.push({ key: c.id, label: c.label, chord: k ? chordLabel(k) : undefined, marks: m.marks, score: m.score, run: c.run });
    }
    return q ? out.sort((a, b) => b.score - a.score) : out;
  });

  createEffect(on(items, () => setSel(0)));
  createEffect(() => {
    const el = list?.children[sel()] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  });

  const choose = (item?: Item) => {
    if (!item) return;
    store.setOverlay(null);
    item.run();
  };

  const placeholder = { palette: "Type a command…", quickopen: `Go to file in ${project()?.name ?? "project"}…`, jump: "Jump to a session or project…" }[props.mode];

  return (
    <div class="overlay" onPointerDown={(e) => e.target === e.currentTarget && store.setOverlay(null)}>
      <div class="palette">
        <input
          ref={input}
          placeholder={placeholder}
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            const n = items().length;
            if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => (s + 1) % Math.max(1, n)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => (s - 1 + n) % Math.max(1, n)); }
            else if (e.key === "Enter") { e.preventDefault(); choose(items()[sel()]); }
            else if (e.key === "Escape") { e.preventDefault(); store.setOverlay(null); }
          }}
        />
        <div class="items" ref={list}>
          <For each={items()}>
            {(item, i) => (
              <div class={`item${i() === sel() ? " sel" : ""}`} onPointerMove={() => setSel(i())} onClick={() => choose(item)}>
                <Show when={item.icon}>{item.icon!()}</Show>
                <span class="label"><Highlight text={item.label} marks={item.marks} /></span>
                <Show when={item.hint}><span class="hint">{item.hint}</span></Show>
                <Show when={item.chord}><span class="kbd">{item.chord}</span></Show>
              </div>
            )}
          </For>
          <Show when={items().length === 0}>
            <div class="muted">{props.mode === "quickopen" && !query() ? "Indexing…" : "No matches"}</div>
          </Show>
        </div>
      </div>
    </div>
  );
}
