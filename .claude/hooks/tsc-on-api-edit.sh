#!/usr/bin/env bash
# Hook 2: PostToolUse on Write|Edit, scoped to apps/api/**/*.ts.
# Runs `tsc --noEmit -p apps/api` async so type drift surfaces immediately
# without blocking the edit cycle. No-op until the api tsconfig exists.
set -euo pipefail

input=$(cat)
file=$(echo "$input" | jq -r '.tool_response.filePath // .tool_input.file_path // empty')
[[ -z "$file" ]] && exit 0

case "$file" in
  */apps/api/*.ts|*/apps/api/*.tsx) ;;
  *) exit 0 ;;
esac

cd "$(dirname "$0")/../.." || exit 0

if command -v bunx >/dev/null 2>&1 && [[ -f apps/api/tsconfig.json ]]; then
  bunx tsc --noEmit -p apps/api 2>&1 | head -40 || true
fi
exit 0
