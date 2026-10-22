"""E2E for several Claude Code / Codex accounts.

    python -X utf8 scripts/e2e/accounts.py <screenshot-dir> <scratch-dir>

Adds accounts (config homes under the data dir), checks their seeding (Claude settings copied,
Codex keeps its login in a file), sign-in status from credential files, the active-account
switch (new sessions get CLAUDE_CONFIG_DIR / CODEX_HOME, running ones keep theirs), the
account picker in the new-session dialog, the floating-terminal sign-in command, history of
every account (listed with its account, resumed on it), automations on an account, the usage
meter menu and removing an account. No real sign-in: test credentials are written into the
test accounts only (never the user's own login).
"""
import base64
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from smoke_support import Run, daemon  # noqa: E402

shots, scratch = sys.argv[1], sys.argv[2]
S = "window.__erka.store"
A = "window.__erka.accounts"
proj = os.path.join(scratch, "accounts-proj")
os.makedirs(proj, exist_ok=True)

run = Run(shots)
d = run.d


def js_await(expr, *args):
    return d.js_async(f"const done = arguments[arguments.length-1]; Promise.resolve().then(() => {expr}).then(v => done(v === undefined ? null : v), e => done({{err: String(e)}}));", *args)


def sess(sid):
    return next((s for s in daemon(d, "session.list") if s["id"] == sid), None)


def wait(cond, timeout=20, interval=0.3):
    end = time.time() + timeout
    while time.time() < end:
        v = cond()
        if v:
            return v
        time.sleep(interval)
    return None


