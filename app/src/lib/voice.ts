// Voice dictation: speak, and the words land where you were typing — a text field (the chat
// composer, a search box) at its caret, or the focused terminal as a paste (no Enter). Speech is
// recognised on this computer by the erka-stt helper (app/src-tauri/src/voice.rs); nothing is
// sent anywhere. Toggle with the shortcut or a mic button; Esc cancels.
import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { store } from "./store";
import { t, msg } from "./i18n";
import { allPanes } from "./layout";
import { typeInto } from "./quick-commands";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

export interface SpeechModel { id: string; label: string; languages: string; size: number; installed: boolean }
export interface MicDevice { name: string; default: boolean }

export const voiceAvailable = () => invoke<boolean>("voice_available");
export const speechModels = () => invoke<SpeechModel[]>("voice_models");
export const micDevices = () => invoke<MicDevice[]>("voice_devices");
export const downloadModel = (model: string) => invoke<boolean>("voice_download", { model });
export const cancelDownload = (model: string) => invoke<boolean>("voice_download_cancel", { model });
export const deleteModel = (model: string) => invoke<boolean>("voice_delete", { model });
export const transcribeFile = (path: string) => invoke<{ text: string }>("voice_transcribe", { ...modelArgs(), path });

/** Languages offered for Whisper models (it detects the language on "auto"). */
export const WHISPER_LANGUAGES: [string, string][] = [
  ["auto", msg("Detect automatically")], ["en", msg("English")], ["vi", msg("Vietnamese")], ["zh", msg("Chinese")], ["ja", msg("Japanese")], ["ko", msg("Korean")],
  ["fr", msg("French")], ["de", msg("German")], ["es", msg("Spanish")], ["pt", msg("Portuguese")], ["ru", msg("Russian")], ["it", msg("Italian")], ["th", msg("Thai")], ["id", msg("Indonesian")],
];

export const voiceSettings = () => store.state.settings.voice ?? { model: null, language: "auto", device: null };

function modelArgs() {
  const v = voiceSettings();
  return { model: v.model ?? "", language: v.language && v.language !== "auto" ? v.language : null };
}

export type VoicePhase = "idle" | "recording" | "transcribing";
const [phase, setPhase] = createSignal<VoicePhase>("idle");
const [level, setLevel] = createSignal(0);
const [startedAt, setStartedAt] = createSignal(0);
const [downloads, setDownloads] = createSignal<Record<string, { done: number; total: number }>>({});
export { phase as voicePhase, level as voiceLevel, startedAt as voiceStartedAt, downloads as speechDownloads };

/** Where the words go: a text field (with the selection to replace) or a terminal session. */
type Target = { kind: "field"; el: HTMLTextAreaElement | HTMLInputElement; start: number; end: number } | { kind: "session"; sessionId: string };
let target: Target | null = null;
let autoStop = 0;
/** Longest dictation; the helper keeps at most ten minutes. */
const MAX_MS = 9 * 60 * 1000;

function isTextField(el: Element | null): el is HTMLTextAreaElement | HTMLInputElement {
  if (!el || el.classList.contains("xterm-helper-textarea")) return false;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  return el instanceof HTMLInputElement && ["text", "search", ""].includes(el.type) && !el.readOnly && !el.disabled;
}

function focusedSessionId(): string | null {
  const p = store.state.activeProject;
  const tab = p ? store.activeTab(p) : undefined;
  const pane = tab && allPanes(tab.root).find((x) => x.id === tab.focus);
  const s = pane?.sessionId ? store.sessions[pane.sessionId] : undefined;
  return s?.alive && !s.chat ? s.id : null;
}

function currentTarget(): Target | null {
  const el = document.activeElement;
  if (isTextField(el)) return { kind: "field", el, start: el.selectionStart ?? el.value.length, end: el.selectionEnd ?? el.value.length };
  const sid = focusedSessionId();
  return sid ? { kind: "session", sessionId: sid } : null;
}

