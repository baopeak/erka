"""Screenshots for README.md: a small, realistic demo state captured from the running app.

    python -X utf8 scripts/e2e/readme_shots.py <out-dir> <worktree demo repo> [--no-chat]

The demo repo should be a git repository with worktrees (scripts/e2e/phase5.py leaves one).
Without --no-chat, one short Claude Code turn runs in chat view (a small model call).
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from smoke_support import REPO, Run, daemon  # noqa: E402

out, demo = sys.argv[1], sys.argv[2]
with_chat = "--no-chat" not in sys.argv
os.makedirs(out, exist_ok=True)
run = Run(out)
d = run.d
S = "window.__erka.store"


def shot(name, wait=0.6):
    time.sleep(wait)
    d.screenshot(os.path.join(out, name + ".png"))
    run.check(f"shot {name}", True)


def new_session(pid, kind, where="tab", name=None):
    return d.js_async(f"const done = arguments[arguments.length-1]; {S}.newSession(arguments[0], arguments[1], {{ where: arguments[2], name: arguments[3] || undefined }}).then(done);", pid, kind, where, name)


def type_into(handle, text):
    daemon(d, "session.input", {"handle": handle, "data": text + "\r"})


def escape():
    d.keys("escape")
    time.sleep(0.3)


try:
    run.boot()
    d._req("POST", d.s("/window/rect"), {"width": 1480, "height": 920})
    d._req("POST", d.s("/timeouts"), {"script": 240000})
    for s in daemon(d, "session.list"):
        daemon(d, "session.close", {"handle": s["handle"]})
    d.js(f"""const s = {S};
        for (const p of [...s.state.projects]) s.removeProject(p.id);
        s.setSettings({{ theme: 'dark', density: 'comfortable', uiScale: 1, shortcutHints: false, quickCommands: [
          {{ id: 'q1', label: 'Run tests', text: 'cargo test --workspace', action: 'terminal', enter: true, projectId: null }},
          {{ id: 'q2', label: 'Review diff', text: 'Review the uncommitted changes and list risks.', action: 'agent', enter: true, projectId: null }},
        ] }});""")

    erka = d.js(f"return {S}.addProject(arguments[0])", REPO)
    orca = d.js(f"return {S}.addProject(arguments[0], {{ open: false }})", os.path.join(os.path.dirname(REPO), "orca-ref", "orca"))
    app = d.js(f"return {S}.addProject(arguments[0], {{ open: false }})", demo)
    d.js(f"{S}.renameProject(arguments[0], 'demo-app')", app)
    d.wait(f"return {S}.projectInfo[arguments[0]]?.is_repo || null", 20, 0.25, app)
    d.js_async("const done = arguments[arguments.length-1]; import('/src/lib/worktrees.ts').then(m => m.addExistingWorktrees(window.__erka.store.state.projects.find(p => p.id === arguments[0]))).then(done, e => done(String(e)));", app)
    kids = d.js(f"return {S}.childrenOf(arguments[0]).map(p => p.id)", app)

    # Board state.
    for pid, status in [(erka, "progress"), (orca, "review"), (app, "todo")] + [(k, s) for k, s in zip(kids, ["progress", "done"])]:
        d.js(f"{S}.setProjectStatus(arguments[0], arguments[1])", pid, status)
    d.js(f"{S}.togglePin(arguments[0])", erka)

    # Terminals with real output.
    d.js(f"{S}.switchProject(arguments[0]); {S}.showRightPanel('files');", erka)
    s1 = new_session(erka, "shell")
    s2 = new_session(erka, "shell", "right")
    for k in kids:
        new_session(k, "shell")
    new_session(orca, "shell")
    time.sleep(8)  # shells start
    type_into(s1["handle"], "git log --oneline --graph --decorate -18")
    type_into(s2["handle"], "git status -sb; Get-ChildItem crates, app/src -Directory | Select-Object Name, LastWriteTime | Format-Table -AutoSize")
    time.sleep(3)
    d.js(f"{S}.switchProject(arguments[0])", erka)
    shot("workspace", 1.5)

    d.keys("ctrl+shift+p")
    d.keys("sess")
    shot("search", 1)
    escape()

    d.js(f"{S}.showRightPanel('git')")
    shot("changes", 1.5)
    d.js(f"{S}.showRightPanel('history')")
    shot("history", 3)
    d.js(f"{S}.showRightPanel('files')")

    d.js(f"{S}.openFile(arguments[0], 'crates/erkad/src/session.rs')", erka)
    d.wait("return document.querySelectorAll('.cm-content span[class]').length > 20 || null", 30)
    shot("editor", 0.5)

    if with_chat:
        info = d.js_async(f"""const done = arguments[arguments.length-1];
            window.__erka.chat.newChat(arguments[0], 'claude', 'tab').then(i => done(i ? i.id : null));""", erka)
        sid = info or d.js(f"return Object.values({S}.sessions).filter(s => s.chat).map(s => s.id).pop()")
        time.sleep(6)
        d.js("window.__erka.chat.getController(window.__erka.store.sessions[arguments[0]]).send(arguments[1])",
             sid, "Using only the Glob tool (no Bash), list the top-level folders of this repository and say in one short line what each is for.")
        try:
            d.wait("const c = window.__erka.chat.getController(window.__erka.store.sessions[arguments[0]]); return (c.state.items.some(i => i.kind === 'assistant') && !c.state.busy) || null", 240, 1, sid)
        except TimeoutError:
            print("chat still busy:", d.js("const c = window.__erka.chat.getController(window.__erka.store.sessions[arguments[0]]); return c.state.items.map(i => i.kind + (i.status ? ':' + i.status : '') + (i.resolved ? ':' + i.resolved : ''))", sid))
        time.sleep(4)
        shot("chat", 0.5)

    d.keys("ctrl+shift+n")
    shot("new-session", 0.6)
    escape()
    d.keys("ctrl+shift+m")
    shot("dashboard", 1)
    escape()
    d.keys("ctrl+shift+j")
    shot("board", 1)
    escape()

    d.js(f"{S}.openSettings('appearance')")
    shot("settings", 0.6)
    escape()
    d.js(f"{S}.openSettings('shortcuts')")
    shot("shortcuts", 0.6)
    escape()

    d.js(f"{S}.setSettings({{ theme: 'light' }}); for (const v of window.__erka.views()) v.applySettings({S}.state.settings);")
    d.js(f"{S}.switchProject(arguments[0]); {S}.selectTab(arguments[0], {S}.workspace(arguments[0]).tabs[0].id);", erka)
    shot("light", 1.5)
    d.js(f"{S}.setSettings({{ theme: 'dark', quickCommands: [] }}); for (const v of window.__erka.views()) v.applySettings({S}.state.settings);")

    for s in daemon(d, "session.list"):
        daemon(d, "session.close", {"handle": s["handle"]})
except Exception:
    import traceback
    traceback.print_exc()
    run.check("screenshots ran to completion", False)
finally:
    run.finish()