try:
    run.boot()
    d.set_window_size(1480, 920)
    d._req("POST", d.s("/timeouts"), {"script": 120000})
    for s in daemon(d, "session.list"):
        daemon(d, "session.close", {"handle": s["handle"]})
    # Accounts of earlier runs.
    for a in d.js(f"return {S}.state.settings.accounts ?? []") or []:
        js_await(f"{A}.removeAccount(arguments[0])", a)
    d.js(f"const s = {S}; for (const p of [...s.state.projects]) s.removeProject(p.id); s.setSettings({{ accounts: [], activeAccounts: {{}}, shortcutHints: false, tips: false }});")
    pid = d.js(f"return {S}.addProject(arguments[0])", proj)

    # ---------- add accounts ----------
    work = js_await(f"{A}.addAccount('claude', 'Work')")
    run.check("claude account added with its own home under the data dir", isinstance(work, dict) and "accounts" in work["dir"].replace("\\", "/") and os.path.isdir(work["dir"]), str(work))
    run.check("account folder carries Erka's marker", os.path.isfile(os.path.join(work["dir"], ".erka-account")))
    default_settings = os.path.join(os.path.expanduser("~"), ".claude", "settings.json")
    if os.path.isfile(default_settings):
        run.check("claude settings copied from the default account", os.path.isfile(os.path.join(work["dir"], "settings.json")))
    personal = js_await(f"{A}.addAccount('codex', 'Personal')")
    cfg = open(os.path.join(personal["dir"], "config.toml"), encoding="utf-8").read()
    run.check("codex account keeps its login in auth.json", 'cli_auth_credentials_store = "file"' in cfg)

    # ---------- status ----------
    st = js_await(f"{A}.accountStatus('claude', arguments[0])", work["dir"])
    run.check("new account is not signed in", st and st["signed_in"] is False, str(st))
    # Test credentials (fake values) inside the test account only.
    with open(os.path.join(work["dir"], ".credentials.json"), "w", encoding="utf-8") as f:
        json.dump({"claudeAiOauth": {"accessToken": "test-not-a-token", "subscriptionType": "max"}}, f)
    with open(os.path.join(work["dir"], ".claude.json"), "w", encoding="utf-8") as f:
        json.dump({"oauthAccount": {"emailAddress": "work@example.test"}}, f)
    claims = base64.urlsafe_b64encode(json.dumps({"email": "me@example.test", "https://api.openai.com/auth": {"chatgpt_plan_type": "plus"}}).encode()).decode().rstrip("=")
    with open(os.path.join(personal["dir"], "auth.json"), "w", encoding="utf-8") as f:
        json.dump({"tokens": {"access_token": "test-not-a-token", "id_token": f"h.{claims}.s"}}, f)
    st = js_await(f"{A}.accountStatus('claude', arguments[0])", work["dir"])
    run.check("signed-in status, email and plan read from the account's files", st["signed_in"] and st["email"] == "work@example.test" and st["plan"] == "max", str(st))
    st = js_await(f"{A}.accountStatus('codex', arguments[0])", personal["dir"])
    run.check("codex status from its id token", st["signed_in"] and st["email"] == "me@example.test" and st["plan"] == "plus", str(st))

    d.js(f"{S}.openSettings('accounts')")
    d.wait("return document.querySelectorAll('.account-row').length === 4", 10)
    d.wait("return [...document.querySelectorAll('.account-in')].some(e => e.textContent.includes('work@example.test'))", 10)
    run.check("settings list default + added accounts with status", True)
    run.shot("01-accounts")

    # ---------- active account and sessions ----------
    d.js("[...document.querySelectorAll('.accounts-agent[data-agent=\"claude\"] .account-row')].find(r => r.dataset.account === arguments[0]).querySelectorAll('.btn')[1].click()", work["id"])
    run.check("'Use for new sessions' makes the account active", d.js(f"return {S}.state.settings.activeAccounts.claude") == work["id"])
    d.js(f"{S}.setOverlay(null)")
    env = d.js(f"return {S}.profileLaunch('claude').env")
    run.check("new claude sessions get the account's CLAUDE_CONFIG_DIR", (env or {}).get("CLAUDE_CONFIG_DIR") == work["dir"], str(env))
    run.check("codex is still on its default account", not (d.js(f"return {S}.profileLaunch('codex').env") or {}).get("CODEX_HOME"))
    # A real session on the account (a shell kind would carry no account): use a custom
    # command that prints the variable, started the way agents are.
    info = js_await(f"{S}.newSession(arguments[0], 'shell', {{ env: {S}.profileLaunch('claude').env }})", pid)
    s1 = sess(info["id"])
    run.check("session environment carries the account home", s1["env"].get("CLAUDE_CONFIG_DIR") == work["dir"])
    d.js(f"{A}.setActiveAccount('claude', null)")
    run.check("switching back to Default: new sessions have no account variable", not (d.js(f"return {S}.profileLaunch('claude').env") or {}).get("CLAUDE_CONFIG_DIR"))
    run.check("a running session keeps the account it started on", sess(info["id"])["env"].get("CLAUDE_CONFIG_DIR") == work["dir"])
    explicit = d.js(f"return {S}.profileLaunch('claude', {{ account: arguments[0] }}).env", work["id"])
    run.check("an explicit account overrides the active one", (explicit or {}).get("CLAUDE_CONFIG_DIR") == work["dir"])

    # New-session dialog: account picker for Claude.
    d.js(f"{S}.setOverlay('newsession')")
    d.wait("return !!document.querySelector('.modal')", 5)
    d.js("[...document.querySelectorAll('.modal .launch-card')].find(c => c.textContent.includes('Claude')).click()")
    has_picker = d.wait("return [...document.querySelectorAll('.modal .form-row label')].some(l => l.textContent === 'Account')", 5)
    run.check("new-session dialog offers the account for Claude", bool(has_picker))
    run.shot("02-newsession-account")
    d.js(f"{S}.setOverlay(null)")

    # Sign in: the agent's login command in the floating terminal, on the account's home.
    d.js(f"{A}.signIn('codex', {S}.state.settings.accounts.find(a => a.agent === 'codex'))")
    fl = wait(lambda: d.js(f"return {S}.state.floating.active"), 10)
    fs = wait(lambda: sess(fl), 10)
    run.check("sign-in runs `codex login` in the floating terminal", fs and fs["kind"] == "custom" and fs["args"][:2] == ["codex", "login"], str(fs and fs["args"]))
    run.check("sign-in runs on the account's CODEX_HOME", fs and fs["env"].get("CODEX_HOME") == personal["dir"])
    run.shot("03-signin-floating")
    daemon(d, "session.close", {"handle": fs["handle"]})
    d.js(f"{S}.toggleFloating(false)")

    # ---------- history of every account ----------
    escaped = "".join(c if c.isalnum() else "-" for c in proj)
    tdir = os.path.join(work["dir"], "projects", escaped)
    os.makedirs(tdir, exist_ok=True)
    conv = "11111111-2222-4333-8444-555555555555"
    line = {"type": "user", "sessionId": conv, "cwd": proj, "timestamp": "2026-10-21T01:00:00.000Z", "message": {"role": "user", "content": "Account history probe"}}
    with open(os.path.join(tdir, conv + ".jsonl"), "w", encoding="utf-8") as f:
        f.write(json.dumps(line, separators=(",", ":")) + "\n")
    items = js_await(f"window.__TAURI_INTERNALS__.invoke('agent_history_list', {{ count: false, homes: {A}.accountHomes() }})")
    hit = next((i for i in items if i["id"] == conv), None)
    run.check("history lists conversations of other accounts with their home", hit is not None and hit["home"] == work["dir"], str(hit)[:200])
    d.js(f"{S}.showRightPanel('history')")
    shown = wait(lambda: d.js("return [...document.querySelectorAll('.history-row')].some(r => r.textContent.includes('Account history probe') && r.textContent.includes('Work'))"), 20)
    run.check("history row shows the account", bool(shown))
    run.shot("04-history-account")
    # Resume from history: the new session runs on that account.
    d.js("[...document.querySelectorAll('.history-row')].find(r => r.textContent.includes('Account history probe')).querySelector('.row-actions .icon-btn').click()")
    resumed = wait(lambda: next((s for s in daemon(d, "session.list") if s.get("agent_session_id") == conv), None), 15)
    run.check("resuming from history uses the conversation's account", resumed and resumed["env"].get("CLAUDE_CONFIG_DIR") == work["dir"], str(resumed and resumed["env"]))
    if resumed:
        daemon(d, "session.close", {"handle": resumed["handle"]})

    # ---------- automations on an account ----------
    d.js(f"{A}.setActiveAccount('claude', arguments[0])", work["id"])
    d.js(f"{S}.openSettings('automations')")
    d.wait("return [...document.querySelectorAll('.btn')].some(b => b.textContent.includes('New automation'))", 10)
    d.js("[...document.querySelectorAll('.btn')].find(b => b.textContent.includes('New automation')).click()")
    d.wait("return !!document.querySelector('.automation-editor')", 5)
    d.js("const i = document.querySelector('.automation-editor input'); i.value = 'acct-auto'; i.dispatchEvent(new InputEvent('input', {bubbles: true}));")
    d.js("const t = document.querySelector('.automation-editor textarea'); t.value = 'noop'; t.dispatchEvent(new InputEvent('input', {bubbles: true}));")
    sel = d.js("return [...document.querySelectorAll('.automation-editor .field span')].some(s => s.textContent === 'Account')")
    run.check("automation editor offers the account", bool(sel))
    d.js("[...document.querySelectorAll('.automation-editor .btn.primary')][0].click()")
    auto = wait(lambda: next((a for a in daemon(d, "automation.list") if a["name"] == "acct-auto"), None), 10)
    run.check("automation saved with the account's environment", auto and auto.get("env", {}).get("CLAUDE_CONFIG_DIR") == work["dir"], str(auto and auto.get("env")))
    if auto:
        daemon(d, "automation.delete", {"id": auto["id"]})
    d.js(f"{S}.setOverlay(null)")

    # ---------- usage meter: account menu ----------
    has_meter = d.js("return !!document.querySelector('.meter[data-provider=\"claude\"]')")
    if has_meter:
        d.js("document.querySelector('.meter[data-provider=\"claude\"]').dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, clientX: 900, clientY: 880}))")
        ok = d.wait("return [...document.querySelectorAll('.ctx-item')].some(e => e.textContent.includes('Work'))", 5)
        run.check("usage meter menu lists the accounts", bool(ok))
        run.shot("05-meter-menu")
        d.js("[...document.querySelectorAll('.ctx-item')].find(e => e.textContent.endsWith('Default')).click()")
        run.check("choosing Default in the meter menu switches the active account", not d.js(f"return {S}.state.settings.activeAccounts.claude"))
    else:
        d.js(f"{A}.setActiveAccount('claude', null)")
        run.check("usage meter hidden: the active test account has no real sign-in", True, "no meter shown")

    # ---------- remove ----------
    js_await(f"{A}.removeAccount({S}.state.settings.accounts.find(a => a.id === arguments[0]))", work["id"])
    run.check("removed account leaves the list", not any(a["id"] == work["id"] for a in d.js(f"return {S}.state.settings.accounts")))
    run.check("removed account's home is gone from the data dir", not os.path.exists(work["dir"]))
    js_await(f"{A}.removeAccount({S}.state.settings.accounts.find(a => a.agent === 'codex'))")
    run.check("all test accounts removed", d.js(f"return {S}.state.settings.accounts.length") == 0)
    for s in daemon(d, "session.list"):
        daemon(d, "session.close", {"handle": s["handle"]})
except Exception:
    import traceback
    traceback.print_exc()
    run.check("scenario ran to completion", False)
finally:
    run.finish()
