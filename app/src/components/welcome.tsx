import { For, Show } from "solid-js";
import { allLayouts } from "../lib/plugins";
import { store } from "../lib/store";
import { pickProjectFolder, chordOf, commands } from "../lib/commands";
import { chordLabel } from "../lib/platform";
import { KindGlyph } from "./icons";
import { TemplateThumb } from "./layout-menu";
import { templateKinds } from "../lib/layout";
import { kindInfo, presetFor, projectAgents } from "../lib/agents";
import { hostLabel } from "../lib/remote";
import type { Project, SessionKind } from "../lib/types";
import { t, msg } from "../lib/i18n";
import { openHosts } from "./hosts-page";
import { BrandWordmark, Kip } from "./brand";

const kbd = (id: string) => {
  const c = commands.find((x) => x.id === id);
  const k = c && chordOf(c);
  return k ? chordLabel(k) : "";
};

export function Welcome() {
  return (
    <div class="empty">
      <div class="welcome">
        <Kip mood="peek" size={150} />
        <h1><BrandWordmark height={34} /></h1>
        <div style={{ color: "var(--text-dim)" }}>
          {t("Run many coding agents across many projects. Sessions live in a background daemon, so switching projects or closing this window never stops them.")}
        </div>
        <div class="actions">
          <button class="btn primary" onClick={() => void pickProjectFolder()}>{t("Add project folder")}</button>
          <button class="btn" onClick={() => store.setOverlay("remote")}>{t("Add remote project (SSH)")}</button>
          <button class="btn" onClick={() => openHosts()}>{t("SSH hosts")}</button>
          <button class="btn" onClick={() => store.setOverlay("palette")}>{t("Command palette")} <span class="kbd">{kbd("palette")}</span></button>
        </div>
      </div>
    </div>
  );
}

const SUBTITLES: Record<string, string> = {
  claude: "Anthropic Claude Code CLI",
  codex: "OpenAI Codex CLI",
  omp: "oh-my-pi coding agent",
  shell: msg("Your default shell"),
};

/** Core agents, installed preset agents (Settings → Agents can hide them), then the shell. */
const choices = (project: Project): { kind: SessionKind; sub: string }[] =>
  [...projectAgents(project, store.state.settings.hiddenAgents), "shell"].map((kind) => ({ kind, sub: project.remote ? t("on {host}", { host: hostLabel(project) }) : SUBTITLES[kind] ? t(SUBTITLES[kind]) : t("{bin} CLI", { bin: presetFor(kind)?.bin ?? kind }) }));

/** Shown in a project with no tabs: one click starts an agent. */
export function Launcher(props: { project: Project }) {
  return (
    <div class="empty">
      <div class="welcome">
        <h1>{props.project.name}</h1>
        <div style={{ color: "var(--text-faint)", "font-family": "var(--font-mono)", "font-size": "12px" }}>{props.project.path}</div>
        <div class="launcher">
          <For each={choices(props.project)}>
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
        <Show when={allLayouts().length}>
          <div class="launcher-layouts">
            <div class="layout-menu-head">{t("Saved layouts")}</div>
            <For each={allLayouts()}>
              {(l) => (
                <button class="launch-card" onClick={() => void store.applyLayout(props.project.id, l.template)}>
                  <TemplateThumb template={l.template} size={34} />
                  <div style={{ "text-align": "left" }}>
                    <div>{l.name}</div>
                    <div class="sub">{templateKinds(l.template).map((k) => (k ? kindInfo(k).label : t("empty"))).join(" · ")}</div>
                  </div>
                </button>
              )}
            </For>
          </div>
        </Show>
        <div style={{ color: "var(--text-faint)", "font-size": "12px" }}>
          {t("New terminal")} <span class="kbd">{kbd("new.shell")}</span> · {t("Go to file")} <span class="kbd">{kbd("quickopen")}</span> · {t("Jump")} <span class="kbd">{kbd("jump")}</span>
        </div>
      </div>
    </div>
  );
}
