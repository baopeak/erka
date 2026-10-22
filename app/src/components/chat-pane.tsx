import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { MicButton } from "./voice";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { openUrl } from "@tauri-apps/plugin-opener";
import { store } from "../lib/store";
import { isMac } from "../lib/platform";
import { getController } from "../chat/mode-switch";
import type { ChatItem } from "../chat/chat-model";
import type { Project } from "../lib/types";
import { Icon } from "./icons";
import { kindInfo } from "../lib/agents";
import { t } from "../lib/i18n";

const RENDER_WINDOW = 300;

function Markdown(props: { text: string }) {
  const html = createMemo(() => DOMPurify.sanitize(marked.parse(props.text, { gfm: true, async: false }) as string));
  const onClick = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    if (/^https?:/i.test(href)) void openUrl(href);
  };
  return <div class="msg-assistant" innerHTML={html()} onClick={onClick} />;
}

function ToolCard(props: { item: Extract<ChatItem, { kind: "tool" }> }) {
  const [open, setOpen] = createSignal(false);
  const icon = () => (props.item.status === "running" ? "◌" : props.item.status === "error" ? "✕" : "✓");
  return (
    <div class={`tool${props.item.status === "error" ? " error" : ""}`}>
      <div class="tool-head" onClick={() => setOpen(!open())}>
        <span style={{ color: props.item.status === "running" ? "var(--working)" : props.item.status === "error" ? "var(--danger)" : "var(--idle)" }}>{icon()}</span>
        <span class="tname">{props.item.name}</span>
        <span class="tsum">{props.item.summary}</span>
        <Icon name={open() ? "chevronDown" : "chevronRight"} size={12} />
      </div>
      <Show when={props.item.diff?.length && (open() || props.item.status !== "done")}>
        <div class="tool-body">
          <For each={props.item.diff}>
            {(d) => (
              <>
                <div style={{ color: "var(--text)", "margin-bottom": "4px" }}>{d.path}</div>
                <For each={d.text.split("\n").slice(0, 400)}>
                  {(l) => <div class={`diff-line${l.startsWith("+") && !l.startsWith("+++") ? " add" : l.startsWith("-") && !l.startsWith("---") ? " del" : ""}`}>{l || " "}</div>}
                </For>
              </>
            )}
          </For>
        </div>
      </Show>
      <Show when={open() && (props.item.output || props.item.input)}>
        <div class="tool-body">
          <Show when={props.item.input && !props.item.diff}>{JSON.stringify(props.item.input, null, 2)}{"\n"}</Show>
          <Show when={props.item.output}>{props.item.output!.length > 20000 ? props.item.output!.slice(-20000) : props.item.output}</Show>
        </div>
      </Show>
    </div>
  );
}

export function ChatPane(props: { sessionId: string; project: Project; focused: boolean }) {
  return (
    <Show when={store.sessions[props.sessionId] ? props.sessionId : null} keyed fallback={<div class="empty">{t("Waiting for session…")}</div>}>
      {(id) => <ChatBody sessionId={id} project={props.project} focused={props.focused} />}
    </Show>
  );
}

