import { Match, Show, Switch, createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import { EditorView } from "@codemirror/view";
import { Compartment, EditorSelection } from "@codemirror/state";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { openUrl } from "@tauri-apps/plugin-opener";
import { store } from "../lib/store";
import { onEvent, readFile, writeFile } from "../lib/ipc";
import { baseExtensions, languageFor } from "../lib/codemirror";
import { isMac } from "../lib/platform";
import type { FileContent, Project } from "../lib/types";

const EDIT_LIMIT = 5 << 20; // larger files open read-only (first 5 MiB)
const IMAGE_EXT: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", ico: "image/x-icon", bmp: "image/bmp", avif: "image/avif" };

const ext = (path: string) => path.split(".").pop()?.toLowerCase() ?? "";

export function FileViewer(props: { project: Project; path: string; line?: number; focused: boolean }) {
  const kind = () => (IMAGE_EXT[ext(props.path)] ? "image" : ext(props.path) === "md" || ext(props.path) === "markdown" ? "markdown" : "text");
  const [mode, setMode] = createSignal<"preview" | "edit">(kind() === "markdown" ? "preview" : "edit");
  return (
    <div class="viewer">
      <div class="viewer-bar">
        <span class="path" title={props.path}>&lrm;{props.path}</span>
        <Show when={kind() === "markdown"}>
          <div class="toggles">
            <button class={`toggle${mode() === "preview" ? " on" : ""}`} onClick={() => setMode("preview")}>Preview</button>
            <button class={`toggle${mode() === "edit" ? " on" : ""}`} onClick={() => setMode("edit")}>Edit</button>
          </div>
        </Show>
      </div>
      <Switch>
        <Match when={kind() === "image"}><ImageView project={props.project} path={props.path} /></Match>
        <Match when={kind() === "markdown" && mode() === "preview"}><MarkdownView project={props.project} path={props.path} /></Match>
        <Match when={true}><TextEditor project={props.project} path={props.path} line={props.line} focused={props.focused} /></Match>
      </Switch>
    </div>
  );
}

function ImageView(props: { project: Project; path: string }) {
  const [src, setSrc] = createSignal<string | null>(null);
  const [info, setInfo] = createSignal("");
  onMount(async () => {
    try {
      const f = await readFile(props.project.path, props.path, 40 << 20, true);
      setSrc(`data:${IMAGE_EXT[ext(props.path)]};base64,${f.base64}`);
      setInfo(`${(f.size / 1024).toFixed(1)} KB`);
    } catch (e) {
      store.notify(String(e));
    }
  });
  return (
    <div class="image-view" title={info()}>
      <Show when={src()}><img src={src()!} alt={props.path} /></Show>
    </div>
  );
}

function MarkdownView(props: { project: Project; path: string }) {
  const [html, setHtml] = createSignal("");
  const load = async () => {
    const f = await readFile(props.project.path, props.path, 4 << 20).catch(() => null);
    const raw = await marked.parse(f?.text ?? "", { gfm: true, async: true });
    setHtml(DOMPurify.sanitize(raw));
  };
  onMount(() => {
    void load();
    const un = onEvent<{ root: string; dirs: string[] }>("fs-changed", (e) => {
      const dir = props.path.includes("/") ? props.path.slice(0, props.path.lastIndexOf("/")) : "";
      if (e.root === props.project.path && e.dirs.includes(dir)) void load();
    });
    onCleanup(() => void un.then((f) => f()));
  });
  // Links never navigate the app window; Ctrl/Cmd+click opens the system browser.
  const onClick = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    if (/^https?:/i.test(href) && (isMac ? e.metaKey : e.ctrlKey)) void openUrl(href);
  };
  return <div class="markdown" innerHTML={html()} onClick={onClick} />;
}

function TextEditor(props: { project: Project; path: string; line?: number; focused: boolean }) {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  const language = new Compartment();
  const [file, setFile] = createSignal<FileContent | null>(null);
  const [dirty, setDirty] = createSignal(false);
  const [external, setExternal] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let mtime = 0;
  let loadedText = "";

  const readOnly = () => !!file() && (file()!.truncated || file()!.binary);

  async function save(force = false) {
    if (!view || readOnly()) return;
    const text = view.state.doc.toString();
    try {
      const r = await writeFile(props.project.path, props.path, text, mtime, force);
      if (r.conflict) {
        if (confirm(`${props.path} changed on disk since it was opened. Overwrite it?`)) return save(true);
        return;
      }
      mtime = r.mtime;
      loadedText = text;
      setDirty(false);
      setExternal(false);
    } catch (e) {
      store.notify(`Save failed: ${e}`);
    }
  }

  async function load(initial: boolean) {
    try {
      const f = await readFile(props.project.path, props.path, EDIT_LIMIT);
      if (!initial && f.mtime === mtime) return;
      setFile(f);
      mtime = f.mtime;
      if (f.binary) return setError(`Binary file (${(f.size / 1024).toFixed(1)} KB) — not shown.`);
      const text = f.text ?? "";
      loadedText = text;
      if (!view) {
        view = new EditorView({
          parent: host,
          doc: text,
          extensions: [
            baseExtensions({ readOnly: f.truncated, onSave: () => void save() }),
            language.of([]),
            EditorView.updateListener.of((u) => u.docChanged && setDirty(u.state.doc.toString() !== loadedText)),
          ],
        });
        void languageFor(props.path).then((lang) => lang && view?.dispatch({ effects: language.reconfigure(lang) }));
        if (props.line) goToLine(props.line);
      } else {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
        setDirty(false);
      }
    } catch (e) {
      setError(String(e));
    }
  }

  function goToLine(line: number) {
    if (!view) return;
    const l = view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines));
    view.dispatch({ selection: EditorSelection.cursor(l.from), effects: EditorView.scrollIntoView(l.from, { y: "center" }) });
    view.focus();
  }

  onMount(() => {
    void load(true);
    const un = onEvent<{ root: string; dirs: string[] }>("fs-changed", (e) => {
      const dir = props.path.includes("/") ? props.path.slice(0, props.path.lastIndexOf("/")) : "";
      if (e.root !== props.project.path || !e.dirs.includes(dir)) return;
      if (dirty()) setExternal(true);
      else void load(false);
    });
    onCleanup(() => {
      void un.then((f) => f());
      view?.destroy();
    });
  });

  createEffect(on(() => props.line, (line) => line && goToLine(line), { defer: true }));
  createEffect(() => props.focused && queueMicrotask(() => view?.focus()));

  return (
    <>
      <Show when={dirty() || readOnly() || external()}>
        <div class="viewer-bar" style={{ "border-top": "0" }}>
          <Show when={dirty()}><span class="dirty">● Unsaved — {isMac ? "⌘" : "Ctrl"}+S to save</span></Show>
          <Show when={readOnly() && file()?.truncated}><span>Read-only: showing the first 5 MiB of {(file()!.size / 1048576).toFixed(1)} MiB</span></Show>
          <Show when={external()}>
            <span style={{ color: "var(--waiting)" }}>Changed on disk.</span>
            <button class="btn" style={{ height: "22px" }} onClick={() => { setDirty(false); setExternal(false); void load(true); }}>Reload</button>
          </Show>
        </div>
      </Show>
      <Show when={error()}><div class="muted">{error()}</div></Show>
      <div class="cm-host" ref={host} />
    </>
  );
}
