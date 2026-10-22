// Sending a prepared prompt (review notes, a hand-off, a failed commit) to an agent: one of
// the project's running agents, or a new session that starts with it.
import { store, sessionLabel } from "./store";
import { t } from "./i18n";
import { typeInto } from "./quick-commands";
import { getController } from "../chat/mode-switch";
import { isAgentKind, kindInfo, launchableAgents } from "./agents";
import { openContextMenu, type MenuItem } from "../components/context-menu";
import type { SessionInfo } from "./types";

/** Running agent sessions of a project, most recently active first. */
export function agentSessions(projectId: string): SessionInfo[] {
  return Object.values(store.sessions)
    .filter((s) => s.project_id === projectId && s.alive && isAgentKind(s.kind))
    .sort((a, b) => b.last_activity - a.last_activity);
}

export async function sendToSession(s: SessionInfo, text: string) {
  if (s.chat) await getController(s).send(text);
  else await typeInto(s, text, true, 250);
  store.revealSession(s.id);
}

/** Menu at the pointer: running agents first, then "New … session" for each launchable agent. */
export function chooseAgentAndSend(e: MouseEvent, projectId: string, text: string, onSent?: () => void) {
  const running: MenuItem[] = agentSessions(projectId).map((s) => ({
    label: t("Send to {name}", { name: sessionLabel(s) }),
    run: () => void sendToSession(s, text).then(onSent),
  }));
  const fresh: MenuItem[] = launchableAgents(store.state.settings.hiddenAgents).map((kind) => ({
    label: t("New {agent} session", { agent: kindInfo(kind).label }),
    run: () => void store.newSession(projectId, kind, { prompt: text }).then((s) => s && onSent?.()),
  }));
  openContextMenu(e, running.length ? [...running, null, ...fresh] : fresh);
}
