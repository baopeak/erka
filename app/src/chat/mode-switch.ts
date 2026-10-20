// Switching a session between its terminal UI (TUI) and Erka's chat view.
//
// Neither Claude Code, Codex nor OMP lets a second client drive a running TUI's
// conversation, so a switch is a hand-off of the *conversation*, not of the process:
//   1. find the agent-side conversation id (hooks, transcript dir, or thread/list),
//   2. stop the old process cleanly (Ctrl+C ×2, then kill) so it flushes its transcript and
//      we never have two writers on one conversation,
//   3. start the other front-end resuming that id, in the same pane.
import { ChatController, type Adapter, type AdapterContext } from "./chat-model";
import { applyClaudeMessage, claudeArgs, createClaudeAdapter } from "./claude-adapter";
import { codexArgs, createCodexAdapter } from "./codex-adapter";
import { createAcpAdapter, ompAcpArgs } from "./acp-adapter";
import { agentLatestSession, claudeTranscript, createSession, daemon, sendInput } from "../lib/ipc";
import { store } from "../lib/store";
import { disposeView } from "../lib/terminal-host";
import { uid } from "../lib/platform";
import type { Pane, Project, SessionInfo, SessionKind, Tab } from "../lib/types";

export const supportsChat = (kind: string) => kind === "claude" || kind === "codex" || kind === "omp";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Panes with a switch in flight (double clicks must not start two front-ends). */
const switching = new Set<string>();

/** Another live session of this agent in the same folder makes "newest conversation" ambiguous. */
function ambiguous(s: SessionInfo): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return Object.values(store.sessions).some((o) => o.id !== s.id && o.alive && o.kind === s.kind && norm(o.cwd) === norm(s.cwd));
}

async function stopProcess(s: SessionInfo, polite: () => Promise<void>): Promise<boolean> {
  if (!s.alive) return true;
  await polite();
  if (await waitExit(s.id, 3000)) return true;
  await daemon("session.kill", { handle: s.handle }).catch(() => {});
  return waitExit(s.id, 3000);
}

async function waitExit(sessionId: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const s = store.sessions[sessionId];
    if (!s || !s.alive) return true;
    await sleep(100);
  }
  return false;
}

function chatArgv(kind: SessionKind, resumeId: string | null): string[] {
  const profile = store.state.settings.profiles.find((p) => p.kind === kind)?.args ?? [];
  if (kind === "claude") return claudeArgs(resumeId, profile);
  if (kind === "codex") return codexArgs(profile);
  return ompAcpArgs();
}

const controllers = new Map<string, ChatController>();

/** One controller per chat session, kept across pane remounts (project switches). */
export function getController(s: SessionInfo): ChatController {
  let c = controllers.get(s.id);
  if (c) return c;
  const make = (ctx: AdapterContext): Adapter =>
    s.kind === "claude" ? createClaudeAdapter(ctx) : s.kind === "codex" ? createCodexAdapter(ctx) : createAcpAdapter(ctx);
  c = new ChatController(s.id, s.cwd, s.agent_session_id, make);
  if (s.kind === "claude" && s.agent_session_id) {
    const resumeId = s.agent_session_id;
    const createdAt = s.created_at;
    // History from before chat mode comes from Claude's own transcript; turns made in chat
    // mode are replayed from the daemon log, so only take lines older than this process.
    c.loadHistory = async (ctx) => {
      const lines = await claudeTranscript(resumeId, s.cwd).catch(() => []);
      const live = { msgId: null as string | null };
      for (const line of lines) {
        let m: any;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.timestamp && Date.parse(m.timestamp) >= createdAt) break;
        if (m.type === "user" || m.type === "assistant") applyClaudeMessage(ctx, m, live);
      }
      if (ctx.state.items.length) ctx.upsert({ kind: "system", id: "history-mark", text: "↑ earlier in this conversation · continued in chat view ↓", tone: "info" });
    };
  }
  controllers.set(s.id, c);
  return c;
}

export function disposeController(sessionId: string) {
  controllers.get(sessionId)?.detach();
  controllers.delete(sessionId);
}

/** Starts a conversation directly in chat mode: a new one, or `resume` (an agent conversation
 *  id) in that conversation's own folder `cwd`. */
