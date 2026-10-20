"""Shared helpers for the WebDriver e2e scripts."""
import json
import os
import subprocess
import sys

from wd import Driver

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def default_app():
    meta = json.loads(subprocess.check_output(["cargo", "metadata", "--format-version", "1", "--no-deps"], cwd=REPO))
    return os.path.join(meta["target_directory"], "debug", "erka.exe" if os.name == "nt" else "erka")


def daemon(d, method, params=None):
    r = d.invoke("daemon_call", {"method": method, "params": params or {}})
    if "err" in r:
        raise RuntimeError(r["err"])
    return r["ok"]


class Run:
    def __init__(self, shots, app=None):
        self.shots = shots
        os.makedirs(shots, exist_ok=True)
        self.results = []
        self.d = Driver(app or default_app())

    def boot(self, tips=False):
        self.d.wait("return !!(window.__erka && window.__erka.store.loaded())", 60)
        self.d.wait("return window.__erka.store.connected()", 30)
        # First-run tips would float over whatever a scenario clicks.
        if not tips:
            self.d.js("window.__erka.store.setSettings({ tips: false })")

    def check(self, name, ok, detail=""):
        self.results.append((name, bool(ok), detail))
        print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail else ""), flush=True)

    def shot(self, name):
        self.d.screenshot(os.path.join(self.shots, name + ".png"))

    def finish(self):
        self.d.quit()
        failed = [r for r in self.results if not r[1]]
        print(json.dumps({"passed": len(self.results) - len(failed), "failed": len(failed)}))
        sys.exit(1 if failed else 0)
