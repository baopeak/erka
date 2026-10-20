"""E2E for UI phase 4: full-page Settings (sections, search, deep links), shortcut editor with
overrides that survive a restart, Back/Forward across projects, appearance, agent profiles,
and first-run tips.

    python -X utf8 scripts/e2e/phase4.py <screenshot-dir> <second project folder>
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from smoke_support import REPO, Run, daemon  # noqa: E402

shots, other = sys.argv[1], sys.argv[2]
run = Run(shots)
d = run.d
S = "window.__erka.store"


def place():
    return d.js(f"const s = {S}; const p = s.state.activeProject; const t = p && s.activeTab(p); return t ? [p, t.id, t.focus] : null")


def new_shell(pid, where="tab"):
    return d.js_async(f"const done = arguments[arguments.length-1]; {S}.newSession(arguments[0], 'shell', {{ where: arguments[1] }}).then(done);", pid, where)


def pane_of(session_id):
    return d.js(f"const l = {S}.paneLocation(arguments[0]); return l ? [l.projectId, l.tabId, l.paneId] : null", session_id)


def record_shortcut(command_id, chord):
    d.js("document.querySelector(`[data-command='${arguments[0]}'] .shortcut-actions .btn`).click()", command_id)
    d.wait("return !!document.querySelector('.shortcut-row.recording')", 5)
    d.keys(chord)
    time.sleep(0.3)


try:
    run.boot()
    for s in daemon(d, "session.list"):
        daemon(d, "session.close", {"handle": s["handle"]})
    d.js(f"const s = {S}; for (const p of [...s.state.projects]) s.removeProject(p.id); for (const id of Object.keys(s.state.keymap || {{}})) s.setShortcut(id, null);")
    d.js(f"{S}.addProject(arguments[0]);", REPO)
    a = d.js(f"return {S}.state.activeProject")
    d.js(f"{S}.addProject(arguments[0]);", other)
    b = d.js(f"return {S}.state.activeProject")

    # ---------- Back / Forward across two projects ----------
    d.js(f"{S}.switchProject(arguments[0]);", a)
    s1 = new_shell(a)
    s2 = new_shell(a, "right")
    p1, p2 = pane_of(s1["id"]), pane_of(s2["id"])
    d.js(f"{S}.focusPane(...arguments);", *p1)
    d.js(f"{S}.switchProject(arguments[0]);", b)
    s3 = new_shell(b)
    p3 = pane_of(s3["id"])
    time.sleep(1.5)
    run.check("starts in the second project", place() == p3, str(place()))
    d.keys("shift+alt+left")
    time.sleep(0.4)
    run.check("Back returns to the previous pane in the first project", place() == p1, str(place()))
    d.keys("shift+alt+left")
    time.sleep(0.4)
    run.check("Back again goes to the pane focused before it", place() == p2, str(place()))
    d.keys("shift+alt+right")
    time.sleep(0.4)
    run.check("Forward moves ahead again", place() == p1, str(place()))
    run.shot("p4-01-nav-back")

    # ---------- settings page ----------
    d.keys("ctrl+,")
    d.wait("return !!document.querySelector('.settings-page')", 5)
    time.sleep(0.3)
    run.shot("p4-02-settings-agents")
    d.keys("ctrl+f")
    d.keys("font")
    time.sleep(0.4)
    sections = d.js("return [...document.querySelectorAll('.settings-section')].map(e => e.dataset.section)")
    rows = d.js("return [...document.querySelectorAll('.setting-row')].map(e => e.dataset.setting)")
    run.check("search 'font' shows the Terminal font settings", "terminal" in sections and "font-family" in rows and "font-size" in rows, f"{sections} {rows}")
    run.shot("p4-03-settings-search")
    d.keys("escape")
    time.sleep(0.2)
    run.check("Escape clears the search first", bool(d.js("return !!document.querySelector('.settings-page')")) and d.js("return document.querySelector('.settings-search input').value") == "")

    # ---------- shortcut editor ----------
    d.js("document.querySelector('.settings-link[data-section=shortcuts]').click()")
    d.wait("return !!document.querySelector('[data-command=quickopen]')", 5)
    record_shortcut("quickopen", "ctrl+alt+p")
    run.check("recorded Ctrl+Alt+P for Go to File", d.js(f"return {S}.state.keymap.quickopen") == "mod+alt+p", str(d.js(f"return {S}.state.keymap")))
    record_shortcut("quickopen", "ctrl+shift+p")
    warn = d.wait("return document.querySelector('.shortcut-warn')?.innerText || null", 5)
    run.check("a key used by another command is flagged", "Search Everything" in warn, warn.replace("\n", " "))
    d.js("document.querySelector('[data-command=quickopen]').scrollIntoView({block: 'center'})")
    run.shot("p4-04-shortcut-conflict")
    d.js("[...document.querySelectorAll('.shortcut-warn .btn')].find(b => b.innerText === 'Cancel').click()")
    record_shortcut("quickopen", "ctrl+r")
    warn = d.wait("return document.querySelector('.shortcut-warn')?.innerText || null", 5)
    run.check("a key terminals rely on is flagged", "Ctrl+R" in warn, warn.replace("\n", " "))
    d.js("[...document.querySelectorAll('.shortcut-warn .btn')].find(b => b.innerText === 'Cancel').click()")
    run.check("cancelled assignments keep the recorded key", d.js(f"return {S}.state.keymap.quickopen") == "mod+alt+p")
    d.keys("escape")
    d.wait("return !document.querySelector('.settings-page')", 5)

    d.keys("ctrl+shift+o")
    time.sleep(0.4)
    run.check("the old default no longer opens Go to File", d.js(f"return {S}.overlay()") is None)
    d.keys("ctrl+alt+p")
    run.check("the new key opens Go to File", d.wait(f"return {S}.overlay() === 'quickopen'", 5))
    d.keys("escape")

    time.sleep(1)  # state is saved 400 ms after a change
    d.js("location.reload()")
    time.sleep(2)
    run.boot()
    d.keys("ctrl+alt+p")
    run.check("the override survives a restart", d.wait(f"return {S}.overlay() === 'quickopen'", 8))
    d.keys("escape")
    d.js(f"{S}.setShortcut('quickopen', null)")

    # ---------- "/" search jumps to the setting ----------
    d.keys("ctrl+shift+p")
    d.wait("return !!document.querySelector('.palette input')", 5)
    d.keys("/scrollback")
    time.sleep(0.4)
    d.keys("enter")
    target = d.wait("return document.querySelector('.setting-row.target')?.dataset.setting || null", 5)
    run.check("a settings result opens its section and highlights the row", target == "scrollback", target)
    run.shot("p4-05-settings-deeplink")

    # ---------- agent profile: permission mode + environment ----------
    d.js("document.querySelector('.settings-link[data-section=agents]').click()")
    d.wait("return !!document.querySelector('[data-setting=agent-claude] select')", 5)
    d.js("const s = document.querySelector('[data-setting=agent-claude] select'); s.value = 'plan'; s.dispatchEvent(new Event('change', {bubbles: true}));")
    d.js("const t = document.querySelector('[data-setting=agent-claude] textarea'); t.value = 'FOO=bar\\nBAD LINE\\nX_Y=1'; t.dispatchEvent(new Event('change', {bubbles: true}));")
    launch = d.js(f"return {S}.profileLaunch('claude')")
    run.check("permission mode becomes a launch flag", launch["args"][-2:] == ["--permission-mode", "plan"], str(launch["args"]))
    run.check("environment lines become the profile env", launch.get("env") == {"FOO": "bar", "X_Y": "1"}, str(launch.get("env")))
    run.shot("p4-06-settings-agent-profile")
    d.js(f"{S}.setSettings({{ profiles: {S}.state.settings.profiles.map(p => ({{ kind: p.kind, label: p.label, args: p.args }})) }})")
    d.keys("escape")

    # ---------- appearance ----------
    d.js(f"{S}.switchProject(arguments[0]); {S}.showRightPanel('files');", a)
    d.js(f"{S}.openSettings('appearance')")
    d.wait("return !!document.querySelector('[data-setting=theme]')", 5)
    d.js("[...document.querySelectorAll('[data-setting=theme] .seg button')].find(b => b.innerText === 'Light').click()")
    time.sleep(0.3)
    run.shot("p4-07-settings-light")
    d.keys("escape")
    time.sleep(0.6)
    bg = d.js("return getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()")
    term_bg = d.js("return window.__erka.peekView(arguments[0])?.term.options.theme.background", s1["id"])
    run.check("light theme restyles the app and the terminals", bg == "#f5f6f9" and term_bg == "#ffffff", f"{bg} {term_bg}")
    run.shot("p4-08-workspace-light")
    d.js(f"{S}.setSettings({{ theme: 'dark', density: 'compact', uiScale: 1.1 }}); for (const v of window.__erka.views()) v.applySettings({S}.state.settings);")
    time.sleep(0.4)
    run.check("compact density and interface scale apply", d.js("return document.documentElement.dataset.density") == "compact"
              and d.js("return getComputedStyle(document.querySelector('.sidebar')).zoom") in ("1.1", 1.1))
    run.shot("p4-09-compact-110")
    d.js(f"{S}.setSettings({{ density: 'comfortable', uiScale: 1 }})")

    # ---------- first-run tips ----------
    d.js(f"{S}.setSettings({{ tips: true, tipsSeen: [] }})")
    time.sleep(1)
    d.js("location.reload()")
    time.sleep(2)
    run.boot(tips=True)
    tip = d.wait("return document.querySelector('.tip')?.dataset.tipId || null", 12)
    run.check("one tip appears after start", tip is not None and d.js("return document.querySelectorAll('.tip').length") == 1, tip)
    run.shot("p4-10-tip")
    d.js("[...document.querySelectorAll('.tip .btn')].find(b => b.innerText === 'Got it').click()")
    time.sleep(0.3)
    run.check("dismissed tips are remembered", tip in d.js(f"return {S}.state.settings.tipsSeen") and not d.js("return !!document.querySelector('.tip')"))
    d.js(f"{S}.setSettings({{ tips: false }})")

    for s in daemon(d, "session.list"):
        daemon(d, "session.close", {"handle": s["handle"]})
except Exception:
    import traceback
    traceback.print_exc()
    run.check("scenario ran to completion", False)
finally:
    run.finish()
