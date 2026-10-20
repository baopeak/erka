// Small inline SVG icon set (stroke icons, 16px grid) — no icon font, no network.
import type { JSX } from "solid-js";

// Factories, not elements: a Solid JSX element is a real DOM node and can live in one place only.
const paths: Record<string, () => JSX.Element> = {
  plus: () => <path d="M8 3v10M3 8h10" />,
  close: () => <path d="M4 4l8 8M12 4l-8 8" />,
  terminal: () => <><path d="M3 4.5l3.5 3.5L3 11.5" /><path d="M8.5 12h4.5" /></>,
  files: () => <><path d="M3 2.5h6l3 3v8H3z" /><path d="M9 2.5v3h3" /></>,
  git: () => <><circle cx="4.5" cy="4" r="1.5" /><circle cx="4.5" cy="12" r="1.5" /><circle cx="11.5" cy="6" r="1.5" /><path d="M4.5 5.5v5M11.5 7.5c0 2.5-3 2.5-6.2 3.6" /></>,
  search: () => <><circle cx="7" cy="7" r="4" /><path d="M10 10l3.5 3.5" /></>,
  dashboard: () => <><rect x="2.5" y="2.5" width="4.5" height="5.5" rx="1" /><rect x="9" y="2.5" width="4.5" height="3.5" rx="1" /><rect x="9" y="8" width="4.5" height="5.5" rx="1" /><rect x="2.5" y="10" width="4.5" height="3.5" rx="1" /></>,
  settings: () => <><circle cx="8" cy="8" r="2" /><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6L5 5M11 11l1.4 1.4M3.6 12.4L5 11M11 5l1.4-1.4" /></>,
  splitRight: () => <><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M8 3v10" /></>,
  splitDown: () => <><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M2.5 8h11" /></>,
  chevronRight: () => <path d="M6 4l4 4-4 4" />,
  chevronDown: () => <path d="M4 6l4 4 4-4" />,
  folder: () => <path d="M2 4.5h4l1.5 1.5H14v6.5H2z" />,
  sidebar: () => <><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M6 3v10" /></>,
  refresh: () => <><path d="M13 8a5 5 0 1 1-1.5-3.6" /><path d="M13 2.5v3h-3" /></>,
  chat: () => <path d="M3 3.5h10v7H7l-3 2.5v-2.5H3z" />,
  check: () => <path d="M3.5 8.5l3 3 6-7" />,
  minus: () => <path d="M4 8h8" />,
  undo: () => <><path d="M5 6.5H10a3 3 0 0 1 0 6H6" /><path d="M7 4L4.5 6.5 7 9" /></>,
  restart: () => <><path d="M3 8a5 5 0 1 0 1.5-3.6" /><path d="M3 2.5v3h3" /></>,
  stop: () => <rect x="4" y="4" width="8" height="8" rx="1.5" />,
  more: () => <><circle cx="4" cy="8" r=".8" /><circle cx="8" cy="8" r=".8" /><circle cx="12" cy="8" r=".8" /></>,
  up: () => <path d="M4 10l4-4 4 4" />,
  down: () => <path d="M4 6l4 4 4-4" />,
  maximize: () => <path d="M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3" />,
  minimize: () => <path d="M6 3v3H3M10 3v3h3M13 10h-3v3M3 10h3v3" />,
  history: () => <><path d="M3 8a5 5 0 1 0 1.5-3.6" /><path d="M3 2.5v3h3" /><path d="M8 5.5V8l2 1.5" /></>,
  back: () => <path d="M9.5 4L5.5 8l4 4" />,
  forward: () => <path d="M6.5 4l4 4-4 4" />,
  bolt: () => <path d="M9 2L4 9h4l-1 5 5-7H8z" />,
  board: () => <><rect x="2.5" y="3" width="3" height="10" rx="1" /><rect x="6.5" y="3" width="3" height="7" rx="1" /><rect x="10.5" y="3" width="3" height="5" rx="1" /></>,
  branch: () => <><circle cx="5" cy="4" r="1.5" /><circle cx="5" cy="12" r="1.5" /><circle cx="11" cy="5" r="1.5" /><path d="M5 5.5v5M11 6.5c0 3-6 2-6 4" /></>,
  filter: () => <path d="M2.5 3.5h11l-4.5 5v4l-2 1v-5z" />,
};

export function Icon(props: { name: keyof typeof paths | string; size?: number }) {
  const s = () => props.size ?? 16;
  return (
    <svg width={s()} height={s()} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
      {paths[props.name]?.()}
    </svg>
  );
}

export function KindGlyph(props: { kind: string; size?: number }) {
  const meta = () => kindMeta[props.kind] ?? kindMeta.custom;
  const size = () => props.size ?? 18;
  return (
    <span
      style={{ width: `${size()}px`, height: `${size()}px`, "border-radius": "5px", background: meta().color, color: "#0b0d12", display: "inline-grid", "place-items": "center", "font-size": `${Math.round(size() * 0.5)}px`, "font-weight": 700, flex: "none" }}
    >
      {meta().glyph}
    </span>
  );
}

export const kindMeta: Record<string, { glyph: string; color: string; label: string }> = {
  shell: { glyph: ">_", color: "#9aa4b5", label: "Terminal" },
  claude: { glyph: "✳", color: "#e8a27c", label: "Claude Code" },
  codex: { glyph: "◎", color: "#8fc8ff", label: "Codex" },
  omp: { glyph: "π", color: "#c592ff", label: "OMP" },
  custom: { glyph: "$", color: "#8bd58b", label: "Command" },
};
