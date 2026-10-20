// Command registry + keymap. One table drives keyboard shortcuts and the command palette.
//
// Defaults avoid stealing keys TUIs need: on Windows/Linux app commands use Ctrl+Shift
// (Ctrl+P/J/K/O/G… are used by Claude Code, Codex, OMP and readline); on macOS Cmd is
// never sent to the terminal, so plain Cmd chords are safe.
import { open } from "@tauri-apps/plugin-dialog";
import { store } from "./store";
import { cyclePane } from "./layout";
import { chordLabel, isMac } from "./platform";
import { allViews, peekView, setAppShortcutMatcher, setOverlayCheck } from "./terminal-host";
import { navBack, navForward } from "./nav-history";
import { addExistingWorktrees } from "./worktrees";
import type { SessionKind } from "./types";

export interface Command {
  id: string;
  label: string;
  /** Chord per platform, e.g. "mod+shift+p". `mod` = Cmd on macOS, Ctrl elsewhere. */
  win?: string;
  mac?: string;
  run: () => void;
  when?: () => boolean;
}

const pid = () => store.state.activeProject;
const hasProject = () => !!pid();

function focusedPane() {
  const p = pid();
  const tab = p ? store.activeTab(p) : undefined;
  return p && tab ? { projectId: p, tab, paneId: tab.focus } : null;
}

function newSession(kind: SessionKind, where: "tab" | "right" | "down" = "tab") {
  const p = pid();
  if (p) void store.newSession(p, kind, { where });
}

export async function pickProjectFolder() {
  const dir = await open({ directory: true, multiple: false, title: "Add project folder" });
  if (typeof dir !== "string") return;
  const id = store.addProject(dir);
  // A repository's other worktrees come along, under it.
  const p = store.state.projects.find((x) => x.id === id);
  if (p && !p.parentId) void addExistingWorktrees(p).catch(() => {});
}

function zoom(delta: number) {
  const size = delta === 0 ? 13 : Math.min(28, Math.max(8, store.state.settings.fontSize + delta));
  store.setSettings({ fontSize: size });
  for (const v of allViews()) v.applySettings(store.state.settings);
}

