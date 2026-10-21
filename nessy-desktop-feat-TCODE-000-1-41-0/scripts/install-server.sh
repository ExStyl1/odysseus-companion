#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = "--print-url" ] || [ "${1:-}" = "--dry-run" ]; then
  : "${NESSY_SERVER_DIST_URL:?Nessy server distribution is not published yet; see docs.}"
  echo "$NESSY_SERVER_DIST_URL"
  exit 0
fi

: "${NESSY_SERVER_DIST_URL:?Nessy server distribution is not published yet; see docs.}"
echo "Nessy server distribution is dormant for v1: $NESSY_SERVER_DIST_URL"
