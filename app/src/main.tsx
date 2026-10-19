import { render } from "solid-js/web";
import "@xterm/xterm/css/xterm.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import "./styles.css";
import { App } from "./components/app";
import { installKeymap } from "./lib/commands";
import { store } from "./lib/store";

installKeymap();
// Dev builds expose internals to the WebDriver end-to-end tests (scripts/e2e).
if (import.meta.env.DEV) {
  void Promise.all([import("./lib/terminal-host"), import("./lib/commands")]).then(([th, cmds]) => {
    (window as any).__erka = { store, views: th.allViews, peekView: th.peekView, commands: cmds.commands };
  });
}
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
