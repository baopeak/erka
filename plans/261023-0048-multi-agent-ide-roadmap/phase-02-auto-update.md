---
phase: 2
title: "Auto-update"
status: pending
priority: P1
effort: "3d"
dependencies: [1]
---

# Phase 2: Auto-update

## Overview
Signed in-app updates. Honest contract [RT-2]: updating stops running processes; agents with resume support continue
their conversation afterwards, shells and agents without resume restart fresh — the dialog says which.

## Requirements
- Check at start + every 6 h (Rust core); status-bar chip; release notes; Install now / Install when idle / Skip version; setting automatic / manual only.
- "Install now" lists working sessions that will be interrupted and which of them can resume.
- Upgrade handover [RT-2]:
  1. App calls new `daemon.shutdown {mode:"upgrade"}` (capability `app`): daemon persists every live session with `alive:true, interrupted:true`
     **before** stopping anything, then exits (job close stops children). No `kill_sessions:true`, no ticker save after the persist.
  2. App waits for the daemon PID to exit (timeout → abort install, nothing lost).
  3. Installer runs; NSIS pre-install hook also stops a stray `kelpied.exe` (same upgrade call via CLI) before copying.
  4. New app starts new daemon; `restore()` marks sessions interrupted; existing resume flow (`resumeSessions`) applies.
- Version check [RT-2]: app compares daemon **package version**, not only `API_LEVEL`; mismatch after an update → automatic upgrade restart (no toast);
  the old `kill_sessions:true` toast path (`store.ts:209-220`) is replaced by the same upgrade handover.
- Security [RT-2]: endpoint + pubkey compile-time constants in release config; test overrides only behind Cargo feature `e2e-updater` that the release job never enables
  (CI asserts absence). Dry run uses a throwaway key in a private test repo — never the production key. Private key + password only in the release repo's CI secrets, offline backup.

## Architecture
`tauri-plugin-updater` + GitHub Releases `latest.json`; release job on `v*` tags builds NSIS + DMG (+ AppImage from phase 15), signs, uploads.

## Related Code Files
- Create: `app/src/lib/updater.ts`, `app/src-tauri/nsis/pre-install.nsh`.
- Modify: `app/src-tauri/Cargo.toml` (plugin, `e2e-updater` feature), `app/src-tauri/tauri.conf.json` (pubkey, endpoint, CSP `connect-src`),
  `app/src-tauri/src/lib.rs`, `app/src-tauri/src/daemon_client.rs` (version compare, wait-for-exit), `crates/kelpied/src/daemon.rs` (upgrade shutdown),
  `crates/kelpied/src/main.rs`, `crates/kelpie-proto/src/lib.rs` (API_LEVEL, version in hello), `app/src/lib/store.ts` (replace restart toast),
  `app/package.json`, `app/src/components/status-bar.tsx`, settings catalog, `.github/workflows/ci.yml`, `scripts/build-release.sh`, locales, README, user guide.

## Implementation Steps
1. Upgrade shutdown + wait-for-exit + version compare; unit tests on persist ordering.
2. Plugin + `updater.ts` + idle gate + dialog. 3. NSIS hook. 4. Release job + private dry run.

## Tests
- `cargo test`: after `shutdown{mode:upgrade}`, `sessions.json` has every live session `alive:true` (regression for the 1.7 s ticker save).
- e2e `updater.py` (built with `e2e-updater`): fake `latest.json` → chip; bad signature rejected; "when idle" waits; full handover with 3 sessions → all marked interrupted and resumable.
- Manual Windows: v0.1.0 → v0.1.1 with Claude + Codex + shell running; installer never reports file-in-use; agents resume; shell restarts.

## Perf gate
- No timers when manual only; entry chunk +≤ 3 KB gz.

## Success Criteria
- [ ] Update never loses a resumable conversation; bad signature never installs; release build has no override path.

## Risk Assessment
- Daemon fails to exit → install aborted with message; signal: wait timeout; response: offer "stop sessions and retry".
