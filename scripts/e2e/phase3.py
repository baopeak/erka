"""E2E for UI phase 3: agent session history (scan, scopes, search, resume), usage / RAM meters
in the status bar, quick commands (search, + menu, settings editor), and inline rename.

    python -X utf8 scripts/e2e/phase3.py <screenshot-dir> <folder with agent transcripts>
"""
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from smoke_support import REPO, Run, daemon  # noqa: E402

shots, probe = sys.argv[1], sys.argv[2]
run = Run(shots)
d = run.d

INVOKE = "const done = arguments[arguments.length-1]; window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1] || {}).then(done, (e) => done({error: String(e)}));"


def session_text(handle):
    return daemon(d, "session.read", {"handle": handle})["text"]


def wait_text(handle, needle, timeout=20, count=1):
    end = time.time() + timeout
    while time.time() < end:
        if session_text(handle).count(needle) >= count:
            return True
        time.sleep(0.3)
    return False


def wait_output_lines(handle, line, count, timeout=15):
    """Output lines equal to `line` (a typed command may wrap, its output line does not)."""
    end = time.time() + timeout
    while time.time() < end:
        if [x.strip() for x in session_text(handle).splitlines()].count(line) >= count:
            return True
        time.sleep(0.3)
    return False


def command_lines_with(needle):
    """Command lines of running processes that mention `needle` (Windows)."""
    out = subprocess.run(
        ["powershell", "-NoProfile", "-Command",
         f"Get-CimInstance Win32_Process | Where-Object {{ $_.CommandLine -like '*{needle}*' -and $_.Name -ne 'powershell.exe' }} | ForEach-Object {{ $_.CommandLine }}"],
        capture_output=True, text=True, timeout=60)
    return [l for l in out.stdout.splitlines() if l.strip()]


