---
name: shell-hook-blocked-words
description: Erka dev env blocks Bash commands containing target/build/dist/vendor/node_modules; review via Read/Grep instead
metadata:
  type: feedback
---

A hook rejects shell commands containing the words "target", "build", "dist", "vendor", "node_modules". Cargo may also be busy with a concurrent build.

**Why:** Lead stated it in the 2026-10-20 concurrency review request; another build was running concurrently.
**How to apply:** For Erka reviews use Read/Grep/Glob for file access; skip `cargo check` unless explicitly allowed. Erka reviews are read-only (report findings, no edits).
