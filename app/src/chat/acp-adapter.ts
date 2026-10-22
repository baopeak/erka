// Agent Client Protocol adapter (JSON-RPC 2.0 over stdio). Used for OMP (`omp acp`) and any
// ACP-native agent. We advertise no client fs/terminal capabilities so the agent uses its
// own tools, exactly like in its TUI.
import { type Adapter, type AdapterContext, type ChatItem, summarize, textOf } from "./chat-model";
import { t } from "../lib/i18n";

export const ompAcpArgs = () => ["omp", "acp"];

const INIT_ID = "kelpie-init";
const SESSION_ID = "kelpie-session";

export function createAcpAdapter(ctx: AdapterContext): Adapter {
  let initialized = false;
  let canLoad = false;
  let sessionId: string | null = null;
  let seq = 0;
  let lastKind: "assistant" | "thinking" | "user" | null = null;
  let lastId: string | null = null;
  const requests = new Map<string, unknown>();
  /** Prompts typed before the session was ready; sent once it is. */
  const queued: string[] = [];

  function prompt(text: string) {
    lastKind = null;
    ctx.set("busy", true);
    rpc(`kelpie-prompt-${++seq}-${Date.now()}`, "session/prompt", { sessionId, prompt: [{ type: "text", text }] });
  }

  const rpc = (id: string, method: string, params: unknown) => ctx.write({ jsonrpc: "2.0", id, method, params });
  const notify = (method: string, params: unknown) => ctx.write({ jsonrpc: "2.0", method, params });

  function openSession() {
    const resume = ctx.state.conversationId;
    if (resume && canLoad) rpc(SESSION_ID, "session/load", { sessionId: resume, cwd: ctx.cwd, mcpServers: [] });
    else rpc(SESSION_ID, "session/new", { cwd: ctx.cwd, mcpServers: [] });
  }

  function appendChunk(kind: "assistant" | "thinking" | "user", text: string) {
    if (lastKind === kind && lastId) {
      ctx.patch(lastId, (i: any) => (i.text += text));
      return;
    }
    lastKind = kind;
    lastId = `${kind}-${++seq}`;
    ctx.upsert({ kind, id: lastId, text, streaming: kind !== "user" } as ChatItem);
  }

  function toolContent(content: any[]): { output?: string; diff?: { path: string; text: string }[] } {
    const out: string[] = [];
    const diff: { path: string; text: string }[] = [];
    for (const c of content ?? []) {
      if (c.type === "content") out.push(textOf(c.content));
      else if (c.type === "diff") diff.push({ path: c.path, text: [...String(c.oldText ?? "").split("\n").map((l: string) => "-" + l), ...String(c.newText ?? "").split("\n").map((l: string) => "+" + l)].join("\n") });
    }
    return { output: out.join("\n") || undefined, diff: diff.length ? diff : undefined };
  }

  function onUpdate(u: any) {
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        appendChunk("assistant", textOf(u.content));
        break;
      case "agent_thought_chunk":
        appendChunk("thinking", textOf(u.content));
        break;
      case "user_message_chunk":
        appendChunk("user", textOf(u.content));
        break;
      case "tool_call": {
        lastKind = null;
        const c = toolContent(u.content);
        ctx.upsert({ kind: "tool", id: u.toolCallId, name: u.title ?? u.kind ?? "tool", summary: summarize(u.rawInput ?? u.locations?.[0]?.path ?? ""), input: u.rawInput, status: u.status === "failed" ? "error" : u.status === "completed" ? "done" : "running", ...c });
        break;
      }
      case "tool_call_update": {
        lastKind = null;
        const c = toolContent(u.content);
        ctx.patch(u.toolCallId, (i: any) => {
          if (u.title) i.name = u.title;
          if (u.status) i.status = u.status === "failed" ? "error" : u.status === "completed" ? "done" : "running";
          if (c.output) i.output = c.output;
          if (c.diff) i.diff = c.diff;
          if (u.rawOutput && !c.output) i.output = typeof u.rawOutput === "string" ? u.rawOutput : JSON.stringify(u.rawOutput).slice(0, 4000);
        });
        break;
      }
      case "plan":
        lastKind = null;
        ctx.upsert({ kind: "thinking", id: `plan-${++seq}`, text: (u.entries ?? []).map((e: any) => `${e.status === "completed" ? "☑" : "☐"} ${e.content}`).join("\n") });
        break;
    }
  }

  return {
    reset() {
      initialized = false;
      canLoad = false;
      sessionId = null;
      lastKind = null;
      requests.clear();
    },
    start() {
      if (!initialized) rpc(INIT_ID, "initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
      else if (!sessionId) openSession();
    },
    onMessage(m) {
      if (!m || typeof m !== "object") return;
      if ("id" in m && !("method" in m)) {
        if (m.error) {
          ctx.upsert({ kind: "system", id: `e-${String(m.id)}`, text: t("Agent: {error}", { error: String(m.error.message ?? JSON.stringify(m.error)) }), tone: "error" });
          if (String(m.id).startsWith("kelpie-prompt-")) ctx.set("busy", false);
          if (m.id === SESSION_ID && ctx.state.conversationId && !ctx.replaying()) {
            ctx.set("conversationId", null);
            openSession();
          }
          return;
        }
        if (m.id === INIT_ID) {
          initialized = true;
          canLoad = !!m.result?.agentCapabilities?.loadSession;
          if (!ctx.replaying()) openSession();
        } else if (m.id === SESSION_ID) {
          sessionId = m.result?.sessionId ?? ctx.state.conversationId;
          if (sessionId) ctx.setConversation(sessionId);
          lastKind = null;
          if (!ctx.replaying()) while (queued.length) prompt(queued.shift()!);
        } else if (m.result && "stopReason" in m.result) {
          ctx.set("busy", false);
          lastKind = null;
          for (const it of ctx.state.items) if ((it as any).streaming) ctx.patch(it.id, (i: any) => (i.streaming = false));
          ctx.upsert({ kind: "result", id: `stop-${String(m.id)}`, text: m.result.stopReason });
        }
        return;
      }
      if (m.method === "session/update") return onUpdate(m.params?.update ?? {});
      if (m.method === "session/request_permission" && "id" in m) {
        const id = `perm-${String(m.id)}`;
        requests.set(id, m.id);
        const tc = m.params?.toolCall ?? {};
        ctx.upsert({
          kind: "permission", id, title: tc.title ? t("Allow: {title}?", { title: String(tc.title) }) : t("Allow this action?"),
          detail: summarize(tc.rawInput ?? "", 600),
          options: (m.params?.options ?? []).map((o: any) => ({ id: o.optionId, label: o.name, tone: String(o.kind).startsWith("allow") ? "allow" : "deny" })),
        });
        return;
      }
      if ("id" in m && "method" in m) {
        // Unsupported client method: tell the agent rather than leaving it hanging.
        if (!ctx.replaying()) ctx.write({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Kelpie does not implement ${m.method}` } });
      }
    },
    send(text) {
      ctx.upsert({ kind: "user", id: `local-${Date.now()}`, text });
      if (!sessionId) {
        queued.push(text);
        ctx.set("busy", true);
        return;
      }
      prompt(text);
    },
    interrupt() {
      if (sessionId) notify("session/cancel", { sessionId });
    },
    respond(id, option) {
      const rid = requests.get(id);
      if (rid === undefined) return;
      requests.delete(id);
      ctx.write({ jsonrpc: "2.0", id: rid, result: { outcome: { outcome: "selected", optionId: option } } });
    },
  };
}
