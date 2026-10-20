"""End-to-end smoke test of the Erka app (Windows dev setup).

Prereqs: dev daemon (scripts/dev-daemon.sh), `pnpm dev` (vite :1427), tauri-driver :4444
with ERKA_ENDPOINT/ERKA_DATA_DIR set, debug app built (`cargo build -p erka`).

    python scripts/e2e/smoke.py <screenshot-dir> <scratch-project-dir> [app.exe]
"""
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from wd import Driver  # noqa: E402

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def default_app():
    meta = json.loads(subprocess.check_output(["cargo", "metadata", "--format-version", "1", "--no-deps"], cwd=REPO))
    return os.path.join(meta["target_directory"], "debug", "erka.exe" if os.name == "nt" else "erka")


shots, scratch = sys.argv[1], sys.argv[2]
app = sys.argv[3] if len(sys.argv) > 3 else default_app()
os.makedirs(shots, exist_ok=True)
results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail else ""), flush=True)


def daemon(d, method, params=None):
    r = d.invoke("daemon_call", {"method": method, "params": params or {}})
    if "err" in r:
        raise RuntimeError(r["err"])
    return r["ok"]


# Text of the mounted terminal buffers; WebGL draws to a canvas, so read xterm itself.
BUFFER_JS = r"""
const out = [];
for (const v of window.__erka.views()) {
  if (!v.visible) continue;
  const b = v.term.buffer.active;
  for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '');
}
return out.join('\n');
"""


def screen_text(d, handle):
    return daemon(d, "session.read", {"handle": handle})["text"]


