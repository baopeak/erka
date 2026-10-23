import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { openUrl } from "@tauri-apps/plugin-opener";
import { store } from "../lib/store";
import { findPane } from "../lib/layout";
import { getController, switchToTerminal } from "../chat/mode-switch";
import type { ChatItem } from "../chat/chat-model";
import { describeTool, diffStats, unifiedFiles } from "../chat/tool-view";
import type { Project } from "../lib/types";
import { Icon } from "./icons";
import { ChatComposer } from "./chat-composer";
import { type FileChange, PermissionCard, ThinkingRow, ToolRow, ToolRun, TurnFiles } from "./chat-rows";
import { kindInfo } from "../lib/agents";
import { t } from "../lib/i18n";

const RENDER_WINDOW = 300;

const toHtml = (text: string) => DOMPurify.sanitize(marked.parse(text, { gfm: true, async: false }) as string);

function openLink(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest("a");
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute("href") ?? "";
  if (/^https?:/i.test(href)) void openUrl(href);
}

function Markdown(props: { text: string }) {
  const html = createMemo(() => toHtml(props.text));
  return <div class="msg-assistant" innerHTML={html()} onClick={openLink} />;
}

/** Where streamed text can be cut: after the last blank line outside a code fence. Blocks
 *  before it are final, so they are parsed once, not again on every delta. */
export function stableEnd(text: string): number {
  let end = 0;
  let fence = false;
  let i = 0;
  for (const line of text.split("\n")) {
    const next = i + line.length + 1;
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    else if (!fence && line.trim() === "" && next <= text.length) end = next;
    i = next;
  }
  return end;
}

/** A reply that is still arriving: finished blocks as markdown, the open one as plain text. */
function StreamingMarkdown(props: { text: string }) {
  const cut = createMemo(() => stableEnd(props.text));
  const done = createMemo(() => props.text.slice(0, cut()));
  const html = createMemo(() => toHtml(done()));
  return (
    <div class="msg-assistant" onClick={openLink}>
      <div innerHTML={html()} />
      <div style={{ "white-space": "pre-wrap" }}>{props.text.slice(cut())}</div>
    </div>
  );
}

type Tool = Extract<ChatItem, { kind: "tool" }>;

const isExplore = (it: ChatItem): it is Tool => it.kind === "tool" && ["read", "search"].includes(describeTool(it).category);

/** Runs of 2+ consecutive reads/searches (folded into one row, keyed by their first item), and
 *  the files each turn changed (keyed by its result). Only structure is read here, so streamed
 *  text does not recompute it. */
function transcriptShape(items: ChatItem[]) {
  const runs = new Map<string, Tool[]>();
  const member = new Set<string>();
  const turnFiles = new Map<string, FileChange[]>();
  let run: Tool[] = [];
  const endRun = () => {
    if (run.length >= 2) {
      runs.set(run[0].id, run);
      for (const t of run.slice(1)) member.add(t.id);
    }
    run = [];
  };
  let changed = new Map<string, FileChange>();
  for (const it of items) {
    if (isExplore(it)) run.push(it);
    else endRun();
    if (it.kind === "tool" && it.diff?.length) {
      for (const d of it.diff) {
        const s = diffStats(d.text);
        const f = changed.get(d.path) ?? { path: d.path, adds: 0, dels: 0 };
        changed.set(d.path, { ...f, adds: f.adds + s.adds, dels: f.dels + s.dels });
      }
    } else if (it.kind === "result") {
      const files = it.diff ? unifiedFiles(it.diff) : [...changed.values()];
      if (files.length) turnFiles.set(it.id, files);
      changed = new Map();
    }
  }
  endRun();
  return { runs, member, turnFiles };
}

