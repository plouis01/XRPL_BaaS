#!/usr/bin/env bash
# Hook 1: PostToolUse on Write|Edit.
# Format the changed file with biome if it's a known type. Silent failure —
# formatting must never block development. If biome isn't installed yet
# (pre-Sprint 1), the hook is a no-op.
#
# CRITICAL: cd into the project root before invoking biome. Biome's config
# resolution walks up from cwd, NOT from the file path — running from a
# subdirectory can pick up a different (or no) biome.json and silently
# reformat with the wrong settings (e.g. double quotes instead of single).
set -euo pipefail

input=$(cat)
file=$(echo "$input" | jq -r '.tool_response.filePath // .tool_input.file_path // empty')
[[ -z "$file" ]] && exit 0

# Project root = parent of .claude/
project_root="$(cd "$(dirname "$0")/../.." && pwd)"

case "$file" in
  *.ts|*.tsx|*.js|*.jsx|*.json|*.jsonc)
    if command -v bunx >/dev/null 2>&1; then
      (cd "$project_root" && bunx --bun biome check --write "$file" >/dev/null 2>&1) || true
    fi
    ;;
esac
exit 0
