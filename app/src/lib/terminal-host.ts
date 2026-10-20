// xterm.js lifecycle for terminal panes.
//
// Policy (performance is the point of the whole app):
// - A view exists only for terminals the user has looked at. Visible views get a WebGL
//   renderer; hidden ("parked") views drop WebGL (browsers cap live contexts ~16) and
//   unsubscribe from the daemon, but keep their buffer so re-showing is a tiny delta replay.
// - At most MAX_PARKED parked views are kept; older ones are disposed and rebuilt from the
//   daemon's snapshot when shown again.
// - The daemon owns the truth. Background sessions cost the UI nothing.
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { attachTerminal, b64ToBytes, daemon, detachTerminal, sendInput } from "./ipc";
import { isMac } from "./platform";
import { terminalTheme } from "./theme";
import type { Settings } from "./types";

const MAX_PARKED = 16;

/** Device reports xterm emits on its own (DA, DSR/CPR, OSC colour replies, focus events). */
export function isTerminalReply(data: string): boolean {
  return /^(\x1b\[[?>=]?[\d;]*[cnR]|\x1b\][\d;]+;[^\x07\x1b]*(\x07|\x1b\\)|\x1b\[[IO])+$/.test(data);
}

/** Set by the keymap: returns true when the event is an app shortcut xterm must not eat. */
let isAppShortcut: (e: KeyboardEvent, fromTerminal: boolean) => boolean = () => false;
export const setAppShortcutMatcher = (fn: (e: KeyboardEvent, fromTerminal: boolean) => boolean) => (isAppShortcut = fn);
/** True while a palette/dialog is open: keys must not reach the terminal underneath. */
let overlayOpen: () => boolean = () => false;
export const setOverlayCheck = (fn: () => boolean) => (overlayOpen = fn);

export class TermView {
  readonly el = document.createElement("div");
  readonly term: Terminal;
  readonly fit = new FitAddon();
  readonly search = new SearchAddon();
  private webgl: WebglAddon | null = null;
  handle: number | null = null;
  /** Subscribed to the daemon (set at the start of attach so effects never double-attach). */
  attached = false;
  /** Stream offset of the last byte written into this buffer (for delta re-attach). */
  lastSeq: number | null = null;
  private opened = false;
  private attachGen = 0;
  private suppressReplies = 0;
  /** Live output that raced ahead of the attach reply, with its stream offset. */
  private early: { seq: number; data: Uint8Array }[] | null = null;
  /** Detach/attach run strictly in order per view (a remount parks then re-attaches). */
  private op: Promise<unknown> = Promise.resolve();
  private sessionSize: [number, number] = [0, 0];
  private resizeObs: ResizeObserver | null = null;
  private resizeTimer = 0;
  focused = false;

  constructor(readonly sessionId: string, private settings: Settings) {
    this.el.className = "term-host";
    this.term = new Terminal({
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      lineHeight: settings.lineHeight,
      scrollback: settings.scrollback,
      cursorBlink: settings.cursorBlink,
      cursorStyle: "bar",
      cursorWidth: 2,
      allowProposedApi: true,
      theme: terminalTheme,
      macOptionIsMeta: true,
      drawBoldTextInBrightColors: false,
      rescaleOverlappingGlyphs: true,
      customGlyphs: true,
      fastScrollSensitivity: 5,
      smoothScrollDuration: 0,
      scrollOnUserInput: true,
    });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = "11";
    // Links open only on Ctrl/Cmd+click: terminal text never triggers actions implicitly.
    this.term.loadAddon(new WebLinksAddon((e, uri) => {
      if (isMac ? e.metaKey : e.ctrlKey) void openUrl(uri);
    }));
    this.term.onData((d) => this.input(d));
    this.term.onBinary((d) => this.input(d, true));
    this.term.attachCustomKeyEventHandler((e) => this.onKey(e));
    this.term.textarea?.addEventListener("focus", () => (this.focused = true));
  }

  private input(data: string, binary = false) {
    if (this.handle == null) return;
    // While a raw replay is written, xterm re-answers old queries; drop only those replies,
    // never the user's keystrokes.
    if (this.suppressReplies > 0 && isTerminalReply(data)) return;
    void sendInput(this.handle, data, binary);
  }

  write(data: Uint8Array | string) {
    this.term.write(data);
  }

  private onKey(e: KeyboardEvent): boolean {
    if (overlayOpen()) return false;
    if (e.type !== "keydown") return true;
    if (isAppShortcut(e, true)) return false;
    const key = e.key.toLowerCase();
    if (!isMac && e.ctrlKey && !e.altKey) {
      if (key === "c" && (e.shiftKey || this.term.hasSelection())) {
        if (this.term.hasSelection()) {
          void writeText(this.term.getSelection());
          this.term.clearSelection();
        }
        e.preventDefault();
        return false;
      }
      if (key === "v") {
        e.preventDefault();
        void this.pasteFromClipboard();
        return false;
      }
    }
    if (isMac && e.metaKey && key === "v") {
      e.preventDefault();
      void this.pasteFromClipboard();
      return false;
    }
    if (isMac && e.metaKey && key === "c") {
      if (this.term.hasSelection()) void writeText(this.term.getSelection());
      return false;
    }
    // Shift+Enter → ESC CR, the "newline without submit" agents (Claude Code, OMP) accept.
    if (key === "enter" && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      this.input("\x1b\r");
      return false;
    }
    return true;
  }

  async pasteFromClipboard() {
    const text = await readText().catch(() => "");
    if (text) this.term.paste(text);
  }

  paste(text: string) {
    this.term.paste(text);
  }

  mount(parent: HTMLElement) {
    parent.appendChild(this.el);
    if (!this.opened) {
      this.term.open(this.el);
      this.opened = true;
    }
    this.enableWebgl();
    this.resizeObs = new ResizeObserver(() => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = window.setTimeout(() => this.fitNow(), 40);
    });
    this.resizeObs.observe(parent);
    this.fitNow();
  }

  unmount() {
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    this.disableWebgl();
    this.el.remove();
  }

  private enableWebgl() {
    if (!this.settings.webgl || this.webgl) return;
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => {
        addon.dispose();
        if (this.webgl === addon) this.webgl = null;
      });
      this.term.loadAddon(addon);
      this.webgl = addon;
    } catch {
      this.webgl = null; // DOM renderer fallback
    }
  }

  private disableWebgl() {
    this.webgl?.dispose();
    this.webgl = null;
  }

  fitNow() {
    if (!this.el.isConnected) return;
    const dims = this.fit.proposeDimensions();
    if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows) || dims.cols < 2 || dims.rows < 1) return;
    if (dims.cols !== this.term.cols || dims.rows !== this.term.rows) this.term.resize(dims.cols, dims.rows);
    if (this.handle != null && (this.sessionSize[0] !== dims.cols || this.sessionSize[1] !== dims.rows)) {
      this.sessionSize = [dims.cols, dims.rows];
      void daemon("session.resize", { handle: this.handle, cols: dims.cols, rows: dims.rows }).catch(() => {});
    }
  }

  /** Subscribes to the daemon session; replays only what this buffer is missing. */
  attach(handle: number): Promise<void> {
    const gen = ++this.attachGen;
    this.attached = true;
    const run = this.op.then(() => this.doAttach(handle, gen));
    this.op = run.catch(() => {});
    return run;
  }

  private async doAttach(handle: number, gen: number) {
    if (gen !== this.attachGen) return;
    if (this.handle !== handle) this.lastSeq = null; // different stream (daemon restarted)
    this.handle = handle;
    this.early = [];
    const reply = await attachTerminal(handle, this.lastSeq, (seq, data) => {
      if (gen !== this.attachGen) return;
      if (this.early) {
        this.early.push({ seq, data });
        return;
      }
      this.write(data);
      this.lastSeq = seq;
    }).catch((e) => {
      console.warn("attach failed", e);
      if (gen === this.attachGen) this.attached = false;
      return null;
    });
    if (!reply || gen !== this.attachGen) return;
    const bytes = b64ToBytes(reply.data);
    if (reply.mode === "reset") {
      this.term.reset();
      if (reply.cols > 0 && (reply.cols !== this.term.cols || reply.rows !== this.term.rows)) this.term.resize(reply.cols, reply.rows);
    }
    this.sessionSize = [reply.cols, reply.rows];
    if (bytes.length) {
      if (reply.raw) {
        // Replayed bytes may contain terminal queries; the app already got its answers.
        this.suppressReplies++;
        this.term.write(bytes, () => this.suppressReplies--);
      } else {
        this.term.write(bytes);
      }
    }
    const early = this.early;
    this.early = null;
    this.lastSeq = reply.seq;
    // Chunks covered by the reply (seq <= reply.seq) were already included in it.
    for (const chunk of early ?? []) {
      if (chunk.seq <= reply.seq) continue;
      this.write(chunk.data);
      this.lastSeq = chunk.seq;
    }
    this.fitNow();
  }

  detach(): Promise<void> {
    this.attachGen++;
    this.attached = false;
    this.early = null;
    const handle = this.handle;
    const run = this.op.then(() => (handle != null ? detachTerminal(handle).catch(() => {}) : undefined));
    this.op = run;
    return run;
  }

  focus() {
    this.term.focus();
  }

  dispose() {
    this.attachGen++;
    this.unmount();
    this.term.dispose();
  }

  applySettings(s: Settings) {
    this.settings = s;
    Object.assign(this.term.options, {
      fontFamily: s.fontFamily,
      fontSize: s.fontSize,
      lineHeight: s.lineHeight,
      cursorBlink: s.cursorBlink,
      scrollback: s.scrollback,
    });
    this.fitNow();
  }
}

