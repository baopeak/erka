"""E2E for long terminal output: back-to-bottom with a new-lines count, and jumping between
the prompts the user sent.

    python -X utf8 scripts/e2e/scrollback.py <screenshot-dir> <project-dir>
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from smoke_support import Run, daemon  # noqa: E402

shots, project = sys.argv[1], sys.argv[2]
S = "window.__kelpie.store"
run = Run(shots)
V = "window.__kelpie.peekView(arguments[0])"


def wait(fn, timeout=30, step=0.25):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(step)
    return None


def command_block(text):
    """Which block's command a few rows show (the row with `print(` names it)."""
    row = next((r for r in text.split("\n") if "print(" in r), "")
    return next((f"block{i}" for i in range(4) if f"block{i}-line" in row), row[:60])


try:
    run.boot()
    d = run.d
    d.set_window_size(1480, 920)
    d.js(f"const s = {S}; for (const p of [...s.state.projects]) s.removeProject(p.id); s.addProject(arguments[0]);", project)
    pid = d.js(f"return {S}.state.activeProject")
    sid = d.js_async(f"const done = arguments[arguments.length-1]; {S}.newSession(arguments[0], 'shell').then((i) => done(i.id));", pid)
    d.wait("return !!document.querySelector('.pane .term-host .xterm')", 20)
    time.sleep(3)

    def typed(cmd):
        # As if typed: xterm's input path (onData), so Enter is seen like a real keystroke.
        d.js(f"{V}.term.input(arguments[1], true)", sid, cmd)
        time.sleep(0.2)
        d.js(f"{V}.term.input('\\r', true)", sid)

    top_rows = lambda: d.js(f"const b = {V}.term.buffer.active; let s = ''; for (let y = b.viewportY; y < b.viewportY + 3; y++) s += b.getLine(y).translateToString(true) + '\\n'; return s;", sid)
    buf = lambda: d.js(f"const b = {V}.term.buffer.active; return {{viewportY: b.viewportY, baseY: b.baseY, length: b.length}}", sid)
    for i in range(4):
        typed(f"python -c \"print('\\n'.join(f'block{i}-line-{{n}}' for n in range(400)))\"")
        wait(lambda: f"block{i}-line-399" in d.js(f"const b = {V}.term.buffer.active; let s = ''; for (let y = Math.max(0, b.length - 60); y < b.length; y++) s += b.getLine(y).translateToString(true) + '\\n'; return s;", sid), 20)
    run.check("long output scrolls (lines in the buffer)", buf()["baseY"] > 1200, str(buf()))
    run.check("no back-to-bottom button at the bottom", not d.js("return !!document.querySelector('[data-scroll-pill]')"))

    d.js(f"{V}.term.scrollLines(-700)", sid)
    run.check("scrolling up shows the back-to-bottom button", wait(lambda: d.js("return !!document.querySelector('[data-scroll-pill]')"), 5))
    # Output that arrives while the user reads further up (an agent streaming): no keystroke in
    # this view, which would scroll it back down.
    handle = d.js(f"return {S}.sessions[arguments[0]].handle", sid)
    daemon(d, "session.input", {"handle": handle, "data": "python -c \"print('\\n'.join(f'late-{n}' for n in range(50)))\"\r"})
    run.check("it counts the lines that arrived meanwhile", wait(lambda: d.js("return /\\d+/.test(document.querySelector('[data-jump-bottom]')?.textContent ?? '') && parseInt(document.querySelector('[data-jump-bottom]').textContent.match(/\\d+/)[0]) >= 50"), 10),
              d.js("return document.querySelector('[data-jump-bottom]')?.textContent"))
    run.shot("01-scrolled-up")

    # Prompt jumps: from the bottom up, each lands on the line of a command that was sent.
    d.js(f"{V}.scrollToBottom()", sid)
    seen = []
    for _ in range(4):
        d.js("window.__kelpie.commands.find((c) => c.id === 'terminal.prevPrompt').run()")
        time.sleep(0.2)
        seen.append(command_block(top_rows()))
    marks = d.js(f"const v = {V}; const b = v.term.buffer.active; return {{top: b.viewportY, base: b.baseY, marks: v.marks.map((m) => m.line)}}", sid)
    run.check("previous-prompt walks back through the commands sent", seen == ["block3", "block2", "block1", "block0"], f"{seen} {marks}")
    d.js("window.__kelpie.commands.find((c) => c.id === 'terminal.nextPrompt').run()")
    time.sleep(0.2)
    run.check("next-prompt goes forward again", command_block(top_rows()) == "block1", top_rows())
    run.check("shortcuts are bound", d.js("return ['terminal.prevPrompt','terminal.nextPrompt','terminal.bottom'].every((id) => { const c = window.__kelpie.commands.find((x) => x.id === id); return c && (c.win || c.mac); })"))
    d.click("[data-jump-bottom]")
    time.sleep(0.3)
    b = buf()
    run.check("the button returns to the bottom and hides", b["viewportY"] == b["baseY"] and not d.js("return !!document.querySelector('[data-scroll-pill]')"), str(b))
    d.js(f"{S}.removeProject(arguments[0])", pid)
except Exception:
    import traceback
    traceback.print_exc()
    run.check("scenario ran to completion", False)
finally:
    run.finish()