/** Starts dictating into `into` (default: the focused text field or terminal). */
export async function startDictation(into?: { field?: HTMLTextAreaElement | HTMLInputElement; sessionId?: string }) {
  if (phase() !== "idle") return;
  if (!(await voiceAvailable().catch(() => false))) return store.notify(t("Voice dictation is not included in this build of Erka"));
  const v = voiceSettings();
  const installed = v.model ? (await speechModels().catch(() => [])).some((m) => m.id === v.model && m.installed) : false;
  if (!installed) {
    store.openSettings("voice");
    return store.notify(t("Download a speech model to dictate (Settings → Voice)"));
  }
  target = into?.field
    ? { kind: "field", el: into.field, start: into.field.selectionStart ?? into.field.value.length, end: into.field.selectionEnd ?? into.field.value.length }
    : into?.sessionId
      ? { kind: "session", sessionId: into.sessionId }
      : currentTarget();
  if (!target) return store.notify(t("Click into a text field or terminal, then dictate"));
  try {
    await invoke("voice_start", { ...modelArgs(), device: v.device || null });
  } catch (e) {
    target = null;
    return store.notify(t("Microphone: {error}", { error: String(e) }));
  }
  setLevel(0);
  setStartedAt(Date.now());
  setPhase("recording");
  autoStop = window.setTimeout(() => void finishDictation(), MAX_MS);
}

/** Stops listening and inserts what was said. */
export async function finishDictation() {
  if (phase() !== "recording") return;
  clearTimeout(autoStop);
  setPhase("transcribing");
  try {
    const r = await invoke<{ text: string }>("voice_stop", modelArgs());
    if (!r.text) store.notify(t("No speech was heard"));
    else await insert(r.text);
  } catch (e) {
    store.notify(t("Dictation: {error}", { error: String(e) }));
  } finally {
    target = null;
    setPhase("idle");
  }
}

export async function cancelDictation() {
  if (phase() !== "recording") return;
  clearTimeout(autoStop);
  target = null;
  setPhase("idle");
  await invoke("voice_cancel").catch(() => {});
}

export function toggleDictation() {
  if (phase() === "recording") return void finishDictation();
  if (phase() === "idle") void startDictation();
}

async function insert(text: string) {
  const tgt = target;
  if (tgt?.kind === "field" && tgt.el.isConnected) {
    const before = tgt.el.value.slice(0, tgt.start);
    // Joined to what is already there with a space.
    const spaced = (before && !/\s$/.test(before) ? " " : "") + text;
    tgt.el.setRangeText(spaced, tgt.start, tgt.end, "end");
    tgt.el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: spaced }));
    tgt.el.focus();
    return;
  }
  const s = tgt?.kind === "session" ? store.sessions[tgt.sessionId] : undefined;
  if (s?.alive) return typeInto(s, text, false, 0);
  // The target went away while transcribing: keep the words.
  await writeText(text).catch(() => {});
  store.notify(t("Dictated text copied to the clipboard"));
}

let started = false;
/** Helper events: microphone level, download progress; Esc cancels a dictation. */
export function initVoice() {
  if (started) return;
  started = true;
  void listen<{ event: string; rms?: number; model?: string; done?: number; total?: number }>("voice-event", ({ payload: e }) => {
    if (e.event === "level" && phase() === "recording") setLevel(e.rms ?? 0);
    else if (e.event === "download" && e.model) setDownloads((d) => ({ ...d, [e.model!]: { done: e.done ?? 0, total: e.total ?? 0 } }));
  });
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || phase() !== "recording") return;
      e.preventDefault();
      e.stopPropagation();
      void cancelDictation();
    },
    true,
  );
}

/** Forgets a finished or failed download's progress. */
export const clearDownload = (model: string) => setDownloads((d) => Object.fromEntries(Object.entries(d).filter(([k]) => k !== model)));
