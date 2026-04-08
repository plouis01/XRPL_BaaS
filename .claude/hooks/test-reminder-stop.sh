#!/usr/bin/env bash
# Hook 6: Stop hook. Reminds to run tests if there are uncommitted .ts/.tsx
# changes under apps/. False positives are tolerated — the prompt is cheap and
# the cost of forgetting is shipping untested money-moving code.
set -euo pipefail

cd "$(dirname "$0")/../.." || exit 0
[[ ! -d .git ]] && exit 0

modified=$(git status --porcelain 2>/dev/null | grep -E '^.{1,2}apps/.*\.tsx?$' | head -1 || true)
if [[ -n "$modified" ]]; then
  echo '{"systemMessage": "RailForge: uncommitted TypeScript changes under apps/. Run `bun test` (or `bunx vitest run <file>` for one file) before wrapping up."}'
fi
exit 0
