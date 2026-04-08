#!/usr/bin/env bash
# Hook 3: PreToolUse on Bash. The most important safety hook on this project.
# Blocks any bash command that touches XRPL mainnet unless the user explicitly
# sets RAILFORGE_ALLOW_MAINNET=1 in the same command. Money-moving codebase —
# the friction is the point.
set -euo pipefail

input=$(cat)
cmd=$(echo "$input" | jq -r '.tool_input.command // empty')
[[ -z "$cmd" ]] && exit 0

# Patterns indicating a mainnet operation. Add to this list if new mainnet
# endpoints or env-var conventions are introduced.
mainnet_pattern='s1\.ripple\.com|s2\.ripple\.com|xrplcluster\.com|XRPL_NETWORK=mainnet|--network[= ]mainnet|--mainnet'

if echo "$cmd" | grep -qE "$mainnet_pattern"; then
  if ! echo "$cmd" | grep -q 'RAILFORGE_ALLOW_MAINNET=1'; then
    cat <<'JSON'
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Mainnet operation blocked by RailForge safety hook. To proceed, prefix the command with RAILFORGE_ALLOW_MAINNET=1 in the same shell invocation. This is intentional friction — make sure you mean it. See SETUP.md §3 hook 3."
  }
}
JSON
    exit 0
  fi
fi
exit 0
