#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Load API key from file
API_KEY=$(cat /Users/ghalmos/Workspace/anthropic_api_key)
if [ -z "$API_KEY" ]; then
  echo "Error: Empty API key"
  exit 1
fi

cd "$REPO_ROOT"

echo "==> Installing dependencies..."
bun install

echo "==> Running validate-daily-note locally..."
# `run` no longer defaults to bypassPermissions (T3, 2026-08-12
# sandbox-default-off-and-bypass-cli-parity) — this script relied on the
# implicit bypass, so the flag is now explicit to keep its behavior unchanged.
ANTHROPIC_API_KEY="$API_KEY" bun run apps/cli/src/index.ts run \
  --workspace-dir .github/agents \
  --source nessy-public \
  --output-format stream-json \
  --dangerously-skip-permissions \
  "Read today's daily note from the Nessy source and print its contents. Do not modify anything."
