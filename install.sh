#!/usr/bin/env sh
# Installs the caveman reply style for Claude Code and Codex. Extra arguments pass through, e.g. sh install.sh --dry-run
command -v node >/dev/null 2>&1 || { echo "Node.js 18+ is required (https://nodejs.org). Install it, then run this again." >&2; exit 1; }
exec node "$(dirname "$0")/caveman.mjs" install "$@"
