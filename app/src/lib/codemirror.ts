// Shared CodeMirror 6 setup: colours come from the app's CSS variables (dark / light themes
// restyle open editors live), lazy language loading.
import { EditorView, ViewPlugin, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, highlightSpecialChars, rectangularSelection, crosshairCursor } from "@codemirror/view";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting, HighlightStyle, LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { tags as t } from "@lezer/highlight";

const syntax = HighlightStyle.define([
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword, t.operatorKeyword], color: "var(--syn-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--syn-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: "var(--syn-function)" },
  { tag: [t.typeName, t.className, t.namespace, t.tagName], color: "var(--syn-type)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--syn-property)" },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: "var(--syn-punct)" },
  { tag: [t.definition(t.variableName), t.variableName, t.self], color: "var(--syn-variable)" },
  { tag: [t.heading, t.strong], fontWeight: "bold", color: "var(--syn-keyword)" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.link, color: "var(--syn-string)", textDecoration: "underline" },
  { tag: t.invalid, color: "var(--danger)" },
]);

const themeSpec = {
    "&": { backgroundColor: "var(--term-bg)", color: "var(--text)", fontSize: "13px", height: "100%" },
    ".cm-content": { fontFamily: '"JetBrains Mono", "Cascadia Code", Menlo, Consolas, monospace', caretColor: "var(--accent)" },
    ".cm-scroller": { fontFamily: '"JetBrains Mono", "Cascadia Code", Menlo, Consolas, monospace', lineHeight: "1.55" },
    ".cm-gutters": { backgroundColor: "var(--term-bg)", color: "var(--text-faint)", border: "none" },
    ".cm-activeLineGutter": { backgroundColor: "var(--bg-hover)", color: "var(--text-dim)" },
    ".cm-activeLine": { backgroundColor: "var(--cm-active-line)" },
    "&.cm-focused .cm-cursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "rgba(108,182,255,0.25) !important" },
    ".cm-selectionMatch": { backgroundColor: "rgba(242,201,109,0.18)" },
    ".cm-searchMatch": { backgroundColor: "rgba(242,201,109,0.28)", outline: "1px solid rgba(242,201,109,0.5)" },
    ".cm-panels": { backgroundColor: "var(--bg-elev-2)", color: "var(--text)", borderColor: "var(--border-strong)" },
    ".cm-panels input, .cm-panels button": { color: "var(--text)" },
    ".cm-textfield": { backgroundColor: "var(--bg)", border: "1px solid var(--border-strong)", borderRadius: "5px" },
    ".cm-button": { backgroundImage: "none", backgroundColor: "var(--bg-hover)", border: "1px solid var(--border-strong)", borderRadius: "5px" },
    ".cm-foldGutter span": { color: "var(--text-faint)" },
    ".cm-tooltip": { backgroundColor: "var(--bg-elev-2)", border: "1px solid var(--border-strong)" },
    // merge view
    ".cm-changedLine": { backgroundColor: "rgba(108,182,255,0.06)" },
    ".cm-insertedLine, .cm-changedText": { backgroundColor: "rgba(139,213,139,0.14)" },
    ".cm-deletedChunk, .cm-deletedLine": { backgroundColor: "rgba(255,107,122,0.12)" },
    ".cm-merge-a .cm-changedText": { backgroundColor: "rgba(255,107,122,0.22)" },
    ".cm-merge-b .cm-changedText": { backgroundColor: "rgba(139,213,139,0.22)" },
};

// Colours come from CSS variables; the dark flag picks CodeMirror's matching base theme for
// everything Erka does not style (fold placeholders, completion lists, merge gutters).
const darkTheme = EditorView.theme(themeSpec, { dark: true });
const lightTheme = EditorView.theme(themeSpec, { dark: false });
const themeSlot = new Compartment();
let dark = true;
const live = new Set<EditorView>();
const tracker = ViewPlugin.define((view) => {
  live.add(view);
  return { destroy: () => void live.delete(view) };
});

/** Switches every open editor (and new ones) to the dark or light base theme. */
export function setEditorTheme(isDark: boolean) {
  if (dark === isDark) return;
  dark = isDark;
  for (const v of live) v.dispatch({ effects: themeSlot.reconfigure(isDark ? darkTheme : lightTheme) });
}

export function baseExtensions(opts: { readOnly?: boolean; onSave?: () => void } = {}): Extension[] {
  const exts: Extension[] = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(syntax, { fallback: true }),
    bracketMatching(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    keymap.of([
      ...(opts.onSave ? [{ key: "Mod-s", preventDefault: true, run: () => (opts.onSave!(), true) }] : []),
      indentWithTab,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
    ]),
    themeSlot.of(dark ? darkTheme : lightTheme),
    tracker,
  ];
  if (opts.readOnly) exts.push(EditorState.readOnly.of(true), EditorView.editable.of(false));
  return exts;
}

/** Loads the language support for a file name (null for unknown types). */
export async function languageFor(path: string): Promise<Extension | null> {
  const name = path.split("/").pop() ?? path;
  const desc = LanguageDescription.matchFilename(languages, name);
  if (!desc) return null;
  try {
    return await desc.load();
  } catch {
    return null;
  }
}
