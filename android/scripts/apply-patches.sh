#!/usr/bin/env bash
# Apply the Android/Termux source patches onto a clean upstream checkout.
#
# The patches live in android/patches/ and target upstream source files. They
# are intentionally NOT committed into the source tree so this fork stays a thin
# overlay: clone upstream, run this script, build. Re-runnable — already-applied
# patches are detected and skipped (via `git apply --reverse --check`).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PATCH_DIR="$REPO_ROOT/android/patches"

cd "$REPO_ROOT"

if ! command -v git >/dev/null 2>&1; then
	echo "error: git is required to apply patches" >&2
	exit 1
fi

shopt -s nullglob
patches=("$PATCH_DIR"/[0-9][0-9]-*.patch)
shopt -u nullglob

if [ ${#patches[@]} -eq 0 ]; then
	echo "error: no patches found in $PATCH_DIR" >&2
	exit 1
fi

applied=0
skipped=0
for patch in "${patches[@]}"; do
	name="$(basename "$patch")"
	if git apply --reverse --check "$patch" >/dev/null 2>&1; then
		echo "skip   $name (already applied)"
		skipped=$((skipped + 1))
		continue
	fi
	if ! git apply --check "$patch" >/dev/null 2>&1; then
		echo "error: $name does not apply cleanly to the current tree" >&2
		echo "       the upstream files may have drifted; regenerate via android/scripts/regen-patches.sh" >&2
		exit 1
	fi
	git apply "$patch"
	echo "apply  $name"
	applied=$((applied + 1))
done

echo "done: $applied applied, $skipped already present"
