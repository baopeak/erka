"""E2E for Linear, Jira and GitLab.

    python -X utf8 scripts/e2e/integrations.py <screenshot-dir> <scratch-dir> [--port 47811]

Needs tauri-driver started with KELPIE_LINEAR_API=http://127.0.0.1:<port>/graphql (the default
port is 47811). Linear and Jira run against a local stand-in server implementing the parts of
their documented APIs Kelpie uses (no account is needed), which checks the auth headers Kelpie
sends; GitLab runs live against the public gitlab.com project gitlab-org/cli (read-only, no
token) and against the stand-in for token-only calls (merge request creation, your issues).

Covers: tokens saved to / removed from the OS credential store from Settings, "Test" showing
who is connected, the Issues panel (assigned, search, details), starting an agent on an issue
(prompt = the issue), worktree + agent from an issue, moving an issue to another state (Linear
states, Jira transitions), GitLab merge request chip with pipeline status, creating a merge
request, GitLab issues.
"""
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(__file__))
from smoke_support import Run, daemon  # noqa: E402

shots, scratch = sys.argv[1], sys.argv[2]
port = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 47811
S = "window.__kelpie.store"
I = "window.__kelpie.integrations"
LINEAR_KEY, JIRA_TOKEN, GITLAB_TOKEN = "lin_api_e2e", "jira-e2e-token", "glpat-e2e"
seen = {"linear_auth": [], "jira_auth": [], "gitlab_auth": [], "linear_state": None, "jira_transition": None, "mr_created": None}

LINEAR_ISSUES = [
    {"id": "uuid-1", "identifier": "ENG-12", "title": "Fix login timeout", "url": "https://linear.app/x/issue/ENG-12", "branchName": "dev/eng-12-fix-login-timeout",
     "description": "Users are logged out after 5 minutes.", "priorityLabel": "Urgent", "updatedAt": "2026-10-20T10:00:00Z", "state": {"name": "Todo", "type": "unstarted"}, "team": {"key": "ENG"}},
    {"id": "uuid-2", "identifier": "ENG-13", "title": "Add CSV export", "url": "https://linear.app/x/issue/ENG-13", "branchName": "dev/eng-13-add-csv-export",
     "description": "", "priorityLabel": "No priority", "updatedAt": "2026-10-19T10:00:00Z", "state": {"name": "In Progress", "type": "started"}, "team": {"key": "ENG"}},
]


