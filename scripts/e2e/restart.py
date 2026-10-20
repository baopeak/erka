"""Closing the app must not stop sessions; reopening must re-attach with the same screen.

    python scripts/e2e/restart.py <screenshot-dir> <project-dir>
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from smoke_support import Run, daemon  # noqa: E402

shots, project = sys.argv[1], sys.argv[2]
BUFFER_JS = r"""
const out = [];
for (const v of window.__erka.views()) {
  if (!v.visible) continue;
  const b = v.term.buffer.active;
  for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '');
}
return out.join('\n');
"""
marker = f"erka-restart-{int(time.time())}"

run = Run(shots)
try:
    run.boot()
    d = run.d
    d.js("const s = window.__erka.store; for (const p of [...s.state.projects]) s.removeProject(p.id); s.addProject(arguments[0]);", project)
    pid = d.js("return window.__erka.store.state.activeProject")
    info = d.js_async("const done = arguments[arguments.length-1]; window.__erka.store.newSession(arguments[0], 'shell').then(done);", pid)
    handle, sid = info["handle"], info["id"]
    d.wait("return !!document.querySelector('.pane .term-host .xterm')", 20)
    time.sleep(2)
    daemon(d, "session.input", {"handle": handle, "data": f"echo {marker}\r"})
    d.wait(f"return (function(){{{BUFFER_JS}}})().split('echo {marker}').pop().includes('{marker}')", 20)
    run.check("marker printed before restart", True)
finally:
    run.d.quit()  # closes the app window and process

time.sleep(3)
run2 = Run(shots)
run2.results = run.results
try:
    run2.boot()
    d = run2.d
    s = next((x for x in daemon(d, "session.list") if x["id"] == sid), None)
    run2.check("session survived app exit", s is not None and s["alive"])
    d.wait("return !!document.querySelector('.pane .term-host .xterm')", 30)
    ok = False
    for _ in range(40):
        if marker in d.js(BUFFER_JS).split(f"echo {marker}")[-1]:
            ok = True
            break
        time.sleep(0.25)
    run2.check("reopened app restores layout and terminal content", ok)
    run2.shot("30-after-restart")
    daemon(d, "session.close", {"handle": s["handle"]})
except Exception:
    import traceback
    traceback.print_exc()
    run2.check("scenario ran to completion", False)
finally:
    run2.finish()
