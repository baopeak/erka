// Status-bar meters: Claude / Codex subscription windows (5 h, week) and Erka's memory use.
import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { store } from "../lib/store";
import { daemon, memoryStats, onEvent, usageFetch } from "../lib/ipc";
import { KindGlyph } from "./icons";
import type { MemoryStats, ProviderUsage, UsageReport, UsageWindow } from "../lib/types";

const USAGE_EVERY = 5 * 60_000;
/** Clicks refresh at most this often: the usage endpoints are strictly rate limited. */
const USAGE_MIN_GAP = 30_000;
const MEMORY_EVERY = 5_000;

/** Runs `fn` now and every `ms` while the window is visible. */
function poll(fn: () => void, ms: number) {
  let timer = 0;
  const tick = () => {
    if (!document.hidden) fn();
    timer = window.setTimeout(tick, ms);
  };
  onMount(tick);
  onCleanup(() => clearTimeout(timer));
}

const level = (pct: number) => (pct >= 100 ? " full" : pct >= 80 ? " high" : "");

function resetText(at: number | null): string {
  if (!at) return "";
  const mins = Math.max(0, Math.round((at - Date.now()) / 60_000));
  const rel = mins < 60 ? `${mins}m` : mins < 48 * 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${Math.round(mins / 1440)}d`;
  return `resets in ${rel} (${new Date(at).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })})`;
}

/** One toast per window and reset period when a limit is reached. */
const warned = new Set<string>();

/** What a meter shows: the latest windows, or the last good ones when a refresh failed. */
type Shown = ProviderUsage & { stale?: string; at?: number };
type ProviderId = "claude" | "codex";

/** Last successful windows per provider, kept across launches: a failed refresh (rate limit,
 *  network) keeps showing them, marked stale, instead of a bare "!". */
const CACHE_KEY = "erka-usage";
const CACHE_MAX_AGE = 12 * 3600_000;
type Cache = Partial<Record<ProviderId, { windows: UsageWindow[]; at: number }>>;

function loadCache(): Cache {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function saveCache(c: Cache) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(c));
  } catch {
    /* storage unavailable: only this session remembers */
  }
}

function shown(fresh: ProviderUsage | null, cached: Cache[ProviderId]): Shown | null {
  if (fresh?.windows.length) return fresh;
  const usable = cached && Date.now() - cached.at < CACHE_MAX_AGE;
  if (usable && (!fresh || (fresh.error && !fresh.error.startsWith("not signed in")))) {
    return { windows: cached.windows, error: null, stale: fresh?.error ?? "not refreshed yet", at: cached.at };
  }
  return fresh;
}

function Provider(props: { kind: ProviderId; name: string; usage: Shown | null }) {
  const u = (): Shown => props.usage ?? { windows: [], error: null };
  const title = () => {
    if (u().error) return `${props.name} usage: ${u().error}`;
    const lines = u().windows.map((w) => `${w.label}: ${Math.round(w.used_percent)}% ${resetText(w.resets_at)}`);
    const stale = u().stale ? `\nLast refresh failed (${u().stale}); showing data from ${new Date(u().at!).toLocaleTimeString()}.` : "";
    return `${props.name} usage\n${lines.join("\n")}${stale}`;
  };
  return (
    <Show when={u().windows.length || (u().error && !u().error!.startsWith("not signed in"))}>
      <span class={`item meter${u().stale ? " stale" : ""}`} title={title()} data-provider={props.kind}>
        <KindGlyph kind={props.kind} size={12} />
        <Show when={!u().error} fallback={<span class="meter-err">!</span>}>
          <For each={u().windows}>
            {(w: UsageWindow) => (
              <span class={`meter-win${level(w.used_percent)}`}>
                <span class="meter-label">{w.label}</span>
                <span class="meter-bar"><span style={{ width: `${Math.min(100, w.used_percent)}%` }} /></span>
                {Math.round(w.used_percent)}%
              </span>
            )}
          </For>
        </Show>
      </span>
    </Show>
  );
}

export function UsageMeters() {
  const cache = loadCache();
  const [report, setReport] = createSignal<UsageReport | null>(null);
  const view = (p: ProviderId) => shown(report()?.[p] ?? null, cache[p]);
  let last = 0;
  const refresh = () => {
    if (Date.now() - last < USAGE_MIN_GAP) return;
    last = Date.now();
    fetchUsage();
  };
  const fetchUsage = () =>
    void usageFetch()
      .then((r) => {
        for (const p of ["claude", "codex"] as const) if (r[p].windows.length) cache[p] = { windows: r[p].windows, at: Date.now() };
        saveCache(cache);
        setReport(r);
        for (const [name, u] of [["Claude", r.claude], ["Codex", r.codex]] as const) {
          for (const w of u.windows) {
            const key = `${name}:${w.label}:${w.resets_at ?? ""}`;
            if (w.used_percent >= 100 && !warned.has(key)) {
              warned.add(key);
              store.notify(`${name} ${w.label} limit reached — ${resetText(w.resets_at)}`, undefined, 8000);
            }
          }
        }
      })
      .catch(() => {});
  poll(refresh, USAGE_EVERY);
  return (
    <Show when={view("claude") || view("codex")}>
      <span class="meters clickable" onClick={refresh} title="Click to refresh">
        <Provider kind="claude" name="Claude" usage={view("claude")} />
        <Provider kind="codex" name="Codex" usage={view("codex")} />
      </span>
    </Show>
  );
}

const gb = (b: number) => (b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(1)} GB` : `${Math.round(b / (1 << 20))} MB`);

export function MemoryMeter() {
  const [stats, setStats] = createSignal<MemoryStats | null>(null);
  let daemonPid: number | null = null;
  // Any (re)connection may be to a different daemon process.
  const unlisten = onEvent("daemon-status", () => (daemonPid = null));
  onCleanup(() => void unlisten.then((f) => f()));
  const refresh = async () => {
    if (daemonPid === null && store.connected()) daemonPid = (await daemon<{ pid: number }>("daemon.info").catch(() => null))?.pid ?? null;
    setStats(await memoryStats(daemonPid).catch(() => null));
  };
  poll(() => void refresh(), MEMORY_EVERY);
  const total = () => (stats() ? stats()!.app + stats()!.daemon + stats()!.sessions : 0);
  return (
    <Show when={stats()}>
      <span
        class="item"
        data-meter="memory"
        title={`Memory\nErka app + WebView: ${gb(stats()!.app)}\nSession daemon: ${gb(stats()!.daemon)}\nSessions (${stats()!.session_processes} processes): ${gb(stats()!.sessions)}`}
      >
        RAM {gb(total())}
      </span>
    </Show>
  );
}
