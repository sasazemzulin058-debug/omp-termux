#!/bin/sh
set -e

# ==========================================================
# Local 1-Command Upstream Sync Script for omp-termux
# Upstream: https://github.com/can1357/oh-my-pi.git
# ==========================================================

echo "🔄 Syncing omp-termux with upstream (can1357/oh-my-pi)..."

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"

cd "$REPO_DIR"

# 1. Add upstream remote if missing
git remote add upstream https://github.com/can1357/oh-my-pi.git 2>/dev/null || true

# 2. Fetch upstream main & tags
echo "📥 Fetching upstream main branch and tags..."
glibc-runner -s "git fetch upstream main --tags" || git fetch upstream main --tags

# 3. Merge upstream/main into main
echo "🔀 Merging upstream/main into main..."
git merge upstream/main -m "chore: sync with upstream can1357/oh-my-pi"

# 4. Push updated main to GitHub
echo "🚀 Pushing updated main branch to origin..."
glibc-runner -s "git push origin main" || git push origin main

echo "✅ Upstream sync completed successfully!"
