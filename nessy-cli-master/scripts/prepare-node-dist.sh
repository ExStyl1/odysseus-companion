#!/usr/bin/env bash

# Script to download Node.js distributions for S3 upload
# Downloads all required platforms for the specified version

set -euo pipefail

NODE_VERSION="${1:-22.22.2}"
OUTPUT_DIR="${2:-./nodejs-dists}"

echo "Downloading Node.js v${NODE_VERSION} distributions..."
mkdir -p "${OUTPUT_DIR}"

PLATFORMS=(
    "darwin-arm64:tar.gz"
    "darwin-x64:tar.gz"
    "linux-arm64:tar.xz"
    "linux-x64:tar.xz"
    "win-x64:zip"
)

BASE_URL="https://nodejs.org/dist/v${NODE_VERSION}"

for platform in "${PLATFORMS[@]}"; do
    IFS=':' read -r arch extension <<< "$platform"
    filename="node-v${NODE_VERSION}-${arch}.${extension}"
    url="${BASE_URL}/${filename}"
    
    echo "Downloading ${filename}..."
    curl -fsSL "${url}" -o "${OUTPUT_DIR}/${filename}"
done

echo "Downloading SHASUMS256.txt..."
curl -fsSL "${BASE_URL}/SHASUMS256.txt" -o "${OUTPUT_DIR}/SHASUMS256.txt"

echo ""
echo "✅ All distributions downloaded to ${OUTPUT_DIR}/"
echo ""
echo "Files:"
ls -lh "${OUTPUT_DIR}/"
echo ""
echo "To upload to S3:"
echo "  s3cmd put ${OUTPUT_DIR}/* s3://nestor-companion/nodejs-releases/"
