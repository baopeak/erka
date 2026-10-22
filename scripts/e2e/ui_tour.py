"""Screenshot tour of every Kelpie surface (dark, light, compact, small window) for visual review.
Not a pass/fail test: it only fails when a surface cannot be opened.

    python -X utf8 scripts/e2e/ui_tour.py <screenshot-dir> <worktree repo (optional)>
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from smoke_support import REPO, Run, daemon  # noqa: E402

shots = sys.argv[1]
wt_repo = sys.argv[2] if len(sys.argv) > 2 else None
run = Run(shots)
d = run.d
S = "window.__kelpie.store"


def shot(name, wait=0.5):
    time.sleep(wait)
    run.shot(name)
    run.check(f"shot {name}", True)


def new_session(pid, kind, where="tab"):
    return d.js_async(f"const done = arguments[arguments.length-1]; {S}.newSession(arguments[0], arguments[1], {{ where: arguments[2] }}).then(done);", pid, kind, where)


def set_window(w, h):
    d.set_window_size(w, h)
    time.sleep(0.8)


def context_menu(css, x=140, y=160):
    d.js(f"document.querySelector(arguments[0]).dispatchEvent(new MouseEvent('contextmenu', {{bubbles: true, clientX: {x}, clientY: {y}}}))", css)


def escape():
    d.keys("escape")
    time.sleep(0.3)


def settings(theme):
    d.js(f"{S}.setSettings({{ theme: arguments[0] }}); for (const v of window.__kelpie.views()) v.applySettings({S}.state.settings);", theme)
    time.sleep(0.5)


try:
    run.boot()
    set_window(1480, 920)
    for s in daemon(d, "session.list"):
        daemon(d, "session.close", {"handle": s["handle"]})
    d.js(f"const s = {S}; for (const p of [...s.state.projects]) s.removeProject(p.id); s.setSettings({{ theme: 'dark', density: 'comfortable', uiScale: 1 }});")
    shot("t01-welcome-empty")

    kelpie = d.js(f"return {S}.addProject(arguments[0])", REPO)
    orca = d.js(f"return {S}.addProject(arguments[0], {{ open: false }})", os.path.join(os.path.dirname(REPO), "orca-ref", "orca"))
    if wt_repo:
        repo = d.js(f"return {S}.addProject(arguments[0], {{ open: false }})", wt_repo)
        d.js(f"window.__kelpie.store.switchProject(arguments[0])", repo)
        # The worktree items appear once the repository's git info is known.
        d.wait(f"return {S}.projectInfo[arguments[0]]?.is_repo || null", 15, 0.25, repo)
        context_menu(f"[data-project='{repo}']")
        d.js("[...document.querySelectorAll('.ctx-item')].find(e => e.innerText.startsWith('Add existing'))?.click()")
        time.sleep(1)
        escape()
    d.js(f"{S}.switchProject(arguments[0]); {S}.showRightPanel('files');", kelpie)
    shot("t02-project-launcher")

    # Workspace: an agent TUI and a shell side by side.
    claude = new_session(kelpie, "claude")
    shell = new_session(kelpie, "shell", "right")
    daemon(d, "session.input", {"handle": shell["handle"], "data": "git log --oneline -12\r"})
    new_session(orca, "shell")
    time.sleep(6)
    shot("t03-workspace-dark", 0.2)

    for tab in ("git", "history"):
        d.js(f"{S}.showRightPanel(arguments[0])", tab)
        shot(f"t04-panel-{tab}", 2.5 if tab == "history" else 1)
    d.js(f"{S}.showRightPanel('files')")
    d.js("const i = document.querySelector('.explorer-tools input'); i.value = 'store'; i.dispatchEvent(new Event('input', {bubbles: true}));")
    shot("t05-explorer-filter", 1)
    d.js("const i = document.querySelector('.explorer-tools input'); i.value = ''; i.dispatchEvent(new Event('input', {bubbles: true}));")

    d.js(f"{S}.openFile(arguments[0], 'app/src/lib/store.ts')", kelpie)
    # Language support loads lazily: wait for highlighted tokens before the shot.
    highlighted = d.wait("return document.querySelectorAll('.cm-content span[class]').length > 20 || null", 20)
    run.check("file viewer highlights syntax", bool(highlighted))
    shot("t06-file-viewer", 0.3)
    d.js(f"{S}.showRightPanel('git')")
    time.sleep(1)
    d.js("document.querySelector('.git-file, .change-row, .list-row')?.click()")
    shot("t07-diff-view", 1.5)
    d.js(f"{S}.showRightPanel('files')")

    d.js_async("const done = arguments[arguments.length-1]; window.__kelpie.chat.newChat(arguments[0], 'claude', 'tab').then(() => done(true));", kelpie)
    shot("t08-chat-view", 3)

    d.keys("ctrl+shift+p")
    shot("t09-search-empty")
    d.keys("store")
    shot("t10-search-query", 1)
    escape()
    d.keys("ctrl+shift+n")
    shot("t11-new-session-menu")
    escape()
    d.keys("ctrl+shift+m")
    shot("t12-dashboard", 1)
    escape()
    d.keys("ctrl+shift+j")
    shot("t13-board", 1)
    escape()

    context_menu(".session-row")
    shot("t14-session-menu", 0.3)
    escape()
    context_menu(f"[data-project='{kelpie}']")
    shot("t15-project-menu", 0.3)
    escape()

    for section in ("agents", "commands", "terminal", "appearance", "shortcuts", "notifications", "usage", "daemon", "about"):
        d.js(f"{S}.openSettings(arguments[0])", section)
        shot(f"t16-settings-{section}", 0.6)
        escape()

    if wt_repo:
        d.js("window.__kelpie.store.switchProject(arguments[0])", repo)
        time.sleep(0.4)
        d.js(f"document.querySelector('[data-project=\"{repo}\"]').dispatchEvent(new MouseEvent('contextmenu', {{bubbles: true, clientX: 140, clientY: 200}}))")
        d.js("[...document.querySelectorAll('.ctx-item')].find(e => e.innerText.startsWith('New worktree'))?.click()")
        shot("t17-worktree-dialog", 1.5)
        escape()
        d.js(f"{S}.switchProject(arguments[0])", kelpie)

    d.js(f"{S}.setSettings({{ sidebarCollapsed: true }})")
    shot("t18-sidebar-collapsed")
    d.js(f"{S}.setSettings({{ sidebarCollapsed: false }})")
    d.keys("ctrl+shift+enter")
    shot("t19-pane-maximized")
    d.keys("ctrl+shift+enter")

    # Light theme: the main surfaces again.
    settings("light")
    shot("t20-light-workspace", 1)
    d.js(f"{S}.showRightPanel('git')")
    shot("t21-light-git", 1)
    d.js(f"{S}.showRightPanel('files')")
    d.keys("ctrl+shift+p")
    shot("t22-light-search")
    escape()
    d.keys("ctrl+shift+m")
    shot("t23-light-dashboard", 1)
    escape()
    d.keys("ctrl+shift+j")
    shot("t24-light-board", 1)
    escape()
    d.js(f"{S}.openSettings('appearance')")
    shot("t25-light-settings")
    escape()
    settings("dark")

    # Density and size.
    d.js(f"{S}.setSettings({{ density: 'compact', uiScale: 1.2 }})")
    shot("t26-compact-120", 1)
    d.js(f"{S}.setSettings({{ density: 'comfortable', uiScale: 1 }})")
    set_window(1100, 700)
    shot("t27-small-workspace", 1)
    d.js(f"{S}.openSettings('shortcuts')")
    shot("t28-small-settings")
    escape()
    d.keys("ctrl+shift+j")
    shot("t29-small-board", 1)
    escape()
    d.keys("ctrl+shift+p")
    shot("t30-small-search")
    escape()
    set_window(1480, 920)

    d.js(f"{S}.setSettings({{ tips: true, tipsSeen: [] }})")
    time.sleep(1)
    d.js("location.reload()")
    time.sleep(2)
    run.boot(tips=True)
    d.wait("return !!document.querySelector('.tip')", 12)
    shot("t31-tip")
    d.js(f"{S}.setSettings({{ tips: false }})")

    for s in daemon(d, "session.list"):
        daemon(d, "session.close", {"handle": s["handle"]})
except Exception:
    import traceback
    traceback.print_exc()
    run.check("tour ran to completion", False)
finally:
    run.finish()
