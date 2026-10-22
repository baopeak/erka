"""Screenshots for README.md: a small, realistic demo state captured from the running app.

    python -X utf8 scripts/e2e/readme_shots.py <out-dir> <worktree demo repo> [--no-chat]

The demo repo should be a git repository with worktrees (scripts/e2e/phase5.py leaves one).
The review-notes, markdown and CSV shots use its uncommitted changes, `docs/architecture.md`
(with a mermaid block) and `data/latency.csv` when it has them.
Without --no-chat, one short Claude Code turn runs in chat view (a small model call).
"""
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from smoke_support import REPO, Run, daemon  # noqa: E402

out, demo = sys.argv[1], sys.argv[2]
with_chat = "--no-chat" not in sys.argv
os.makedirs(out, exist_ok=True)
run = Run(out)
d = run.d
S = "window.__kelpie.store"


def shot(name, wait=0.6):
    time.sleep(wait)
    d.screenshot(os.path.join(out, name + ".png"))
    run.check(f"shot {name}", True)


def new_session(pid, kind, where="tab", name=None):
    return d.js_async(f"const done = arguments[arguments.length-1]; {S}.newSession(arguments[0], arguments[1], {{ where: arguments[2], name: arguments[3] || undefined }}).then(done);", pid, kind, where, name)


def type_into(handle, text):
    daemon(d, "session.input", {"handle": handle, "data": text + "\r"})


def git_changed(repo):
    """First modified tracked file of the demo repo, for the review-notes shot."""
    out = subprocess.run(["git", "-C", repo, "diff", "--name-only"], capture_output=True, text=True).stdout.split()
    return out[0] if out else None


def escape():
    d.keys("escape")
    time.sleep(0.3)


