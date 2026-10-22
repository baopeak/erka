// Claude Code `-p --input-format stream-json --output-format stream-json` adapter.
//
// Wire facts (verified against Claude Code 2.1.x):
// - `stream_event` lines carry Anthropic streaming events (message_start, content_block_*);
// - each completed content block is re-emitted as an `assistant` line with one block;
// - `user` lines carry tool results, and our own prompts when `--replay-user-messages`;
// - permission prompts arrive as `control_request{subtype:"can_use_tool"}` and are answered
//   with `control_response` (because of `--permission-prompt-tool stdio`);
// - `result` ends a turn.
import { type Adapter, type AdapterContext, type ChatItem, summarize, textOf } from "./chat-model";
import { t } from "../lib/i18n";

export function claudeArgs(resumeId: string | null, extra: string[] = []): string[] {
  return [
    "claude", "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--replay-user-messages",
    "--permission-prompt-tool", "stdio",
    ...(resumeId ? ["--resume", resumeId] : []),
    ...extra,
  ];
}

/** Renders one Claude transcript/stream message (assistant or user) into items. */
export function applyClaudeMessage(ctx: AdapterContext, m: any, live: { msgId: string | null }) {
  const msg = m.message ?? {};
  const content = msg.content;
  if (m.type === "user") {
    if (m.isMeta || m.isCompactSummary) return;
    if (typeof content === "string") {
      if (!content.startsWith("<")) pushUser(ctx, content, m.uuid);
      return;
    }
    for (const block of content ?? []) {
      if (block.type === "tool_result") {
        const output = textOf(block.content);
        ctx.patch(block.tool_use_id, (it: ChatItem) => {
          if (it.kind !== "tool") return;
          it.output = output;
          it.status = block.is_error ? "error" : "done";
        });
      } else if (block.type === "text" && !String(block.text).startsWith("<")) {
        pushUser(ctx, block.text, m.uuid);
      }
    }
    return;
  }
  if (m.type !== "assistant" || !Array.isArray(content)) return;
  const group = msg.id ?? m.uuid;
  for (const block of content) {
    if (block.type === "tool_use") {
      const prev = ctx.find(block.id);
      ctx.upsert({
        kind: "tool", id: block.id, name: block.name, input: block.input, summary: summarize(block.input),
        status: prev?.kind === "tool" ? prev.status : "running", output: prev?.kind === "tool" ? prev.output : undefined,
        diff: diffFor(block.name, block.input),
      });
    } else if (block.type === "text" || block.type === "thinking") {
      const kind = block.type === "text" ? "assistant" : "thinking";
      const text = block.type === "text" ? block.text : block.thinking;
      if (kind === "thinking" && !text) continue;
      // Finalize the streaming item of this message/kind if there is one.
      const streaming = ctx.state.items.findLast((i) => i.kind === kind && (i as any).group === group && (i as any).streaming);
      if (streaming) ctx.patch(streaming.id, (i: any) => { i.text = text; i.streaming = false; });
      else ctx.upsert({ kind, id: `${group}:${kind}:${ctx.state.items.length}`, text, group } as ChatItem);
    }
  }
  live.msgId = group;
}

