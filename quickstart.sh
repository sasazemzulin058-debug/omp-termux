#!/bin/sh
set -eu

# Remove only omp-managed files. Do not touch unrelated Termux packages.
PREFIX_DIR="${PREFIX:-/data/data/com.termux/files/usr}"
rm -f "$PREFIX_DIR/bin/omp"
rm -rf "$PREFIX_DIR/lib/omp-termux" "$PREFIX_DIR/lib/omp" "$HOME/.omp/natives"

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
if [ -f "$SCRIPT_DIR/install.sh" ]; then
    exec sh "$SCRIPT_DIR/install.sh" "$@"
fi
exec sh -c 'curl -fsSL https://raw.githubusercontent.com/sasazemzulin058-debug/omp-termux/main/quickstart.sh | sh'