export const commands: Command[] = [
  { id: "palette", label: "Search Everything", win: "mod+shift+p", mac: "mod+shift+p", run: () => store.setOverlay("palette") },
  { id: "quickopen", label: "Go to File…", win: "mod+shift+o", mac: "mod+p", run: () => store.setOverlay("quickopen"), when: hasProject },
  { id: "jump", label: "Jump to Session / Project…", win: "mod+shift+k", mac: "mod+k", run: () => store.setOverlay("jump") },
  { id: "dashboard", label: "Toggle Agent Dashboard", win: "mod+shift+m", mac: "mod+shift+m", run: () => store.setOverlay(store.overlay() === "dashboard" ? null : "dashboard") },
  { id: "project.add", label: "Add Project Folder…", run: () => void pickProjectFolder() },
  { id: "board", label: "Toggle Workspace Board", win: "mod+shift+j", mac: "mod+shift+j", run: () => store.setOverlay(store.overlay() === "board" ? null : "board") },
  { id: "new.shell", label: "New Terminal", win: "mod+shift+t", mac: "mod+t", run: () => newSession("shell"), when: hasProject },
  { id: "panel.history", label: "Agent Session History", run: () => store.showRightPanel("history"), when: hasProject },
  { id: "new.menu", label: "New Session…", win: "mod+shift+n", mac: "mod+shift+n", run: () => store.setOverlay("newsession"), when: hasProject },
  { id: "new.claude", label: "New Claude Code Session", run: () => newSession("claude"), when: hasProject },
  { id: "new.codex", label: "New Codex Session", run: () => newSession("codex"), when: hasProject },
  { id: "new.omp", label: "New OMP Session", run: () => newSession("omp"), when: hasProject },
  { id: "split.right", label: "Split Right (Terminal)", win: "mod+shift+d", mac: "mod+d", run: () => newSession("shell", "right"), when: hasProject },
  { id: "split.down", label: "Split Down (Terminal)", win: "mod+shift+s", mac: "mod+shift+d", run: () => newSession("shell", "down"), when: hasProject },
  {
    id: "pane.close", label: "Close Pane", win: "mod+shift+w", mac: "mod+w", when: hasProject,
    run: () => {
      const f = focusedPane();
      if (!f) return;
      const pane = f.tab && findInTab(f.tab, f.paneId);
      const s = pane?.sessionId ? store.sessions[pane.sessionId] : undefined;
      if (s?.alive && s.kind !== "shell" && !confirm(`Stop ${s.kind} and close this pane?`)) return;
      void store.closePane(f.projectId, f.tab.id, f.paneId);
    },
  },
  {
    id: "pane.next", label: "Focus Next Pane", win: "alt+]", mac: "mod+]", when: hasProject,
    run: () => { const f = focusedPane(); if (f) store.focusPane(f.projectId, f.tab.id, cyclePane(f.tab.root, f.paneId, 1)); },
  },
  {
    id: "pane.prev", label: "Focus Previous Pane", win: "alt+[", mac: "mod+[", when: hasProject,
    run: () => { const f = focusedPane(); if (f) store.focusPane(f.projectId, f.tab.id, cyclePane(f.tab.root, f.paneId, -1)); },
  },
  { id: "tab.next", label: "Next Tab", win: "ctrl+tab", mac: "ctrl+tab", run: () => store.cycleTab(1) },
  { id: "tab.prev", label: "Previous Tab", win: "ctrl+shift+tab", mac: "ctrl+shift+tab", run: () => store.cycleTab(-1) },
  { id: "panel.files", label: "Toggle Explorer", win: "mod+shift+e", mac: "mod+shift+e", run: () => store.setRightPanel("files"), when: hasProject },
  { id: "panel.git", label: "Toggle Source Control", win: "mod+shift+g", mac: "mod+shift+g", run: () => store.setRightPanel("git"), when: hasProject },
  { id: "panel.search", label: "Search in Files", win: "mod+shift+h", mac: "mod+shift+f", run: () => store.showRightPanel("search"), when: hasProject },
  {
    id: "pane.zoom", label: "Toggle Maximize Pane", win: "mod+shift+enter", mac: "mod+shift+enter", when: hasProject,
    run: () => { const f = focusedPane(); if (f) store.toggleZoom(f.tab.id, f.paneId); },
  },
  { id: "sidebar", label: "Toggle Sidebar", win: "mod+shift+b", mac: "mod+b", run: () => store.setSettings({ sidebarCollapsed: !store.state.settings.sidebarCollapsed }) },
  {
    id: "find", label: "Find in Terminal", win: "mod+shift+f", mac: "mod+f",
    run: () => window.dispatchEvent(new CustomEvent("erka:find")),
    // Pages and dialogs have their own find (e.g. Settings search).
    when: () => store.overlay() === null,
  },
  { id: "settings", label: "Settings", win: "mod+,", mac: "mod+,", run: () => store.openSettings() },
  // Alt+Shift+Arrow, not Alt+Arrow: shells use Alt+Arrow for word movement.
  { id: "nav.back", label: "Go Back", win: "shift+alt+arrowleft", mac: "mod+alt+arrowleft", run: navBack, when: () => hasProject() && store.overlay() === null },
  { id: "nav.forward", label: "Go Forward", win: "shift+alt+arrowright", mac: "mod+alt+arrowright", run: navForward, when: () => hasProject() && store.overlay() === null },
  { id: "zoom.in", label: "Increase Font Size", win: "mod+=", mac: "mod+=", run: () => zoom(1) },
  { id: "zoom.out", label: "Decrease Font Size", win: "mod+-", mac: "mod+-", run: () => zoom(-1) },
  { id: "zoom.reset", label: "Reset Font Size", win: "mod+0", mac: "mod+0", run: () => zoom(0) },
  {
    id: "terminal.clear", label: "Clear Terminal Buffer", when: hasProject,
    run: () => {
      const f = focusedPane();
      const pane = f && findInTab(f.tab, f.paneId);
      if (pane?.sessionId) peekView(pane.sessionId)?.term.clear();
    },
  },
];

