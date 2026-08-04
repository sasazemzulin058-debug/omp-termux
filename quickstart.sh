#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
if [ -f "$SCRIPT_DIR/install.sh" ]; then
    exec sh "$SCRIPT_DIR/install.sh" "$@"
fi
exec sh -c 'curl -fsSL https://raw.githubusercontent.com/sasazemzulin058-debug/omp-termux/main/install.sh | sh'
