"""E2E for orchestration runs.

    python -X utf8 scripts/e2e/runs.py <screenshot-dir> <scratch-dir> [--ai]

Without --ai the tasks are commands (no model calls) that report with the real
`kelpied run report` command from inside their session, or exit: dependencies, a task in its own
git worktree (shown as a worktree project with its session), an approval gate approved from the
Runs page, a failing task that skips the tasks after it, retry, mark done, cancel (stops the
running agent), delete, the `kelpied run` CLI (create / list / show / wait), the activity inbox
and the status-bar indicator. --ai: plans a run with an agent, and runs a real Claude Code task
that does a small edit and reports back by itself.
"""
import json
import os
import shutil
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from smoke_support import REPO, Run, daemon  # noqa: E402

shots, scratch = sys.argv[1], sys.argv[2]
with_ai = "--ai" in sys.argv
S = "window.__kelpie.store"
R = "window.__kelpie.runs"
kelpied = os.path.join(REPO, "target", "release", "kelpied.exe" if os.name == "nt" else "kelpied")
py = sys.executable
repo = os.path.join(scratch, "runs-repo")


def rm(path):
    for _ in range(10):
        if not os.path.exists(path):
            return
        try:
            shutil.rmtree(path, onexc=lambda f, p, e: (os.chmod(p, 0o666), f(p)))
            return
        except PermissionError:
            time.sleep(0.5)


def git(*args):
    return subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, check=True).stdout


def cli(*args, stdin=None):
    p = subprocess.run([kelpied, *args], capture_output=True, text=True, timeout=120, input=stdin)
    return p.returncode, p.stdout, p.stderr


run = Run(shots)
d = run.d


def js_await(expr, *args):
    return d.js_async(f"const done = arguments[arguments.length-1]; Promise.resolve().then(() => {expr}).then(v => done(v === undefined ? null : v), e => done({{err: String(e)}}));", *args)


def get_run(rid):
    return daemon(d, "run.get", {"id": rid})


def wait(cond, timeout=30, interval=0.4):
    end = time.time() + timeout
    while time.time() < end:
        v = cond()
        if v:
            return v
        time.sleep(interval)
    return None


def task(r, tid):
    return next(t for t in r["tasks"] if t["id"] == tid)


def report_task(tid, summary):
    """A command task that reports done through the kelpied CLI from inside its own session."""
    return {"id": tid, "title": f"Task {tid}", "prompt": f"report {tid}", "kind": "custom", "args": [kelpied, "run", "report", "done", summary]}