function findInTab(tab: { root: import("./types").LayoutNode }, paneId: string) {
  const walk = (n: import("./types").LayoutNode): import("./types").Pane | undefined =>
    n.type === "leaf" ? (n.pane.id === paneId ? n.pane : undefined) : walk(n.a) ?? walk(n.b);
  return walk(tab.root);
}

// Project switching: Alt+1..9 (Windows) / Cmd+1..9 (macOS).
for (let i = 1; i <= 9; i++) {
  commands.push({
    id: `project.${i}`,
    label: `Switch to Project ${i}`,
    win: `alt+${i}`,
    mac: `mod+${i}`,
    run: () => {
      const p = store.topProjects()[i - 1];
      if (p) store.switchProject(p.id);
    },
  });
}

export function eventChord(e: KeyboardEvent): string {
  const parts: string[] = [];
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (mod) parts.push("mod");
  if (isMac && e.ctrlKey) parts.push("ctrl");
  if (!isMac && e.metaKey) parts.push("meta");
  if (e.shiftKey) parts.push("shift");
  if (e.altKey) parts.push("alt");
  let key = e.key.toLowerCase();
  // Use the physical key for digits/punctuation so Shift/Alt layouts still match.
  if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (e.code === "BracketLeft") key = "[";
  else if (e.code === "BracketRight") key = "]";
  else if (e.code === "Equal") key = "=";
  else if (e.code === "Minus") key = "-";
  else if (e.code === "Comma") key = ",";
  else if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase();
  // Numpad keys by name: "+" itself would be read as a separator.
  else if (/^Numpad/.test(e.code)) key = e.code.toLowerCase();
  parts.push(key);
  return parts.join("+");
}

const MODIFIER_ORDER = ["mod", "ctrl", "meta", "shift", "alt"];

/** Canonical form for comparing chords: "ctrl" is `mod` off macOS, modifiers in a fixed order. */
export function normalizeChord(chord: string): string {
  const parts = chord.toLowerCase().split("+").filter(Boolean).map((p) => (!isMac && p === "ctrl" ? "mod" : p));
  const key = parts.pop() ?? "";
  const mods = [...new Set(parts)].sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b));
  return [...mods, key].join("+");
}

export const defaultChordOf = (c: Command) => (isMac ? c.mac : c.win);

/** The user's override (from Settings → Shortcuts) or the default; "" means unbound. */
export function chordOf(c: Command): string | undefined {
  const override = store.state.keymap?.[c.id];
  return override !== undefined ? override || undefined : defaultChordOf(c);
}

/** Commands bound to `chord`, optionally ignoring one command. */
export function commandsWithChord(chord: string, except?: string): Command[] {
  const n = normalizeChord(chord);
  return commands.filter((c) => c.id !== except && chordOf(c) && normalizeChord(chordOf(c)!) === n);
}

/** While the shortcut editor records a key, no command may run. */
let suspended = false;
export const suspendKeymap = (on: boolean) => (suspended = on);

function match(e: KeyboardEvent): Command | undefined {
  if (suspended) return undefined;
  const chord = normalizeChord(eventChord(e));
  return commands.find((c) => {
    const k = chordOf(c);
    return k && normalizeChord(k) === chord && (!c.when || c.when());
  });
}

/** Chords already explained this session (one toast per chord). */
const explained = new Set<string>();

function explainIntercept(cmd: Command) {
  const chord = chordOf(cmd);
  if (!chord || explained.has(cmd.id) || !store.state.settings.shortcutHints) return;
  explained.add(cmd.id);
  store.notify(`${chordLabel(chord)} → ${cmd.label} (kept from the terminal)`, {
    label: "Don't show again",
    run: () => store.setSettings({ shortcutHints: false }),
  }, 5000);
}

export function installKeymap() {
  setOverlayCheck(() => store.overlay() !== null);
  setAppShortcutMatcher((e, fromTerminal) => {
    const cmd = match(e);
    if (cmd && fromTerminal) explainIntercept(cmd);
    return !!cmd;
  });
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.isComposing) return;
      const cmd = match(e);
      if (!cmd) return;
      e.preventDefault();
      e.stopPropagation();
      // The terminal never sees this key; tell the user once why.
      if ((e.target as HTMLElement | null)?.closest?.(".xterm")) explainIntercept(cmd);
      cmd.run();
    },
    true,
  );
}
