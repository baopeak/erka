"""Rename the project from Erka to Kelpie in file contents and paths.

Run from the repo root once all pending work is committed:

    python -I scripts/rename-to-kelpie.py --dry-run   # report only
    python -I scripts/rename-to-kelpie.py             # apply

The run is idempotent: a second run finds nothing to change. Cargo.lock is left
for cargo to regenerate, and plans/ keeps its historical names.
"""
import argparse
import os
import re
import subprocess
from collections import Counter
from pathlib import Path

# Only whole-name occurrences: a letter or digit right before "erka" means it is part of
# another token (hashes inside lock files, for example), so it is left alone.
PATTERN = re.compile(r"(?<![A-Za-z0-9])(ERKA|Erka|erka)")
MAPPING = {"ERKA": "KELPIE", "Erka": "Kelpie", "erka": "kelpie"}
TOKEN = re.compile(r"(?<![A-Za-z0-9])(?:ERKA|Erka|erka)[A-Za-z0-9_]*")

# Historical records, vendored code and generated files keep their original text.
SKIP_PREFIXES = ("plans/", "third_party/", "docs/screenshots/", "app/src-tauri/gen/")
SKIP_NAMES = {"Cargo.lock", "pnpm-lock.yaml", "rename-to-kelpie.py"}


def rename(text: str) -> str:
    return PATTERN.sub(lambda m: MAPPING[m.group(1)], text)


def project_files(root: Path) -> list[str]:
    out = subprocess.run(["git", "ls-files", "-co", "--exclude-standard", "-z"],
                         cwd=root, capture_output=True, check=True).stdout
    return [p for p in out.decode("utf-8").split("\0") if p]


def skipped(path: str) -> bool:
    return path.startswith(SKIP_PREFIXES) or Path(path).name in SKIP_NAMES


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", help="report changes without writing")
    args = parser.parse_args()
    root = Path.cwd()
    files = [p for p in project_files(root) if not skipped(p)]

    # 1. File contents. Bytes in and out, so line endings and encodings stay as they are.
    tokens: Counter[str] = Counter()
    changed = 0
    for rel in files:
        path = root / rel
        if not path.is_file():
            continue
        raw = path.read_bytes()
        if b"\0" in raw:
            continue  # binary
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            continue
        new = rename(text)
        if new == text:
            continue
        changed += 1
        tokens.update(TOKEN.findall(text))
        if args.dry_run:
            print(f"edit   {rel} ({len(PATTERN.findall(text))})")
        else:
            path.write_bytes(new.encode("utf-8"))

    # 2. Paths, deepest first so parents are renamed after their children.
    entries = set()
    for rel in files:
        parts = Path(rel).parts
        for i in range(len(parts)):
            if PATTERN.search(parts[i]):
                entries.add(Path(*parts[: i + 1]))
    moves = sorted(entries, key=lambda p: len(p.parts), reverse=True)
    for old in moves:
        new = old.with_name(rename(old.name))
        print(f"move   {old.as_posix()} -> {new.as_posix()}")
        if not args.dry_run and (root / old).exists():
            os.rename(root / old, root / new)

    print(f"\n{changed} files edited, {len(moves)} paths renamed{' (dry run)' if args.dry_run else ''}")
    print("tokens:", ", ".join(f"{t}×{n}" for t, n in tokens.most_common()))


if __name__ == "__main__":
    main()
