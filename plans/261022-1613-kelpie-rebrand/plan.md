# Kelpie rebrand

Status: phase 1 done; phase 2 blocked until the two other sessions working in this repo have committed.

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
| Old user data | Migrated: `%LOCALAPPDATA%\Erka` → `Kelpie` on first start when the new dir is absent; `.erka.yaml` and `erka-plugin.json` still read as fallbacks |
| GitHub | `gh repo rename` baopeak/erka → baopeak/kelpie (keeps history, redirects old URL); new repo only if rename fails |

## Phases

1. **Assets (done).** `app/src/assets/brand/` (mark, wordmark, lockups, app icon, 5 Kip states), regenerated `app/src-tauri/icons/`, `scripts/rename-to-kelpie.py` (dry run: 136 files, 4 paths).
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
