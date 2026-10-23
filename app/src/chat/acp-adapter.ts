// Agent Client Protocol adapter (JSON-RPC 2.0 over stdio). Used for OMP (`omp acp`) and any
// ACP-native agent. We advertise no client fs/terminal capabilities so the agent uses its
// own tools, exactly like in its TUI. The agent lists its slash commands
// (`available_commands_update`, run by sending `/name args` as prompt text) and its settings
// (`configOptions`: mode, model, thought level) itself.
import { type Adapter, type AdapterContext, type ChatCommand, type ChatItem, type ToolCategory, putSetting, setSettingValue, summarize, textOf } from "./chat-model";
import { lineDiff, planStatus } from "./tool-view";
import { t } from "../lib/i18n";

/** ACP tool kinds → the transcript's categories. */
const KINDS: Record<string, ToolCategory> = { read: "read", search: "search", edit: "edit", delete: "edit", move: "edit", execute: "command", fetch: "fetch" };

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
  /** The config option that holds the session mode (for `current_mode_update`). */
  let modeOption: string | null = null;
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

  function applyConfig(options: any[] | undefined) {
    for (const o of options ?? []) {
      if (o.type !== "select" || !Array.isArray(o.options)) continue;
      // Options may come grouped ({group, options: [...]}); the picker lists them flat.
      const flat = o.options.flatMap((x: any) => (Array.isArray(x.options) ? x.options : [x]));
      putSetting(ctx, { id: o.id, label: o.name ?? o.id, value: o.currentValue ?? null, options: flat.map((x: any) => ({ value: x.value, label: x.name ?? x.value, description: x.description })) });
      if (o.category === "model") ctx.setModel(o.currentValue ?? null);
      if (o.category === "mode") modeOption = o.id;
    }
  }

  function toolContent(content: any[]): { output?: string; diff?: { path: string; text: string }[] } {
    const out: string[] = [];
    const diff: { path: string; text: string }[] = [];
    for (const c of content ?? []) {
      if (c.type === "content") out.push(textOf(c.content));
      else if (c.type === "diff") diff.push({ path: c.path, text: lineDiff(String(c.oldText ?? ""), String(c.newText ?? "")) });
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
        ctx.upsert({
          kind: "tool", id: u.toolCallId, name: u.title ?? u.kind ?? "tool", summary: summarize(u.locations?.[0]?.path ?? u.rawInput ?? ""), input: u.rawInput,
          category: KINDS[u.kind] ?? "other", status: u.status === "failed" ? "error" : u.status === "completed" ? "done" : "running", ...c,
        });
        break;
      }
      case "tool_call_update": {
        lastKind = null;
        const c = toolContent(u.content);
        ctx.patch(u.toolCallId, (i: any) => {
          if (u.title) i.name = u.title;
          if (u.kind) i.category = KINDS[u.kind] ?? "other";
          if (u.status) i.status = u.status === "failed" ? "error" : u.status === "completed" ? "done" : "running";
          if (c.output) i.output = c.output;
          if (c.diff) i.diff = c.diff;
          if (u.rawOutput && !c.output) i.output = typeof u.rawOutput === "string" ? u.rawOutput : JSON.stringify(u.rawOutput).slice(0, 4000);
        });
        break;
      }
      case "plan":
        // Each update is the whole plan: it replaces the last one.
        ctx.set("plan", { entries: (u.entries ?? []).map((e: any) => ({ text: String(e.content ?? ""), status: planStatus(e.status) })) });
        break;
      case "usage_update":
        if (typeof u.used === "number") ctx.set("usage", { used: u.used, size: typeof u.size === "number" ? u.size : null, cost: typeof u.cost?.amount === "number" ? u.cost.amount : undefined });
        break;
      case "current_mode_update":
        if (modeOption && u.currentModeId) setSettingValue(ctx, modeOption, u.currentModeId);
        break;
      case "available_commands_update":
        ctx.set("commands", (u.availableCommands ?? []).map((c: any): ChatCommand => ({ name: c.name, description: c.description, hint: c.input?.hint })));
        break;
      case "config_option_update":
        applyConfig(u.configOptions);
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
          applyConfig(m.result?.configOptions);
          lastKind = null;
          if (!ctx.replaying()) while (queued.length) prompt(queued.shift()!);
        } else if (Array.isArray(m.result?.configOptions)) {
          applyConfig(m.result.configOptions);
        } else if (m.result && "stopReason" in m.result) {
          lastKind = null;
          for (const it of ctx.state.items) if ((it as any).streaming) ctx.patch(it.id, (i: any) => (i.streaming = false));
          ctx.upsert({ kind: "result", id: `stop-${String(m.id)}`, text: m.result.stopReason });
          // Last: going idle sends the next queued message.
          ctx.set("busy", false);
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
      if (!sessionId) return;
      notify("session/cancel", { sessionId });
      // ACP: after a cancel the client answers every open permission request as cancelled,
      // or the agent may never end the turn.
      for (const [id, rid] of requests) {
        ctx.write({ jsonrpc: "2.0", id: rid, result: { outcome: { outcome: "cancelled" } } });
        ctx.patch(id, (i: any) => {
          if (i.kind === "permission" && !i.resolved) i.resolved = t("Cancelled");
        });
      }
      requests.clear();
    },
    setSetting(id, value) {
      if (sessionId) rpc(`kelpie-config-${++seq}`, "session/set_config_option", { sessionId, configId: id, value });
    },
    respond(id, option) {
      const rid = requests.get(id);
      if (rid === undefined) return;
      requests.delete(id);
      ctx.write({ jsonrpc: "2.0", id: rid, result: { outcome: { outcome: "selected", optionId: option } } });
    },
  };
}
