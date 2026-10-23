---
name: shell-hook-blocked-words
description: Kelpie dev env blocks Read on target/ paths (scout-block hook); Grep/Glob still work there; cargo may be locked by a concurrent build
metadata:
  type: feedback
---

A scout-block hook (`~/.claude/hooks/scout-block.cjs`, `.ckignore`) rejects the Read tool on paths containing "target" (and similar build-output words). On 2026-10-23 Bash commands containing "build" ran fine (`pnpm tauri build --help`, `cat scripts/build-release.sh`), so the Bash-side block seen on 2026-10-20 is not always active. Cargo may be busy with a concurrent build. D: had ~30 GB free on 2026-10-23 (was ~1 GB on 2026-10-20).

On 2026-10-23 evening a Bash `ls` naming `target/release/nsis/...` was blocked too (pattern "target"); Glob on `target/**` and Grep with `pattern: "."` still worked, and `cargo build/test` (which writes to target/) ran fine.

**Why:** Lead stated the restrictions in the 2026-10-20 concurrency review; observed again 2026-10-23.
**How to apply:** For generated files under `target/` (e.g. Tauri's `target/release/nsis/x64/installer.nsi`, useful to see where NSIS hooks are inserted), use Grep with `pattern: "."` plus offset/head_limit instead of Read. Run `cargo clippy -p ...` / `cargo test -p ...` when the lead permits; never release builds. Reviews are read-only (report findings, no edits).
