import { describe, expect, it } from "vitest";
import { createStore, produce } from "solid-js/store";
import { createAcpAdapter } from "./acp-adapter";
import { type AdapterContext, type ChatItem, type ChatState, emptyChatState } from "./chat-model";

/** An adapter context over a real store; `written` collects what the adapter sends to the agent. */
function harness(replaying = false) {
  const [state, set] = createStore<ChatState>(emptyChatState());
  const written: any[] = [];
  const ctx: AdapterContext = {
    state, set,
    write: (obj) => written.push(obj),
    upsert: (item) => {
      const i = state.items.findIndex((x) => x.id === item.id);
      set("items", i < 0 ? state.items.length : i, item);
    },
    patch: (id, fn) => {
      const i = state.items.findIndex((x) => x.id === id);
      if (i >= 0) set("items", i, produce(fn as never));
    },
    find: (id) => state.items.find((x) => x.id === id),
    clear: () => set({ items: [], plan: null, usage: null }),
    setConversation: (id) => set("conversationId", id),
    setModel: (m) => set("model", m),
    cwd: "/work", resumeId: null, replaying: () => replaying,
  };
  return { state, ctx, written, items: () => JSON.parse(JSON.stringify(state.items)) as ChatItem[] };
}

/** Walks the handshake up to an open session with one answered prompt on screen. */
function openSession(a: ReturnType<typeof createAcpAdapter>) {
  a.start();
  a.onMessage({ jsonrpc: "2.0", id: "kelpie-init", result: { agentCapabilities: {} } }, "");
  a.onMessage({ jsonrpc: "2.0", id: "kelpie-session", result: { sessionId: "s-1" } }, "");
  a.send("hi");
  a.onMessage({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } } } }, "");
}

describe("createAcpAdapter", () => {
  it("offers /new and /clear ahead of the agent's own commands, without the agent's own clear", () => {
    const h = harness();
    const a = createAcpAdapter(h.ctx);
    a.start();
    expect(h.state.commands.map((c) => c.name)).toEqual(["new", "clear"]);
    a.onMessage({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "clear", description: "Clear context" }, { name: "compact" }] } } }, "");
    expect(h.state.commands.map((c) => c.name)).toEqual(["new", "clear", "compact"]);
  });

  it("/new, /clear and /reset start a new session with an empty transcript, live and replayed", () => {
    for (const cmd of ["/new", "/clear", "/reset"]) {
      const h = harness();
      const a = createAcpAdapter(h.ctx);
      openSession(a);
      expect(h.items()).toHaveLength(2);
      a.send(cmd);
      expect(h.written.at(-1)).toMatchObject({ id: "kelpie-session-new", method: "session/new", params: { cwd: "/work" } });
      a.onMessage({ jsonrpc: "2.0", id: "kelpie-session-new", result: { sessionId: "s-2" } }, "");
      expect(h.items()).toEqual([]);
      expect(h.state.conversationId).toBe("s-2");
      a.send("next");
      expect(h.written.at(-1)).toMatchObject({ method: "session/prompt", params: { sessionId: "s-2" } });
    }
    const r = harness(true);
    const b = createAcpAdapter(r.ctx);
    b.onMessage({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old" } } } }, "");
    b.onMessage({ jsonrpc: "2.0", id: "kelpie-session-new", result: { sessionId: "s-2" } }, "");
    expect(r.items()).toEqual([]);
  });

  it("words after /new are a prompt, and a failed /new stays in the session shown", () => {
    const h = harness();
    const a = createAcpAdapter(h.ctx);
    openSession(a);
    a.send("/new login page");
    expect(h.written.at(-1)).toMatchObject({ method: "session/prompt", params: { prompt: [{ text: "/new login page" }] } });
    a.send("/clear");
    a.onMessage({ jsonrpc: "2.0", id: "kelpie-session-new", error: { message: "nope" } }, "");
    expect(h.items().at(-1)).toMatchObject({ kind: "system", tone: "error" });
    a.send("again");
    expect(h.written.at(-1)).toMatchObject({ method: "session/prompt", params: { sessionId: "s-1" } });
  });
});
