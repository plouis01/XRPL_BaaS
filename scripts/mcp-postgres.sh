#!/usr/bin/env bash
# MCP postgres launcher.
#
# Reads DATABASE_URL from the project's .env file rather than embedding it
# in ~/.claude.json. This keeps the credential out of long-lived config files
# (which would be a textbook secret-leak pattern — see PLAN.md §9).
#
# .env is gitignored and the secret-scan hook (Hook 5) blocks committing it.
# If you ever copy this pattern for a mainnet credential, the discipline of
# "credentials live in .env, code references them" must hold.
#
# Usage: ~/.claude.json registers this script as the postgres MCP command.
# To install:
#   claude mcp remove postgres
#   claude mcp add postgres -- /Users/main/XRPL_BaaS/scripts/mcp-postgres.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found. Run: cp .env.example .env" >&2
  exit 1
fi

# Extract DATABASE_URL from .env without sourcing the whole file. Sourcing
# would export every variable in .env to the MCP subprocess — including
# unrelated secrets like API_KEY_SALT — which is exactly what we're trying
# to avoid. Strip surrounding quotes if present.
DATABASE_URL=$(
  grep -E '^DATABASE_URL=' "$ENV_FILE" \
    | head -1 \
    | sed -e 's/^DATABASE_URL=//' \
          -e 's/^"\(.*\)"$/\1/' \
          -e "s/^'\(.*\)'$/\1/"
)

if [[ -z "$DATABASE_URL" ]]; then
  echo "ERROR: DATABASE_URL not set in $ENV_FILE" >&2
  exit 1
fi

# exec replaces the shell process so signals propagate cleanly to the MCP.
exec npx -y @modelcontextprotocol/server-postgres "$DATABASE_URL"
