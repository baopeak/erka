"""E2E for voice dictation (Settings → Voice, the Dictate shortcut, mic buttons).

    python -X utf8 scripts/e2e/voice.py <screenshot-dir> <scratch-dir>

Needs the speech helper (`cargo build --release -p kelpie-stt`), Windows (the English clip is made
with its speech synthesizer) and tauri-driver started with
KELPIE_STT_TEST_INPUT=<scratch>/../stt-input.wav — the "microphone" plays that file, which this
script swaps between a Vietnamese clip, an English SAPI recording and silence. Models are really
downloaded (Vietnamese 26 MB, Whisper tiny 104 MB) and checked against their pinned SHA-256.

Covers: models listed, dictating before a model exists leads to Settings, download with
progress (the first model becomes the active one), cancelling a download leaves nothing, the
microphone list, the language choice (fixed for the Vietnamese model), dictation into a terminal
(pasted, not run), into a text field at the caret (shortcut and mic button, joined with a space),
the recording pill (time, level, Done / Cancel), Esc cancels, silence inserts nothing, the mic
button on terminal panes, deleting a model.
"""
import os
import shutil
import struct
import subprocess
import sys
import time
import wave

sys.path.insert(0, os.path.dirname(__file__))
from smoke_support import Run, daemon  # noqa: E402

shots, scratch = sys.argv[1], sys.argv[2]
S = "window.__kelpie.store"
V = "window.__kelpie.voice"
INPUT = os.environ.get("KELPIE_STT_TEST_INPUT") or os.path.join(os.path.dirname(os.path.abspath(scratch)), "stt-input.wav")
SAPI_EN = os.environ.get("KELPIE_TEST_EN_WAV") or os.path.join(scratch, "sapi-en.wav")
if not os.path.isfile(SAPI_EN):
    # English speech from Windows' own synthesizer (16 kHz mono).
    os.makedirs(os.path.dirname(SAPI_EN), exist_ok=True)
    subprocess.run(["powershell", "-NoProfile", "-Command",
                    "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
                    "$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono); "
                    f"$s.SetOutputToWaveFile('{SAPI_EN}', $f); $s.Speak('Please open the project and run the unit tests for the terminal daemon.'); $s.Dispose()"], check=True)
proj = os.path.join(scratch, "voiceproj")
os.makedirs(proj, exist_ok=True)

run = Run(shots)
d = run.d


def js_await(expr, *args):
    return d.js_async(f"const done = arguments[arguments.length-1]; Promise.resolve().then(() => {expr}).then(v => done(v === undefined ? null : v), e => done({{err: String(e)}}));", *args)


def wait(cond, timeout=20, interval=0.3):
    end = time.time() + timeout
    while time.time() < end:
        v = cond()
        if v:
            return v
        time.sleep(interval)
    return None


def speak(path):
    shutil.copyfile(path, INPUT)


