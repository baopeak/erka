// Saved commands/prompts: typed into the focused shell (or a new one), or sent as a prompt to
// the focused agent session.
import { store } from "./store";
import { sendInput } from "./ipc";
import { allPanes } from "./layout";
import { peekView } from "./terminal-host";
import { getController } from "../chat/mode-switch";
import type { QuickCommand, SessionInfo } from "./types";

/** Commands for a project: global ones, its own, and ones whose project was removed. */
export function quickCommandsFor(projectId: string | null): QuickCommand[] {
  const known = new Set(store.state.projects.map((p) => p.id));
  return (store.state.settings.quickCommands ?? []).filter((c) => !c.projectId || c.projectId === projectId || !known.has(c.projectId));
}

function focusedSession(): SessionInfo | undefined {
  const p = store.state.activeProject;
  const tab = p ? store.activeTab(p) : undefined;
  const pane = tab && allPanes(tab.root).find((x) => x.id === tab.focus);
  return pane?.sessionId ? store.sessions[pane.sessionId] : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Delivers `text` like a real paste: xterm adds bracketed-paste markers only when the program
 *  asked for them and turns newlines into Enter keys, exactly as when the user pastes. */
async function typeInto(s: SessionInfo, text: string, enter: boolean, enterDelay: number) {
  const view = peekView(s.id);
  // A view between attachments (e.g. during a daemon reconnect) would drop the paste.
  if (view?.handle != null) view.paste(text);
  else await sendInput(s.handle, text.replace(/\r?\n/g, "\r"));
  if (!enter) return;
  // Agent TUIs treat Enter that follows a burst of input as part of the paste (Codex: within
  // 120 ms) and insert a newline instead of submitting.
  await sleep(enterDelay);
  await sendInput(s.handle, "\r");
}

export async function runQuickCommand(c: QuickCommand) {
  const project = store.activeProject();
  if (!project) return store.notify("Open a project first");
  const s = focusedSession();
  if (c.action === "agent") {
    if (!s?.alive || s.kind === "shell" || s.kind === "custom") return store.notify(`Focus an agent session to send "${c.label}"`);
    if (s.chat) return getController(s).send(c.text);
    return typeInto(s, c.text, c.enter, 250);
  }
  let target = s?.alive && s.kind === "shell" && !s.chat ? s : undefined;
  // No shell focused: open one. The PTY buffers input until the shell reads it.
  target ??= await store.newSession(project.id, "shell");
  if (target) await typeInto(target, c.text, c.enter, 60);
}