export async function newChat(projectId: string, kind: SessionKind, where: "tab" | "right" | "down" = "tab", opts: { resume?: string; cwd?: string } = {}) {
  const project = store.state.projects.find((p) => p.id === projectId);
  if (!project) return;
  try {
    const resume = opts.resume ?? null;
    const info = await createSession({
      kind, cwd: opts.cwd ?? project.path, project_id: projectId,
      agent_session_id: resume ?? undefined,
      chat_argv: chatArgv(kind, kind === "claude" ? resume : null),
    });
    store.setSessions(info.id, info);
    store.placePane(projectId, { id: uid(), kind: "chat", sessionId: info.id }, where);
  } catch (e) {
    store.notify(`Could not start ${kind} chat: ${e}`);
  }
}

export async function switchToChat(project: Project, tab: Tab, pane: Pane) {
  if (switching.has(pane.id)) return;
  switching.add(pane.id);
  try {
    await doSwitchToChat(project, tab, pane);
  } finally {
    switching.delete(pane.id);
  }
}

async function doSwitchToChat(project: Project, tab: Tab, pane: Pane) {
  const s = pane.sessionId ? store.sessions[pane.sessionId] : undefined;
  if (!s || !supportsChat(s.kind)) return;
  if (s.alive && s.status === "working" && !confirm("The agent is working. Interrupt it and continue in chat view?")) return;
  let conv = s.agent_session_id;
  if (!conv && ambiguous(s)) {
    store.notify(`This ${s.kind} session has not reported its conversation id yet and other ${s.kind} sessions run in this folder — finish one turn first, then switch.`);
    return;
  }
  if (!conv && (s.kind === "claude" || s.kind === "omp")) conv = (await agentLatestSession(s.kind, s.cwd).catch(() => null))?.id ?? null;
  if (s.kind !== "codex" && !conv) {
    store.notify("No conversation to continue yet — starting a new chat.");
  }
  store.notify(`Switching ${s.kind} to chat view…`);
  const stopped = await stopProcess(s, async () => {
    await sendInput(s.handle, "\x03");
    await sleep(300);
    await sendInput(s.handle, "\x03");
  });
  if (!stopped) {
    store.notify("The terminal session did not stop; not starting a second writer.");
    return;
  }
  try {
    const info = await createSession({
      kind: s.kind, cwd: s.cwd, project_id: s.project_id ?? project.id, name: s.name ?? undefined,
      // Codex without a known thread id resumes the newest thread of this folder.
      agent_session_id: conv ?? (s.kind === "codex" ? "latest" : undefined),
      chat_argv: chatArgv(s.kind, s.kind === "claude" ? conv : null),
    });
    store.setSessions(info.id, info);
    store.replacePaneIn(project.id, tab.id, pane.id, { id: pane.id, kind: "chat", sessionId: info.id });
    disposeView(s.id);
    await daemon("session.close", { handle: s.handle }).catch(() => {});
  } catch (e) {
    store.notify(`Chat mode failed: ${e}`);
  }
}

export async function switchToTerminal(project: Project, tab: Tab, pane: Pane) {
  if (switching.has(pane.id)) return;
  switching.add(pane.id);
  try {
    await doSwitchToTerminal(project, tab, pane);
  } finally {
    switching.delete(pane.id);
  }
}

async function doSwitchToTerminal(project: Project, tab: Tab, pane: Pane) {
  const c = pane.sessionId ? store.sessions[pane.sessionId] : undefined;
  if (!c) return;
  const ctrl = controllers.get(c.id);
  if (ctrl?.state.busy && !confirm("The agent is working. Interrupt it and continue in the terminal?")) return;
  let conv = ctrl?.state.conversationId ?? c.agent_session_id;
  if (conv === "latest") conv = null;
  const stopped = await stopProcess(c, async () => {
    ctrl?.interrupt();
    await sleep(200);
    await daemon("chat.close_stdin", { handle: c.handle }).catch(() => {});
  });
  if (!stopped) {
    store.notify("The chat process did not stop; not starting a second writer.");
    return;
  }
  try {
    const info = await createSession({ kind: c.kind, cwd: c.cwd, project_id: c.project_id ?? project.id, name: c.name ?? undefined, agent_session_id: conv ?? undefined, cols: 120, rows: 32 });
    store.setSessions(info.id, info);
    store.replacePaneIn(project.id, tab.id, pane.id, { id: pane.id, kind: "terminal", sessionId: info.id });
    disposeController(c.id);
    await daemon("session.close", { handle: c.handle }).catch(() => {});
  } catch (e) {
    store.notify(`Terminal mode failed: ${e}`);
  }
}
