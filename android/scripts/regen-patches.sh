#!/usr/bin/env bash
# Regenerate android/patches/*.patch from the current working tree.
#
# Workflow when adapting to a new upstream:
#   1. android/scripts/apply-patches.sh   # apply existing patches
#   2. ... fix any conflicts by hand in the 6 target files ...
#   3. android/scripts/regen-patches.sh   # rewrite the patch files from the tree
#   4. git checkout -- <the 6 files>      # reset tree back to clean upstream
#
# The patches are stored as `git diff` output (default context) which `git
# apply` consumes exactly; apply-patches.sh validates each with --check first.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PATCH_DIR="$REPO_ROOT/android/patches"
cd "$REPO_ROOT"

# file path -> patch basename (order matters: lower number applies first)
declare -A MAP=(
	["crates/pi-natives/Cargo.toml"]="01-arboard-gate.patch"
	["crates/pi-natives/src/lib.rs"]="02-remove-alloc-error-hook.patch"
	["crates/pi-natives/src/crash_handler.rs"]="03-disable-alloc-hook.patch"
	["crates/pi-natives/src/clipboard.rs"]="04-clipboard-android-cfg.patch"
	["crates/pi-shell/src/process.rs"]="05-pi-shell-android-cfg.patch"
	["packages/natives/native/loader-state.js"]="06-loader-state-android-arm64.patch"
)

for file in "${!MAP[@]}"; do
	out="$PATCH_DIR/${MAP[$file]}"
	if git diff --quiet -- "$file"; then
		echo "warn: no changes in $file — leaving ${MAP[$file]} untouched" >&2
		continue
	fi
	git diff -- "$file" > "$out"
	echo "wrote ${MAP[$file]} ($(wc -l < "$out") lines)"
done

echo "done"