def silence(seconds=3):
    with wave.open(INPUT, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(struct.pack("<h", 0) * 16000 * seconds)


def phase():
    return d.js(f"return {V}.voicePhase()")


def model_row(mid):
    return f'[data-model="{mid}"]'


def row_text(mid):
    return d.js("const e = document.querySelector(arguments[0]); return e ? e.innerText : ''", model_row(mid))


def click_button(container, label):
    return d.js("""const c = document.querySelector(arguments[0]); if (!c) return false;
        const b = [...c.querySelectorAll('button')].find(b => b.innerText.trim() === arguments[1]); if (!b || b.disabled) return false; b.click(); return true;""", container, label)


def toast():
    return d.js("const t = document.querySelector('.toast'); return t ? t.innerText : ''")


def screen(handle, lines=40):
    return daemon(d, "session.read", {"handle": handle, "lines": lines})["text"]


def dictate(seconds, finish):
    """Waits for the recording pill, lets the input play, then finishes; returns when idle."""
    ok = wait(lambda: phase() == "recording", 30)
    time.sleep(seconds)
    finish()
    wait(lambda: phase() == "idle", 120)
    return ok


try:
    run.boot()
    d.set_window_size(1480, 920)
    d._req("POST", d.s("/timeouts"), {"script": 300000})
    data_dir = d.js_async("const done = arguments[arguments.length-1]; window.__TAURI_INTERNALS__.invoke('platform_info').then(i => done(i.data_dir));")
    models_dir = os.path.join(data_dir, "speech-models")
    shutil.rmtree(models_dir, ignore_errors=True)
    for s in daemon(d, "session.list"):
        daemon(d, "session.close", {"handle": s["handle"]})
    d.js(f"const s = {S}; for (const p of [...s.state.projects]) s.removeProject(p.id); s.setSettings({{ voice: {{ model: null, language: 'auto', device: null }}, tips: false }});")
    pid = d.js(f"return {S}.addProject(arguments[0])", proj)

    run.check("speech helper available", js_await(f"{V}.voiceAvailable()") is True)
    models = js_await(f"{V}.speechModels()")
    run.check("four models offered, none downloaded", [m["id"] for m in models] == ["vi-zipformer", "whisper-tiny", "whisper-base", "whisper-small"] and not any(m["installed"] for m in models), str(models))

    # ---------- no model yet ----------
    d.js("window.__kelpie.commands.find(c => c.id === 'voice.toggle').run()")
    ok = wait(lambda: d.js("return !!document.querySelector('[data-setting=\"voice-models\"]')"), 10)
    run.check("dictating without a model opens Settings → Voice", ok and "Download a speech model" in (wait(toast, 5) or ""))
    run.check("still idle", phase() == "idle")

    # ---------- download ----------
    run.check("each model shows its size and a Download button", "26 MB" in row_text("vi-zipformer") and "Download" in row_text("vi-zipformer") and "104 MB" in row_text("whisper-tiny"))
    click_button(model_row("vi-zipformer"), "Download")
    saw_progress = wait(lambda: d.js("return !!document.querySelector(arguments[0] + ' .speech-progress')", model_row("vi-zipformer")), 10)
    run.shot("voice-downloading")
    done = wait(lambda: "Downloaded" in row_text("vi-zipformer"), 300)
    run.check("download shows progress, then Downloaded", saw_progress and done, row_text("vi-zipformer"))
    run.check("model verified and marked complete on disk", os.path.isfile(os.path.join(models_dir, "vi-zipformer", ".complete")) and os.path.isfile(os.path.join(models_dir, "vi-zipformer", "encoder.int8.onnx")))
    run.check("first model becomes the active one", d.js(f"return {S}.state.settings.voice.model") == "vi-zipformer")
    run.check("its radio is selected", d.js("return document.querySelector(arguments[0] + ' input[type=radio]').checked", model_row("vi-zipformer")))

    click_button(model_row("whisper-base"), "Download")
    wait(lambda: d.js("return !!document.querySelector(arguments[0] + ' .speech-progress')", model_row("whisper-base")), 10)
    time.sleep(1)
    click_button(model_row("whisper-base"), "Cancel")
    back = wait(lambda: "Download" in row_text("whisper-base") and "Cancel" not in row_text("whisper-base"), 30)
    run.check("cancelling a download leaves nothing behind", back and not os.path.exists(os.path.join(models_dir, "whisper-base")), row_text("whisper-base"))

    click_button(model_row("whisper-tiny"), "Download")
    run.check("second model downloads", wait(lambda: "Downloaded" in row_text("whisper-tiny"), 600))
    run.check("the active model stays the first one", d.js(f"return {S}.state.settings.voice.model") == "vi-zipformer")

    mics = d.js("return [...document.querySelectorAll('[data-setting=\"voice-mic\"] option')].map(o => o.textContent)")
    run.check("microphone list: system default plus devices", mics and mics[0].startswith("System default"), str(mics))
    run.check("language is fixed for the Vietnamese model", d.js("return document.querySelector('[data-setting=\"voice-language\"] select').disabled"))
    run.shot("voice-settings")

    # ---------- dictate into a terminal (Vietnamese) ----------
    d.js(f"{S}.setOverlay(null)")
    sh = js_await(f"{S}.newSession(arguments[0], 'shell')", pid)
    sid = wait(lambda: d.js(f"const s = {S}; const t = s.activeTab(arguments[0]); return t && window.__kelpie.layout.allPanes(t.root).map(p => p.sessionId).find(Boolean)", pid), 15)
    sess = wait(lambda: next((s for s in daemon(d, "session.list") if s["id"] == sid), None), 10)
    run.check("terminal pane has a mic button", wait(lambda: d.js("return !!document.querySelector('.pane .mic-btn')"), 5))
    speak(os.path.join(models_dir, "vi-zipformer", "test_wavs", "1.wav"))
    d.js(f"{S}.revealSession(arguments[0])", sid)
    d.js("window.__kelpie.commands.find(c => c.id === 'voice.toggle').run()")
    rec = wait(lambda: phase() == "recording", 30)
    pill = wait(lambda: d.js("const p = document.querySelector('.voice-pill'); return p && p.innerText"), 5)
    lvl = wait(lambda: d.js(f"return {V}.voiceLevel()") > 0.01, 5)
    run.check("recording pill shows time, Done and Cancel", rec and pill and "0:0" in pill and "Done" in pill and "Cancel" in pill, str(pill))
    run.check("pill shows the microphone level", lvl)
    run.shot("voice-recording")
    time.sleep(3)
    d.js("window.__kelpie.commands.find(c => c.id === 'voice.toggle').run()")
    run.check("then transcribing", wait(lambda: phase() == "transcribing" or d.js("const p = document.querySelector('.voice-pill'); return p && p.innerText.includes('Transcribing')"), 5) or phase() == "idle")
    wait(lambda: phase() == "idle", 120)
    txt = wait(lambda: "Những nơi đã khống chế được căn bệnh" in screen(sess["handle"]), 15)
    run.check("Vietnamese speech is typed into the terminal", txt, screen(sess["handle"])[-300:])
    after = screen(sess["handle"])
    run.check("dictation is pasted, not run", "is not recognized" not in after and "CommandNotFound" not in after)

    # ---------- dictate into a text field (English, Whisper) ----------
    d.js(f"{S}.setSettings({{ voice: {{ ...{S}.state.settings.voice, model: 'whisper-tiny', language: 'en' }} }})")
    d.js(f"{S}.openSettings('voice')")
    d.wait("return !!document.querySelector('[data-setting=\"voice-try\"] textarea')", 10)
    run.check("language can be chosen for Whisper", not d.js("return document.querySelector('[data-setting=\"voice-language\"] select').disabled"))
    speak(SAPI_EN)
    d.js("const t = document.querySelector('[data-setting=\"voice-try\"] textarea'); t.value = 'Note:'; t.dispatchEvent(new InputEvent('input', {bubbles: true})); t.focus(); t.setSelectionRange(5, 5);")
    d.keys("ctrl+shift+ ")
    dictate(6, lambda: d.keys("ctrl+shift+ "))
    val = d.js("return document.querySelector('[data-setting=\"voice-try\"] textarea').value")
    run.check("shortcut dictates into the focused field at the caret, joined with a space", val.startswith("Note: Please open the project and run the unit tests"), val)

    speak(SAPI_EN)
    d.js("const t = document.querySelector('[data-setting=\"voice-try\"] textarea'); t.value = ''; t.dispatchEvent(new InputEvent('input', {bubbles: true}));")
    d.js("document.querySelector('[data-setting=\"voice-try\"] .mic-btn').click()")
    dictate(6, lambda: d.js("document.querySelector('.voice-pill .btn.primary').click()"))
    val = d.js("return document.querySelector('[data-setting=\"voice-try\"] textarea').value")
    run.check("mic button and Done dictate into its field", val.startswith("Please open the project"), val)

    # Language detection.
    d.js(f"{S}.setSettings({{ voice: {{ ...{S}.state.settings.voice, language: 'auto' }} }})")
    speak(SAPI_EN)
    d.js("const t = document.querySelector('[data-setting=\"voice-try\"] textarea'); t.value = ''; t.dispatchEvent(new InputEvent('input', {bubbles: true}));")
    d.js("document.querySelector('[data-setting=\"voice-try\"] .mic-btn').click()")
    dictate(6, lambda: d.js("document.querySelector('[data-setting=\"voice-try\"] .mic-btn').click()"))
    val = d.js("return document.querySelector('[data-setting=\"voice-try\"] textarea').value")
    run.check("Whisper detects English by itself", "open the project" in val, val)

    # Esc cancels.
    speak(SAPI_EN)
    d.js("const t = document.querySelector('[data-setting=\"voice-try\"] textarea'); t.value = ''; t.dispatchEvent(new InputEvent('input', {bubbles: true}));")
    d.js("document.querySelector('[data-setting=\"voice-try\"] .mic-btn').click()")
    wait(lambda: phase() == "recording", 30)
    time.sleep(2)
    d.keys("escape")
    run.check("Esc cancels dictation", wait(lambda: phase() == "idle", 5) and not d.js("return !!document.querySelector('.voice-pill')"))
    time.sleep(1)
    run.check("nothing inserted after cancelling", d.js("return document.querySelector('[data-setting=\"voice-try\"] textarea').value") == "")
    run.check("settings page stays open after Esc in dictation", d.js("return !!document.querySelector('[data-setting=\"voice-try\"]')"))

    # Silence.
    silence()
    d.js("document.querySelector('[data-setting=\"voice-try\"] .mic-btn').click()")
    dictate(2, lambda: d.js("document.querySelector('.voice-pill .btn.primary').click()"))
    run.check("silence inserts nothing and says so", d.js("return document.querySelector('[data-setting=\"voice-try\"] textarea').value") == "" and "No speech was heard" in (wait(toast, 5) or ""))

    # ---------- delete ----------
    d.js("window.confirm = () => true")
    click_button(model_row("whisper-tiny"), "Delete")
    gone = wait(lambda: not os.path.exists(os.path.join(models_dir, "whisper-tiny")), 15)
    run.check("deleting a model removes its files", gone)
    run.check("deleting the active model switches to another downloaded one", wait(lambda: d.js(f"return {S}.state.settings.voice.model") == "vi-zipformer", 5))
    run.check("deleted model offers Download again", wait(lambda: "Download" in row_text("whisper-tiny"), 10))
except Exception as e:
    import traceback
    traceback.print_exc()
    run.check("scenario ran to the end", False, repr(e))
finally:
    try:
        if d.js(f"return {V}.voicePhase()") == "recording":
            js_await(f"{V}.cancelDictation()")
        for s in daemon(d, "session.list"):
            daemon(d, "session.close", {"handle": s["handle"]})
    except Exception:
        pass
    run.finish()
