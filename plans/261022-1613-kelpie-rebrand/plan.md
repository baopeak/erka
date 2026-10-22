# Kelpie rebrand

Status: done. Shipped in af10e12 (rename + brand), 6291fe0 (macOS path-rewrite fix) and 814586d (cross-platform launch tests); repo renamed to github.com/baopeak/kelpie; CI green on Windows and macOS. Open: README screenshots still show the Erka UI; macOS keychain prompt on reading Erka's secrets unverified.

Verification (2026-10-22): `cargo test` 83 + 1 opt-in keyring test pass; typecheck, i18n, NSIS release build pass; e2e on the release build: smoke 16/16, restart 3/3, phase4 22/22, phase5 23/23, plugins 68/68, parity 74/74 (one flaky Ctrl+C timing check passed on rerun), ssh_hosts 25/25; upgrade simulated on a copy of real Erka data (state, sessions, snapshots, ssh copied; program files, lock, hook settings left behind; no old paths inside).

Rename Erka to **Kelpie** (Erka reads too close to Orca) and roll out the new identity across the app, docs and repo.
Design source: canvas https://claude.ai/artifact/F3idpWC6i9kent9G1Gu7dt (page "Kelpie"); guide: [docs/brand.md](../../docs/brand.md).

## Decisions

| Item | Choice |
|---|---|
| Name / daemon / identifier | Kelpie · `kelpied` · `dev.kelpie.desktop` |
| Logo | "Chỉ đôi tai" mark (two ears behind a `>_` window) + Bricolage Grotesque wordmark |
| App icon | Kip peeking over a terminal band on Night `#141823` |
| Mascot | Kip, the kelpie peeking out of a terminal; states peek, working, needs you, done, sleep |
| Colors | Rust `#E8743B`, Night `#141823`, Spirit Teal `#18A999`, Tan, Cream, Paper; status teal / amber / green / grey |
| Old user data | Moved once on first start (`kelpie_proto::migrate_legacy_data_dir`): a running old `erkad` is stopped first, entries are renamed (program files stay), state files last, stored paths and `ERKA_*` env keys rewritten, resumable after interruption; secrets move on first read; webview profile moved; `.erka.yaml`, `erka-plugin.json`, `.erka-account`, `erka-token` and remote `erka-<id>` tmux sessions still honoured. Audit: [code-reviewer report](../reports/code-reviewer-261022-1811-kelpie-rename-audit.md) |
| GitHub | `gh repo rename` baopeak/erka → baopeak/kelpie (keeps history, redirects old URL); new repo only if rename fails |

## Phases

1. **Assets (done).** `app/src/assets/brand/` (mark, wordmark, lockups, app icon, 5 Kip states), regenerated `app/src-tauri/icons/`, `scripts/rename-to-kelpie.py` (136 files, 4 paths; removed after the run, since a second run would rename the legacy fallbacks).
2. **Rename (blocked).** Needs a clean tree. Run the script, let cargo regenerate `Cargo.lock`, then add the data-dir / `.erka.yaml` / plugin-manifest fallbacks (written after the script so it does not rename the legacy names).
3. **UI rollout.** Theme tokens in `app/src/styles.css` (dark + light), window `backgroundColor`, logo in sidebar / about / settings, Kip in empty states, onboarding and notifications, `index.html` title.
4. **Docs.** README header and wording, `docs/*.md`; screenshots retaken after the UI change.
5. **Verify.** `cargo test --workspace`, `pnpm build` + typecheck, e2e smoke, launch the app and check icon, theme, migration with an existing `Erka` data dir.
6. **Ship.** Commit (rename separate from UI), `gh repo rename`, update `origin`, push. Local folder `D:\Works\Erka` renamed by the user once no session uses it.

## Acceptance

- `git grep -i erka` outside `plans/` returns only the intentional legacy fallbacks.
- Build and tests pass; installed app shows the Kelpie icon, name and theme.
- Existing sessions and settings survive the upgrade.

## Risks

- A running old `erkad` holds `erkad.lock`, so the data-dir rename fails: migration logs and keeps using the old dir until the old daemon stops.
- The new identifier installs beside the old app; uninstall Erka manually.
