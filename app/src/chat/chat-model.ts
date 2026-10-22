// Chat-mode state shared by all agent adapters. Adapters translate their wire protocol
// (Claude stream-json, Codex app-server, ACP) into these items; the UI only knows items.
import { createStore, produce, type SetStoreFunction } from "solid-js/store";
import { attachTerminal, b64ToBytes, daemon, sendInput } from "../lib/ipc";
import { t } from "../lib/i18n";

export type ChatItem =
  | { kind: "user"; id: string; text: string; pending?: boolean }
  | { kind: "assistant"; id: string; text: string; streaming?: boolean; group?: string }
  | { kind: "thinking"; id: string; text: string; streaming?: boolean; group?: string }
  | { kind: "tool"; id: string; name: string; summary: string; input?: unknown; output?: string; status: "running" | "done" | "error"; diff?: { path: string; text: string }[] }
  | { kind: "permission"; id: string; title: string; detail?: string; options: { id: string; label: string; tone?: "allow" | "deny" }[]; resolved?: string }
  | { kind: "system"; id: string; text: string; tone?: "error" | "info" }
  | { kind: "result"; id: string; text: string };

export interface ChatState {
  items: ChatItem[];
  busy: boolean;
  model: string | null;
  /** Agent-side conversation id (Claude session id, Codex thread id, ACP session id). */
  conversationId: string | null;
  ready: boolean;
  exited: boolean;
  status: string | null;
}

export interface Adapter {
  /** Called once per process after the log replay finished (handshake / resume). */
  start(): void;
  /** One stdout line from the agent (already JSON-parsed when possible). */
  onMessage(msg: any, raw: string): void;
  send(text: string): void;
  interrupt(): void;
  respond(permissionId: string, optionId: string): void;
  /** Reset internal bookkeeping before a full log replay. */
  reset(): void;
}

export interface AdapterContext {
  state: ChatState;
  set: SetStoreFunction<ChatState>;
  /** Writes one JSON line to the agent's stdin. */
  write(obj: unknown): void;
  upsert(item: ChatItem): void;
  patch<T extends ChatItem>(id: string, fn: (item: T) => void): void;
  find(id: string): ChatItem | undefined;
  setConversation(id: string): void;
  setModel(model: string | null): void;
  cwd: string;
  resumeId: string | null;
  replaying: () => boolean;
}

/** Owns one chat session's stream: attach, line framing, replay, adapter dispatch. */
export class ChatController {
  readonly state: ChatState;
  readonly set: SetStoreFunction<ChatState>;
  private index = new Map<string, number>();
  private buffer = "";
  private decoder = new TextDecoder();
  private adapter!: Adapter;
  private handle: number | null = null;
  private attachGen = 0;
  private isReplaying = false;
  /** Answered approval ids (the agent's log does not contain our answers). */
  private resolved = new Map<string, string>();
  private started = false;
  /** Renders the agent's own transcript (history from before chat mode) ahead of the log. */
  loadHistory: ((ctx: AdapterContext) => Promise<void>) | null = null;

  constructor(readonly sessionId: string, readonly cwd: string, readonly resumeId: string | null, makeAdapter: (ctx: AdapterContext) => Adapter) {
    const [state, set] = createStore<ChatState>({ items: [], busy: false, model: null, conversationId: resumeId, ready: false, exited: false, status: null });
    this.state = state;
    this.set = set;
    this.adapter = makeAdapter(this.context());
  }

  private context(): AdapterContext {
    return {
      state: this.state,
      set: this.set,
      // Replays must never talk to the agent: those messages were answered long ago.
      write: (obj) => this.handle != null && !this.isReplaying && void sendInput(this.handle, JSON.stringify(obj) + "\n"),
      upsert: (item) => this.upsert(item),
      patch: (id, fn) => this.patch(id, fn as (i: ChatItem) => void),
      find: (id) => {
        const i = this.index.get(id);
        return i == null ? undefined : this.state.items[i];
      },
      setConversation: (id) => {
        if (this.state.conversationId === id) return;
        this.set("conversationId", id);
        void daemon("session.update", { handle: this.handle, agent_session_id: id }).catch(() => {});
      },
      setModel: (model) => {
        if (this.state.model === model) return;
        this.set("model", model);
        if (model && !this.isReplaying) void daemon("session.update", { handle: this.handle, model }).catch(() => {});
      },
      cwd: this.cwd,
      resumeId: this.resumeId,
      replaying: () => this.isReplaying,
    };
  }

