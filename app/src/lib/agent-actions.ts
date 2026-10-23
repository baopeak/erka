// Conversation upkeep for a running agent: compact or clear it with the agent's own slash
// commands (typed into its TUI, or sent through chat view), or restart its process on the same
// conversation. A long-lived TUI process grows heavy; a fresh one renders a small tree again.
import { store, sessionLabel } from "./store";
import { daemon } from "./ipc";
import { typeInto } from "./quick-commands";
import { confirmDialog } from "./confirm-dialog";
import { getController } from "../chat/mode-switch";
import { t } from "./i18n";
import type { SessionInfo } from "./types";

/** The agents' own commands (verified against each CLI's command list). */
const COMMANDS: Record<string, { compact: string; clear?: string }> = {
  claude: { compact: "/compact", clear: "/clear" },
  codex: { compact: "/compact", clear: "/new" },
  omp: { compact: "/compact" },
};

export const conversationCommands = (s: SessionInfo) => (s.alive ? COMMANDS[s.kind] : undefined);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function okToInterrupt(s: SessionInfo): Promise<boolean> {
  return s.status !== "working" || confirmDialog(t("{name} is working. Continue anyway?", { name: sessionLabel(s) }));
}

export async function runConversationCommand(s: SessionInfo, which: "compact" | "clear") {
  const cmd = COMMANDS[s.kind]?.[which];
  if (!cmd || !(await okToInterrupt(s))) return;
  if (s.chat) {
    // A chat not shown since the app started has no stream yet: show it, then send.
    const ctrl = getController(s);
    if (!ctrl.state.ready) store.revealSession(s.id);
    const end = Date.now() + 5000;
    while (!ctrl.state.ready && Date.now() < end) await sleep(100);
    if (!ctrl.state.ready) return store.notify(t("{name} is not ready yet.", { name: sessionLabel(s) }));
    ctrl.send(cmd);
  } else await typeInto(s, cmd, true, 250);
}

/** Stops the agent and starts it again on the same conversation, in the same pane. */
export async function restartKeepingConversation(s: SessionInfo) {
  if (!s.alive || !store.resumable(s) || !(await okToInterrupt(s))) return;
  await daemon("session.kill", { handle: s.handle }).catch(() => {});
  const end = Date.now() + 5000;
  while (store.sessions[s.id]?.alive && Date.now() < end) await sleep(100);
  if (store.sessions[s.id]?.alive) return store.notify(t("{name} did not stop.", { name: sessionLabel(s) }));
  await store.resumeSession(s.id);
}
