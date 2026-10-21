#!/usr/bin/env bash
set -euo pipefail

platform=""

usage() {
  cat <<'USAGE'
Usage: bash scripts/publish-dev.sh --platform=mac|win|linux

Uploads a prepared dev update feed to S3. Immutable artifacts are uploaded
first, latest*.yml metadata last, and every file is also copied under
releases/$APP_VERSION when APP_VERSION is available.
USAGE
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --platform=*)
      platform="${1#--platform=}"
      ;;
    --platform)
      shift
      platform="${1:-}"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

case "$platform" in
  mac|win|linux) ;;
  "")
    echo "ERROR: --platform=mac|win|linux is required" >&2
    usage >&2
    exit 1
    ;;
  *)
    echo "ERROR: unsupported platform: $platform" >&2
    usage >&2
    exit 1
    ;;
esac

if [[ -f version.env && -z "${APP_VERSION:-}" ]]; then
  # shellcheck disable=SC1091
  source version.env
fi

required_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "ERROR: $name is required" >&2
    exit 1
  fi
}

required_env S3_DEV_BUCKET
required_env S3_DEV_ACCESS_KEY
required_env S3_DEV_SECRET_KEY
required_env S3_ENDPOINT

release_dir="${NESSY_DESKTOP_RELEASE_DIR:-release}"
release_prefix="${NESSY_DESKTOP_DEV_RELEASE_PREFIX:-dev/${platform}}"
release_prefix="${release_prefix#/}"
release_prefix="${release_prefix%/}"

if [[ ! -d "$release_dir" ]]; then
  echo "ERROR: release directory was not found: $release_dir" >&2
  exit 1
fi

export AWS_ACCESS_KEY_ID="$S3_DEV_ACCESS_KEY"
export AWS_SECRET_ACCESS_KEY="$S3_DEV_SECRET_KEY"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-ru-msk}"
export AWS_EC2_METADATA_DISABLED="${AWS_EC2_METADATA_DISABLED:-true}"

metadata_find_expr=()
metadata_description=""

case "$platform" in
  mac)
    metadata_find_expr=( -name 'latest-mac.yml' -o -name 'latest-arm64-mac.yml' -o -name 'dev-mac.yml' -o -name 'dev-arm64-mac.yml' )
    metadata_description="macOS feed metadata"
    ;;
  win)
    metadata_find_expr=( -name 'latest.yml' -o -name 'latest-win.yml' -o -name 'latest-win-arm64.yml' -o -name 'dev.yml' -o -name 'dev-win.yml' -o -name 'dev-win-arm64.yml' )
    metadata_description="Windows feed metadata"
    ;;
  linux)
    metadata_find_expr=( -name 'latest-linux.yml' -o -name 'latest-linux-arm64.yml' -o -name 'dev-linux.yml' -o -name 'dev-linux-arm64.yml' )
    metadata_description="Linux feed metadata"
    ;;
esac

# Split the upload set into two ordered groups so the feed is never observed
# pointing at an artifact that has not landed yet:
#
#   immutable_artifacts: packaged binaries/installers and blockmaps. Uploaded
#     FIRST with immutable cache headers.
#   feed_metadata: updater latest/dev metadata. Uploaded LAST with no-cache
#     headers so the feed flips only after every referenced artifact is live.
#
# Any other *.yml (notably electron-builder's builder-debug.yml) is deliberately
# excluded: it is debug output, not feed metadata, and must never reach the feed.
immutable_artifacts=()
feed_metadata=()
while IFS= read -r -d '' artifact; do
  feed_metadata+=("$artifact")
done < <(
  find "$release_dir" -type f \
    \( "${metadata_find_expr[@]}" \) \
    -print0
)

if [[ "${#feed_metadata[@]}" -eq 0 ]]; then
  echo "ERROR: no $metadata_description found under $release_dir" >&2
  exit 1
fi

referenced_names=()
for metadata in "${feed_metadata[@]}"; do
  while IFS= read -r reference; do
    reference="${reference%%#*}"
    reference="${reference#"${reference%%[![:space:]]*}"}"
    reference="${reference%"${reference##*[![:space:]]}"}"
    reference="${reference%\"}"
    reference="${reference#\"}"
    reference="${reference%\'}"
    reference="${reference#\'}"
    reference="${reference##*/}"
    if [[ -n "$reference" ]]; then
      referenced_names+=("$reference")
    fi
  done < <(
    awk '
      /^[[:space:]]*(-[[:space:]]*)?(url|path):/ {
        sub(/^[[:space:]]*(-[[:space:]]*)?(url|path):[[:space:]]*/, "", $0)
        print $0
      }
    ' "$metadata"
  )
done

seen_artifacts="|"
for name in "${referenced_names[@]}"; do
  case "$name" in
    *.AppImage|*.deb|*.dmg|*.exe|*.zip|*.blockmap) ;;
    *) continue ;;
  esac

  if [[ "$seen_artifacts" == *"|$name|"* ]]; then
    continue
  fi

  artifact_path=""
  while IFS= read -r -d '' candidate; do
    artifact_path="$candidate"
    break
  done < <(find "$release_dir" -type f -name "$name" -print0)

  if [[ -z "$artifact_path" ]]; then
    echo "ERROR: $metadata_description references missing artifact: $name" >&2
    exit 1
  fi

  immutable_artifacts+=("$artifact_path")
  seen_artifacts="${seen_artifacts}${name}|"