function ChatBody(props: { sessionId: string; project: Project; focused: boolean }) {
  let scroller!: HTMLDivElement;
  let textarea!: HTMLTextAreaElement;
  const session = () => store.sessions[props.sessionId];
  const ctrl = getController(session());
  const [draft, setDraft] = createSignal("");
  const [showAll, setShowAll] = createSignal(false);
  let stick = true;

  // Attach only when the handle or the daemon connection changes — not on every status tick.
  const target = createMemo(() => (store.connected() ? session()?.handle ?? null : null));
  onMount(() => {
    createEffect(on(target, (handle) => handle != null && void ctrl.attach(handle)));
    // The daemon dropped us for falling behind: re-attach (full replay).
    const onResync = (e: Event) => (e as CustomEvent).detail === props.sessionId && target() != null && void ctrl.attach(target()!);
    window.addEventListener("erka:chat-resync", onResync);
    onCleanup(() => {
      window.removeEventListener("erka:chat-resync", onResync);
      ctrl.detach();
    });
  });

  const items = createMemo(() => (showAll() ? ctrl.state.items : ctrl.state.items.slice(-RENDER_WINDOW)));

  // Keep pinned to the bottom while streaming unless the user scrolled up.
  createEffect(() => {
    const last = ctrl.state.items[ctrl.state.items.length - 1];
    void (last && "text" in last ? (last as any).text : last);
    void ctrl.state.items.length;
    if (stick) queueMicrotask(() => scroller && (scroller.scrollTop = scroller.scrollHeight));
  });
  createEffect(() => props.focused && store.overlay() === null && queueMicrotask(() => textarea?.focus()));

  const send = () => {
    const text = draft();
    if (!text.trim()) return;
    ctrl.send(text);
    setDraft("");
    stick = true;
  };

  const meta = () => kindInfo(session()?.kind ?? "custom");

  return (
    <div class="chat">
      <div class="chat-scroll" ref={scroller} onScroll={(e) => (stick = e.currentTarget.scrollHeight - e.currentTarget.scrollTop - e.currentTarget.clientHeight < 40)}>
        <div class="chat-inner">
          <Show when={!showAll() && ctrl.state.items.length > RENDER_WINDOW}>
            <button class="btn" style={{ "align-self": "center" }} onClick={() => setShowAll(true)}>{t("Show {n} earlier items", { n: ctrl.state.items.length - RENDER_WINDOW })}</button>
          </Show>
          <Show when={ctrl.state.ready && ctrl.state.items.length === 0}>
            <div class="muted" style={{ "text-align": "center" }}>
              {t("{agent} chat · {project}. Ask anything — tools, diffs and approvals appear inline.", { agent: meta().label, project: props.project.name })}
            </div>
          </Show>
          <For each={items()}>
            {(item) => (
              <Switch>
                <Match when={item.kind === "user" && item}>
                  {(it) => <Show when={(it() as any).text}><div class="msg-user" style={{ opacity: (it() as any).pending ? 0.7 : 1 }}>{(it() as any).text}</div></Show>}
                </Match>
                <Match when={item.kind === "assistant" && item}>
                  {(it) => <Show when={(it() as any).streaming} fallback={<Markdown text={(it() as any).text} />}><div class="msg-assistant" style={{ "white-space": "pre-wrap" }}>{(it() as any).text}</div></Show>}
                </Match>
                <Match when={item.kind === "thinking" && item}>
                  {(it) => <div class="msg-thinking">{(it() as any).text}</div>}
                </Match>
                <Match when={item.kind === "tool" && item}>
                  {(it) => <ToolCard item={it() as any} />}
                </Match>
                <Match when={item.kind === "permission" && item}>
                  {(it) => {
                    const p = it() as Extract<ChatItem, { kind: "permission" }>;
                    return (
                      <div class="perm">
                        <div class="q">{p.title}</div>
                        <Show when={p.detail}><div class="tool-body" style={{ border: 0, padding: 0 }}>{p.detail}</div></Show>
                        <Show when={!p.resolved} fallback={<div class="muted" style={{ padding: 0 }}>→ {p.resolved}</div>}>
                          <div class="actions">
                            <For each={p.options}>
                              {(o) => <button class={`btn${o.tone === "allow" ? " primary" : ""}`} onClick={() => ctrl.respond(p.id, o.id, o.label)}>{o.label}</button>}
                            </For>
                          </div>
                        </Show>
                      </div>
                    );
                  }}
                </Match>
                <Match when={item.kind === "system" && item}>
                  {(it) => <div class="result-line" style={{ color: (it() as any).tone === "error" ? "var(--danger)" : undefined }}>{(it() as any).text}</div>}
                </Match>
                <Match when={item.kind === "result" && item}>
                  {(it) => <Show when={(it() as any).text}><div class="result-line">{(it() as any).text}</div></Show>}
                </Match>
              </Switch>
            )}
          </For>
          <Show when={ctrl.state.busy}>
            <div class="typing"><span class="dot working" /> {ctrl.state.status === "requesting" ? t("Thinking…") : t("Working…")}</div>
          </Show>
        </div>
      </div>
      <div class="chat-composer">
        <div class="composer-box">
          <textarea
            ref={textarea}
            rows={2}
            placeholder={ctrl.state.exited ? t("Agent exited — switch to terminal to resume") : t("Message {agent}…  (Enter to send, Shift+Enter for newline, Esc to interrupt)", { agent: meta().label })}
            value={draft()}
            disabled={ctrl.state.exited}
            onInput={(e) => {
              setDraft(e.currentTarget.value);
              e.currentTarget.style.height = "auto";
              e.currentTarget.style.height = Math.min(240, e.currentTarget.scrollHeight) + "px";
            }}
            onKeyDown={(e) => {
              if (e.isComposing) return;
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              } else if (e.key === "Escape" && ctrl.state.busy) {
                e.preventDefault();
                ctrl.interrupt();
              }
            }}
          />
          <div class="composer-row">
            <span>{meta().label}{ctrl.state.model ? ` · ${ctrl.state.model}` : ""}</span>
            <Show when={ctrl.state.conversationId && ctrl.state.conversationId !== "latest"}>
              <span title={t("Agent conversation id")}>· {ctrl.state.conversationId!.slice(0, 8)}</span>
            </Show>
            <span class="spacer" />
            <Show when={session() && !session()!.alive}>
              <button class="btn" style={{ height: "26px" }} title={t("Start the agent again, continuing this conversation")} onClick={() => void store.resumeSession(props.sessionId)}>
                <Icon name="restart" size={12} /> {t("Resume")}
              </button>
            </Show>
            <Show when={ctrl.state.busy}>
              <button class="btn" style={{ height: "26px" }} onClick={() => ctrl.interrupt()}><Icon name="stop" size={12} /> {t("Stop")}</button>
            </Show>
            <Show when={!ctrl.state.exited}><MicButton field={() => textarea} /></Show>
            <button class="btn primary" style={{ height: "26px" }} disabled={!draft().trim() || ctrl.state.exited} onClick={send}>{t("Send {key}", { key: isMac ? "↩" : "⏎" })}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
