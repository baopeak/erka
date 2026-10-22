"""Minimal W3C WebDriver client for driving the Erka app through tauri-driver.

    tauri-driver --port 4444 --native-driver <msedgedriver.exe>
"""
import base64
import json
import os
import time
import urllib.error
import urllib.request

KEYS = {
    "enter": "", "escape": "", "tab": "", "backspace": "",
    "ctrl": "", "shift": "", "alt": "", "meta": "",
    "down": "", "up": "", "left": "", "right": "",
}


class Driver:
    def __init__(self, app_path, url=None):
        # ERKA_E2E_DRIVER: another tauri-driver port, when 4444 is taken by someone else's run.
        self.url = url or os.environ.get("ERKA_E2E_DRIVER", "http://127.0.0.1:4444")
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

    def set_window_size(self, width, height):
        """Resizes the app window. Never WebDriver's `window/rect`: on WebView2 it moves the web
        view inside the window, leaving the whole UI offset and clipped."""
        r = self.invoke("test_window_size", {"width": width, "height": height})
        if "err" in r:
            raise RuntimeError(r["err"])
        # Until the page sees the new size, layout-dependent checks would read the old one.
        self.wait("return innerWidth === arguments[0] && innerHeight === arguments[1]", 5, 0.1, width, height)

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

    def pointer(self, steps):
        """Mouse actions in viewport CSS pixels: ("move", x, y) | ("down",) | ("up",) | ("pause", ms)."""
        acts = []
        for st in steps:
            if st[0] == "move":
                acts.append({"type": "pointerMove", "origin": "viewport", "x": int(st[1]), "y": int(st[2]), "duration": st[3] if len(st) > 3 else 50})
            elif st[0] == "down":
                acts.append({"type": "pointerDown", "button": 0})
            elif st[0] == "up":
                acts.append({"type": "pointerUp", "button": 0})
            elif st[0] == "pause":
                acts.append({"type": "pause", "duration": st[1]})
        self._req("POST", self.s("/actions"), {"actions": [{"type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"}, "actions": acts}]})
        self._req("DELETE", self.s("/actions"))

    def drag(self, x0, y0, x1, y1, steps=8):
        seq = [("move", x0, y0), ("down",), ("pause", 50)]
        for i in range(1, steps + 1):
            seq.append(("move", x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps, 30))
        seq += [("pause", 80), ("up",)]
        self.pointer(seq)

    def quit(self):
        try:
            self._req("DELETE", f"/session/{self.sid}")
        except Exception:
            pass
