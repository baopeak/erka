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
import { CsvView, MermaidView, NotebookView, PdfView, renderMermaidBlocks } from "./rich-viewers";
import type { FileContent, Project } from "../lib/types";
import { msg, t } from "../lib/i18n";

const EDIT_LIMIT = 5 << 20; // larger files open read-only (first 5 MiB)
const IMAGE_EXT: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", ico: "image/x-icon", bmp: "image/bmp", avif: "image/avif" };

const ext = (path: string) => path.split(".").pop()?.toLowerCase() ?? "";

type Kind = "image" | "pdf" | "markdown" | "csv" | "notebook" | "mermaid" | "text";

function kindOf(path: string): Kind {
  const e = ext(path);
  if (IMAGE_EXT[e]) return "image";
  if (e === "pdf") return "pdf";
  if (e === "md" || e === "markdown") return "markdown";
  if (e === "csv" || e === "tsv") return "csv";
  if (e === "ipynb") return "notebook";
  if (e === "mmd" || e === "mermaid") return "mermaid";
  return "text";
}

/** Label of the rendered view for kinds that also have an editable source. */
const RENDERED: Partial<Record<Kind, string>> = { markdown: msg("Preview"), csv: msg("Table"), notebook: msg("Notebook"), mermaid: msg("Diagram") };

export function FileViewer(props: { project: Project; path: string; line?: number; focused: boolean }) {
  const kind = () => kindOf(props.path);
  // Opening at a line (search hit, go to file) means the source.
  const [mode, setMode] = createSignal<"rendered" | "source">(RENDERED[kindOf(props.path)] && !props.line ? "rendered" : "source");
  return (
    <div class="viewer">
      <div class="viewer-bar">
        <span class="path" title={props.path}>&lrm;{props.path}</span>
        <Show when={RENDERED[kind()]}>
          <div class="toggles">
            <button class={`toggle${mode() === "rendered" ? " on" : ""}`} onClick={() => setMode("rendered")}>{t(RENDERED[kind()]!)}</button>
            <button class={`toggle${mode() === "source" ? " on" : ""}`} onClick={() => setMode("source")}>{kind() === "markdown" ? t("Edit") : t("Source")}</button>
          </div>
        </Show>
        <Show when={kind() === "text" || mode() === "source"}>
          <button class={`toggle${store.state.settings.wordWrap ? " on" : ""}`} title={t("Word wrap (Alt+Z)")} onClick={() => store.setSettings({ wordWrap: !store.state.settings.wordWrap })}>{t("Wrap")}</button>
        </Show>
      </div>
      <Switch>
        <Match when={kind() === "image"}><ImageView project={props.project} path={props.path} /></Match>
        <Match when={kind() === "pdf"}><PdfView project={props.project} path={props.path} /></Match>
        <Match when={kind() === "markdown" && mode() === "rendered"}><MarkdownView project={props.project} path={props.path} /></Match>
        <Match when={kind() === "csv" && mode() === "rendered"}><CsvView project={props.project} path={props.path} /></Match>
        <Match when={kind() === "notebook" && mode() === "rendered"}><NotebookView project={props.project} path={props.path} /></Match>
        <Match when={kind() === "mermaid" && mode() === "rendered"}><MermaidView project={props.project} path={props.path} /></Match>
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
  let el!: HTMLDivElement;
  const load = async () => {
    const f = await readFile(props.project.path, props.path, 4 << 20).catch(() => null);
    const raw = await marked.parse(f?.text ?? "", { gfm: true, async: true });
    setHtml(DOMPurify.sanitize(raw));
    if (el.querySelector("code.language-mermaid")) void renderMermaidBlocks(el);
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
  return <div class="markdown" ref={el} innerHTML={html()} onClick={onClick} />;
}

function TextEditor(props: { project: Project; path: string; line?: number; focused: boolean }) {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  const language = new Compartment();
  const wrap = new Compartment();
  const wrapExt = () => (store.state.settings.wordWrap ? EditorView.lineWrapping : []);
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
        if (confirm(t("{path} changed on disk since it was opened. Overwrite it?", { path: props.path }))) return save(true);
        return;
      }
      mtime = r.mtime;
      loadedText = text;
      setDirty(false);
      setExternal(false);
    } catch (e) {
      store.notify(t("Save failed: {error}", { error: String(e) }));
    }
  }

  async function load(initial: boolean) {
    try {
      const f = await readFile(props.project.path, props.path, EDIT_LIMIT);
      if (!initial && f.mtime === mtime) return;
      setFile(f);
      mtime = f.mtime;
      if (f.binary) return setError(t("Binary file ({size} KB) — not shown.", { size: (f.size / 1024).toFixed(1) }));
      const text = f.text ?? "";
      loadedText = text;
      if (!view) {
        view = new EditorView({
          parent: host,
          doc: text,
          extensions: [
            baseExtensions({ readOnly: f.truncated, onSave: () => void save() }),
            language.of([]),
            wrap.of(wrapExt()),
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
  createEffect(on(() => store.state.settings.wordWrap, () => view?.dispatch({ effects: wrap.reconfigure(wrapExt()) }), { defer: true }));
  createEffect(() => props.focused && queueMicrotask(() => view?.focus()));

  return (
    <>
      <Show when={dirty() || readOnly() || external()}>
        <div class="viewer-bar" style={{ "border-top": "0" }}>
          <Show when={dirty()}><span class="dirty">● {t("Unsaved — {key}+S to save", { key: isMac ? "⌘" : "Ctrl" })}</span></Show>
          <Show when={readOnly() && file()?.truncated}><span>{t("Read-only: showing the first 5 MiB of {size} MiB", { size: (file()!.size / 1048576).toFixed(1) })}</span></Show>
          <Show when={external()}>
            <span style={{ color: "var(--waiting)" }}>{t("Changed on disk.")}</span>
            <button class="btn" style={{ height: "22px" }} onClick={() => { setDirty(false); setExternal(false); void load(true); }}>{t("Reload")}</button>
          </Show>
        </div>
      </Show>
      <Show when={error()}><div class="muted">{error()}</div></Show>
      <div class="cm-host" ref={host} />
    </>
  );
}
