// Saved commands/prompts: typed into the focused shell (or a new one), or sent as a prompt to
// the focused agent session.
import { store } from "./store";
import { sendInput } from "./ipc";
import { allPanes } from "./layout";
import { getController } from "../chat/mode-switch";
import type { QuickCommand, SessionInfo } from "./types";

export function quickCommandsFor(projectId: string | null): QuickCommand[] {
  return (store.state.settings.quickCommands ?? []).filter((c) => !c.projectId || c.projectId === projectId);
}

function focusedSession(): SessionInfo | undefined {
  const p = store.state.activeProject;
  const tab = p ? store.activeTab(p) : undefined;
  const pane = tab && allPanes(tab.root).find((x) => x.id === tab.focus);
  return pane?.sessionId ? store.sessions[pane.sessionId] : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function typeInto(s: SessionInfo, text: string, enter: boolean, paste: boolean) {
  // Agent TUIs submit on a bare newline; bracketed paste keeps a multi-line prompt together.
  await sendInput(s.handle, paste && text.includes("\n") ? `\x1b[200~${text}\x1b[201~` : text);
  if (enter) {
    await sleep(80); // let the TUI finish handling the paste before Enter
    await sendInput(s.handle, "\r");
  }
}

export async function runQuickCommand(c: QuickCommand) {
  const project = store.activeProject();
  if (!project) return store.notify("Open a project first");
  const s = focusedSession();
  if (c.action === "agent") {
    if (!s?.alive || s.kind === "shell" || s.kind === "custom") return store.notify(`Focus an agent session to send "${c.label}"`);
    if (s.chat) return getController(s).send(c.text);
    return typeInto(s, c.text, c.enter, true);
  }
  let target = s?.alive && s.kind === "shell" && !s.chat ? s : undefined;
  // No shell focused: open one. The PTY buffers input until the shell reads it.
  target ??= await store.newSession(project.id, "shell");
  if (target) await typeInto(target, c.text, c.enter, false);
}
