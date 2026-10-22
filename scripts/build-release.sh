#!/usr/bin/env bash
# Builds the Kelpie installer for the current platform:
#   Windows → NSIS installer (kelpied.exe, kelpie-stt.exe + sideloaded ConPTY next to Kelpie.exe)
#   macOS   → Kelpie.app + .dmg (kelpied, kelpie-stt inside Contents/MacOS)
# Usage: scripts/build-release.sh [extra tauri build args]
set -euo pipefail
cd "$(dirname "$0")/.."

triple=$(rustc -vV | sed -n 's/^host: //p')
ext=""
case "$triple" in *windows*) ext=".exe" ;; esac

cargo build --release -p kelpied -p kelpie-stt
out_dir=$(cargo metadata --format-version 1 --no-deps | python -c "import json,sys;print(json.load(sys.stdin)['target_directory'])")
mkdir -p app/src-tauri/binaries
# Tauri sidecars are looked up as <name>-<target triple><ext>.
cp "$out_dir/release/kelpied$ext" "app/src-tauri/binaries/kelpied-$triple$ext"
cp "$out_dir/release/kelpie-stt$ext" "app/src-tauri/binaries/kelpie-stt-$triple$ext"

cd app
pnpm install --frozen-lockfile
pnpm tauri build --config src-tauri/tauri.bundle.json "$@"
echo "Bundles: $out_dir/release/bundle"