/** "23/10 16:02" (the full date and time on hover). */
const clock = (at: number) => new Date(at).toLocaleString([], { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const fullClock = (at: number) => new Date(at).toLocaleString([], { dateStyle: "full", timeStyle: "medium" });

/** The date and time a message was sent, in the top right corner. */
function Stamp(props: { at?: number }) {
  return <Show when={props.at}><span class="msg-time" title={fullClock(props.at!)}>{clock(props.at!)}</span></Show>;
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
  const session = () => store.sessions[props.sessionId];
  const ctrl = getController(session());
  const [showAll, setShowAll] = createSignal(false);
  let stick = true;

  // Attach only when the handle or the daemon connection changes — not on every status tick.
  const target = createMemo(() => (store.connected() ? session()?.handle ?? null : null));
  onMount(() => {
    createEffect(on(target, (handle) => handle != null && void ctrl.attach(handle)));
    // The daemon dropped us for falling behind: re-attach (full replay).
    const onResync = (e: Event) => (e as CustomEvent).detail === props.sessionId && target() != null && void ctrl.attach(target()!);
    window.addEventListener("kelpie:chat-resync", onResync);
    onCleanup(() => {
      window.removeEventListener("kelpie:chat-resync", onResync);
      ctrl.detach();
    });
  });

  const items = createMemo(() => (showAll() ? ctrl.state.items : ctrl.state.items.slice(-RENDER_WINDOW)));
  const shape = createMemo(() => transcriptShape(items()));

  // Keep pinned to the bottom while streaming unless the user scrolled up; then offer a way back.
  const [away, setAway] = createSignal(false);
  createEffect(() => {
    const last = ctrl.state.items[ctrl.state.items.length - 1];
    void (last && "text" in last ? (last as any).text : last);
    void ctrl.state.items.length;
    if (stick) queueMicrotask(() => scroller && (scroller.scrollTop = scroller.scrollHeight));
  });
  const toBottom = () => {
    stick = true;
    setAway(false);
    scroller.scrollTop = scroller.scrollHeight;
  };
  /** An approval nobody answered yet: the pill leads to it. */
  const pending = createMemo(() => ctrl.state.items.find((i): i is Extract<ChatItem, { kind: "permission" }> => i.kind === "permission" && !i.resolved));
  const toPending = () => {
    const el = scroller.querySelector(`[data-perm="${CSS.escape(pending()!.id)}"]`);
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
    else toBottom();
  };

  // Elapsed time of the running turn.
  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    if (ctrl.state.busySince == null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(timer));
  });
  const elapsed = () => {
    const since = ctrl.state.busySince;
    if (since == null) return "";
    const s = Math.max(0, Math.floor((now() - since) / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  };

  /** Continues the conversation in the agent's terminal UI and runs `command` there. */
  const openInTerminal = (command: string) => {
    const loc = store.paneLocation(props.sessionId);
    const tab = loc && store.workspace(loc.projectId).tabs.find((x) => x.id === loc.tabId);
    const pane = tab && findPane(tab.root, loc.paneId);
    if (tab && pane) void switchToTerminal(props.project, tab, pane, command);
  };

  const meta = () => kindInfo(session()?.kind ?? "custom");

  return (
    <div class="chat">
      <div class="chat-scroll" ref={scroller} onScroll={(e) => {
        stick = e.currentTarget.scrollHeight - e.currentTarget.scrollTop - e.currentTarget.clientHeight < 40;
        setAway(!stick);
      }}>
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
                  {(it) => {
                    const u = it() as Extract<ChatItem, { kind: "user" }>;
                    return (
                      <Show when={u.text}>
                        <div class="msg-user-wrap">
                          <Stamp at={u.at} />
                          <div class="msg-user" style={{ opacity: u.pending ? 0.7 : 1 }}>{u.text}</div>
                        </div>
                      </Show>
                    );
                  }}
                </Match>
                <Match when={item.kind === "assistant" && item}>
                  {(it) => (
                    <div class="msg-reply">
                      <Stamp at={it().at} />
                      <Show when={(it() as any).streaming} fallback={<Markdown text={(it() as any).text} />}><StreamingMarkdown text={(it() as any).text} /></Show>
                    </div>
                  )}
                </Match>
                <Match when={item.kind === "thinking" && item}>
                  {(it) => <Show when={(it() as any).text}><ThinkingRow item={it() as any} /></Show>}
                </Match>
                <Match when={item.kind === "tool" && item}>
                  {(it) => (
                    <Show when={!shape().member.has(it().id)}>
                      <Show when={shape().runs.get(it().id)} fallback={<ToolRow item={it() as Tool} project={props.project} />}>
                        {(run) => <ToolRun items={run()} project={props.project} />}
                      </Show>
                    </Show>
                  )}
                </Match>
                <Match when={item.kind === "permission" && item}>
                  {(it) => <PermissionCard item={it() as any} ctrl={ctrl} markdown={(text) => <Markdown text={text} />} />}
                </Match>
                <Match when={item.kind === "system" && item}>
                  {(it) => {
                    const s = it() as Extract<ChatItem, { kind: "system" }>;
                    return (
                      <div class="result-line" style={{ color: s.tone === "error" ? "var(--danger)" : undefined }}>
                        {s.text}
                        <Show when={s.tui}>
                          {" "}<button class="btn" style={{ height: "22px" }} onClick={() => openInTerminal(s.tui!.command)}><Icon name="terminal" size={12} /> {t("Run it in the terminal")}</button>
                        </Show>
                      </div>
                    );
                  }}
                </Match>
                <Match when={item.kind === "result" && item}>
                  {(it) => (
                    <>
                      <Show when={shape().turnFiles.get(it().id)}>{(files) => <TurnFiles files={files()} project={props.project} />}</Show>
                      <Show when={(it() as any).text}><div class="result-line">{(it() as any).text}<Show when={it().at}> · {clock(it().at!)}</Show></div></Show>
                    </>
                  )}
                </Match>
              </Switch>
            )}
          </For>
          <Show when={ctrl.state.busy}>
            <div class="typing">
              <span class="dot working" /> {ctrl.state.status === "requesting" ? t("Thinking…") : t("Working…")}
              <Show when={elapsed()}><span class="elapsed">{elapsed()}</span></Show>
              <span class="hint">{t("Esc to interrupt")}</span>
            </div>
          </Show>
        </div>
        <Show when={away()}>
          <div class="chat-pill-dock">
            <Show when={pending()} fallback={<button class="chat-pill" onClick={toBottom}><Icon name="down" size={12} /> {t("Jump to latest")}</button>}>
              <button class="chat-pill warn" onClick={toPending}><Icon name="alert" size={12} /> {t("Waiting for your approval")}</button>
            </Show>
          </div>
        </Show>
      </div>
      <ChatComposer ctrl={ctrl} session={session()} agentLabel={meta().label} focused={props.focused} onSent={() => (stick = true)} />
    </div>
  );
}
