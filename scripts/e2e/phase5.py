"""E2E for UI phase 5: worktrees as child projects (create with .kelpie.yaml, agents in each,
remove one cleanly: sessions stop, folder goes, branch stays), the workspace board with drag
and drop, and the app-state migration backup.

    python -X utf8 scripts/e2e/phase5.py <screenshot-dir> <scratch-dir>
"""
import json
import os
import shutil
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from smoke_support import Run, daemon  # noqa: E402

shots, scratch = sys.argv[1], sys.argv[2]
repo = os.path.join(scratch, "wt-repo")
S = "window.__kelpie.store"


def git(*args):
    return subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, check=True).stdout


def _writable_and_retry(func, path, _exc):
    os.chmod(path, 0o666)  # git object files are read-only on Windows
    func(path)


def fresh_repo():
    """Repository with an .kelpie.yaml; leftovers of an earlier run are discarded first."""
    for path in (repo, repo + "-worktrees"):
        if os.path.exists(path):
            shutil.rmtree(path, onexc=_writable_and_retry)
    os.makedirs(repo)
    git("init", "-q", "-b", "main")
    git("config", "user.email", "e2e@kelpie.test")
    git("config", "user.name", "Kelpie e2e")
    open(os.path.join(repo, "README.md"), "w").write("worktree test\n")
    # The nonce makes this a file the user has not approved before (approvals are by content).
    open(os.path.join(repo, ".kelpie.yaml"), "w").write(f"# run {time.time()}\nsetup:\n  - echo kelpie-setup-ran\ntabs:\n  - shell\n")
    git("add", ".")
    git("commit", "-q", "-m", "init")



run = Run(shots)
d = run.d


def drag(x1, y1, x2, y2):
    d._req("POST", d.s("/actions"), {"actions": [{"type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"}, "actions": [
        {"type": "pointerMove", "x": int(x1), "y": int(y1), "duration": 0},
        {"type": "pointerDown", "button": 0},
        {"type": "pointerMove", "x": int(x1) + 8, "y": int(y1) + 8, "duration": 80},
        {"type": "pointerMove", "x": int(x2), "y": int(y2), "duration": 250},
        {"type": "pointerUp", "button": 0},
    ]}]})
    d._req("DELETE", d.s("/actions"))


def center(css):
    r = d.js("const r = document.querySelector(arguments[0]).getBoundingClientRect(); return [r.x + r.width / 2, r.y + Math.min(r.height / 2, 20)]", css)
    return r[0], r[1]


def children(repo_id):
    return d.js(f"return {S}.childrenOf(arguments[0]).map(p => ({{id: p.id, name: p.name, branch: p.branch, path: p.path}}))", repo_id)


def sessions_of(pid):
    return [s for s in daemon(d, "session.list") if s.get("project_id") == pid]