function pushUser(ctx: AdapterContext, text: string, uuid?: string) {
  // Ctrl+C used to stop the TUI during a mode switch leaves this marker; it is not a message.
  if (/^\[Request interrupted by user/.test(text.trim())) return;
  // Replace our optimistic copy instead of duplicating it.
  const pending = ctx.state.items.find((i) => i.kind === "user" && i.pending && i.text.trim() === text.trim());
  if (pending) ctx.patch(pending.id, (i: any) => (i.pending = false));
  else ctx.upsert({ kind: "user", id: uuid ?? `u-${ctx.state.items.length}`, text });
}

function diffFor(name: string, input: any): { path: string; text: string }[] | undefined {
  if (!input) return undefined;
  if (name === "Edit" && input.file_path) {
    return [{ path: input.file_path, text: [...String(input.old_string ?? "").split("\n").map((l: string) => "-" + l), ...String(input.new_string ?? "").split("\n").map((l: string) => "+" + l)].join("\n") }];
  }
  if (name === "MultiEdit" && Array.isArray(input.edits)) {
    return [{ path: input.file_path, text: input.edits.map((e: any) => [...String(e.old_string).split("\n").map((l: string) => "-" + l), ...String(e.new_string).split("\n").map((l: string) => "+" + l)].join("\n")).join("\n@@\n") }];
  }
  if (name === "Write" && input.file_path) {
    return [{ path: input.file_path, text: String(input.content ?? "").split("\n").slice(0, 400).map((l: string) => "+" + l).join("\n") }];
  }
  return undefined;
}

export function createClaudeAdapter(ctx: AdapterContext): Adapter {
  const live = { msgId: null as string | null };
  let blocks = new Map<number, string>(); // stream block index → item id
  let partialJson = new Map<number, string>();
  let interruptSeq = 0;
  const pendingInputs = new Map<string, { input: unknown; suggestions?: unknown }>();

  return {
    reset() {
      live.msgId = null;
      blocks = new Map();
      partialJson = new Map();
    },
    start() {
      // stream-json mode starts lazily on the first user message; nothing to send.
      ctx.set("status", null);
    },
    onMessage(m) {
      if (!m || typeof m !== "object") return;
      switch (m.type) {
        case "system":
          if (m.subtype === "init") {
            ctx.setModel(m.model ?? null);
            if (m.session_id) ctx.setConversation(m.session_id);
          } else if (m.subtype === "status") {
            ctx.set("status", m.status ?? null);
          } else if (m.subtype === "api_retry") {
            ctx.upsert({ kind: "system", id: `retry-${ctx.state.items.length}`, text: t("API retry…"), tone: "info" });
          }
          return;
        case "stream_event": {
          const e = m.event ?? {};
          if (m.parent_tool_use_id) return; // subagent internals stay folded into the tool card
          if (e.type === "message_start") {
            live.msgId = e.message?.id ?? null;
            blocks = new Map();
            ctx.set("busy", true);
          } else if (e.type === "content_block_start") {
            const b = e.content_block ?? {};
            const group = live.msgId ?? "live";
            if (b.type === "text" || b.type === "thinking") {
              const kind = b.type === "text" ? "assistant" : "thinking";
              const id = `${group}:${kind}:${e.index}`;
              blocks.set(e.index, id);
              ctx.upsert({ kind, id, text: "", streaming: true, group } as ChatItem);
            } else if (b.type === "tool_use") {
              blocks.set(e.index, b.id);
              partialJson.set(e.index, "");
              ctx.upsert({ kind: "tool", id: b.id, name: b.name, summary: "", status: "running" });
            }
          } else if (e.type === "content_block_delta") {
            const id = blocks.get(e.index);
            const d = e.delta ?? {};
            if (!id) return;
            if (d.type === "text_delta") ctx.patch(id, (i: any) => (i.text += d.text));
            else if (d.type === "thinking_delta") ctx.patch(id, (i: any) => (i.text += d.thinking));
            else if (d.type === "input_json_delta") {
              const acc = (partialJson.get(e.index) ?? "") + (d.partial_json ?? "");
              partialJson.set(e.index, acc);
              const cmd = /"(?:command|file_path|pattern|path|url)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(acc)?.[1];
              if (cmd) ctx.patch(id, (i: any) => (i.summary = cmd.replace(/\\(.)/g, "$1")));
            }
          }
          return;
        }
        case "assistant":
        case "user":
          if (m.parent_tool_use_id) return;
          applyClaudeMessage(ctx, m, live);
          if (m.type === "user" && !m.isReplay) ctx.set("busy", true);
          return;
        case "control_request": {
          const r = m.request ?? {};
          if (r.subtype !== "can_use_tool") return;
          ctx.upsert({
            kind: "permission",
            id: m.request_id,
            title: t("Allow {tool}?", { tool: String(r.tool_name) }),
            detail: summarize(r.input, 600),
            options: [
              { id: "allow", label: t("Allow"), tone: "allow" },
              { id: "allow-session", label: t("Allow for session"), tone: "allow" },
              { id: "deny", label: t("Deny"), tone: "deny" },
            ],
          });
          pendingInputs.set(m.request_id, { input: r.input, suggestions: r.permission_suggestions });
          return;
        }
        case "control_response":
          return;
        case "result":
          ctx.set({ busy: false, status: null });
          ctx.upsert({
            kind: "result",
            id: `result-${m.uuid ?? ctx.state.items.length}`,
            text: [m.is_error ? t("Error: {error}", { error: String(m.result ?? m.subtype) }) : null, m.duration_ms ? `${(m.duration_ms / 1000).toFixed(1)}s` : null, m.num_turns ? (m.num_turns === 1 ? t("{n} turn", { n: m.num_turns }) : t("{n} turns", { n: m.num_turns })) : null, m.total_cost_usd != null ? `$${m.total_cost_usd.toFixed(3)}` : null].filter(Boolean).join(" · "),
          });
          // Close any stale streaming markers.
          for (const it of ctx.state.items) if ((it as any).streaming) ctx.patch(it.id, (i: any) => (i.streaming = false));
          return;
      }
    },
    send(text) {
      ctx.upsert({ kind: "user", id: `local-${Date.now()}`, text, pending: true });
      ctx.set("busy", true);
      ctx.write({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
    },
    interrupt() {
      ctx.write({ type: "control_request", request_id: `erka-interrupt-${++interruptSeq}`, request: { subtype: "interrupt" } });
    },
    respond(id, option) {
      const pending = pendingInputs.get(id);
      pendingInputs.delete(id);
      const response =
        option === "deny"
          ? { behavior: "deny", message: "The user denied this action." }
          : { behavior: "allow", updatedInput: pending?.input ?? {}, ...(option === "allow-session" && pending?.suggestions ? { updatedPermissions: pending.suggestions } : {}) };
      ctx.write({ type: "control_response", response: { subtype: "success", request_id: id, response } });
    },
  };
}

