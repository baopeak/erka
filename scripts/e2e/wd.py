"""Minimal W3C WebDriver client for driving the Erka app through tauri-driver.

    tauri-driver --port 4444 --native-driver <msedgedriver.exe>
"""
import base64
import json
import time
import urllib.error
import urllib.request

KEYS = {
    "enter": "", "escape": "", "tab": "", "backspace": "",
    "ctrl": "", "shift": "", "alt": "", "meta": "",
    "down": "", "up": "",
}


class Driver:
    def __init__(self, app_path, url="http://127.0.0.1:4444"):
        self.url = url
        caps = {"capabilities": {"alwaysMatch": {"browserName": "wry", "tauri:options": {"application": app_path}}}}
        self.sid = self._req("POST", "/session", caps)["sessionId"]

    def _req(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.url + path, data=data, method=method, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.loads(r.read() or b"{}").get("value", {})
        except urllib.error.HTTPError as e:
            detail = json.loads(e.read() or b"{}").get("value", {})
            raise RuntimeError(f"{method} {path}: {detail.get('message', detail)}") from None

    def s(self, path):
        return f"/session/{self.sid}{path}"

    def js(self, script, *args):
        return self._req("POST", self.s("/execute/sync"), {"script": script, "args": list(args)})

    def js_async(self, script, *args):
        """`script` must call arguments[arguments.length-1](result)."""
        return self._req("POST", self.s("/execute/async"), {"script": script, "args": list(args)})

    def invoke(self, cmd, payload=None):
        return self.js_async(
            "const done = arguments[arguments.length-1];"
            "window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1] || {}).then(r => done({ok: r}), e => done({err: String(e)}));",
            cmd, payload or {},
        )

    def wait(self, script, timeout=30, interval=0.25, *args):
        end = time.time() + timeout
        while time.time() < end:
            v = self.js(script, *args)
            if v:
                return v
            time.sleep(interval)
        raise TimeoutError(script)

    def screenshot(self, path):
        png = base64.b64decode(self._req("GET", self.s("/screenshot")))
        open(path, "wb").write(png)

    def find(self, css):
        v = self._req("POST", self.s("/element"), {"using": "css selector", "value": css})
        return next(iter(v.values()))

    def click(self, css):
        self._req("POST", self.s(f"/element/{self.find(css)}/click"), {})

    def keys(self, *chords):
        """Each chord: "ctrl+shift+p" or plain text. Text is typed char by char."""
        actions = []
        for chord in chords:
            parts = chord.split("+") if "+" in chord and all(p in KEYS or len(p) == 1 for p in chord.split("+")) and len(chord) > 1 else None
            if parts:
                mods = [KEYS[p] for p in parts[:-1]]
                key = KEYS.get(parts[-1], parts[-1])
                seq = [{"type": "keyDown", "value": m} for m in mods] + [{"type": "keyDown", "value": key}, {"type": "keyUp", "value": key}] + [{"type": "keyUp", "value": m} for m in reversed(mods)]
            elif chord in KEYS:
                seq = [{"type": "keyDown", "value": KEYS[chord]}, {"type": "keyUp", "value": KEYS[chord]}]
            else:
                seq = []
                for ch in chord:
                    seq += [{"type": "keyDown", "value": ch}, {"type": "keyUp", "value": ch}]
            actions += seq
        self._req("POST", self.s("/actions"), {"actions": [{"type": "key", "id": "kb", "actions": actions}]})
        self._req("DELETE", self.s("/actions"))

    def quit(self):
        try:
            self._req("DELETE", f"/session/{self.sid}")
        except Exception:
            pass
