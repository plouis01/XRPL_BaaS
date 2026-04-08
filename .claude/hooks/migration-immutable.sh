#!/usr/bin/env bash
# Hook 4: PreToolUse on Edit|Write. Blocks edits to migration files that are
# already tracked in git — applied migrations are immutable. New state requires
# a new migration via `bunx drizzle-kit generate`.
set -euo pipefail

input=$(cat)
file=$(echo "$input" | jq -r '.tool_input.file_path // empty')
[[ -z "$file" ]] && exit 0

case "$file" in
  */packages/db/src/migrations/*) ;;
  *) exit 0 ;;
esac

# New file = creating a new migration. Allow.
[[ ! -f "$file" ]] && exit 0

cd "$(dirname "$0")/../.." || exit 0
[[ ! -d .git ]] && exit 0

if git ls-files --error-unmatch "$file" >/dev/null 2>&1; then
  jq -nc --arg f "$file" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Migration \($f) is already applied (tracked in git). Migrations are immutable — generate a new migration with `bunx drizzle-kit generate` instead of editing this one. See CLAUDE.md implementation rules."
    }
  }'
  exit 0
fi
exit 0