try:
    run.boot()
    for s in daemon(d, "session.list"):
        daemon(d, "session.close", {"handle": s["handle"]})
    d.js("const s = window.__erka.store; for (const p of [...s.state.projects]) s.removeProject(p.id);")
    d.js("window.__erka.store.addProject(arguments[0]);", REPO)
    d.js("window.__erka.store.addProject(arguments[0]);", probe)
    probe_id = d.js("return window.__erka.store.state.activeProject")

    # ---------- history scan ----------
    # count=false: measure the list itself, not its race with the background prompt count.
    t = time.time()
    items = d.js_async(INVOKE, "agent_history_list", {"count": False})
    cold = time.time() - t
    t = time.time()
    d.js_async(INVOKE, "agent_history_list", {"count": False})
    warm = time.time() - t
    agents = sorted({i["agent"] for i in items})
    run.check("history lists every agent's transcripts", len(items) > 10 and "claude" in agents, f"{len(items)} items {agents} cold={cold:.2f}s warm={warm*1000:.0f}ms")
    # Debug build + WebDriver round trip, with the background prompt count running; the release
    # build lists warm in ~30-60 ms (cargo test --release ... scan_real).
    run.check("warm history scan is fast (< 600 ms round trip, debug build)", warm < 0.6, f"{warm*1000:.0f} ms")

    d.js("window.__erka.store.showRightPanel('history')")
    d.wait("return document.querySelectorAll('.history-row').length > 0", 20)
    folder_rows = d.js("return document.querySelectorAll('.history-row').length")
    run.check("folder scope shows this folder's conversations", folder_rows >= 1, f"{folder_rows} rows")
    run.shot("p3-01-history-folder")

    d.js("[...document.querySelectorAll('.history-scope .seg button')].find(b => b.innerText === 'All').click()")
    time.sleep(0.4)
    all_rows = d.js("return document.querySelectorAll('.history-row').length")
    days = d.js("return [...document.querySelectorAll('.history-day')].map(e => e.textContent)")
    run.check("All scope shows more, grouped by day", all_rows > folder_rows and len(days) >= 1, f"{all_rows} rows, days={days[:4]}")
    run.shot("p3-02-history-all")

    d.js("const i = document.querySelector('.history input'); i.value = 'gamma'; i.dispatchEvent(new Event('input', {bubbles: true}));")
    time.sleep(0.3)
    tips = d.js("return [...document.querySelectorAll('.history-row')].map(e => e.title)")
    run.check("search filters by prompt text", 1 <= len(tips) < all_rows and all("gamma" in x.lower() for x in tips), f"{len(tips)} rows")
    d.js("const i = document.querySelector('.history input'); i.value = ''; i.dispatchEvent(new Event('input', {bubbles: true}));")
    d.js("[...document.querySelectorAll('.history-scope .seg button')].find(b => b.innerText === 'This folder').click()")
    time.sleep(0.3)

    # Resume a Claude conversation of this folder in a terminal.
    norm = lambda p: p.replace("\\", "/").rstrip("/").lower()
    target = next((i for i in items if i["agent"] == "claude" and norm(i["cwd"]) == norm(probe) and i["first_prompt"]), None)
    run.check("a Claude conversation exists in the probe folder", target is not None)
    if target:
        before = {s["handle"] for s in daemon(d, "session.list")}
        d.js("""const id = arguments[0];
            const row = [...document.querySelectorAll('.history-row')].find(r => r.title.includes(arguments[1]));
            row.querySelector('.row-actions button').click();""", target["id"], target["first_prompt"][:30])
        new = d.wait("return Object.values(window.__erka.store.sessions).find(s => s.agent_session_id === arguments[0]) || null", 15, 0.25, target["id"])
        run.check("resume starts the agent on that conversation", new["kind"] == "claude" and norm(new["cwd"]) == norm(probe), f"{new['kind']} {new['cwd']}")
        # The probe folder was only used non-interactively, so Claude first asks to trust it;
        # answering would change the user's global Claude config. Check the launch instead.
        time.sleep(3)
        cmds = command_lines_with(target["id"])
        run.check("agent launched with --resume <conversation id>", any("--resume" in c for c in cmds), f"{len(cmds)} processes")
        run.check("TUI is up in the conversation's folder", wait_text(new["handle"], "chat-probe", 30))
        run.shot("p3-03-history-resumed")
        running = d.js("return document.querySelectorAll('.history-row.running').length")
        run.check("history marks the conversation as open", running >= 1)
        daemon(d, "session.close", {"handle": new["handle"]})

    # ---------- meters ----------
    d.wait("return !!document.querySelector('[data-meter=memory]')", 15)
    ram = d.js("return document.querySelector('[data-meter=memory]').innerText")
    run.check("RAM meter shows memory use", ram.startswith("RAM ") and any(c.isdigit() for c in ram), ram)
    usage = d.js_async(INVOKE, "usage_fetch")
    summary = {k: ([f"{w['label']} {round(w['used_percent'])}%" for w in v["windows"]] or v["error"]) for k, v in usage.items()}
    run.check("usage endpoint answers for each provider (data or a reason)", all(v["windows"] or v["error"] for v in usage.values()), str(summary))
    has_data = any(v["windows"] for v in usage.values())
    if has_data:
        meters = d.wait("return document.querySelectorAll('.meter-win').length || null", 30)
        run.check("status bar shows usage windows", meters >= 1, f"{meters} windows")
    run.shot("p3-04-statusbar")

    # ---------- quick commands ----------
    d.js("window.__erka.store.switchProject(arguments[0]);", probe_id)
    shell = d.js_async("const done = arguments[arguments.length-1]; window.__erka.store.newSession(arguments[0], 'shell').then(done);", probe_id)
    d.wait("return !!document.querySelector('.pane .term-host .xterm')", 20)
    time.sleep(1.5)
    d.js("""window.__erka.store.setSettings({ quickCommands: [
        { id: 'qc1', label: 'Echo marker', text: 'echo erka-qc-' + 'ok', action: 'terminal', enter: true, projectId: null },
        { id: 'qc2', label: 'Ask agent', text: 'Summarize', action: 'agent', enter: true, projectId: null },
    ] })""")
    d.keys("ctrl+shift+p")
    d.wait("return !!document.querySelector('.palette input')", 5)
    d.keys(">echo marker")
    d.wait("return [...document.querySelectorAll('.palette .item .label')].some(e => e.innerText.includes('Run: Echo marker'))", 5)
    run.shot("p3-05-quick-command-search")
    d.keys("enter")
    run.check("quick command from search runs in the focused shell", wait_output_lines(shell["handle"], "erka-qc-ok", 1))

    d.keys("ctrl+shift+n")
    d.wait("return document.querySelectorAll('.qc-chip').length === 2", 5)
    run.shot("p3-06-quick-command-menu")
    d.keys("ctrl+1")
    run.check("Ctrl+1 in the + menu runs the first quick command", wait_output_lines(shell["handle"], "erka-qc-ok", 2))
    run.check("menu closes after running", not d.js("return !!document.querySelector('.qc-chip')"))

    d.keys("ctrl+shift+p")
    d.wait("return !!document.querySelector('.palette input')", 5)
    d.keys(">ask agent")
    time.sleep(0.4)
    d.keys("enter")
    toast = d.wait("return document.querySelector('.toast')?.innerText || null", 5)
    run.check("agent quick command refuses a shell target", "agent session" in toast, toast)

    d.js("window.__erka.store.openSettings('commands')")
    d.wait("return document.querySelectorAll('.qc-row').length === 2", 5)
    d.js("document.querySelector('[data-section=commands]').scrollIntoView()")
    run.shot("p3-07-quick-command-settings")
    d.keys("escape")

    # ---------- inline rename (sidebar) ----------
    d.js("const r = document.querySelector('.session-row'); r.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, clientX: 120, clientY: 160}));")
    d.js("[...document.querySelectorAll('.ctx-item')].find(e => e.innerText.startsWith('Rename')).click()")
    d.wait("return !!document.querySelector('.rename-input')", 5)
    d.js("const i = document.querySelector('.rename-input'); i.value = 'build box';")
    d.keys("enter")
    name = d.wait("return [...document.querySelectorAll('.session-row .name')].map(e => e.innerText).find(t => t === 'build box') || null", 5)
    run.check("inline rename updates the session name", name == "build box", name)

    for s in daemon(d, "session.list"):
        daemon(d, "session.close", {"handle": s["handle"]})
    d.js("window.__erka.store.setSettings({ quickCommands: [] })")
except Exception:
    import traceback
    traceback.print_exc()
    run.check("scenario ran to completion", False)
finally:
    run.finish()
