#!/bin/bash
set -euo pipefail

# SessionStart hook for Claude Code on the web.
# Installs the Vite + React frontend dependencies in web/ so that
# `npm run build`, `npm run lint`, and the dev server work immediately
# in a fresh remote container. No-op on local machines.

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Resolve the repo root: prefer the harness-provided var, fall back to the
# script's own location so the hook is also runnable by hand for testing.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

echo "[session-start] Installing web/ dependencies…"
cd "$PROJECT_DIR/web"
npm install --no-audit --no-fund
echo "[session-start] web/ dependencies ready."
