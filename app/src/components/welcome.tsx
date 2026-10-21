import { For } from "solid-js";
import { store } from "../lib/store";
import { pickProjectFolder, chordOf, commands } from "../lib/commands";
import { chordLabel } from "../lib/platform";
import { KindGlyph } from "./icons";
import { kindInfo, launchableAgents, presetFor } from "../lib/agents";
import type { Project, SessionKind } from "../lib/types";

const kbd = (id: string) => {
  const c = commands.find((x) => x.id === id);
  const k = c && chordOf(c);
  return k ? chordLabel(k) : "";
};

export function Welcome() {
  return (
    <div class="empty">
      <div class="welcome">
        <span class="brand-logo" style={{ width: "54px", height: "54px", "font-size": "26px", "border-radius": "15px" }}>E</span>
        <h1>Erka</h1>
        <div style={{ color: "var(--text-dim)" }}>
          Run many coding agents across many projects. Sessions live in a background daemon, so switching projects or closing this window never stops them.
        </div>
        <div class="actions">
          <button class="btn primary" onClick={() => void pickProjectFolder()}>Add project folder</button>
          <button class="btn" onClick={() => store.setOverlay("palette")}>Command palette <span class="kbd">{kbd("palette")}</span></button>
        </div>
      </div>
    </div>
  );
}

const SUBTITLES: Record<string, string> = {
  claude: "Anthropic Claude Code CLI",
  codex: "OpenAI Codex CLI",
  omp: "oh-my-pi coding agent",
  shell: "Your default shell",
};

/** Core agents, installed preset agents (Settings → Agents can hide them), then the shell. */
const choices = (): { kind: SessionKind; sub: string }[] =>
  [...launchableAgents(store.state.settings.hiddenAgents), "shell"].map((kind) => ({ kind, sub: SUBTITLES[kind] ?? `${presetFor(kind)?.bin ?? kind} CLI` }));

/** Shown in a project with no tabs: one click starts an agent. */
export function Launcher(props: { project: Project }) {
  return (
    <div class="empty">
      <div class="welcome">
        <h1>{props.project.name}</h1>
        <div style={{ color: "var(--text-faint)", "font-family": "var(--font-mono)", "font-size": "12px" }}>{props.project.path}</div>
        <div class="launcher">
          <For each={choices()}>
            {(c) => (
              <div class="launch-card" onClick={() => void store.newSession(props.project.id, c.kind)}>
                <KindGlyph kind={c.kind} size={34} />
                <div>
                  <div>{kindInfo(c.kind).label}</div>
                  <div class="sub">{c.sub}</div>
                </div>
              </div>
            )}
          </For>
        </div>
        <div style={{ color: "var(--text-faint)", "font-size": "12px" }}>
          New terminal <span class="kbd">{kbd("new.shell")}</span> · Go to file <span class="kbd">{kbd("quickopen")}</span> · Jump <span class="kbd">{kbd("jump")}</span>
        </div>
      </div>
    </div>
  );
}
