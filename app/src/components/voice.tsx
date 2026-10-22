// Dictation controls: the mic button (chat composer, terminal header, settings) and the pill that
// shows while listening / transcribing, with the microphone level, Stop and Cancel.
import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { Icon } from "./icons";
import { cancelDictation, finishDictation, startDictation, voiceLevel, voicePhase, voiceStartedAt } from "../lib/voice";
import { chordOf, commands } from "../lib/commands";
import { chordLabel } from "../lib/platform";
import { t } from "../lib/i18n";

const shortcut = () => {
  const c = commands.find((x) => x.id === "voice.toggle");
  const chord = c && chordOf(c);
  return chord ? ` (${chordLabel(chord)})` : "";
};

/** Starts dictating into `field()` / `sessionId()`, or stops a dictation in progress. */
export function MicButton(props: { field?: () => HTMLTextAreaElement | HTMLInputElement | undefined; sessionId?: string; size?: number; class?: string }) {
  const active = () => voicePhase() !== "idle";
  return (
    <button
      class={`icon-btn mic-btn${active() ? " on" : ""}${props.class ? ` ${props.class}` : ""}`}
      title={active() ? t("Stop dictation") : t("Dictate") + shortcut()}
      // Keeps the caret in the text field the words go into.
      onPointerDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.stopPropagation();
        if (voicePhase() === "recording") void finishDictation();
        else if (voicePhase() === "idle") void startDictation({ field: props.field?.(), sessionId: props.sessionId });
      }}
    >
      <Icon name="mic" size={props.size ?? 14} />
    </button>
  );
}

export function VoicePill() {
  const [now, setNow] = createSignal(Date.now());
  onMount(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    onCleanup(() => clearInterval(timer));
  });
  const elapsed = () => {
    const s = Math.max(0, Math.floor((now() - voiceStartedAt()) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  return (
    <Show when={voicePhase() !== "idle"}>
      <div class={`voice-pill ${voicePhase()}`} data-voice={voicePhase()} onPointerDown={(e) => e.preventDefault()}>
        <Show when={voicePhase() === "recording"} fallback={<><span class="spinner" /> {t("Transcribing…")}</>}>
          <span class="voice-dot" />
          <span class="voice-time">{elapsed()}</span>
          <span class="voice-meter"><span style={{ width: `${Math.min(100, Math.sqrt(voiceLevel()) * 260)}%` }} /></span>
          <button class="btn primary" onClick={() => void finishDictation()}>{t("Done")}</button>
          <button class="btn" title={t("Cancel (Esc)")} onClick={() => void cancelDictation()}>{t("Cancel")}</button>
        </Show>
      </div>
    </Show>
  );
}
