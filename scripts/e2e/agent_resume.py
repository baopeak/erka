"""Agents must resume the same conversation after the session daemon stops (reboot, update, crash).

    python scripts/e2e/agent_resume.py <kelpied.exe> <project-dir> [agent ...]   # default: claude codex omp

Runs an isolated daemon (own endpoint and data folder), tells each agent a secret number,
kills the daemon hard, starts it again, resumes every interrupted session and asks for a value
only the original conversation can produce (secret x 3). Uses the agents' real sign-in.
"""
import importlib.util
import os
import random
import re
import subprocess
import sys
import tempfile
import time

exe, project = sys.argv[1], sys.argv[2]
agents = sys.argv[3:] or ["claude", "codex", "omp"]
os.environ["KELPIE_ENDPOINT"] = f"kelpie-resume-test-{os.getpid()}"
os.environ["KELPIE_DATA_DIR"] = tempfile.mkdtemp(prefix="kelpie-resume-")

spec = importlib.util.spec_from_file_location("kelpie_call", os.path.join(os.path.dirname(__file__), "..", "kelpie-call.py"))
kelpie_call = importlib.util.module_from_spec(spec)
spec.loader.exec_module(kelpie_call)

results = []


def check(name, ok, detail=""):
    results.append((name, ok))
    detail = str(detail).encode("ascii", "replace").decode()
    print(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail and not ok else ""), flush=True)


def start_daemon():
    proc = subprocess.Popen([exe, "serve"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(100):
        try:
            return proc, kelpie_call.Conn()
        except OSError:
            time.sleep(0.1)
    raise SystemExit("daemon did not start")


def find(c, sid):
    return next((s for s in c.call("session.list") if s["id"] == sid), None)


def wait_idle(c, sid, timeout=240, min_wait=4):
    """Idle (or waiting) after the agent worked, with a screen that stopped changing."""
    end, last, stable = time.time() + timeout, None, 0
    time.sleep(min_wait)
    while time.time() < end:
        s = find(c, sid)
        screen = c.call("session.read", {"handle": s["handle"]})["text"]
        stable = stable + 1 if screen == last else 0
        last = screen
        if s["status"] in ("idle", "waiting") and stable >= 6:
            return s
        time.sleep(0.5)
    return find(c, sid)


def screen(c, sid, lines=60):
    return c.call("session.read", {"handle": find(c, sid)["handle"], "lines": lines})["text"]


def wait_for(fn, timeout):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(0.5)
    return None


def accept_trust(c, sid):
    """A folder the agent has not seen asks to be trusted first (answer: "Yes, I trust")."""
    if wait_for(lambda: re.search(r"trust (this|the contents)", screen(c, sid), re.I) or find(c, sid).get("agent_session_id"), 40) and not find(c, sid).get("agent_session_id"):
        handle = find(c, sid)["handle"]
        text = screen(c, sid)
        # Claude puts "No, exit" first; Codex already highlights "Yes".
        if "No, exit" in text:
            c.call("session.input", {"handle": handle, "data": "\x1b[B"})
            time.sleep(0.4)
        c.call("session.input", {"handle": handle, "data": "\r"})


def type_line(c, handle, text):
    c.call("session.input", {"handle": handle, "data": f"\x1b[200~{text}\x1b[201~"})
    time.sleep(0.6)
    c.call("session.input", {"handle": handle, "data": "\r"})


daemon, c = start_daemon()
secrets, sids = {}, {}
try:
    for kind in agents:
        secret = random.randint(1000, 9999)
        secrets[kind] = secret
        info = c.call("session.create", {
            "kind": kind, "cwd": project, "cols": 120, "rows": 36,
            "prompt": f"Remember this secret number for later: {secret}. Do not use any tools. Reply with only the word OK.",
        })
        sids[kind] = info["id"]
    for kind in agents:
        accept_trust(c, sids[kind])
    for kind in agents:
        s = wait_idle(c, sids[kind])
        answered = wait_for(lambda: re.search(r"^\W*OK\W*$", screen(c, sids[kind]).split("Reply with only the word OK.")[-1], re.M), 120)
        check(f"{kind}: first turn answered", s["alive"] and answered, screen(c, sids[kind])[-800:])
    # Claude and Codex hooks report the conversation id; others resume the folder's latest one.
    for kind in agents:
        if kind in ("claude", "codex"):
            check(f"{kind}: hook reported the conversation id", wait_for(lambda: find(c, sids[kind]).get("agent_session_id"), 30))
    time.sleep(2)
    before = {k: find(c, sids[k]).get("agent_session_id") for k in agents}
    for kind in agents:
        print(f"  {kind} conversation id before: {before[kind]}")
finally:
    subprocess.run(["taskkill", "/PID", str(daemon.pid), "/F", "/T"], capture_output=True)
    daemon.wait()

time.sleep(2)
daemon, c = start_daemon()
try:
    for kind in agents:
        s = find(c, sids[kind])
        check(f"{kind}: restored as interrupted", s is not None and s["interrupted"] and not s["alive"])
        check(f"{kind}: kept its conversation id", s is not None and s.get("agent_session_id") == before[kind], f"{s and s.get('agent_session_id')} != {before[kind]}")
        c.call("session.restart", {"handle": s["handle"]})
    for kind in agents:
        s = wait_idle(c, sids[kind], min_wait=8)
        check(f"{kind}: resumed and running", s["alive"], screen(c, sids[kind])[-800:])
        type_line(c, s["handle"], "Multiply the secret number I gave you earlier by 3. Do not use any tools. Reply with only the result.")
    for kind in agents:
        s = wait_idle(c, sids[kind])
        text = c.call("session.read", {"handle": s["handle"], "lines": 400})["text"]
        want = str(secrets[kind] * 3)
        check(f"{kind}: remembers the conversation ({secrets[kind]} x 3 = {want})", want in text.split("Multiply the secret")[-1], text[-600:])
    for kind in agents:
        s = find(c, sids[kind])
        c.call("session.kill", {"handle": s["handle"]})
finally:
    try:
        c.call("daemon.shutdown")
    except BaseException:
        pass
    time.sleep(1)
    subprocess.run(["taskkill", "/PID", str(daemon.pid), "/F", "/T"], capture_output=True)

failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
