#!/usr/bin/env bash
# Apply legacy Android patches. New upstream sync uses apply-overlay.py.
# Kept for local maintenance and old checkouts.
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
	if [ "$name" = "05-pi-shell-android-cfg.patch" ]; then
		file="crates/pi-shell/src/process.rs"
		if grep -q '^#[[:space:]]*cfg(any(target_os = "linux", target_os = "android"))]' "$file"; then
			echo "skip   $name (already applied)"
			skipped=$((skipped + 1))
			continue
		fi
		if grep -q '^#[[:space:]]*cfg(target_os = "linux")]' "$file"; then
			sed -i 's/^\(#[[:space:]]*cfg(\)target_os = "linux"\)]/\1any(target_os = "linux", target_os = "android")]/' "$file"
			echo "apply  $name (direct cfg update)"
			applied=$((applied + 1))
			continue
		fi
	fi
	if git apply --reverse --check "$patch" >/dev/null 2>&1; then
		echo "skip   $name (already applied)"
		skipped=$((skipped + 1))
		continue
	fi
	if git apply --3way --check "$patch" >/dev/null 2>&1; then
		git apply --3way "$patch"
		printf 'apply  %s (3-way)\n' "$name"
		applied=$((applied + 1))
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
