#!/usr/bin/env bash
set -euo pipefail

dry_run="${NESSY_DESKTOP_DOCS_DRY_RUN:-false}"

usage() {
  cat <<'USAGE'
Usage: bash scripts/publish-docs-dev.sh [--dry-run]

Builds the self-hosted docs site and publishes it to the dev S3 bucket under
the docs/ prefix. --dry-run builds and prints the target without uploading.
USAGE
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --dry-run)
      dry_run=true
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

required_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "ERROR: $name is required" >&2
    exit 1
  fi
}

docs_prefix="${NESSY_DESKTOP_DOCS_PREFIX:-docs}"
docs_prefix="${docs_prefix#/}"
docs_prefix="${docs_prefix%/}"

docs_url="${NESSY_DESKTOP_DOCS_URL:-https://nessy-desktop-releases-dev.s3-msk.tinkoff.ru/${docs_prefix}/index.html}"
build_dir="${NESSY_DESKTOP_DOCS_BUILD_DIR:-docs-site/content/.vitepress/dist}"
npm_registry="${NPM_CONFIG_REGISTRY:-https://artifactory.tcsbank.ru/artifactory/api/npm/npm-all/}"

# CI splits build and upload across images: the build job (node image)
# produces the dist artifact, the publish job (aws image, no node) reuses it
# with NESSY_DESKTOP_DOCS_SKIP_BUILD=true.
if [[ "${NESSY_DESKTOP_DOCS_SKIP_BUILD:-false}" != "true" ]]; then
  if ! command -v npm >/dev/null 2>&1; then
    echo "ERROR: npm is required to build docs-site." >&2
    exit 1
  fi

  if [[ ! -d docs-site/node_modules/vitepress ]]; then
    npm --prefix docs-site ci \
      --registry="$npm_registry" \
      --no-audit \
      --no-fund
  fi

  npm --prefix docs-site run docs:build
fi

if [[ ! -d "$build_dir" ]]; then
  echo "ERROR: docs build directory was not found: $build_dir" >&2
  exit 1
fi

if [[ "$dry_run" == "true" ]]; then
  echo "Docs build ready: $build_dir"
  echo "Docs URL: $docs_url"
  echo "Dry run: skipping S3 upload"
  exit 0
fi

required_env S3_DEV_BUCKET
required_env S3_DEV_ACCESS_KEY
required_env S3_DEV_SECRET_KEY
required_env S3_ENDPOINT

docs_bucket="${NESSY_DESKTOP_DOCS_BUCKET:-$S3_DEV_BUCKET}"

export AWS_ACCESS_KEY_ID="$S3_DEV_ACCESS_KEY"
export AWS_SECRET_ACCESS_KEY="$S3_DEV_SECRET_KEY"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-ru-msk}"
export AWS_EC2_METADATA_DISABLED="${AWS_EC2_METADATA_DISABLED:-true}"

if ! command -v aws >/dev/null 2>&1; then
  echo "ERROR: aws CLI is required to publish docs." >&2
  exit 1
fi

destination="s3://${docs_bucket}/${docs_prefix}/"

echo "Uploading docs to ${destination}"
# Hashed assets/* are excluded here and uploaded by the second pass: a sync
# that already uploaded a key skips it later (same size/mtime), so the
# immutable Cache-Control would never be applied. logo/* is not
# content-hashed, so it stays on the no-cache pass.
aws s3 sync "${build_dir}/" "$destination" \
  --endpoint-url "$S3_ENDPOINT" \
  --delete \
  --exclude "assets/*" \
  --cache-control "no-cache, no-store, must-revalidate" \
  --no-progress

aws s3 sync "${build_dir}/" "$destination" \
  --endpoint-url "$S3_ENDPOINT" \
  --delete \
  --exclude "*" \
  --include "assets/*" \
  --cache-control "public, max-age=31536000, immutable" \
  --no-progress

echo "Docs published: $docs_url"
