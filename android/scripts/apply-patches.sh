#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
PATCHES_DIR="$SCRIPT_DIR/../patches"

cd "$ROOT_DIR"
echo "Applying Android patches from $PATCHES_DIR..."
shopt -s nullglob
patches=("$PATCHES_DIR"/[0-9][0-9]-*.patch)
shopt -u nullglob

for patch in "${patches[@]}"; do
  echo "Applying $(basename "$patch")..."
  git apply --whitespace=nowarn --check "$patch"
  git apply --whitespace=nowarn "$patch"
done

echo "All patches applied successfully."
