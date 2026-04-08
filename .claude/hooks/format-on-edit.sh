#!/usr/bin/env bash
# Hook 1: PostToolUse on Write|Edit.
# Format the changed file with biome if it's a known type. Silent failure —
# formatting must never block development. If biome isn't installed yet
# (pre-Sprint 1), the hook is a no-op.
set -euo pipefail

input=$(cat)
file=$(echo "$input" | jq -r '.tool_response.filePath // .tool_input.file_path // empty')
[[ -z "$file" ]] && exit 0

case "$file" in
  *.ts|*.tsx|*.js|*.jsx|*.json|*.jsonc)
    if command -v bunx >/dev/null 2>&1; then
      bunx --bun biome check --write "$file" >/dev/null 2>&1 || true
    fi
    ;;
esac
exit 0