class Fake(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def do_POST(self):
        if self.path == "/graphql":
            seen["linear_auth"].append(self.headers.get("Authorization"))
            if self.headers.get("Authorization") != LINEAR_KEY:
                return self.reply(200, {"errors": [{"message": "Authentication required", "extensions": {"code": "AUTHENTICATION_ERROR"}}]})
            q = self.body()
            query, var = q["query"], q.get("variables", {})
            if "viewer { name email }" in query:
                return self.reply(200, {"data": {"viewer": {"name": "E2E User", "email": "e2e@example.test"}}})
            if "searchIssues" in query:
                hits = [i for i in LINEAR_ISSUES if var["q"].lower() in i["title"].lower()]
                return self.reply(200, {"data": {"searchIssues": {"nodes": hits}}})
            if "assignedIssues" in query:
                return self.reply(200, {"data": {"viewer": {"assignedIssues": {"nodes": LINEAR_ISSUES}}}})
            if "states" in query:
                return self.reply(200, {"data": {"issue": {"team": {"states": {"nodes": [
                    {"id": "st-done", "name": "Done", "type": "completed", "position": 3},
                    {"id": "st-todo", "name": "Todo", "type": "unstarted", "position": 1},
                    {"id": "st-prog", "name": "In Progress", "type": "started", "position": 2}]}}}}})
            if "issueUpdate" in query:
                seen["linear_state"] = (var["id"], var["state"])
                return self.reply(200, {"data": {"issueUpdate": {"success": True}}})
            return self.reply(400, {"errors": [{"message": "unknown query"}]})
        if self.path.startswith("/jira/rest/api/3/issue/") and self.path.endswith("/transitions"):
            seen["jira_auth"].append(self.headers.get("Authorization"))
            seen["jira_transition"] = (self.path.split("/")[-2], self.body()["transition"]["id"])
            self.send_response(204)
            self.end_headers()
            return
        if self.path == "/api/v4/projects/team%2Fapp/merge_requests":
            seen["gitlab_auth"].append(self.headers.get("PRIVATE-TOKEN"))
            if self.headers.get("PRIVATE-TOKEN") != GITLAB_TOKEN:
                return self.reply(401, {"message": "401 Unauthorized"})
            b = self.body()
            seen["mr_created"] = b
            return self.reply(201, {"iid": 7, "web_url": f"http://127.0.0.1:{port}/team/app/-/merge_requests/7"})
        self.reply(404, {"message": "not found"})

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        if u.path.startswith("/jira/rest/api/3/"):
            seen["jira_auth"].append(self.headers.get("Authorization"))
            import base64
            want = "Basic " + base64.b64encode(f"me@example.test:{JIRA_TOKEN}".encode()).decode()
            if self.headers.get("Authorization") != want:
                return self.reply(401, {"errorMessages": ["Client must be authenticated"]})
            rest = u.path[len("/jira/rest/api/3"):]
            if rest == "/myself":
                return self.reply(200, {"displayName": "Jira E2E"})
            if rest == "/search/jql":
                jql = q.get("jql", [""])[0]
                issues = [{"key": "PROJ-7", "fields": {"summary": "Crash on save", "status": {"name": "To Do", "statusCategory": {"key": "new"}}, "priority": {"name": "High"}, "project": {"key": "PROJ"},
                           "description": {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Saving a file with "}, {"type": "text", "text": "emoji crashes"}]}]}}}]
                if "text ~" in jql and "nothing" in jql:
                    issues = []
                return self.reply(200, {"issues": issues, "isLast": True})
            if rest == "/issue/PROJ-7/transitions":
                return self.reply(200, {"transitions": [{"id": "21", "name": "Start progress", "to": {"statusCategory": {"key": "indeterminate"}}}, {"id": "31", "name": "Done", "to": {"statusCategory": {"key": "done"}}}]})
        if u.path.startswith("/api/v4/"):
            seen["gitlab_auth"].append(self.headers.get("PRIVATE-TOKEN"))
            rest = u.path[len("/api/v4"):]
            if rest == "/user":
                return self.reply(200, {"name": "GitLab E2E", "username": "gle2e"}) if self.headers.get("PRIVATE-TOKEN") == GITLAB_TOKEN else self.reply(401, {"message": "401 Unauthorized"})
            if rest == "/projects/team%2Fapp":
                return self.reply(200, {"default_branch": "main"})
            if rest == "/projects/team%2Fapp/merge_requests":
                return self.reply(200, [])
            if rest == "/issues":
                return self.reply(200, [{"iid": 3, "title": "Flaky test", "web_url": "w", "state": "opened", "references": {"full": "team/app#3"}, "description": "It fails on CI."}])
        self.reply(404, {"message": "not found"})


server = ThreadingHTTPServer(("127.0.0.1", port), Fake)
threading.Thread(target=server.serve_forever, daemon=True).start()


def rm(path):
    for _ in range(10):
        if not os.path.exists(path):
            return
        try:
            shutil.rmtree(path, onexc=lambda f, p, e: (os.chmod(p, 0o666), f(p)))
            return
        except PermissionError:
            time.sleep(0.5)


def make_repo(path, remote, branch):
    rm(path)
    os.makedirs(path)
    run_git = lambda *a: subprocess.run(["git", "-C", path, *a], capture_output=True, text=True, check=True)
    subprocess.run(["git", "init", "-q", "-b", "main", path], check=True)
    run_git("config", "user.email", "e2e@kelpie.test")
    run_git("config", "user.name", "Kelpie e2e")
    open(os.path.join(path, "README.md"), "w").write("x\n")
    run_git("add", ".")
    run_git("commit", "-q", "-m", "init")
    run_git("remote", "add", "origin", remote)
    if branch != "main":
        run_git("checkout", "-q", "-b", branch)


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


def set_input(css, value, i=0):
    d.js("const el = document.querySelectorAll(arguments[0])[arguments[2]]; el.value = arguments[1]; el.dispatchEvent(new InputEvent('input', {bubbles: true})); el.dispatchEvent(new Event('change', {bubbles: true}));", css, value, i)


try:
    run.boot()
    d.set_window_size(1480, 920)
    d._req("POST", d.s("/timeouts"), {"script": 120000})
    for s in daemon(d, "session.list"):
        daemon(d, "session.close", {"handle": s["handle"]})
    jira_url = f"http://127.0.0.1:{port}/jira"
    for key in ["linear", f"jira:{jira_url}", f"gitlab:127.0.0.1:{port}"]:
        js_await(f"{I}.secretClear(arguments[0])", key)
    d.js(f"const s = {S}; for (const p of [...s.state.projects]) s.removeProject(p.id); s.setSettings({{ integrations: {{ linear: false, jira: null, gitlabHosts: [] }}, shortcutHints: false, tips: false }});")
    repo = os.path.join(scratch, "integ-repo")
    make_repo(repo, f"http://127.0.0.1:{port}/team/app.git", "feature/csv")
    pid = d.js(f"return {S}.addProject(arguments[0])", repo)
    d.wait(f"return {S}.projectInfo[arguments[0]]?.is_repo || null", 20, 0.25, pid)

    # ---------- settings: tokens into the credential store ----------
    d.js(f"{S}.openSettings('integrations')")
    d.wait("return !!document.querySelector('.token-field input')", 10)
    set_input(".token-field input[type=password]", LINEAR_KEY)
    d.js("document.querySelector('.token-field .btn.primary').click()")
    ok = d.wait("return [...document.querySelectorAll('.form-note.ok')].some(e => e.textContent.includes('E2E User'))", 15)
    run.check("Linear key saved and tested: shows who is connected", bool(ok))
    run.check("Linear key sent as the Authorization header", LINEAR_KEY in seen["linear_auth"])
    run.check("Linear key is in the credential store, not the settings", js_await(f"{I}.secretHas('linear')") is True and LINEAR_KEY not in json.dumps(d.js(f"return {S}.state.settings")))
    # Jira Cloud: site + e-mail + token.
    d.js("""const row = [...document.querySelectorAll('.setting-row')].find(r => r.textContent.includes('Jira'));
      const [u, e] = row.querySelectorAll('input.text-input');
      for (const [el, v] of [[u, arguments[0]], [e, 'me@example.test']]) { el.value = v; el.dispatchEvent(new InputEvent('input', {bubbles: true})); el.dispatchEvent(new Event('change', {bubbles: true})); }""", jira_url)
    d.wait("return [...document.querySelectorAll('.setting-row')].find(r => r.textContent.includes('Jira')).querySelectorAll('input[type=password]').length === 1", 5)
    d.js("""const row = [...document.querySelectorAll('.setting-row')].find(r => r.textContent.includes('Jira'));
      const t = row.querySelector('input[type=password]'); t.value = arguments[0]; t.dispatchEvent(new InputEvent('input', {bubbles: true}));
      row.querySelector('.token-field .btn.primary').click();""", JIRA_TOKEN)
    ok = d.wait("return [...document.querySelectorAll('.form-note.ok')].some(e => e.textContent.includes('Jira E2E'))", 15)
    run.check("Jira Cloud site connected (Basic e-mail + API token)", bool(ok))
    # GitLab self-hosted host (the stand-in) with a token.
    d.js("""const row = [...document.querySelectorAll('.setting-row')].find(r => r.textContent.includes('GitLab'));
      const inputs = row.querySelectorAll('input.text-input:not([type=password])'); const h = inputs[inputs.length - 1];
      h.value = arguments[0]; h.dispatchEvent(new InputEvent('input', {bubbles: true}));
      [...row.querySelectorAll('.btn')].find(b => b.textContent.includes('Add host')).click();""", f"http://127.0.0.1:{port}")
    d.wait("return document.querySelectorAll('.gitlab-host').length === 2", 5)
    d.js("""const host = document.querySelectorAll('.gitlab-host')[1];
      const t = host.querySelector('input[type=password]'); t.value = arguments[0]; t.dispatchEvent(new InputEvent('input', {bubbles: true}));
      host.querySelector('.btn.primary').click();""", GITLAB_TOKEN)
    ok = d.wait("return [...document.querySelectorAll('.form-note.ok')].some(e => e.textContent.includes('gle2e'))", 15)
    run.check("GitLab token for a self-hosted host saved and tested", bool(ok))
    run.shot("01-integrations-settings")
    d.js(f"{S}.setOverlay(null)")

    # ---------- Issues panel: Linear ----------
    d.js(f"{S}.showRightPanel('issues')")
    d.wait("return document.querySelectorAll('.issue-row').length === 2", 15)
    sources = wait(lambda: (lambda v: v if len(v) == 3 else None)(d.js("return [...document.querySelectorAll('.issues-head .toggle')].map(b => b.textContent)")), 15)
    run.check("Issues panel offers Linear, Jira and GitLab", sources == ["Linear", "Jira", "GitLab"], str(sources))
    run.check("assigned Linear issues listed with key and state", d.js("return document.querySelector('.issue-row').textContent.includes('ENG-12') && document.querySelector('.issue-row').textContent.includes('Todo')"))
    set_input(".issues-search input", "csv")
    d.js("document.querySelector('.issues-search').dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}))")
    ok = d.wait("return document.querySelectorAll('.issue-row').length === 1 && document.querySelector('.issue-row').textContent.includes('ENG-13')", 10)
    run.check("Linear search", bool(ok))
    set_input(".issues-search input", "")
    d.wait("return document.querySelectorAll('.issue-row').length === 2", 10)
    d.js("document.querySelector('.issue-row .issue-line').click()")
    d.wait("return !!document.querySelector('.issue-detail')", 5)
    run.check("issue details show the description", "logged out after 5 minutes" in d.js("return document.querySelector('.issue-detail').textContent"))
    run.shot("02-issues-linear")
    # Move to another state.
    d.js("[...document.querySelectorAll('.issue-detail .btn')].find(b => b.textContent.includes('Move')).click()")
    d.wait("return [...document.querySelectorAll('.ctx-item')].some(e => e.textContent.includes('In Progress'))", 10)
    order = d.js("return [...document.querySelectorAll('.ctx-item')].map(e => e.textContent)")
    run.check("Linear states listed in workflow order, current marked", order[:3] == ["● Todo", "In Progress", "Done"], str(order))
    d.js("[...document.querySelectorAll('.ctx-item')].find(e => e.textContent === 'In Progress').click()")
    run.check("moving an issue updates it in Linear", bool(wait(lambda: seen["linear_state"] == ("uuid-1", "st-prog"), 10)))
    # Agent on the issue (a shell kind keeps this free of model calls: the prompt is what matters).
    d.js(f"{S}.setSettings({{ aiAgent: 'claude' }})")
    issue = {"source": "linear", "id": "uuid-1", "key": "ENG-12", "title": "Fix login timeout", "url": "https://linear.app/x/issue/ENG-12", "state": "Todo", "state_kind": "open", "priority": "Urgent", "branch": "dev/eng-12-fix-login-timeout", "description": "Users are logged out after 5 minutes.", "team": "ENG", "updated": None}
    prompt = d.js(f"return {I}.issuePrompt(arguments[0])", issue)
    run.check("the agent prompt is the issue (key, title, link, description)", all(x in prompt for x in ["ENG-12: Fix login timeout", "https://linear.app/x/issue/ENG-12", "logged out after 5 minutes"]))
    run.check("worktree branch comes from Linear's suggestion", d.js(f"return {I}.issueBranch(arguments[0])", issue) == "dev/eng-12-fix-login-timeout")
    run.check("without a suggestion the branch is key + title", d.js(f"return {I}.issueBranch(arguments[0])", {**issue, "branch": None}) == "eng-12-fix-login-timeout")
    # "Worktree + agent" opens the worktree dialog with the issue's branch.
    d.js("[...document.querySelectorAll('.issue-detail .btn')].find(b => b.textContent.includes('Worktree')).click()")
    d.wait("return !!document.querySelector('.modal input')", 10)
    branch = d.js("return document.querySelector('.modal input').value")
    run.check("'Worktree + agent' proposes the issue's branch", branch == "dev/eng-12-fix-login-timeout", branch)
    run.shot("03-worktree-from-issue")
    d.js(f"{S}.setOverlay(null)")

    # ---------- Jira ----------
    d.js("[...document.querySelectorAll('.issues-head .toggle')].find(b => b.textContent === 'Jira').click()")
    d.wait("return [...document.querySelectorAll('.issue-row')].some(r => r.textContent.includes('PROJ-7'))", 10)
    d.js("document.querySelector('.issue-row .issue-line').click()")
    d.wait("return !!document.querySelector('.issue-detail')", 5)
    run.check("Jira issue description flattened from ADF", "Saving a file with emoji crashes" in d.js("return document.querySelector('.issue-detail').textContent"))
    d.js("[...document.querySelectorAll('.issue-detail .btn')].find(b => b.textContent.includes('Move')).click()")
    d.wait("return [...document.querySelectorAll('.ctx-item')].some(e => e.textContent === 'Start progress')", 10)
    d.js("[...document.querySelectorAll('.ctx-item')].find(e => e.textContent === 'Start progress').click()")
    run.check("Jira transition posted", bool(wait(lambda: seen["jira_transition"] == ("PROJ-7", "21"), 10)))
    run.shot("04-issues-jira")

    # ---------- GitLab (stand-in): issues, merge request ----------
    d.js("[...document.querySelectorAll('.issues-head .toggle')].find(b => b.textContent === 'GitLab').click()")
    ok = d.wait("return [...document.querySelectorAll('.issue-row')].some(r => r.textContent.includes('team/app#3'))", 10)
    run.check("GitLab issues assigned to the token's user", bool(ok))
    d.js(f"{S}.showRightPanel('git')")
    d.wait("return [...document.querySelectorAll('.btn')].some(b => b.textContent.includes('Create merge request'))", 15)
    run.check("GitLab project offers 'Create merge request'", True)
    url = js_await(f"{I}.gitlabMrCreate(arguments[0], 'Add CSV export', 'Body', 'main', true)", repo)
    run.check("merge request created with the token", isinstance(url, str) and url.endswith("/merge_requests/7") and seen["mr_created"]["source_branch"] == "feature/csv", str(url))
    run.check("draft merge requests get the Draft: prefix", (seen["mr_created"] or {}).get("title") == "Draft: Add CSV export")

    # ---------- GitLab live: a public project, no token ----------
    live = os.path.join(scratch, "integ-gitlab-live")
    # A branch of gitlab-org/cli with a merged merge request (looked up first).
    import urllib.request
    with urllib.request.urlopen("https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/merge_requests?state=merged&per_page=1", timeout=30) as r:
        merged = json.loads(r.read())[0]
    make_repo(live, "https://gitlab.com/gitlab-org/cli.git", merged["source_branch"])
    lpid = d.js(f"return {S}.addProject(arguments[0])", live)
    mr = js_await(f"{I}.gitlabMrStatus(arguments[0])", live)
    run.check("live gitlab.com: merge request of the branch found without a token", isinstance(mr, dict) and mr.get("iid") == merged["iid"] and mr.get("state") == "merged", str(mr)[:200])
    run.check("live gitlab.com: pipeline status read", isinstance(mr, dict) and bool(mr.get("pipeline")), str(mr and mr.get("pipeline")))
    js_await(f"window.__kelpie.prs.pullRequests.refresh(arguments[0], arguments[1])", lpid, live)
    chip = wait(lambda: d.js("return [...document.querySelectorAll('.primary-tag')].map(e => e.textContent).find(t => t.startsWith('!')) ?? null"), 15)
    run.check("sidebar shows the merge request chip (!iid)", chip == f"!{merged['iid']}", str(chip))
    run.shot("05-gitlab-live-chip")

    # ---------- remove tokens ----------
    for key in ["linear", f"jira:{jira_url}", f"gitlab:127.0.0.1:{port}"]:
        js_await(f"{I}.secretClear(arguments[0])", key)
    run.check("tokens removed from the credential store", all(js_await(f"{I}.secretHas(arguments[0])", k) is False for k in ["linear", f"jira:{jira_url}", f"gitlab:127.0.0.1:{port}"]))
except Exception:
    import traceback
    traceback.print_exc()
    try:
        print("notes:", d.js("return [...document.querySelectorAll('.form-note')].map(e => e.className + ': ' + e.textContent)"), "seen:", {k: v for k, v in seen.items() if v})
    except Exception:
        pass
    run.check("scenario ran to completion", False)
finally:
    server.shutdown()
    run.finish()