done

if [[ "${#immutable_artifacts[@]}" -eq 0 ]]; then
  echo "ERROR: no immutable artifacts referenced by $metadata_description under $release_dir" >&2
  exit 1
fi

content_type_for() {
  case "$1" in
    *.sh) echo "text/x-shellscript" ;;
    *.ps1) echo "text/plain" ;;
    *.AppImage) echo "application/octet-stream" ;;
    *.deb) echo "application/vnd.debian.binary-package" ;;
    *.dmg) echo "application/x-apple-diskimage" ;;
    *.exe) echo "application/vnd.microsoft.portable-executable" ;;
    *.zip) echo "application/zip" ;;
    *.yml) echo "text/yaml" ;;
    *.blockmap) echo "application/octet-stream" ;;
    *) echo "application/octet-stream" ;;
  esac
}

cache_control_for() {
  case "$1" in
    *.yml|*.sh|*.ps1) echo "no-cache, no-store, must-revalidate" ;;
    *) echo "public, max-age=31536000, immutable" ;;
  esac
}

supporting_files=()
case "$platform" in
  mac)
    supporting_files+=(scripts/install-app.sh)
    ;;
  win)
    supporting_files+=(scripts/install-app.ps1)
    ;;
esac

for artifact in "${supporting_files[@]}"; do
  if [[ ! -f "$artifact" ]]; then
    echo "ERROR: supporting release file was not found: $artifact" >&2
    exit 1
  fi
done

upload_artifact() {
  local source_path="$1"
  local destination_key="$2"
  local content_type
  local cache_control

  content_type="$(content_type_for "$source_path")"
  cache_control="$(cache_control_for "$source_path")"

  echo "Uploading ${source_path} -> s3://${S3_DEV_BUCKET}/${destination_key}"
  aws s3 cp "$source_path" "s3://${S3_DEV_BUCKET}/${destination_key}" \
    --endpoint-url "$S3_ENDPOINT" \
    --content-type "$content_type" \
    --cache-control "$cache_control" \
    --no-progress
}

upload_one() {
  local artifact="$1"
  local filename
  filename="$(basename "$artifact")"
  upload_artifact "$artifact" "${release_prefix}/${filename}"

  if [[ -n "${APP_VERSION:-}" ]]; then
    upload_artifact "$artifact" "${release_prefix}/releases/${APP_VERSION}/${filename}"
  fi
}

# Immutable binaries/blockmaps first so the metadata that references them only
# goes live once they are already reachable. Inlined (not a nameref helper) to
# stay compatible with the bash 3.2 that ships on macOS for local publishes.
echo "Uploading ${#immutable_artifacts[@]} immutable ${platform} artifact(s) first"
for artifact in "${immutable_artifacts[@]}"; do
  upload_one "$artifact"
done

if [[ "${#supporting_files[@]}" -gt 0 ]]; then
  echo "Uploading ${#supporting_files[@]} supporting ${platform} file(s)"
  for artifact in "${supporting_files[@]}"; do
    upload_artifact "$artifact" "${release_prefix}/$(basename "$artifact")"
  done
fi

# Feed metadata last so a partially-uploaded release never advertises missing
# artifacts to update clients.
echo "Uploading ${#feed_metadata[@]} ${platform} feed metadata file(s) last"
for artifact in "${feed_metadata[@]}"; do
  upload_one "$artifact"
done

total_uploaded=$(( ${#immutable_artifacts[@]} + ${#supporting_files[@]} + ${#feed_metadata[@]} ))
echo "Uploaded ${total_uploaded} ${platform} artifact(s) to s3://${S3_DEV_BUCKET}/${release_prefix}"
if [[ -n "${NESSY_DESKTOP_DEV_UPDATE_URL:-}" ]]; then
  echo "Dev update feed base: ${NESSY_DESKTOP_DEV_UPDATE_URL}"
else
  echo "Dev update feed base is not set; configure NESSY_DESKTOP_DEV_UPDATE_URL in CI."
fi
