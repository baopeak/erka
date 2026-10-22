"""End-to-end test of chat mode with real agents (uses a few small model calls).

    python scripts/e2e/chat.py <screenshot-dir> <scratch-dir> [claude|codex|omp ...]

Claude: terminal (TUI) turn → switch to chat → chat turn → back to terminal, same conversation.
Codex / OMP: new chat → turn → switch to terminal (resume).
Claude's TUI needs an already-trusted folder; set ERKA_E2E_TRUSTED_DIR (default C:\\Windows\\System32).
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from smoke_support import Run, daemon  # noqa: E402

shots, scratch = sys.argv[1], sys.argv[2]
agents = sys.argv[3:] or ["claude", "codex", "omp"]
trusted = os.environ.get("ERKA_E2E_TRUSTED_DIR", r"C:\Windows\System32")
run = Run(shots)
d = run.d

ITEMS_JS = r"""
const pane = document.querySelector('.chat');
return pane ? [...pane.querySelectorAll('.msg-user, .msg-assistant, .result-line, .tool-head, .perm .q')].map(e => e.className.split(' ')[0] + ': ' + e.innerText.slice(0, 200)) : null;
"""


def wait_chat_text(word, timeout=180):
    end = time.time() + timeout
    while time.time() < end:
        items = d.js(ITEMS_JS) or []
        hits = [i for i in items if i.startswith("msg-assistant") and word in i.lower()]
        busy = d.js("return !!document.querySelector('.chat .typing')")
        if hits and not busy:
            return items
        # Approve any permission prompt so the turn can finish.
        if d.js("return !!document.querySelector('.perm .actions .btn.primary')"):
            d.click(".perm .actions .btn.primary")
        time.sleep(1)
    raise TimeoutError(f"chat reply containing {word!r}: {d.js(ITEMS_JS)}")


def chat_send(text):
    d.click(".composer-box textarea")
    d.keys(text, "enter")


def pane_session():
    return d.js("const s = window.__erka.store; const t = s.activeTab(s.state.activeProject); const p = (function f(n){return n.type==='leaf'?[n.pane]:[...f(n.a),...f(n.b)]})(t.root).find(p => p.id === t.focus); return s.sessions[p.sessionId];")


def switch(fn):
    d.js_async("const done = arguments[arguments.length-1]; const s = window.__erka.store; const p = s.activeProject(); const t = s.activeTab(p.id);"
               f"window.__erka.chat.{fn}(p, t, (function f(n){{return n.type==='leaf'?[n.pane]:[...f(n.a),...f(n.b)]}})(t.root).find(x => x.id === t.focus)).then(() => done(true), e => done(String(e)));")


try:
    run.boot()
    d.js("const s = window.__erka.store; for (const p of [...s.state.projects]) s.removeProject(p.id);")

    if "claude" in agents:
        d.js("window.__erka.store.addProject(arguments[0]);", trusted)
        pid = d.js("return window.__erka.store.state.activeProject")
        info = d.js_async("const done = arguments[arguments.length-1]; window.__erka.store.newSession(arguments[0], 'claude').then(done);", pid)
        h = info["handle"]
        end = time.time() + 60
        while "❯" not in daemon(d, "session.read", {"handle": h})["text"] and time.time() < end:
            time.sleep(1)
        daemon(d, "session.input", {"handle": h, "data": "Reply with exactly the single word: alpha"})
        time.sleep(0.6)
        daemon(d, "session.input", {"handle": h, "data": "\r"})
        end = time.time() + 120
        ok = False
        while time.time() < end:
            s = next(x for x in daemon(d, "session.list") if x["handle"] == h)
            if s["agent_session_id"] and s["status"] == "idle" and "alpha" in daemon(d, "session.read", {"handle": h})["text"].split("alpha", 1)[-1]:
                ok = True
                break
            time.sleep(1)
        run.check("claude TUI turn completes (hooks report idle + session id)", ok)
        run.shot("10-claude-tui")
        switch("switchToChat")
        d.wait("return !!document.querySelector('.chat .composer-box')", 60)
        time.sleep(3)
        items = d.js(ITEMS_JS) or []
        run.check("chat view shows TUI history", any("alpha" in i for i in items), json.dumps(items[-4:], ensure_ascii=False))
        chat_send("Now reply with exactly the single word: beta")
        items = wait_chat_text("beta")
        run.check("claude chat turn streams a reply", True, json.dumps(items[-3:], ensure_ascii=False))
        run.shot("11-claude-chat")
        conv = pane_session()["agent_session_id"]
        switch("switchToTerminal")
        d.wait("return !!document.querySelector('.pane .term-host .xterm')", 60)
        s = pane_session()
        # Resuming re-renders the conversation; slow when the API is slow.
        end = time.time() + 120
        text = ""
        while time.time() < end:
            text = daemon(d, "session.read", {"handle": s["handle"]})["text"]
            if "beta" in text:
                break
            time.sleep(1)
        run.check("back in TUI, same conversation resumed", "beta" in text and s["agent_session_id"] == conv, f"conv={conv}")
        run.shot("12-claude-back-to-tui")

    for kind, word in (("codex", "gamma"), ("omp", "delta")):
        if kind not in agents:
            continue
        d.js("window.__erka.store.addProject(arguments[0]);", scratch)
        pid = d.js("return window.__erka.store.state.activeProject")
        model = os.environ.get("ERKA_E2E_CODEX_MODEL")
        if kind == "codex" and model:
            d.js("const s = window.__erka.store; s.setSettings({ profiles: s.state.settings.profiles.map(p => p.kind === 'codex' ? { ...p, args: ['--model', arguments[0]] } : p) });", model)
        d.js_async("const done = arguments[arguments.length-1]; window.__erka.chat.newChat(arguments[0], arguments[1]).then(done);", pid, kind)
        d.wait("return !!document.querySelector('.chat .composer-box')", 30)
        # Wait until the handshake produced a conversation id.
        d.wait("const s = window.__erka.store; return Object.values(s.sessions).some(x => x.chat && x.kind === arguments[0] && x.alive)", 30, 0.5, kind)
        time.sleep(8)
        chat_send(f"Reply with exactly the single word: {word}")
        items = wait_chat_text(word, 240)
        run.check(f"{kind} chat turn completes", True, json.dumps(items[-3:], ensure_ascii=False))
        run.shot(f"2{0 if kind == 'codex' else 1}-{kind}-chat")
        switch("switchToTerminal")
        d.wait("return !!document.querySelector('.pane .term-host .xterm')", 60)
        time.sleep(10)
        s = pane_session()
        text = daemon(d, "session.read", {"handle": s["handle"]})["text"]
        run.check(f"{kind} resumes in TUI", s["alive"] and s["agent_session_id"], f"id={s['agent_session_id']}")
        run.shot(f"2{2 if kind == 'codex' else 3}-{kind}-tui")
        daemon(d, "session.close", {"handle": s["handle"]})
        d.js("const s = window.__erka.store; s.removeProject(s.state.activeProject);")
except Exception:
    import traceback
    traceback.print_exc()
    run.check("scenario ran to completion", False)
finally:
    run.finish()
