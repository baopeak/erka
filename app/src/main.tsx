import { render } from "solid-js/web";
import "@xterm/xterm/css/xterm.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import "./styles.css";
import { App } from "./components/app";
import { installKeymap } from "./lib/commands";
import { startNavHistory } from "./lib/nav-history";
import { store } from "./lib/store";
import { platformInfo } from "./lib/ipc";

// Paint the last used theme before the state file is read (no dark flash in light mode).
try {
  document.documentElement.dataset.theme = localStorage.getItem("erka-theme") ?? "dark";
} catch {
  /* storage unavailable */
}
installKeymap();
startNavHistory();
// Dev builds, and release builds started by the test runner (ERKA_E2E), expose internals to
// the WebDriver end-to-end tests (scripts/e2e).
void (import.meta.env.DEV ? Promise.resolve(true) : platformInfo().then((i) => i.e2e, () => false)).then((expose) => {
  if (!expose) return;
  void Promise.all([import("./lib/terminal-host"), import("./lib/commands"), import("./chat/mode-switch")]).then(([th, cmds, chat]) => {
    (window as any).__erka = { store, views: th.allViews, peekView: th.peekView, commands: cmds.commands, chat };
  });
});
// Terminals measure glyphs once at open: wait for the bundled font before the first render.
void Promise.all([document.fonts.load('13px "JetBrains Mono"'), document.fonts.load('bold 13px "JetBrains Mono"')])
  .catch(() => {})
  .finally(() => {
    void store.init();
    render(() => <App />, document.getElementById("root")!);
  });

// Native context menu / reload shortcuts make no sense in a desktop workbench.
window.addEventListener("contextmenu", (e) => {
  if (!(e.target as HTMLElement).closest("input, textarea, .cm-editor, .markdown, .chat-scroll")) e.preventDefault();
});
