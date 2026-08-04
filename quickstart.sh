#!/bin/sh
set -e

# quickstart.sh - install standalone omp and verify
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"

if [ -f "$SCRIPT_DIR/install.sh" ]; then
    sh "$SCRIPT_DIR/install.sh"
else
    curl -fsSL https://raw.githubusercontent.com/sasazemzulin058-debug/omp-termux/main/install.sh | sh
fi

echo ""
echo "🔍 Verifying omp..."
omp --version
