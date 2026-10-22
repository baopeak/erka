// Codex `app-server` adapter (JSON-RPC over stdio, no "jsonrpc" field on the wire).
// Shapes follow `codex app-server generate-json-schema` (v2 protocol, codex-cli 0.158).
import { type Adapter, type AdapterContext, textOf } from "./chat-model";
import { t } from "../lib/i18n";

/** `codex app-server` accepts `-c key=value` overrides; translate the TUI's `--model X`. */
export function codexArgs(profile: string[] = []): string[] {
  const out = ["codex", "app-server"];
  for (let i = 0; i < profile.length; i++) {
    const a = profile[i];
    if ((a === "--model" || a === "-m") && profile[i + 1]) out.push("-c", `model="${profile[++i]}"`);
    else if (a.startsWith("--model=")) out.push("-c", `model="${a.slice(8)}"`);
    else if ((a === "-c" || a === "--config") && profile[i + 1]) out.push("-c", profile[++i]);
  }
  return out;
}

const INIT_ID = "erka-init";
const THREAD_ID = "erka-thread";
const LIST_ID = "erka-list";

export function createCodexAdapter(ctx: AdapterContext): Adapter {
  let initialized = false;
  let threadReady = false;
  let threadId: string | null = null;
  let turnId: string | null = null;
  let seq = 0;
  const approvals = new Map<string, { id: unknown; method: string }>();
  /** Prompts typed before the thread was ready; sent once it is. */
  const queued: string[] = [];

  function startTurn(text: string) {
    ctx.set("busy", true);
    request(`erka-turn-${++seq}-${Date.now()}`, "turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }] });
  }

  const request = (id: string, method: string, params: unknown) => ctx.write({ id, method, params });

  /** `latest` (switching from a TUI whose thread id we never saw) = newest thread in cwd. */
  function openThread(id: string | null) {
    if (id === "latest") request(LIST_ID, "thread/list", { cwd: ctx.cwd, limit: 1 });
    else if (id) request(THREAD_ID, "thread/resume", { threadId: id });
    else request(THREAD_ID, "thread/start", { cwd: ctx.cwd });
  }

  function renderItem(item: any, done: boolean) {
    if (!item?.id) return;
    switch (item.type) {
      case "userMessage":
        ctx.upsert({ kind: "user", id: item.id, text: textOf((item.content ?? []).filter((c: any) => c.type === "text")) });
        break;
      case "agentMessage":
        ctx.upsert({ kind: "assistant", id: item.id, text: item.text ?? "", streaming: !done });
        break;
      case "reasoning": {
        const text = [...(item.summary ?? []), ...(item.content ?? [])].map((s: any) => (typeof s === "string" ? s : s?.text ?? "")).join("\n");
        if (text) ctx.upsert({ kind: "thinking", id: item.id, text, streaming: !done });
        break;
      }
      case "plan":
        ctx.upsert({ kind: "thinking", id: item.id, text: item.text ?? "" });
        break;
      case "commandExecution": {
        const cmd = Array.isArray(item.command) ? item.command.join(" ") : String(item.command ?? "");
        const prev = ctx.find(item.id);
        ctx.upsert({
          kind: "tool", id: item.id, name: "Shell", summary: cmd,
          output: item.aggregatedOutput ?? (prev?.kind === "tool" ? prev.output : undefined),
          status: !done ? "running" : item.exitCode && item.exitCode !== 0 ? "error" : item.status === "failed" || item.status === "declined" ? "error" : "done",
        });
        break;
      }
      case "fileChange": {
        const changes: any[] = item.changes ?? [];
        ctx.upsert({
          kind: "tool", id: item.id, name: "Edit", summary: changes.map((c) => c.path).join(", "),
          status: !done ? "running" : item.status === "failed" || item.status === "declined" ? "error" : "done",
          diff: changes.map((c) => ({ path: c.path, text: c.diff ?? c.unified_diff ?? "" })),
        });
        break;
      }
      case "mcpToolCall":
      case "dynamicToolCall":
        ctx.upsert({
          kind: "tool", id: item.id, name: `${item.server ? item.server + "." : ""}${item.tool}`, summary: JSON.stringify(item.arguments ?? {}).slice(0, 120),
          output: item.result ? JSON.stringify(item.result).slice(0, 4000) : item.error ? String(item.error?.message ?? item.error) : undefined,
          status: !done ? "running" : item.error ? "error" : "done",
        });
        break;
      case "webSearch":
        ctx.upsert({ kind: "tool", id: item.id, name: "WebSearch", summary: item.query ?? "", status: done ? "done" : "running" });
        break;
      case "contextCompaction":
        ctx.upsert({ kind: "system", id: item.id, text: t("Context compacted"), tone: "info" });
        break;
    }
  }

  function renderTurns(turns: any[]) {
    for (const t of turns ?? []) for (const item of t.items ?? []) renderItem(item, true);
  }

  return {
    reset() {
      initialized = false;
      threadReady = false;
      threadId = null;
      turnId = null;
      approvals.clear();
    },
    start() {
      if (!initialized) {
        request(INIT_ID, "initialize", { clientInfo: { name: "erka", title: "Erka", version: "0.1.0" } });
      } else if (!threadReady) {
        openThread(ctx.state.conversationId);
      }
    },
    onMessage(m) {
      if (!m || typeof m !== "object") return;
      // Responses to our requests
      if ("id" in m && ("result" in m || "error" in m) && !("method" in m)) {
        if (m.error) {
          ctx.upsert({ kind: "system", id: `e-${String(m.id)}-${ctx.state.items.length}`, text: t("Codex: {error}", { error: String(m.error.message ?? JSON.stringify(m.error)) }), tone: "error" });
          if (String(m.id).startsWith("erka-turn-")) ctx.set("busy", false);
          if ((m.id === THREAD_ID || m.id === LIST_ID) && ctx.state.conversationId && !ctx.replaying()) {
            // Resume failed (thread gone): start fresh instead.
            ctx.set("conversationId", null);
            openThread(null);
          }
          return;
        }
        if (m.id === INIT_ID) {
          initialized = true;
          if (!ctx.replaying()) {
            ctx.write({ method: "initialized", params: {} });
            openThread(ctx.state.conversationId);
          }
        } else if (m.id === LIST_ID) {
          const latest = m.result?.data?.[0] ?? m.result?.threads?.[0];
          if (!ctx.replaying()) openThread(latest?.id ?? null);
        } else if (m.id === THREAD_ID) {
          threadReady = true;
          const thread = m.result?.thread;
          threadId = thread?.id ?? null;
          if (threadId) ctx.setConversation(threadId);
          ctx.setModel(m.result?.model ?? null);
          renderTurns(thread?.turns);
          if (!ctx.replaying()) {
            for (const it of ctx.state.items) if (it.id.startsWith("queued-")) ctx.patch(it.id, (i: any) => (i.text = ""));
            while (queued.length) startTurn(queued.shift()!);
          }
        }
        return;
      }
      const p = m.params ?? {};
      // Server → client requests (approvals)
      if ("id" in m && "method" in m) {
        const id = `approval-${String(m.id)}`;
        approvals.set(id, { id: m.id, method: m.method });
        if (m.method.endsWith("requestApproval") || m.method === "execCommandApproval" || m.method === "applyPatchApproval") {
          const what = p.command ? (Array.isArray(p.command) ? p.command.join(" ") : p.command) : p.reason ?? (p.fileChanges ? Object.keys(p.fileChanges).join(", ") : m.method);
          ctx.upsert({
            kind: "permission", id, title: m.method.includes("fileChange") || m.method === "applyPatchApproval" ? t("Apply file changes?") : t("Run command?"),
            detail: String(what ?? ""),
            options: [
              { id: "accept", label: t("Allow"), tone: "allow" },
              { id: "acceptForSession", label: t("Allow for session"), tone: "allow" },
              { id: "decline", label: t("Decline"), tone: "deny" },
            ],
          });
        } else if (m.method === "item/tool/requestUserInput") {
          ctx.upsert({ kind: "system", id, text: t("Codex asked for input that chat mode cannot answer yet; switch to terminal."), tone: "info" });
        }
        return;
      }
      switch (m.method) {
        case "turn/started":
          turnId = p.turn?.id ?? p.turnId ?? null;
          ctx.set("busy", true);
          break;
        case "turn/completed":
          turnId = null;
          ctx.set("busy", false);
          for (const it of ctx.state.items) if ((it as any).streaming) ctx.patch(it.id, (i: any) => (i.streaming = false));
          if (p.turn?.error) ctx.upsert({ kind: "system", id: `turn-err-${p.turn.id}`, text: String(p.turn.error.message ?? t("Turn failed")), tone: "error" });
          ctx.upsert({ kind: "result", id: `turn-${p.turn?.id ?? ctx.state.items.length}`, text: [p.turn?.status, p.turn?.durationMs ? `${(p.turn.durationMs / 1000).toFixed(1)}s` : null].filter(Boolean).join(" · ") });
          break;
        case "item/started":
          renderItem(p.item, false);
          break;
        case "item/completed":
          renderItem(p.item, true);
          break;
        case "item/agentMessage/delta":
          if (!ctx.find(p.itemId)) ctx.upsert({ kind: "assistant", id: p.itemId, text: "", streaming: true });
          ctx.patch(p.itemId, (i: any) => (i.text += p.delta ?? ""));
          break;
        case "item/reasoning/summaryTextDelta":
        case "item/reasoning/textDelta":
          if (!ctx.find(p.itemId)) ctx.upsert({ kind: "thinking", id: p.itemId, text: "", streaming: true });
          ctx.patch(p.itemId, (i: any) => (i.text += p.delta ?? ""));
          break;
        case "item/commandExecution/outputDelta":
          ctx.patch(p.itemId, (i: any) => {
            if (i.kind === "tool") i.output = ((i.output ?? "") + (p.delta ?? "")).slice(-20000);
          });
          break;
        case "error":
          ctx.upsert({ kind: "system", id: `err-${ctx.state.items.length}`, text: String(p.error?.message ?? p.message ?? t("Codex error")), tone: "error" });
          break;
      }
    },
    send(text) {
      if (!threadId) {
        queued.push(text);
        ctx.upsert({ kind: "user", id: `queued-${Date.now()}`, text, pending: true });
        ctx.set("busy", true);
        return;
      }
      // No optimistic bubble: Codex echoes the prompt as a `userMessage` item right away.
      startTurn(text);
    },
    interrupt() {
      if (threadId && turnId) request(`erka-int-${++seq}`, "turn/interrupt", { threadId, turnId });
    },
    respond(id, option) {
      const a = approvals.get(id);
      if (!a) return;
      approvals.delete(id);
      const legacy = a.method === "execCommandApproval" || a.method === "applyPatchApproval";
      const decision = legacy ? { accept: "approved", acceptForSession: "approved_for_session", decline: "denied" }[option] ?? "denied" : option;
      ctx.write({ id: a.id, result: { decision } });
    },
  };
}