  upsert(item: ChatItem) {
    if (item.kind === "permission" && this.resolved.has(item.id)) item = { ...item, resolved: this.resolved.get(item.id) };
    const i = this.index.get(item.id);
    if (i != null) {
      this.set("items", i, item);
      return;
    }
    this.index.set(item.id, this.state.items.length);
    this.set("items", this.state.items.length, item);
  }

  patch(id: string, fn: (item: ChatItem) => void) {
    const i = this.index.get(id);
    if (i == null) return;
    this.set("items", i, produce(fn));
  }

  private resetState() {
    this.index.clear();
    this.buffer = "";
    this.set({ items: [], busy: false, ready: false, status: null });
    this.adapter.reset();
  }

  private feed(bytes: Uint8Array) {
    this.buffer += this.decoder.decode(bytes, { stream: true });
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: any = null;
      try {
        msg = JSON.parse(line);
      } catch {
        /* non-JSON noise */
      }
      if (msg?.type === "erka_exit") {
        this.set({ exited: true, busy: false });
        this.upsert({ kind: "system", id: `exit-${Date.now()}`, text: t("Agent process exited (code {code}).", { code: String(msg.code) }), tone: "info" });
        continue;
      }
      if (msg?.type === "erka_stderr") {
        if (/error|fatal|panic/i.test(msg.text)) this.upsert({ kind: "system", id: `err-${this.state.items.length}`, text: msg.text, tone: "error" });
        continue;
      }
      try {
        this.adapter.onMessage(msg, line);
      } catch (e) {
        console.warn("chat adapter error", e, line);
      }
    }
  }

  async attach(handle: number) {
    const gen = ++this.attachGen;
    this.handle = handle;
    const early: Uint8Array[] = [];
    let applied = false;
    const reply = await attachTerminal(handle, null, (_seq, data) => {
      if (gen !== this.attachGen) return;
      if (applied) this.feed(data);
      else early.push(data);
    }).catch((e) => {
      this.upsert({ kind: "system", id: "attach-error", text: t("Could not attach: {error}", { error: String(e) }), tone: "error" });
      return null;
    });
    if (!reply || gen !== this.attachGen) return;
    this.resetState();
    if (this.loadHistory) await this.loadHistory(this.context()).catch(() => {});
    if (gen !== this.attachGen) return;
    this.isReplaying = true;
    this.feed(b64ToBytes(reply.data));
    this.isReplaying = false;
    applied = true;
    for (const chunk of early) this.feed(chunk);
    this.set("ready", true);
    if (!this.started && !this.state.exited) {
      this.started = true;
      this.adapter.start();
    }
  }

  detach() {
    this.attachGen++;
    if (this.handle != null) void daemon("session.detach", { handle: this.handle }).catch(() => {});
  }

  send(text: string) {
    if (!text.trim() || this.state.exited) return;
    this.adapter.send(text);
  }

  interrupt() {
    this.adapter.interrupt();
  }

  respond(permissionId: string, optionId: string, label: string) {
    if (this.resolved.has(permissionId)) return;
    this.resolved.set(permissionId, label);
    this.adapter.respond(permissionId, optionId);
    this.patch(permissionId, (i) => {
      if (i.kind === "permission") i.resolved = label;
    });
  }
}

export function summarize(input: unknown, max = 120): string {
  if (input == null) return "";
  if (typeof input === "string") return input.length > max ? input.slice(0, max) + "…" : input;
  const o = input as Record<string, unknown>;
  const pick = o.command ?? o.cmd ?? o.file_path ?? o.path ?? o.pattern ?? o.url ?? o.query ?? o.description ?? o.prompt;
  const s = typeof pick === "string" ? pick : Array.isArray(pick) ? pick.join(" ") : JSON.stringify(input);
  return s.length > max ? s.slice(0, max) + "…" : s;
}

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: any) => (typeof c === "string" ? c : c?.text ?? (c?.type === "image" ? "[image]" : ""))).join("");
  if (content && typeof content === "object" && "text" in (content as any)) return String((content as any).text);
  return "";
}