const views = new Map<string, TermView>();
const parked: string[] = [];

export function getView(sessionId: string, settings: Settings): TermView {
  let v = views.get(sessionId);
  if (!v) {
    v = new TermView(sessionId, settings);
    views.set(sessionId, v);
  }
  const i = parked.indexOf(sessionId);
  if (i >= 0) parked.splice(i, 1);
  return v;
}

export const peekView = (sessionId: string) => views.get(sessionId);
export const allViews = () => [...views.values()];

/** Pane hidden: stop rendering and streaming but keep the buffer for a fast return. */
export function parkView(sessionId: string) {
  const v = views.get(sessionId);
  if (!v) return;
  v.unmount();
  void v.detach();
  if (!parked.includes(sessionId)) parked.push(sessionId);
  while (parked.length > MAX_PARKED) disposeView(parked.shift()!);
}

export function disposeView(sessionId: string) {
  const v = views.get(sessionId);
  if (!v) return;
  void v.detach();
  v.dispose();
  views.delete(sessionId);
  const i = parked.indexOf(sessionId);
  if (i >= 0) parked.splice(i, 1);
}

/** Daemon reconnected: handles may have changed, buffers must be rebuilt from snapshots. */
export function resetStreams() {
  for (const v of views.values()) {
    v.lastSeq = null;
    v.handle = null;
    v.attached = false;
  }
}
