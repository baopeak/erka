#!/usr/bin/env python3
"""Dev/automation client for erkad that does not depend on the Rust binary being built.

    python scripts/erka-call.py <method> [json-params]
    python scripts/erka-call.py watch <handle> <seconds>   # print status changes

Honours ERKA_ENDPOINT like the daemon (Windows named pipe name / Unix socket path).
"""
import json
import os
import socket
import struct
import sys
import time

KIND_JSON = 1


def endpoint():
    custom = os.environ.get("ERKA_ENDPOINT")
    if os.name == "nt":
        name = custom or "erka-%s-v1" % "".join(
            c for c in os.environ.get("USERNAME", "user") if c.isalnum() or c in "-_")
        return r"\\.\pipe" + "\\" + name
    if custom:
        return custom
    raise SystemExit("set ERKA_ENDPOINT to the daemon socket path")


class Conn:
    def __init__(self):
        ep = endpoint()
        if os.name == "nt":
            self.f = open(ep, "r+b", buffering=0)
            self.read = self.f.read
            self.write = self.f.write
        else:
            s = socket.socket(socket.AF_UNIX)
            s.connect(ep)
            self.read = lambda n: s.recv(n, socket.MSG_WAITALL)
            self.write = s.sendall
        self.next_id = 1

    def frame(self):
        hdr = self.read(5)
        (length,) = struct.unpack("<I", hdr[:4])
        kind = hdr[4]
        body = b""
        while len(body) < length - 1:
            body += self.read(length - 1 - len(body))
        return kind, body

    def call(self, method, params=None):
        rid = self.next_id
        self.next_id += 1
        body = json.dumps({"id": rid, "method": method, "params": params or {}}).encode()
        self.write(struct.pack("<I", len(body) + 1) + bytes([KIND_JSON]) + body)
        while True:
            kind, payload = self.frame()
            if kind != KIND_JSON:
                continue
            msg = json.loads(payload)
            if msg.get("id") == rid:
                if "error" in msg:
                    raise SystemExit("%s: %s" % (method, msg["error"]["message"]))
                return msg.get("result")


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    c = Conn()
    if sys.argv[1] == "watch":
        handle, secs = int(sys.argv[2]), float(sys.argv[3])
        last = None
        end = time.time() + secs
        while time.time() < end:
            for s in c.call("session.list"):
                if s["handle"] == handle:
                    cur = (s["status"], s["unread"], s.get("title"))
                    if cur != last:
                        print("%6.1fs %s unread=%s title=%r" % (secs - (end - time.time()), *cur), flush=True)
                        last = cur
            time.sleep(0.25)
        return
    params = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    print(json.dumps(c.call(sys.argv[1], params), indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
