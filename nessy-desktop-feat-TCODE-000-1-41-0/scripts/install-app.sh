#!/usr/bin/env bash
set -euo pipefail

INSTALL_BASE="${NESSY_DESKTOP_INSTALL_BASE:-https://nessy-desktop-releases-dev.s3-msk.tinkoff.ru/dev/mac}"
DOWNLOAD_DIR="${NESSY_DESKTOP_DOWNLOAD_DIR:-$HOME/.nessy-agent/downloads}"
PRINT_URL=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run|--print-url) PRINT_URL=true ;;
    -h|--help)
      echo "Usage: install-app.sh [--print-url]"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

[ "$(uname -s)" = "Darwin" ] || { echo "Nessy Desktop installer currently supports macOS only." >&2; exit 1; }

case "$(uname -m)" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64) arch="x64" ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O - "$1"
  else
    echo "curl or wget is required." >&2
    exit 1
  fi
}

version="${NESSY_DESKTOP_INSTALL_VERSION:-}"
if [ -z "$version" ]; then
  manifest=""
  for name in dev-mac.yml "dev-${arch}-mac.yml" "latest-${arch}-mac.yml" latest-mac.yml; do
    if manifest="$(fetch "${INSTALL_BASE%/}/$name" 2>/dev/null)"; then
      break
    fi
  done
  version="$(printf "%s\n" "$manifest" | awk '/^version:/ {print $2; exit}')"
fi

[ -n "$version" ] || { echo "Could not resolve Nessy Desktop version from ${INSTALL_BASE%/}." >&2; exit 1; }

filename="NessyDesktop-${version}-mac-${arch}.dmg"
url="${INSTALL_BASE%/}/$filename"

if [ "$PRINT_URL" = true ]; then
  echo "$url"
  exit 0
fi

mkdir -p "$DOWNLOAD_DIR"
installer="$DOWNLOAD_DIR/$filename"
echo "Downloading $url"
if command -v curl >/dev/null 2>&1; then
  curl -fL --progress-bar -o "$installer" "$url"
else
  wget --show-progress -q -O "$installer" "$url"
fi

mount_dir="$(mktemp -d)"
cleanup() {
  hdiutil detach "$mount_dir" -quiet >/dev/null 2>&1 || true
  rmdir "$mount_dir" >/dev/null 2>&1 || true
}
trap cleanup EXIT

hdiutil attach "$installer" -mountpoint "$mount_dir" -nobrowse -quiet
osascript -e 'tell application id "ru.tfinance.nessy-desktop.NessyDesktop" to quit' >/dev/null 2>&1 || true
# Remove the previous bundle first: cp -R onto an existing .app merges the
# trees, leaving stale files inside and breaking the code-signature seal.
rm -rf "/Applications/Nessy Desktop.app"
cp -R "$mount_dir/Nessy Desktop.app" /Applications/
echo "Nessy Desktop installed to /Applications."
