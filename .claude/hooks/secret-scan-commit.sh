#!/usr/bin/env bash
# Hook 5: PreToolUse on Bash, fires only on `git commit` / `git add`.
# Blocks the command if any staged file matches a secret pattern (filename or
# content). No-op until `git init` happens.
set -euo pipefail

input=$(cat)
cmd=$(echo "$input" | jq -r '.tool_input.command // empty')
[[ -z "$cmd" ]] && exit 0

# Only run on git commit / git add
if ! echo "$cmd" | grep -qE '(^|[[:space:]&;|])git[[:space:]]+(commit|add)([[:space:]]|$)'; then
  exit 0
fi

cd "$(dirname "$0")/../.." || exit 0
[[ ! -d .git ]] && exit 0

staged=$(git diff --cached --name-only 2>/dev/null || true)
[[ -z "$staged" ]] && exit 0

violations=""
while IFS= read -r f; do
  [[ -z "$f" ]] && continue

  case "$f" in
    .env|.env.*|*.pem|*.key|hsm-*|*hsm-key*|*-secrets.*|*credentials.json)
      violations+="\n  - $f (filename matches secret pattern)"
      ;;
  esac

  # XRPL secret seeds: start with 's', 28 base58 chars
  if [[ -f "$f" ]] && grep -qE '\bs[a-zA-Z1-9]{28}\b' "$f" 2>/dev/null; then
    violations+="\n  - $f (contains XRPL secret seed pattern)"
  fi
done <<< "$staged"

if [[ -n "$violations" ]]; then
  reason="Secret scan blocked git commit. Suspicious files:${violations}\n\nUnstage with: git reset HEAD <file>. If this is a false positive (e.g. .env.example), update .claude/hooks/secret-scan-commit.sh to allow it."
  jq -nc --arg r "$reason" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $r
    }
  }'
  exit 0
fi
exit 0
