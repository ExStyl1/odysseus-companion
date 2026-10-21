#!/usr/bin/env bash
# [nessy-fork] desktop-linux-update-signing
set -euo pipefail

: "${LINUX_GPG_PRIVATE_KEY_B64:?LINUX_GPG_PRIVATE_KEY_B64 is required}"
: "${LINUX_GPG_KEY_FINGERPRINT:?LINUX_GPG_KEY_FINGERPRINT is required}"
: "${LINUX_GPG_PASSPHRASE:?LINUX_GPG_PASSPHRASE is required}"

if ! command -v gpg >/dev/null 2>&1; then
  echo "ERROR: gpg is required"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELEASE_DIR="${LINUX_RELEASE_DIR:-$SCRIPT_DIR/../apps/electron/release}"
export GNUPGHOME
GNUPGHOME="$(mktemp -d)"
trap 'rm -rf "$GNUPGHOME"' EXIT
chmod 700 "$GNUPGHOME"

if [[ "$(uname -s)" == "Darwin" ]]; then
  printf '%s' "$LINUX_GPG_PRIVATE_KEY_B64" | base64 -D | gpg --batch --import
else
  printf '%s' "$LINUX_GPG_PRIVATE_KEY_B64" | base64 --decode | gpg --batch --import
fi
if ! gpg --batch --with-colons --list-secret-keys "$LINUX_GPG_KEY_FINGERPRINT" \
  | awk -F: '$1 == "fpr" { print $10 }' \
  | grep -Fxq "$LINUX_GPG_KEY_FINGERPRINT"; then
  echo "ERROR: Imported GPG key does not match LINUX_GPG_KEY_FINGERPRINT"
  exit 1
fi

embedded_public_key="$SCRIPT_DIR/../apps/electron/resources/brands/nessy-cli/linux-update-public-key.asc"
embedded_fingerprint="$(gpg --batch --with-colons --show-keys "$embedded_public_key" \
  | awk -F: '$1 == "fpr" { print $10; exit }')"
if [[ "$embedded_fingerprint" != "$LINUX_GPG_KEY_FINGERPRINT" ]]; then
  echo "ERROR: Embedded Linux update key does not match LINUX_GPG_KEY_FINGERPRINT"
  exit 1
fi

public_key="$RELEASE_DIR/nessy-cli-desktop.gpg-key.asc"
cp "$embedded_public_key" "$public_key"
if [[ ! -s "$public_key" ]]; then
  echo "ERROR: Failed to export GPG public key"
  exit 1
fi

appimage_count=0
manifest_count=0
while IFS= read -r -d '' artifact; do
  signature="${artifact}.asc"
  printf '%s' "$LINUX_GPG_PASSPHRASE" | gpg \
    --batch \
    --yes \
    --pinentry-mode loopback \
    --passphrase-fd 0 \
    --local-user "$LINUX_GPG_KEY_FINGERPRINT" \
    --armor \
    --detach-sign \
    --output "$signature" \
    "$artifact"
  gpg --batch --verify "$signature" "$artifact"
  echo "Signed and verified: ${artifact#"$RELEASE_DIR/"}"
  if [[ "$artifact" == *.AppImage ]]; then
    appimage_count=$((appimage_count + 1))
  else
    manifest_count=$((manifest_count + 1))
  fi
done < <(find "$RELEASE_DIR" -maxdepth 1 -type f \( -name '*.AppImage' -o -name '*-linux*.yml' \) -print0)

if [[ "$appimage_count" -eq 0 || "$manifest_count" -eq 0 ]]; then
  echo "ERROR: AppImage or Linux update manifest missing in $RELEASE_DIR"
  exit 1
fi
