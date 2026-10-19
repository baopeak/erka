// Shared CodeMirror 6 setup: dark theme matching the terminal, lazy language loading.
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, highlightSpecialChars, rectangularSelection, crosshairCursor } from "@codemirror/view";
import { EditorState, type Extension } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting, LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";

export const erkaTheme = EditorView.theme(
  {
    "&": { backgroundColor: "#0e1117", color: "#d7dce6", fontSize: "13px", height: "100%" },
    ".cm-content": { fontFamily: '"JetBrains Mono", "Cascadia Code", Menlo, Consolas, monospace', caretColor: "#6cb6ff" },
    ".cm-scroller": { fontFamily: '"JetBrains Mono", "Cascadia Code", Menlo, Consolas, monospace', lineHeight: "1.55" },
    ".cm-gutters": { backgroundColor: "#0e1117", color: "#4b5263", border: "none" },
    ".cm-activeLineGutter": { backgroundColor: "#151a24", color: "#9aa4b5" },
    ".cm-activeLine": { backgroundColor: "#131824" },
    "&.cm-focused .cm-cursor": { borderLeftColor: "#6cb6ff", borderLeftWidth: "2px" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "rgba(108,182,255,0.25) !important" },
    ".cm-selectionMatch": { backgroundColor: "rgba(242,201,109,0.18)" },
    ".cm-searchMatch": { backgroundColor: "rgba(242,201,109,0.28)", outline: "1px solid rgba(242,201,109,0.5)" },
    ".cm-panels": { backgroundColor: "#161a23", color: "#d7dce6", borderColor: "#2a3246" },
    ".cm-panels input, .cm-panels button": { color: "#d7dce6" },
    ".cm-textfield": { backgroundColor: "#0b0d12", border: "1px solid #2a3246", borderRadius: "5px" },
    ".cm-button": { backgroundImage: "none", backgroundColor: "#1b2030", border: "1px solid #2a3246", borderRadius: "5px" },
    ".cm-foldGutter span": { color: "#4b5263" },
    ".cm-tooltip": { backgroundColor: "#161a23", border: "1px solid #2a3246" },
    // merge view
    ".cm-changedLine": { backgroundColor: "rgba(108,182,255,0.06)" },
    ".cm-insertedLine, .cm-changedText": { backgroundColor: "rgba(139,213,139,0.14)" },
    ".cm-deletedChunk, .cm-deletedLine": { backgroundColor: "rgba(255,107,122,0.12)" },
    ".cm-merge-a .cm-changedText": { backgroundColor: "rgba(255,107,122,0.22)" },
    ".cm-merge-b .cm-changedText": { backgroundColor: "rgba(139,213,139,0.22)" },
  },
  { dark: true },
);

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
    syntaxHighlighting(oneDarkHighlightStyle, { fallback: true }),
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
    erkaTheme,
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
