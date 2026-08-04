#!/bin/sh
set -e

# Quickstart script for omp-termux
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"

echo "⚡ omp-termux Quickstart"
echo "----------------------"

# Run install.sh
if [ -f "$SCRIPT_DIR/install.sh" ]; then
    sh "$SCRIPT_DIR/install.sh"
else
    curl -fsSL https://raw.githubusercontent.com/sasazemzulin058-debug/omp-termux/main/install.sh | sh
fi

echo ""
echo "💡 Quickstart Tips:"
echo "1. Set an API key (e.g. export GEMINI_API_KEY=\"your_key\")"
echo "2. Run 'omp' for interactive mode"
echo "3. Run 'omp -p \"your prompt\"' for non-interactive mode"