d = Driver(app)
handles, ids = {}, []
try:
    d.wait("return !!(window.__erka && window.__erka.store.loaded())", 60)
    d.wait("return window.__erka.store.connected()", 30)
    check("app boots and connects to erkad", True)

    # Fresh state: drop projects from earlier runs (sessions stay in the daemon).
    d.js("const s = window.__erka.store; for (const p of [...s.state.projects]) s.removeProject(p.id);")
    projects = [REPO, os.path.join(os.path.dirname(REPO), "orca-ref", "orca"), scratch]
    for p in projects:
        d.js("window.__erka.store.addProject(arguments[0]);", p)
    ids = d.js("return window.__erka.store.state.projects.map(p => p.id);")
    check("3 projects added", len(ids) == 3, str(len(ids)))

    # One shell per project.
    handles = {}
    for pid in ids:
        d.js("window.__erka.store.switchProject(arguments[0]);", pid)
        info = d.js_async("const done = arguments[arguments.length-1]; window.__erka.store.newSession(arguments[0], 'shell').then(i => done(i));", pid)
        handles[pid] = info["handle"]
    d.wait("return document.querySelectorAll('.pane .xterm-screen').length > 0", 20)
    check("terminal rendered", True)

    # Shells must be ready before typing and before timing switches: a cold PowerShell start
    # takes 5-20 s on a busy machine and its CPU use would skew both.
    def prompt_ready(h):
        text = screen_text(d, h)
        return any(m in text for m in ("PS ", "$ ", "% ", "> "))
    end = time.time() + 60
    while time.time() < end and not all(prompt_ready(h) for h in handles.values()):
        time.sleep(0.3)
    check("shells printed their prompt", all(prompt_ready(h) for h in handles.values()))

    # Type into the active terminal through real keyboard events.
    active = ids[-1]
    d.click(".pane .xterm")
    time.sleep(1.5)
    d.keys("echo erka-e2e-ok", "enter")
    ok = False
    for _ in range(40):
        # The output line itself: a long prompt may wrap the typed command across lines.
        if "erka-e2e-ok" in [l.strip() for l in screen_text(d, handles[active]).splitlines()]:
            ok = True
            break
        time.sleep(0.25)
    check("keyboard input reaches PTY and output renders", ok)
    if not ok:  # what the views looked like, for diagnosis
        print("views:", d.js("return window.__erka.views().map(v => [v.sessionId.slice(0, 6), v.visible, v.handle, v.hasWebgl, v.el.parentElement?.className])"))
        info = [x for x in daemon(d, "session.list") if x["handle"] == handles[active]]
        print("session:", [(x["alive"], x["status"], x["pid"]) for x in info], repr(screen_text(d, handles[active])[-300:]))
        print("active element:", d.js("return document.activeElement?.className + ' in ' + (document.activeElement?.closest('[data-session]')?.dataset.session || '-').slice(0, 6)"))
    # The view gets output a few ms after the daemon (batched IPC); allow it to arrive.
    in_view = False
    for _ in range(25):
        if "erka-e2e-ok" in [l.strip() for l in d.js(BUFFER_JS).splitlines()]:
            in_view = True
            break
        time.sleep(0.2)
    check("xterm buffer shows command output", in_view)
    d.screenshot(os.path.join(shots, "01-terminal.png"))

    # Split right with the keyboard shortcut.
    d.keys("ctrl+shift+d")
    d.wait("return document.querySelectorAll('.pane .xterm-screen').length >= 2", 20)
    check("split right creates second terminal", True)
    time.sleep(1)
    d.screenshot(os.path.join(shots, "02-split.png"))

    # Project switching: sessions keep running, switch time measured by the app.
    times = []
    for i in range(30):
        pid = ids[i % 3]
        d.js("window.__erka.store.switchProject(arguments[0]);", pid)
        t = d.wait("return window.__erka.store.state.activeProject === arguments[0] && document.querySelector('.pane .term-host .xterm') ? window.__erka.store.lastSwitchMs() : null", 10, 0.05, pid)
        times.append(t)
    order = list(times)  # in switch order, to tell first visits from steady state
    times.sort()
    p50, p95 = times[len(times) // 2], times[int(len(times) * 0.95) - 1]
    check("project switch p95 < 200 ms", p95 < 200, f"p50={p50}ms p95={p95}ms")
    if p95 >= 200:
        print("switch times in order:", order)
    alive = [s for s in daemon(d, "session.list") if s["handle"] in handles.values() and s["alive"]]
    check("all sessions still alive after 30 switches", len(alive) == len(handles), f"{len(alive)}/{len(handles)}")

    # Re-attach after switching shows previous output (delta replay or snapshot).
    d.js("window.__erka.store.switchProject(arguments[0]);", active)
    time.sleep(1)
    check("terminal content restored after project switch", "erka-e2e-ok" in d.js(BUFFER_JS).split("echo erka-e2e-ok", 1)[-1])

    # Quick open in the Erka repo project.
    d.js("window.__erka.store.switchProject(arguments[0]);", ids[0])
    time.sleep(0.5)
    d.keys("ctrl+shift+o")
    d.wait("return !!document.querySelector('.palette input')", 5)
    d.keys("session.rs")
    d.wait("return [...document.querySelectorAll('.palette .item .hint')].some(e => e.textContent.includes('session.rs'))", 15)
    check("quick open finds crates/erkad/src/session.rs", True)
    d.keys("enter")
    d.wait("return !!document.querySelector('.cm-editor .cm-content')", 15)
    time.sleep(1)
    check("file opens in CodeMirror viewer", "Session" in d.js("return document.querySelector('.cm-content').innerText"))
    d.screenshot(os.path.join(shots, "03-file-viewer.png"))

    # Explorer + git panel.
    d.js("const s = window.__erka.store; if (s.workspace(s.state.activeProject).rightPanel !== 'files') s.setRightPanel('files');")
    d.wait("return document.querySelectorAll('.tree-row').length > 3", 15)
    check("file tree lists project root", True)
    d.screenshot(os.path.join(shots, "04-explorer.png"))
    d.js("const s = window.__erka.store; if (s.workspace(s.state.activeProject).rightPanel !== 'git') s.setRightPanel('git');")
    d.wait("return !!document.querySelector('.git-head .branch')", 10)
    time.sleep(1.5)
    d.screenshot(os.path.join(shots, "05-git.png"))
    check("git panel renders branch", d.js("return document.querySelector('.git-head .branch').innerText").strip() != "")

    # Dashboard + command palette.
    d.keys("ctrl+shift+m")
    d.wait("return !!document.querySelector('.dashboard')", 5)
    time.sleep(0.5)
    d.screenshot(os.path.join(shots, "06-dashboard.png"))
    d.keys("escape")
    d.keys("ctrl+shift+p")
    d.wait("return !!document.querySelector('.palette')", 5)
    d.keys("split")
    time.sleep(0.4)
    d.screenshot(os.path.join(shots, "07-palette.png"))
    d.keys("escape")
    check("dashboard and palette open via shortcuts", True)
finally:
    try:
        for h in set(handles.values()) | {s["handle"] for s in daemon(d, "session.list") if s.get("project_id") in ids}:
            daemon(d, "session.close", {"handle": h})
    except Exception as e:  # cleanup is best effort
        print("cleanup:", e)
    d.quit()

failed = [r for r in results if not r[1]]
print(json.dumps({"passed": len(results) - len(failed), "failed": len(failed)}))
sys.exit(1 if failed else 0)