try:
    run.boot()
    d.js("window.confirm = () => true")  # the remove flow asks twice; answer yes
    for s in daemon(d, "session.list"):
        daemon(d, "session.close", {"handle": s["handle"]})
    d.js(f"const s = {S}; for (const p of [...s.state.projects]) s.removeProject(p.id);")
    time.sleep(1.5)  # let closed sessions release their folders
    fresh_repo()
    repo_id = d.js(f"return {S}.addProject(arguments[0])", repo)
    d.wait(f"return {S}.projectInfo[arguments[0]]?.is_repo || null", 15, 0.25, repo_id)

    # ---------- create three worktrees through the dialog ----------
    for i, branch in enumerate(["feature/a", "feature/b", "feature/c"]):
        d.js(f"document.querySelector('[data-project=\"{repo_id}\"]').dispatchEvent(new MouseEvent('contextmenu', {{bubbles: true, clientX: 120, clientY: 140}}))")
        d.js("[...document.querySelectorAll('.ctx-item')].find(e => e.innerText.startsWith('New worktree')).click()")
        d.wait("return !!document.querySelector('.worktree-dialog input')", 5)
        d.js("const i = document.querySelector('.worktree-dialog input'); i.value = arguments[0]; i.dispatchEvent(new Event('input', {bubbles: true}));", branch)
        d.wait("return !!document.querySelector('.worktree-dialog .form-check input')", 10)
        ticked = d.js("return document.querySelector('.worktree-dialog .form-check input').checked")
        if i == 0:
            shown = d.js("return document.querySelector('.kelpie-config-body').innerText")
            run.check(".kelpie.yaml commands are shown before creating", "$ echo kelpie-setup-ran" in shown and "tab: shell" in shown, shown.replace(chr(10), " | "))
            run.check("running .kelpie.yaml is opt-in the first time", ticked is False)
            d.js("document.querySelector('.worktree-dialog .form-check input').click()")
            run.shot("p5-01-new-worktree")
        elif i == 1:
            run.check("an approved .kelpie.yaml is pre-selected next time", ticked is True)
        d.js("[...document.querySelectorAll('.worktree-dialog .btn')].find(b => b.innerText.startsWith('Create')).click()")
        d.wait("return !document.querySelector('.worktree-dialog')", 30)
    kids = children(repo_id)
    run.check("three worktrees appear under the repository", [k["branch"] for k in kids] == ["feature/a", "feature/b", "feature/c"], str([k["name"] for k in kids]))
    run.check("worktree folders exist on their branches", all(os.path.isdir(k["path"]) for k in kids)
              and "feature/b" in git("worktree", "list"), str([k["path"] for k in kids]))

    # .kelpie.yaml: a setup terminal that ran the command, plus the default shell tab.
    a = kids[0]
    end = time.time() + 20
    setup_ok = False
    while time.time() < end and not setup_ok:
        for s in sessions_of(a["id"]):
            if s.get("name") == "setup" and "kelpie-setup-ran" in daemon(d, "session.read", {"handle": s["handle"]})["text"].replace("echo kelpie-setup-ran", ""):
                setup_ok = True
        time.sleep(0.4)
    run.check(".kelpie.yaml setup ran in the new worktree", setup_ok)
    run.check(".kelpie.yaml default tabs opened", len(sessions_of(a["id"])) == 2, str([(s["kind"], s.get("name")) for s in sessions_of(a["id"])]))

    # An agent in each worktree.
    for k in kids:
        d.js_async(f"const done = arguments[arguments.length-1]; {S}.newSession(arguments[0], 'claude').then(done);", k["id"])
    time.sleep(3)
    agents = {k["name"]: [s for s in sessions_of(k["id"]) if s["kind"] == "claude" and s["alive"]] for k in kids}
    run.check("an agent runs in every worktree", all(len(v) == 1 for v in agents.values()), str({n: len(v) for n, v in agents.items()}))
    run.check("agents run in their worktree folder", all(v[0]["cwd"] == k["path"] for k, v in zip(kids, agents.values())))
    d.js(f"{S}.switchProject(arguments[0])", repo_id)
    time.sleep(0.6)
    run.shot("p5-02-sidebar-worktrees")

    # ---------- board ----------
    d.keys("ctrl+shift+j")
    d.wait("return !!document.querySelector('.board')", 5)
    time.sleep(0.4)
    x1, y1 = center(f"[data-card='{kids[0]['id']}']")
    x2, y2 = center("[data-col=progress] .board-col-body")
    drag(x1, y1, x2, y2)
    time.sleep(0.4)
    st = d.js(f"return {S}.state.projects.find(p => p.id === arguments[0]).status", kids[0]["id"])
    run.check("dragging a card to In progress changes its status", st == "progress", str(st))
    x1, y1 = center(f"[data-card='{kids[1]['id']}']")
    x2, y2 = center("[data-col=review] .board-col-body")
    drag(x1, y1, x2, y2)
    time.sleep(0.4)
    run.check("and another to Review", d.js(f"return {S}.state.projects.find(p => p.id === arguments[0]).status", kids[1]["id"]) == "review")
    d.js("document.querySelector(`[data-card='${arguments[0]}'] .pin`).click()", kids[2]["id"])
    run.check("pinning a card", d.js(f"return !!{S}.state.projects.find(p => p.id === arguments[0]).pinned", kids[2]["id"]))
    run.shot("p5-03-board")
    x, y = center(f"[data-card='{kids[0]['id']}'] .board-card-name")
    d._req("POST", d.s("/actions"), {"actions": [{"type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"}, "actions": [
        {"type": "pointerMove", "x": int(x), "y": int(y), "duration": 0}, {"type": "pointerDown", "button": 0}, {"type": "pointerUp", "button": 0}]}]})
    d._req("DELETE", d.s("/actions"))
    time.sleep(0.4)
    run.check("clicking a card opens its worktree", d.js(f"return {S}.state.activeProject") == kids[0]["id"] and d.js(f"return {S}.overlay()") is None)

    # ---------- remove a worktree ----------
    b = kids[1]
    pids = [s["pid"] for s in sessions_of(b["id"]) if s.get("pid")]
    d.js(f"{S}.switchProject(arguments[0])", b["id"])  # removing the open worktree must work too
    time.sleep(0.8)
    d.js(f"document.querySelector('[data-project=\"{b['id']}\"]').dispatchEvent(new MouseEvent('contextmenu', {{bubbles: true, clientX: 120, clientY: 200}}))")
    d.js("[...document.querySelectorAll('.ctx-item')].find(e => e.innerText.startsWith('Remove worktree')).click()")
    gone = d.wait(f"return !{S}.state.projects.some(p => p.id === arguments[0]) || null", 30, 0.25, b["id"])
    run.check("the worktree leaves the sidebar", bool(gone))
    run.check("its sessions are closed in the daemon", sessions_of(b["id"]) == [])
    alive = [p for p in pids if str(p) in subprocess.run(["tasklist", "/FI", f"PID eq {p}", "/NH"], capture_output=True, text=True).stdout]
    run.check("its processes have exited", not alive, f"{len(pids)} pids, alive={alive}")
    run.check("its folder is gone", not os.path.exists(b["path"]), b["path"])
    run.check("its branch is kept", "feature/b" in git("branch", "--list", "feature/b"))
    run.check("other worktrees keep running", all(any(s["alive"] for s in sessions_of(k["id"])) for k in (kids[0], kids[2])))
    run.shot("p5-04-after-remove")

    # ---------- a detached worktree with its own commit is protected ----------
    det = os.path.join(repo + "-worktrees", "detached")
    git("worktree", "add", "-q", "--detach", det)
    subprocess.run(["git", "-C", det, "commit", "-q", "--allow-empty", "-m", "only here"], check=True, capture_output=True)
    d.js(f"document.querySelector('[data-project=\"{repo_id}\"]').dispatchEvent(new MouseEvent('contextmenu', {{bubbles: true, clientX: 120, clientY: 140}}))")
    d.js("[...document.querySelectorAll('.ctx-item')].find(e => e.innerText.startsWith('Add existing worktrees')).click()")
    det_id = d.wait(f"return {S}.childrenOf(arguments[0]).find(p => p.path.toLowerCase().endsWith('detached'))?.id || null", 10, 0.25, repo_id)
    run.check("existing worktrees are picked up (main worktree not duplicated)", det_id is not None and len(children(repo_id)) == 3, str([k["name"] for k in children(repo_id)]))
    d.js(f"document.querySelector('[data-project=\"{det_id}\"]').dispatchEvent(new MouseEvent('contextmenu', {{bubbles: true, clientX: 120, clientY: 260}}))")
    d.js("[...document.querySelectorAll('.ctx-item')].find(e => e.innerText.startsWith('Remove worktree')).click()")
    toast = d.wait("const t = document.querySelector('.toast')?.innerText || ''; return t.includes('detached') ? t : null", 15)
    run.check("removing a detached worktree with unique commits is refused", "detached HEAD" in toast and os.path.isdir(det), toast)
    run.shot("p5-05-detached-protected")
    d.js(f"{S}.removeProject(arguments[0])", det_id)
    git("worktree", "remove", "--force", det)

    # ---------- state migration keeps a backup ----------
    data_dir = d.js_async("const done = arguments[arguments.length-1]; window.__TAURI_INTERNALS__.invoke('platform_info').then(i => done(i.data_dir));")
    state_file = os.path.join(data_dir, "app-state.json")
    import glob
    for old in glob.glob(os.path.join(data_dir, "app-state.v1-*.bak.json")):
        os.remove(old)
    time.sleep(1)
    st = json.load(open(state_file, encoding="utf8"))
    st["version"] = 1
    json.dump(st, open(state_file, "w", encoding="utf8"))
    d.js("location.reload()")
    time.sleep(2)
    run.boot()
    time.sleep(1)
    backups = glob.glob(os.path.join(data_dir, "app-state.v1-*.bak.json"))
    run.check("an old state file is backed up before migration", len(backups) == 1 and json.load(open(backups[0], encoding="utf8"))["version"] == 1, str(backups))
    run.check("and rewritten in the current format", json.load(open(state_file, encoding="utf8"))["version"] == 3
              and d.js(f"return {S}.childrenOf(arguments[0]).length", repo_id) == 2)

    for s in daemon(d, "session.list"):
        daemon(d, "session.close", {"handle": s["handle"]})
except Exception:
    import traceback
    traceback.print_exc()
    run.check("scenario ran to completion", False)
finally:
    run.finish()
