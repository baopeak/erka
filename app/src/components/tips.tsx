// First-run tips: at most one small popover per launch, next to the feature it explains.
// Dismissed tips are remembered; tips can be turned off for good.
import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { store } from "../lib/store";
import { chordOf, commands } from "../lib/commands";
import { chordLabel } from "../lib/platform";

interface Tip {
  id: string;
  /** Element the popover points at. */
  target: string;
  title: string;
  text: () => string;
}

const key = (id: string) => {
  const c = commands.find((x) => x.id === id);
  return c && chordOf(c) ? chordLabel(chordOf(c)!) : "";
};

const TIPS: Tip[] = [
  { id: "search", target: ".search-btn", title: "Search everything", text: () => `${key("palette")} finds sessions, projects, files, commands and settings. Start with @ # > or / to narrow it down.` },
  { id: "dashboard", target: "[data-tip=dashboard]", title: "Agent dashboard", text: () => `${key("dashboard")} shows every agent across projects, and which ones need you.` },
  { id: "chat", target: ".session-row", title: "Terminal or chat", text: () => "Right-click an agent session → Continue in chat view. The conversation carries over, and you can switch back any time." },
  { id: "history", target: ".panel-tabs", title: "Past conversations", text: () => "The Sessions tab lists earlier Claude, Codex and OMP conversations of this folder; resume any of them." },
];

const SHOW_AFTER_MS = 4000;

export function Tips() {
  const [tip, setTip] = createSignal<Tip | null>(null);
  const [pos, setPos] = createSignal({ left: 0, top: 0 });

  const place = (t: Tip) => {
    const el = document.querySelector(t.target);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const width = 280;
    // Right of the target when there is room (sidebar items), otherwise below it.
    const left = r.right + 12 + width < window.innerWidth ? r.right + 12 : Math.max(12, r.right - width);
    const top = r.right + 12 + width < window.innerWidth ? r.top : r.bottom + 8;
    setPos({ left, top: Math.min(top, window.innerHeight - 160) });
    return true;
  };

  const timer = window.setTimeout(() => {
    const s = store.state.settings;
    if (!s.tips || store.overlay() !== null) return;
    const next = TIPS.find((t) => !s.tipsSeen.includes(t.id) && place(t));
    if (next) setTip(next);
  }, SHOW_AFTER_MS);
  onCleanup(() => clearTimeout(timer));

  const dismiss = () => {
    const t = tip();
    if (t) store.setSettings({ tipsSeen: [...store.state.settings.tipsSeen, t.id] });
    setTip(null);
  };
  const onResize = () => tip() && !place(tip()!) && setTip(null);
  onMount(() => window.addEventListener("resize", onResize));
  onCleanup(() => window.removeEventListener("resize", onResize));

  return (
    <Show when={tip() && store.state.settings.tips && store.overlay() === null ? tip() : null}>
      {(t) => (
        <div class="tip" data-tip-id={t().id} style={{ left: `${pos().left}px`, top: `${pos().top}px` }}>
          <div class="tip-title">{t().title}</div>
          <div class="tip-text">{t().text()}</div>
          <div class="tip-actions">
            <button class="btn mini" onClick={() => { store.setSettings({ tips: false }); setTip(null); }}>Turn off tips</button>
            <span style={{ flex: 1 }} />
            <button class="btn mini primary" onClick={dismiss}>Got it</button>
          </div>
        </div>
      )}
    </Show>
  );
}
