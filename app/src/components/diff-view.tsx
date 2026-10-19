import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { gitFileVersions, onEvent } from "../lib/ipc";
import { baseExtensions, languageFor } from "../lib/codemirror";
import { store } from "../lib/store";
import type { Project } from "../lib/types";

/** HEAD ↔ working tree (or index when `staged`) diff, side by side or unified. */
export function DiffView(props: { project: Project; path: string; staged: boolean }) {
  let host!: HTMLDivElement;
  const [unified, setUnified] = createSignal(host?.clientWidth < 900);
  const [info, setInfo] = createSignal("");
  let destroy: (() => void) | null = null;

  async function render() {
    try {
      const v = await gitFileVersions(props.project.path, props.path, props.staged);
      const lang = await languageFor(props.path);
      const exts = [...baseExtensions({ readOnly: true }), ...(lang ? [lang] : []), EditorView.editable.of(false), EditorState.readOnly.of(true)];
      destroy?.();
      host.replaceChildren();
      const a = v.original ?? "";
      const b = v.modified ?? "";
      setInfo(v.original == null ? "new file" : v.modified == null ? "deleted" : "");
      if (unified()) {
        const view = new EditorView({ parent: host, doc: b, extensions: [...exts, unifiedMergeView({ original: a, mergeControls: false, gutter: true })] });
        destroy = () => view.destroy();
      } else {
        const mv = new MergeView({ parent: host, a: { doc: a, extensions: exts }, b: { doc: b, extensions: exts }, gutter: true, highlightChanges: true, collapseUnchanged: { margin: 3, minSize: 8 } });
        destroy = () => mv.destroy();
      }
    } catch (e) {
      store.notify(String(e));
    }
  }

  onMount(() => {
    if (host.clientWidth && host.clientWidth < 900) setUnified(true);
    void render();
    const un = onEvent<{ root: string; git: boolean }>("fs-changed", (e) => e.root === props.project.path && e.git && void render());
    onCleanup(() => {
      void un.then((f) => f());
      destroy?.();
    });
  });

  return (
    <div class="viewer">
      <div class="viewer-bar">
        <span class="path">&lrm;{props.path}</span>
        <span style={{ color: "var(--text-faint)" }}>{props.staged ? "HEAD ↔ index" : "HEAD ↔ working tree"}{info() ? ` · ${info()}` : ""}</span>
        <div class="toggles">
          <button class={`toggle${!unified() ? " on" : ""}`} onClick={() => { setUnified(false); void render(); }}>Split</button>
          <button class={`toggle${unified() ? " on" : ""}`} onClick={() => { setUnified(true); void render(); }}>Unified</button>
          <button class="toggle" onClick={() => store.openFile(props.project.id, props.path)}>Open file</button>
        </div>
      </div>
      <div class="cm-host" ref={host} style={{ overflow: "auto" }} />
      <Show when={false}><span /></Show>
    </div>
  );
}