try:
    run.boot()
    d.set_window_size(1480, 920)
    d._req("POST", d.s("/timeouts"), {"script": 240000})
    for s in daemon(d, "session.list"):
        daemon(d, "session.close", {"handle": s["handle"]})
    d.js(f"""const s = {S};
        for (const p of [...s.state.projects]) s.removeProject(p.id);
        s.setSettings({{ theme: 'dark', density: 'comfortable', uiScale: 1, shortcutHints: false, quickCommands: [
          {{ id: 'q1', label: 'Run tests', text: 'cargo test --workspace', action: 'terminal', enter: true, projectId: null }},
          {{ id: 'q2', label: 'Review diff', text: 'Review the uncommitted changes and list risks.', action: 'agent', enter: true, projectId: null }},
        ] }});""")

    kelpie = d.js(f"return {S}.addProject(arguments[0])", REPO)
    orca = d.js(f"return {S}.addProject(arguments[0], {{ open: false }})", os.path.join(os.path.dirname(REPO), "orca-ref", "orca"))
    app = d.js(f"return {S}.addProject(arguments[0], {{ open: false }})", demo)
    d.js(f"{S}.renameProject(arguments[0], arguments[1])", app, os.path.basename(os.path.normpath(demo)))
    d.wait(f"return {S}.projectInfo[arguments[0]]?.is_repo || null", 20, 0.25, app)
    d.js_async("const done = arguments[arguments.length-1]; import('/src/lib/worktrees.ts').then(m => m.addExistingWorktrees(window.__kelpie.store.state.projects.find(p => p.id === arguments[0]))).then(done, e => done(String(e)));", app)
    kids = d.js(f"return {S}.childrenOf(arguments[0]).map(p => p.id)", app)
    # Worktree comments, as an agent would set them with `kelpied worktree set --comment`.
    for k, comment in zip(kids, ["checkout endpoint returns 201; writing tests", "burst of 30 req/s reproduced; tuning bucket"]):
        daemon(d, "meta.set", {"path": d.js(f"return {S}.state.projects.find(p => p.id === arguments[0]).path", k), "comment": comment})

    # Board state.
    for pid, status in [(kelpie, "progress"), (orca, "review"), (app, "todo")] + [(k, s) for k, s in zip(kids, ["progress", "done"])]:
        d.js(f"{S}.setProjectStatus(arguments[0], arguments[1])", pid, status)
    d.js(f"{S}.togglePin(arguments[0])", kelpie)

    # Terminals with real output.
    d.js(f"{S}.switchProject(arguments[0]); {S}.showRightPanel('files');", kelpie)
    s1 = new_session(kelpie, "shell")
    s2 = new_session(kelpie, "shell", "right")
    for k in kids:
        new_session(k, "shell")
    new_session(orca, "shell")
    time.sleep(8)  # shells start
    type_into(s1["handle"], "git log --oneline --graph --decorate -18")
    type_into(s2["handle"], "git status -sb; Get-ChildItem crates, app/src -Directory | Select-Object Name, LastWriteTime | Format-Table -AutoSize")
    time.sleep(3)
    d.js(f"{S}.switchProject(arguments[0])", kelpie)
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

    d.js(f"{S}.openFile(arguments[0], 'crates/kelpied/src/session.rs')", kelpie)
    d.wait("return document.querySelectorAll('.cm-content span[class]').length > 20 || null", 30)
    shot("editor", 0.5)

    if with_chat:
        info = d.js_async(f"""const done = arguments[arguments.length-1];
            window.__kelpie.chat.newChat(arguments[0], 'claude', 'tab').then(i => done(i ? i.id : null));""", kelpie)
        sid = info or d.js(f"return Object.values({S}.sessions).filter(s => s.chat).map(s => s.id).pop()")
        time.sleep(6)
        d.js("window.__kelpie.chat.getController(window.__kelpie.store.sessions[arguments[0]]).send(arguments[1])",
             sid, "Using only the Glob tool (no Bash), list the top-level folders of this repository and say in one short line what each is for.")
        try:
            d.wait("const c = window.__kelpie.chat.getController(window.__kelpie.store.sessions[arguments[0]]); return (c.state.items.some(i => i.kind === 'assistant') && !c.state.busy) || null", 240, 1, sid)
        except TimeoutError:
            print("chat still busy:", d.js("const c = window.__kelpie.chat.getController(window.__kelpie.store.sessions[arguments[0]]); return c.state.items.map(i => i.kind + (i.status ? ':' + i.status : '') + (i.resolved ? ':' + i.resolved : ''))", sid))
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

    # Review notes on the demo repo's uncommitted change, with the Changes panel beside it.
    d.js(f"{S}.switchProject(arguments[0]); {S}.showRightPanel('git');", app)
    changed = git_changed(demo)
    if changed:
        d.js(f"{S}.removeNotes(arguments[0], 'all'); {S}.openFile(arguments[0], arguments[1], {{ diff: true }})", app, changed)
        d.wait("return document.querySelector('.cm-note-gutter') || null", 20)
        for line, text, note in [(4, 'import { allow } from "../lib/rate-limit.js";', "Rate-limit before parsing: also cover GET /:id?"),
                                 (25, "const discount = body.coupon ? await db.coupons.value(body.coupon) : 0;", "db.coupons does not exist yet; read from src/lib/coupons.ts")]:
            d.js(f"{S}.addNote(arguments[0], {{ path: arguments[1], line: arguments[2], side: 'new', text: arguments[3], note: arguments[4] }})", app, changed, line, text, note)
        d.wait("return document.querySelector('.cm-note-mark.has') || null", 10)
        shot("review-notes", 1)
        d.js(f"{S}.removeNotes(arguments[0], 'all')", app)

    # Rich viewers.
    d.js(f"{S}.showRightPanel('files')")
    if os.path.isfile(os.path.join(demo, "docs", "architecture.md")):
        d.js(f"{S}.openFile(arguments[0], 'docs/architecture.md')", app)
        d.wait("return document.querySelector('.markdown svg') || null", 40)
        shot("markdown", 1)
    if os.path.isfile(os.path.join(demo, "data", "latency.csv")):
        d.js(f"{S}.openFile(arguments[0], 'data/latency.csv')", app)
        d.wait("return document.querySelector('.data-table tbody tr') || null", 20)
        d.js("const th = [...document.querySelectorAll('.data-table th')].find(t => t.textContent.startsWith('p95')); th?.click(); th?.click();")
        shot("csv", 0.8)

    # Terminal colour theme and context menu.
    d.js(f"{S}.switchProject(arguments[0]); {S}.selectTab(arguments[0], {S}.workspace(arguments[0]).tabs[0].id);", kelpie)
    d.js(f"{S}.setSettings({{ terminalTheme: 'dracula' }}); for (const v of window.__kelpie.views()) v.applySettings({S}.state.settings);")
    d.wait("return getComputedStyle(document.querySelector('.pane .term-wrap')).backgroundColor === 'rgb(40, 42, 54)' || null", 5)
    d.js("document.querySelector('.pane .term-wrap').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 520, clientY: 330 }))")
    d.wait("return document.querySelector('.ctx-menu .ctx-item') || null", 5)
    shot("terminal-menu", 0.6)
    escape()
    run.check("Escape closes the terminal context menu", d.wait("return !document.querySelector('.ctx-menu') || null", 5))
    d.js(f"{S}.setSettings({{ terminalTheme: 'default' }}); for (const v of window.__kelpie.views()) v.applySettings({S}.state.settings);")

    # Floating terminal over the workspace (opens in the home folder: keep that path off the picture).
    d.keys("ctrl+shift+`")
    d.wait("return document.querySelector('.floating-term .xterm') || null", 20)
    fl = d.js(f"return {S}.state.floating.active")
    fh = d.js(f"return {S}.sessions[arguments[0]].handle", fl)
    time.sleep(4)
    type_into(fh, f"function prompt {{ 'PS> ' }}; Set-Location '{demo}'; Clear-Host")
    time.sleep(1.5)
    type_into(fh, "git log --oneline --graph --all -12")
    shot("floating", 2)
    d.keys("ctrl+shift+`")
    d.js(f"{S}.closeFloating(arguments[0])", fl)

    # Activity inbox.
    d.js(f"""const s = {S}; s.clearInbox();
        s.addInbox({{ kind: 'worktree', title: 'Worktree feature/checkout-flow', body: 'Created in shop-api · copied .env · linked node_modules', projectId: arguments[0] }});
        s.addInbox({{ kind: 'automation', title: 'Nightly dependency audit', body: 'Ran in shop-api', projectId: arguments[1] }});
        s.addInbox({{ kind: 'waiting', title: 'Codex · rate-limit-burst', body: 'Needs approval: run npm test', projectId: arguments[2] }});
        s.addInbox({{ kind: 'finished', title: 'Claude Code · checkout-flow', body: 'Finished: checkout endpoint returns 201 with the order id', projectId: arguments[0] }});""",
         kids[0] if kids else app, app, kids[-1] if kids else app)
    d.js("document.querySelector('.inbox-anchor').click()")
    d.wait("return document.querySelector('.inbox .inbox-item') || null", 5)
    shot("inbox", 0.6)
    escape()
    run.check("Escape closes the inbox", d.wait("return !document.querySelector('.inbox') || null", 5))

    # New worktree dialog with the start-from picker and ignored-file copy / link.
    d.js("import('/src/components/worktree-dialog.tsx').then(m => m.openWorktreeDialog(arguments[0], 'fix coupon rounding'))", app)
    d.wait("return document.querySelector('.worktree-dialog input') || null", 10)
    shot("worktree-dialog", 2)
    escape()

    # Scheduled automations and agent settings.
    autos = [daemon(d, "automation.save", {"id": "", "name": name, "enabled": True, "kind": kind, "prompt": prompt, "cwd": demo, "project_id": app, "args": [], "every": every, "time": at, "weekday": 5})
             for name, kind, prompt, every, at in [
                 ("Nightly dependency audit", "claude", "Run npm audit, fix what is safe to fix and list the rest.", "daily", "02:00"),
                 ("Weekly changelog draft", "codex", "Draft release notes from the commits merged this week.", "weekly", "17:00"),
                 ("Flaky test sweep", "claude", "Run the test suite three times and report tests that fail only sometimes.", "weekdays", "07:30")]]
    d.js(f"{S}.openSettings('automations')")
    d.wait("return document.querySelector('.automation-name') || null", 10)
    shot("automations", 0.8)
    escape()
    for a in autos:
        daemon(d, "automation.delete", {"id": a["id"]})
    d.js(f"{S}.openSettings('agents')")
    d.wait("return document.querySelectorAll('.agent-item').length > 5 || null", 10)
    # The preset list sits below the per-agent arguments.
    d.js("[...document.querySelectorAll('.settings-page *')].find(e => e.childElementCount === 0 && e.textContent === 'Agent CLIs')?.scrollIntoView({ block: 'start' })")
    shot("agents", 0.8)
    escape()

    d.js(f"{S}.openSettings('appearance')")
    shot("settings", 0.6)
    escape()
    d.js(f"{S}.openSettings('shortcuts')")
    shot("shortcuts", 0.6)
    escape()

    d.js(f"{S}.setSettings({{ theme: 'light' }}); for (const v of window.__kelpie.views()) v.applySettings({S}.state.settings);")
    d.js(f"{S}.switchProject(arguments[0]); {S}.selectTab(arguments[0], {S}.workspace(arguments[0]).tabs[0].id);", kelpie)
    shot("light", 1.5)
    d.js(f"{S}.setSettings({{ theme: 'dark', quickCommands: [] }}); for (const v of window.__kelpie.views()) v.applySettings({S}.state.settings);")

    for s in daemon(d, "session.list"):
        daemon(d, "session.close", {"handle": s["handle"]})
except Exception:
    import traceback
    traceback.print_exc()
    run.check("screenshots ran to completion", False)
finally:
    run.finish()
