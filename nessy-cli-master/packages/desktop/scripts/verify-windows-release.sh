#!/usr/bin/env bash
# [nessy-fork] desktop-windows-signing
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELEASE_DIR="${WINDOWS_RELEASE_DIR:-$SCRIPT_DIR/../apps/electron/release}"
APP_DIR="$RELEASE_DIR/win-unpacked"

if [[ ! -d "$APP_DIR" ]]; then
  echo "ERROR: Windows unpacked app not found: $APP_DIR"
  exit 1
fi

VERIFY_TOOL="${OSSLSIGNCODE:-$(command -v osslsigncode || true)}"
if [[ -z "$VERIFY_TOOL" ]]; then
  CACHE_DIR="${ELECTRON_BUILDER_CACHE:-$HOME/Library/Caches/electron-builder}"
  while IFS= read -r candidate; do
    VERIFY_TOOL="$candidate"
    break
  done < <(find "$CACHE_DIR/winCodeSign" -path '*/darwin/ci/osslsigncode' -type f 2>/dev/null | sort -r)
fi

if [[ -z "$VERIFY_TOOL" || ! -x "$VERIFY_TOOL" ]]; then
  echo "ERROR: osslsigncode verifier not found"
  exit 1
fi

dll_count=0
while IFS= read -r -d '' dll; do
  verification_output="$($VERIFY_TOOL verify -in "$dll" 2>&1)"
  if ! grep -Fq 'Signature verification: ok' <<<"$verification_output"; then
    echo "ERROR: Missing or invalid Authenticode signature: ${dll#"$APP_DIR/"}"
    echo "$verification_output"
    exit 1
  fi
  echo "Verified Authenticode signature: ${dll#"$APP_DIR/"}"
  dll_count=$((dll_count + 1))
done < <(find "$APP_DIR" -type f -iname '*.dll' -print0)

if [[ "$dll_count" -eq 0 ]]; then
  echo "ERROR: No DLL files found in $APP_DIR"
  exit 1
fi

echo "Verified Authenticode signatures on $dll_count DLL files"
