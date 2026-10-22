// Agent CLIs Kelpie can launch. The daemon owns the table (crates/kelpied/src/agents.rs PRESETS)
// and reports which are installed; the UI adds glyphs and decides what launchers show.
import { createSignal } from "solid-js";
import { daemon } from "./ipc";
import { msg, t } from "./i18n";

export interface AgentPreset {
  id: string;
  label: string;
  bin: string;
  /** Flags that skip permission prompts (Settings → Agents → Permissions: Yolo). */
  yolo: string[];
  /** Restart continues the folder's latest conversation. */
  resume_latest: boolean;
  installed: boolean;
}

/** Always offered: Kelpie integrates them deeply (hooks, chat view, history). */
export const CORE_AGENTS = ["claude", "codex", "omp"];

const [presets, setPresets] = createSignal<AgentPreset[]>([]);
export { presets as agentPresets };

export async function loadAgentPresets() {
  try {
    setPresets(await daemon<AgentPreset[]>("agent.presets"));
  } catch {
    /* older daemon: core agents only */
  }
}

export const presetFor = (kind: string) => presets().find((p) => p.id === kind);

const BUILTIN: Record<string, { glyph: string; color: string; label: string }> = {
  shell: { glyph: ">_", color: "#9aa4b5", label: msg("Terminal") },
  claude: { glyph: "✳", color: "#e8a27c", label: "Claude Code" },
  codex: { glyph: "◎", color: "#8fc8ff", label: "Codex" },
  omp: { glyph: "π", color: "#c592ff", label: "OMP" },
  custom: { glyph: "$", color: "#8bd58b", label: msg("Command") },
  gemini: { glyph: "✦", color: "#8ab4f8", label: "Gemini" },
  cursor: { glyph: "▲", color: "#d0d4dc", label: "Cursor CLI" },
  opencode: { glyph: "◇", color: "#f2c96d", label: "OpenCode" },
  copilot: { glyph: "◉", color: "#a8b3ff", label: "GitHub Copilot" },
};

const HUES = ["#5fd7d7", "#ffb86c", "#ff8f9c", "#a8e6a1", "#d7b0ff", "#87e8e8", "#ffdd8a"];

/** Glyph, colour and label for any session kind. */
export function kindInfo(kind: string): { glyph: string; color: string; label: string } {
  const known = BUILTIN[kind];
  if (known) return { ...known, label: t(known.label) };
  const p = presetFor(kind);
  const label = p?.label ?? kind;
  let h = 0;
  for (const c of kind) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { glyph: label.charAt(0).toUpperCase(), color: HUES[h % HUES.length], label };
}

/** Short name for session titles ("Claude", not "Claude Code"). */
export function kindShortName(kind: string): string {
  return ({ shell: t("Terminal"), claude: "Claude", codex: "Codex", omp: "OMP", custom: t("Command") } as Record<string, string>)[kind] ?? kindInfo(kind).label;
}

export const isAgentKind = (kind: string) => kind !== "shell" && kind !== "custom";

/** Agents for a project's launchers: on a remote host, the ones found there. */
export function projectAgents(project: { remote?: { agents?: string[] } } | null | undefined, hidden: string[] = []): string[] {
  if (project?.remote) return (project.remote.agents ?? CORE_AGENTS).filter((k) => !hidden.includes(k));
  return launchableAgents(hidden);
}

/** Agents for launchers: the core three plus installed presets the user has not hidden. */
export function launchableAgents(hidden: string[] = []): string[] {
  const extra = presets().filter((p) => p.installed && !CORE_AGENTS.includes(p.id) && !hidden.includes(p.id)).map((p) => p.id);
  return [...CORE_AGENTS.filter((k) => !hidden.includes(k)), ...extra];
}