try:
    run.boot()
    d.set_window_size(1480, 920)
    d._req("POST", d.s("/timeouts"), {"script": 300000})
    for s in daemon(d, "session.list"):
        daemon(d, "session.close", {"handle": s["handle"]})
    for r in daemon(d, "run.list"):
        if r["status"] == "running":
            daemon(d, "run.cancel", {"id": r["id"]})
        daemon(d, "run.delete", {"id": r["id"]})
    rm(repo)
    rm(repo + "-worktrees")
    os.makedirs(repo)
    subprocess.run(["git", "init", "-q", "-b", "main", repo], check=True)
    git("config", "user.email", "e2e@kelpie.test")
    git("config", "user.name", "Kelpie e2e")
    open(os.path.join(repo, "README.md"), "w").write("runs\n")
    git("add", ".")
    git("commit", "-q", "-m", "init")
    d.js(f"const s = {S}; for (const p of [...s.state.projects]) s.removeProject(p.id); s.setSettings({{ shortcutHints: false, tips: false }}); s.clearInbox();")
    pid = d.js(f"return {S}.addProject(arguments[0])", repo)
    d.wait(f"return {S}.projectInfo[arguments[0]]?.is_repo || null", 20, 0.25, pid)

    # ---------- a run with dependencies, a worktree, a gate and a failure ----------
    spec = {
        "name": "E2E pipeline", "objective": "Exercise the run engine", "cwd": repo, "project_id": pid, "idle_done_secs": 0,
        "tasks": [
            {**report_task("a", "a built the parser"), "worktree": True},
            {**report_task("b", "b wrote the tests"), "deps": ["a"], "approve": True},
            {"id": "c", "title": "Task c", "prompt": "fail", "kind": "custom", "args": [py, "-c", "import sys; sys.exit(3)"], "deps": ["a"]},
            {**report_task("d", "d never runs"), "deps": ["c"]},
        ],
    }
    r = js_await(f"{R}.createRun(arguments[0])", spec)
    rid = r["id"]
    run.check("run created with four pending tasks", r["status"] == "running" and [t["status"] for t in r["tasks"]] == ["pending"] * 4, str([t["status"] for t in r["tasks"]]))
    a = wait(lambda: (lambda t: t if t["status"] == "done" else None)(task(get_run(rid), "a")), 40)
    run.check("task a ran in its own worktree and reported done with its summary", a and a["summary"] == "a built the parser" and a["branch"] and a["branch"].startswith("kelpie/"), str(a and {k: a[k] for k in ("status", "summary", "branch", "error")}))
    run.check("task a's worktree exists on its branch", a and os.path.isdir(a["cwd"]) and subprocess.run(["git", "-C", a["cwd"], "rev-parse", "--abbrev-ref", "HEAD"], capture_output=True, text=True).stdout.strip() == a["branch"])
    wt_project = wait(lambda: d.js(f"return {S}.state.projects.find(p => p.path === arguments[0])?.id ?? null", a["cwd"]), 10) if a else None
    run.check("the worktree appears as a project under the repository", bool(wt_project) and d.js(f"return {S}.state.projects.find(p => p.id === arguments[0]).parentId", wt_project) == pid)
    sa = next((s for s in daemon(d, "session.list") if s["id"] == a["session_id"]), None) if a else None
    run.check("task a's session belongs to the worktree project", bool(wait(lambda: (next((s for s in daemon(d, "session.list") if s["id"] == a["session_id"]), {}) or {}).get("project_id") == wt_project, 10)))
    r = wait(lambda: (lambda x: x if task(x, "b")["status"] == "waiting_approval" and task(x, "c")["status"] in ("failed", "done") else None)(get_run(rid)), 40)
    run.check("task b waits for approval once a is done", r and task(r, "b")["status"] == "waiting_approval")
    run.check("task c failed with its exit code", r and task(r, "c")["status"] == "failed" and "code 3" in (task(r, "c")["error"] or ""), str(r and task(r, "c")["error"]))
    r = wait(lambda: (lambda x: x if task(x, "d")["status"] == "skipped" else None)(get_run(rid)), 10)
    run.check("task d is skipped because c failed", bool(r))
    inbox = d.js(f"return {S}.state.inbox.map(i => i.title + ' | ' + i.body)")
    run.check("approval request and failure land in the activity inbox", any("Task b" in i and "approval" in i for i in inbox) and any("Task c" in i for i in inbox), str(inbox[:4]))
    run.check("status bar shows the running run", d.js("return [...document.querySelectorAll('.statusbar .item')].some(e => /1 run/.test(e.textContent))"))

    # Runs page: approve b from its card.
    d.js("window.__kelpie.commands.find(c => c.id === 'runs').run()")
    d.wait("return !!document.querySelector('.runs-page .run-task')", 10)
    d.js("document.querySelector('.runs-item[data-run=\"' + arguments[0] + '\"]').click()", rid)
    d.wait("return !!document.querySelector('.run-task[data-task=\"b\"] .btn.primary')", 10)
    run.shot("01-run-waiting-approval")
    lanes = d.js("return [...document.querySelectorAll('.run-lane')].map(l => [...l.querySelectorAll('.run-task')].map(t => t.dataset.task))")
    run.check("tasks laid out by dependency depth", lanes == [["a"], ["b", "c"], ["d"]], str(lanes))
    d.js("document.querySelector('.run-task[data-task=\"b\"] .btn.primary').click()")
    b = wait(lambda: (lambda t: t if t["status"] == "done" else None)(task(get_run(rid), "b")), 30)
    run.check("approved task b runs and reports done", b and b["summary"] == "b wrote the tests")
    r = wait(lambda: (lambda x: x if x["status"] != "running" else None)(get_run(rid)), 10)
    run.check("run ends as failed (task c failed)", r and r["status"] == "failed")
    run.check("activity inbox records the run's end", d.js(f"return {S}.state.inbox.some(i => i.title === 'Run · E2E pipeline')"))

    # Retry c (fails again: same command) puts d back to waiting first.
    before = get_run(rid)
    d.js("[...document.querySelectorAll('.run-task[data-task=\"c\"] .run-task-actions .btn')].find(b => b.textContent.includes('Retry')).click()")
    r = wait(lambda: (lambda x: x if task(x, "c")["session_id"] != task(before, "c")["session_id"] else None)(get_run(rid)), 15)
    run.check("retry restarts a failed task in a new session", bool(r))
    r = wait(lambda: (lambda x: x if x["status"] != "running" else None)(get_run(rid)), 30)
    run.check("after the retry fails again, d is skipped again", r and task(r, "d")["status"] == "skipped")
    run.shot("02-run-finished")

    # ---------- CLI ----------
    spec2 = {"name": "CLI run", "cwd": repo, "idle_done_secs": 0, "tasks": [report_task("x", "from the cli"), {**report_task("y", "after x"), "deps": ["x"]}]}
    code, out, err = cli("run", "create", "-", "--json", stdin=json.dumps(spec2))
    run.check("`kelpied run create -` creates a run", code == 0 and json.loads(out)["name"] == "CLI run", err[-300:])
    rid2 = json.loads(out)["id"] if code == 0 else ""
    code, out, err = cli("run", "wait", rid2[:8], "--timeout-ms", "60000")
    run.check("`kelpied run wait` returns when the run is done", code == 0 and "from the cli" in out and "after x" in out, (out + err)[-400:])
    code, out, _ = cli("run", "list")
    run.check("`kelpied run list` shows both runs", "CLI run" in out and "E2E pipeline" in out and "2/2" in out, out[-300:])
    code, out, _ = cli("run", "show", rid2[:8])
    run.check("`kelpied run show` lists tasks with status and summary", "x" in out and "done" in out and "from the cli" in out)
    code, out, err = cli("run", "report", "done", "outside")
    run.check("`kelpied run report` outside a task session explains itself", code != 0 and "task" in (out + err).lower())

    # ---------- mark done, cancel (stops the agent), delete ----------
    spec3 = {"name": "Cancel me", "cwd": repo, "project_id": pid, "idle_done_secs": 0, "tasks": [
        {"id": "long", "title": "Long task", "prompt": "wait", "kind": "custom", "args": [py, "-c", "import time; time.sleep(600)"]},
        {"id": "manual", "title": "Manual task", "prompt": "wait", "kind": "custom", "args": [py, "-c", "import time; time.sleep(600)"]},
        {**report_task("after", "after manual"), "deps": ["manual"]},
    ]}
    r3 = js_await(f"{R}.createRun(arguments[0])", spec3)
    rid3 = r3["id"]
    wait(lambda: all(task(get_run(rid3), t)["status"] == "running" for t in ("long", "manual")), 20)
    js_await(f"{R}.taskAction('task_done', arguments[0], 'manual')", rid3)
    r = wait(lambda: (lambda x: x if task(x, "after")["status"] == "done" else None)(get_run(rid3)), 30)
    run.check("'Mark done' finishes a running task and starts the next", bool(r))
    long_sid = task(get_run(rid3), "long")["session_id"]
    js_await(f"{R}.cancelRun(arguments[0])", rid3)
    r = wait(lambda: (lambda x: x if x["status"] == "cancelled" else None)(get_run(rid3)), 10)
    run.check("cancel marks unfinished tasks cancelled", r and task(r, "long")["status"] == "cancelled")
    run.check("cancel stops the task's running agent", bool(wait(lambda: not (next((s for s in daemon(d, "session.list") if s["id"] == long_sid), {}) or {}).get("alive"), 15)))
    js_await(f"{R}.deleteRun(arguments[0])", rid3)
    run.check("deleted run leaves the list", bool(wait(lambda: not d.js(f"return !!{R}.runsById[arguments[0]]", rid3), 10)))

    # ---------- new-run editor ----------
    d.js("[...document.querySelectorAll('.runs-page .btn.primary')].find(b => b.textContent.includes('New run')).click()")
    d.wait("return !!document.querySelector('.run-editor')", 5)
    d.js("const i = document.querySelector('.run-editor input'); i.value = 'Editor run'; i.dispatchEvent(new InputEvent('input', {bubbles: true}));")
    d.js("document.querySelector('.run-editor textarea').value = 'objective'; document.querySelector('.run-editor textarea').dispatchEvent(new InputEvent('input', {bubbles: true}));")
    d.js("[...document.querySelectorAll('.run-editor .btn')].find(b => b.textContent.includes('Add task')).click()")
    d.js("""const drafts = document.querySelectorAll('.run-editor-task');
      drafts.forEach((el, i) => {
        const title = el.querySelectorAll('input')[1]; title.value = 'Step ' + (i + 1); title.dispatchEvent(new InputEvent('input', {bubbles: true}));
        const ta = el.querySelector('textarea'); ta.value = 'Do step ' + (i + 1); ta.dispatchEvent(new InputEvent('input', {bubbles: true}));
      });""")
    d.js("[...document.querySelectorAll('.run-editor-task')[1].querySelectorAll('.toggle')].find(b => b.textContent === 't1').click()")
    d.js("document.querySelectorAll('.run-editor-task')[0].querySelectorAll('input[type=checkbox]')[1].click()")
    run.shot("03-run-editor")
    d.js("[...document.querySelectorAll('.run-editor .btn.primary')].find(b => b.textContent.includes('Start run')).click()")
    er = wait(lambda: next((x for x in daemon(d, "run.list") if x["name"] == "Editor run"), None), 10)
    run.check("editor creates the run with dependencies and the approval gate", er and task(er, "t2")["deps"] == ["t1"] and task(er, "t1")["approve"] is True, str(er and [(t["id"], t["deps"], t["approve"]) for t in er["tasks"]]))
    if er:
        wait(lambda: task(get_run(er["id"]), "t1")["status"] == "waiting_approval", 10)
        run.check("gated first task waits (no agent started)", task(get_run(er["id"]), "t1")["session_id"] is None)
        daemon(d, "run.cancel", {"id": er["id"]})
        daemon(d, "run.delete", {"id": er["id"]})

    if with_ai:
        # Plan with an agent (one-shot).
        plan = js_await(f"{R}.planTasks('Add a CONTRIBUTING.md and a LICENSE file, then review both.', arguments[0], 'claude', 'claude')", repo)
        run.check("AI planning returns several tasks with prompts", isinstance(plan, dict) and len(plan.get("tasks", [])) >= 2 and all(t["prompt"] for t in plan["tasks"]), str(plan)[:300])
        # A real agent task that reports back by itself.
        spec4 = {"name": "Real agent", "objective": "Small edit", "cwd": repo, "project_id": pid, "idle_done_secs": 0, "tasks": [
            {"id": "hello", "title": "Write hello.txt", "kind": "claude", "args": ["--model", "haiku", "--permission-mode", "bypassPermissions"],
             "prompt": "Create a file named hello.txt in the current folder containing exactly the text: hi from kelpie"},
        ]}
        r4 = js_await(f"{R}.createRun(arguments[0])", spec4)
        sid = wait(lambda: task(get_run(r4["id"]), "hello")["session_id"], 20)
        # Claude asks to trust a folder it has not seen.
        sess = lambda: next((s for s in daemon(d, "session.list") if s["id"] == sid), None)
        if wait(lambda: sess() and "trust this folder" in daemon(d, "session.read", {"handle": sess()["handle"], "lines": 40})["text"], 40):
            daemon(d, "session.input", {"handle": sess()["handle"], "data": chr(27) + "[B"})
            time.sleep(0.4)
            daemon(d, "session.input", {"handle": sess()["handle"], "data": chr(13)})
        t = wait(lambda: (lambda x: x if x["status"] in ("done", "failed") else None)(task(get_run(r4["id"]), "hello")), 420, 2)
        run.check("a real agent reports its task done with `kelpied run report`", t and t["status"] == "done" and bool(t["summary"]), str(t and {k: t[k] for k in ("status", "summary", "error")}))
        run.check("the agent did the work", os.path.isfile(os.path.join(repo, "hello.txt")))
        run.shot("04-real-agent-run")
        if sess():
            daemon(d, "session.close", {"handle": sess()["handle"]})

    d.js(f"{S}.setOverlay(null)")
    for s in daemon(d, "session.list"):
        daemon(d, "session.close", {"handle": s["handle"]})
except Exception:
    import traceback
    traceback.print_exc()
    run.check("scenario ran to completion", False)
finally:
    run.finish()
