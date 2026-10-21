#!/bin/bash
set -e
# P2.275 — `pipefail` is OFF by default, so a pipeline reports its LAST stage's
# status and a failing first stage is invisible: `node -p … | tr` returns 0 when
# `node` dies, and `set -e` never fires. Three values in this script are read out
# of a pipeline, so without this line a failed read becomes an EMPTY variable the
# build then carries — which is the shape of the defect that shipped a packaged
# app against the wrong SDK version with nothing saying so. The pipelines below
# are all short-output (`printf`, `node -p`, `du`), so `pipefail` cannot turn a
# harmless SIGPIPE into a build failure here; the two that could were rewritten
# to use no pipe at all.
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ELECTRON_DIR="$(dirname "$SCRIPT_DIR")"
ROOT_DIR="$(dirname "$(dirname "$ELECTRON_DIR")")"

# Helper function to check required file/directory exists
require_path() {
    local path="$1"
    local description="$2"
    local hint="$3"

    if [ ! -e "$path" ]; then
        echo "ERROR: $description not found at $path"
        [ -n "$hint" ] && echo "$hint"
        exit 1
    fi
}

# Load environment variables from .env
if [ -f "$ROOT_DIR/.env" ]; then
    set -a
    source "$ROOT_DIR/.env"
    set +a
fi

# Parse arguments
ARCH="x64"
UPLOAD=false
UPLOAD_LATEST=false
UPLOAD_SCRIPT=false

show_help() {
    cat << EOF
Usage: build-linux.sh [x64|arm64] [--upload] [--latest] [--script]

Arguments:
  x64|arm64    Target architecture (default: x64)
  --upload     Upload AppImage to S3 after building
  --latest     Also update electron/latest (requires --upload)
  --script     Also upload install-app.sh (requires --upload)

Environment variables (from .env or environment):
  S3_VERSIONS_BUCKET_*      - S3 credentials (for --upload)
EOF
    exit 0
}

while [[ $# -gt 0 ]]; do
    case $1 in
        x64|arm64)     ARCH="$1"; shift ;;
        --upload)      UPLOAD=true; shift ;;
        --latest)      UPLOAD_LATEST=true; shift ;;
        --script)      UPLOAD_SCRIPT=true; shift ;;
        -h|--help)     show_help ;;
        *)
            echo "Unknown option: $1"
            echo "Run with --help for usage"
            exit 1
            ;;
    esac
done

# P6.980 — refuse HERE, before any packaging work, when the update feed is unset.
#
# `apps/electron/electron-builder.yml`'s publish block interpolates both of these
# (`${env.NESSY_DESKTOP_UPDATE_URL}` / `${env.NESSY_DESKTOP_UPDATE_CHANNEL}`), and
# electron-builder expands them at the PACKAGING step — the last one. Measured:
# the whole `.app` is built (about two minutes locally, longer cold) and the run
# then dies with `cannot expand pattern "${env.NESSY_DESKTOP_UPDATE_URL}"`, a
# message that names the variable but not the file, the fix, or the value to use.
# The recipe is documented three times in the tree, so nothing here is invented.
MISSING_UPDATE_VARS=""
if [ -z "${NESSY_DESKTOP_UPDATE_URL:-}" ]; then
    MISSING_UPDATE_VARS="NESSY_DESKTOP_UPDATE_URL"
fi
if [ -z "${NESSY_DESKTOP_UPDATE_CHANNEL:-}" ]; then
    MISSING_UPDATE_VARS="${MISSING_UPDATE_VARS:+$MISSING_UPDATE_VARS, }NESSY_DESKTOP_UPDATE_CHANNEL"
fi
if [ -n "$MISSING_UPDATE_VARS" ]; then
    echo "ERROR: the update feed is not configured: $MISSING_UPDATE_VARS"
    echo ""
    echo "apps/electron/electron-builder.yml's publish block reads both variables, and"
    echo "electron-builder expands them only when it packages - so without this check the"
    echo "build would run for minutes and then die on 'cannot expand pattern'."
    echo ""
    echo "For a local rehearsal (apps/electron/README.md, 'Local unsigned macOS release"
    echo "rehearsal'):"
    echo "  export NESSY_DESKTOP_UPDATE_URL=https://updates.invalid/dev"
    echo "  export NESSY_DESKTOP_UPDATE_CHANNEL=dev"
    echo ""
    echo "Release jobs set NESSY_DESKTOP_UPDATE_URL=\"\$NESSY_DESKTOP_DEV_UPDATE_URL\" and"
    echo "NESSY_DESKTOP_UPDATE_CHANNEL=dev (.gitlab-ci.yml). Either variable may also come"
    echo "from the repo-root .env, which this script sources above."
    exit 1
fi

# Configuration
BUN_VERSION="bun-v1.3.9"  # Pinned version for reproducible builds

echo "=== Building Nessy Desktop AppImage (${ARCH}) using electron-builder ==="
if [ "$UPLOAD" = true ]; then
    echo "Will upload to S3 after build"
fi

# The Claude SDK native binary ships when EITHER flag is on. DO NOT QUOTE ITS
# SIZE AS AN EXPECTATION — this comment has now gone stale four times, and the
# fourth is the one worth reading: it used to say the binary "has grown on every
# bump", and that DIRECTION has since reversed twice. Dated readings on
# darwin-arm64, so the trend is visible rather than a single number that ages:
# 0.3.215 = 247 124 336 B, 0.3.218 = 255 069 680 B, 0.3.223 = 272 553 824 B,
# 0.3.233 = 306 981 408 B (293 MiB) — then 0.3.247 = 233 073 008 B (222 MiB,
# −24 %) and 0.3.251 = 197 171 680 B (188 MiB, a further −15 %; −36 % against
# 0.3.233). Measured 2026-09-17 from the tarballs themselves, three of which are
# still in the bun cache, so the two shrinks are one artefact reading and not an
# inference from a changelog. A monotone expectation in EITHER direction is the
# thing to avoid: the vendor has moved this number both ways inside one month.
# The 50 MB floor below is the ACTUAL guard: it catches a botched copy or the
# wrong tarball, and is deliberately generous so a bump never has to touch it —
# it survived a 36 % shrink without being edited, which is the point of it.
# Read the size the build prints, not a number written here.
# NESSY_FEATURE_PROVIDER_CLAUDE gates the Pro/Max subscription card (which needs
# the runtime) and NESSY_FEATURE_CLAUDE_RUNTIME gates the runtime on its own.
# The runtime defaults ON (owner decision 2026-08-06), so the binary ships
# unless NESSY_FEATURE_CLAUDE_RUNTIME=0 — and even then an explicit
# NESSY_FEATURE_PROVIDER_CLAUDE=1 re-enables it. Mirrors
# isAnthropicBackendEnabled() in packages/shared/src/feature-flags.ts and the
# same gate in build-dmg.sh. Without it a runtime-off Linux build ships a
# binary the factory gate refuses to use (the afterPack hook never deletes a
# staged binary, and electron-builder.yml's Linux include is unconditional).
CLAUDE_ENABLED=1
case "$(printf '%s' "${NESSY_FEATURE_CLAUDE_RUNTIME:-}" | tr '[:upper:]' '[:lower:]')" in
    0|false|no|off) CLAUDE_ENABLED=0 ;;
esac
case "$(printf '%s' "${NESSY_FEATURE_PROVIDER_CLAUDE:-}" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on) CLAUDE_ENABLED=1 ;;
esac
echo "Claude SDK native binary bundle: $([ "$CLAUDE_ENABLED" = "1" ] && echo enabled || echo disabled)"

# 1. Clean previous build artifacts
echo "Cleaning previous builds..."
rm -rf "$ELECTRON_DIR/vendor"
rm -rf "$ELECTRON_DIR/node_modules/@anthropic-ai"
rm -rf "$ELECTRON_DIR/packages"
rm -rf "$ELECTRON_DIR/release"

# 2. Install dependencies
echo "Installing dependencies..."
cd "$ROOT_DIR"
bun install --frozen-lockfile

# 3. Download Bun binary with checksum verification
echo "Downloading Bun ${BUN_VERSION} for linux-${ARCH}..."
mkdir -p "$ELECTRON_DIR/vendor/bun"

# Map architecture names (electron uses x64/arm64, bun uses x64/aarch64)
if [ "$ARCH" = "arm64" ]; then
    BUN_DOWNLOAD="bun-linux-aarch64"
else
    BUN_DOWNLOAD="bun-linux-x64-baseline"
fi

# Create temp directory to avoid race conditions
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

# Download binary and checksums
curl -fSL "https://github.com/oven-sh/bun/releases/download/${BUN_VERSION}/${BUN_DOWNLOAD}.zip" -o "$TEMP_DIR/${BUN_DOWNLOAD}.zip"
curl -fSL "https://github.com/oven-sh/bun/releases/download/${BUN_VERSION}/SHASUMS256.txt" -o "$TEMP_DIR/SHASUMS256.txt"

# Verify checksum
echo "Verifying checksum..."
cd "$TEMP_DIR"
# Use sha256sum on Linux (not shasum)
grep "${BUN_DOWNLOAD}.zip" SHASUMS256.txt | sha256sum -c -
cd - > /dev/null

# Extract and install
unzip -o "$TEMP_DIR/${BUN_DOWNLOAD}.zip" -d "$TEMP_DIR"
cp "$TEMP_DIR/${BUN_DOWNLOAD}/bun" "$ELECTRON_DIR/vendor/bun/"
chmod +x "$ELECTRON_DIR/vendor/bun/bun"

# 4. Copy SDK from root node_modules (monorepo hoisting).
# Since SDK 0.2.113: thin core + per-platform binary package.
# See apps/electron/scripts/build-dmg.sh for the full rationale.
SDK_SOURCE="$ROOT_DIR/node_modules/@anthropic-ai/claude-agent-sdk"
require_path "$SDK_SOURCE" "SDK core" "Run 'bun install' from the repository root first."
echo "Copying SDK core..."
mkdir -p "$ELECTRON_DIR/node_modules/@anthropic-ai"
rm -rf "$ELECTRON_DIR/node_modules/@anthropic-ai/claude-agent-sdk"
cp -r "$SDK_SOURCE" "$ELECTRON_DIR/node_modules/@anthropic-ai/"

# 4a. Resolve the target arch's binary package (cross-fetch from npm if absent).
#     The alias directory is created unconditionally so electron-builder's
#     unconditional `from:` entry always has something to copy; it stays EMPTY
#     when the Claude stack is disabled for this build.
ALIAS_DEST="$ELECTRON_DIR/node_modules/@anthropic-ai/claude-agent-sdk-binary"
rm -rf "$ALIAS_DEST"
mkdir -p "$ALIAS_DEST"
if [ "$CLAUDE_ENABLED" = "1" ]; then
    SDK_BIN_PKG="claude-agent-sdk-linux-${ARCH}"
    SDK_BIN_SOURCE="$ROOT_DIR/node_modules/@anthropic-ai/${SDK_BIN_PKG}"
    if [ ! -d "$SDK_BIN_SOURCE" ]; then
        echo "Cross-arch build: ${SDK_BIN_PKG} not in node_modules — fetching from npm..."
        SDK_VERSION=$(node -p "require('$ROOT_DIR/package.json').dependencies['@anthropic-ai/claude-agent-sdk']" | tr -d '"')
        # P2.275: `pipefail` above makes a failed `node -p` fail the assignment;
        # this catches the other half, a `node` that succeeds and prints nothing.
        if [ -z "$SDK_VERSION" ]; then
            echo "could not read @anthropic-ai/claude-agent-sdk's version from $ROOT_DIR/package.json" >&2
            exit 1
        fi
        PKG_TMP=$(mktemp -d)
        trap "rm -rf $PKG_TMP" RETURN
        (
            cd "$PKG_TMP"
            npm pack "@anthropic-ai/${SDK_BIN_PKG}@${SDK_VERSION}" >/dev/null
            # P2.275: was `TARBALL=$(ls anthropic-ai-*.tgz | head -1)`, whose exit
            # status is head's, so an absent tarball produced an empty name and a
            # `tar` failure two lines later instead of naming its own cause.
            set -- anthropic-ai-*.tgz
            TARBALL="$1"
            if [ ! -f "$TARBALL" ]; then
                echo "npm pack produced no anthropic-ai-*.tgz in $PKG_TMP" >&2
                exit 1
            fi
            tar -xzf "$TARBALL"
        )
        mkdir -p "$SDK_BIN_SOURCE"
        cp -r "$PKG_TMP/package/." "$SDK_BIN_SOURCE/"
    fi

    require_path "$SDK_BIN_SOURCE" "SDK native binary package (${SDK_BIN_PKG})" \
      "Run 'bun install' from the repository root, or check your network for the npm cross-fetch."

    echo "Staging SDK native binary as claude-agent-sdk-binary alias..."
    cp -r "$SDK_BIN_SOURCE/." "$ALIAS_DEST/"
    chmod +x "$ALIAS_DEST/claude"

    BIN_SIZE=$(stat -c%s "$ALIAS_DEST/claude")
    if [ "$BIN_SIZE" -lt 50000000 ]; then
        echo "ERROR: claude binary at $ALIAS_DEST/claude is only ${BIN_SIZE} bytes; the SDK's native binary has been 222-307 MB across every version we have shipped (it SHRANK at 0.3.247 -- 222-242 MB across the eight platform packages, under the 247 this sentence used to claim as a floor), so this is a botched copy or the wrong tarball"
        exit 1
    fi
    echo "  Native binary: $((BIN_SIZE / 1024 / 1024)) MiB"
else
    echo "Skipping Claude SDK native binary (Claude stack disabled)."
fi

# 5. Copy ripgrep (sourced from @vscode/ripgrep since 0.2.113).
#    F1.746: @vscode/ripgrep >=1.17 ships the binary only in its per-platform
#    optional package; the root package's bin/rg is an old-layout leftover (and
#    `bun pm trust` has no script to run, docs/agents/traps.md). The binary of
#    THIS build's arch is staged into the Electron copy, which is the path the
#    packaged resolver reads; the root node_modules tree is never written.
RG_SOURCE="$ROOT_DIR/node_modules/@vscode/ripgrep"
require_path "$RG_SOURCE" "@vscode/ripgrep" "Run 'bun install --frozen-lockfile' first."
RG_PLATFORM_SOURCE="$ROOT_DIR/node_modules/@vscode/ripgrep-linux-${ARCH}/bin/rg"
require_path "$RG_PLATFORM_SOURCE" "platform ripgrep binary" "@vscode/ripgrep optional package is missing for linux-${ARCH}."
echo "Copying @vscode/ripgrep..."
RG_STAGED="$ELECTRON_DIR/node_modules/@vscode/ripgrep"
mkdir -p "$ELECTRON_DIR/node_modules/@vscode"
rm -rf "$RG_STAGED"
cp -r "$RG_SOURCE" "$ELECTRON_DIR/node_modules/@vscode/"
mkdir -p "$RG_STAGED/bin"
cp "$RG_PLATFORM_SOURCE" "$RG_STAGED/bin/rg"
chmod +x "$RG_STAGED/bin/rg"
require_path "$RG_STAGED/bin/rg" "staged ripgrep binary" "copying the linux-${ARCH} ripgrep binary failed."

# 6. Stage the network interceptor and its DERIVED import closure (P6.820) —
#    for the Pi subprocess; Claude no longer uses --preload (Phase 2 will move
#    that to SDK hooks or a local proxy). The three names this loop used to
#    spell by hand were three of SEVEN; `stageInterceptorSources` walks the
#    interceptor's own imports, so no script can carry a short list any more.
echo "Staging interceptor sources (for Pi subprocess)..."
cd "$ROOT_DIR"
NESSY_STAGE_INTERCEPTOR_ROOT_DIR="$ROOT_DIR" \
NESSY_STAGE_INTERCEPTOR_ELECTRON_DIR="$ELECTRON_DIR" \
bun -e 'import { copyInterceptor } from "./scripts/build/common.ts"; copyInterceptor({ rootDir: process.env.NESSY_STAGE_INTERCEPTOR_ROOT_DIR, electronDir: process.env.NESSY_STAGE_INTERCEPTOR_ELECTRON_DIR })'
require_path "$ELECTRON_DIR/packages/shared/src/unified-network-interceptor.ts" "Interceptor" "copyInterceptor did not stage the interceptor."

# Plugin MCPs can declare uvx/python entrypoints. Ship the same verified uv
# runtime on every desktop platform instead of depending on the user's PATH.
echo "Staging uv runtime..."
cd "$ROOT_DIR"
NESSY_STAGE_UV_ARCH="$ARCH" \
NESSY_STAGE_UV_ROOT_DIR="$ROOT_DIR" \
NESSY_STAGE_UV_ELECTRON_DIR="$ELECTRON_DIR" \
bun -e 'import { downloadUv } from "./scripts/build/common.ts"; await downloadUv({ platform: "linux", arch: process.env.NESSY_STAGE_UV_ARCH, upload: false, uploadLatest: false, uploadScript: false, rootDir: process.env.NESSY_STAGE_UV_ROOT_DIR, electronDir: process.env.NESSY_STAGE_UV_ELECTRON_DIR })'
UV_BINARY="$ELECTRON_DIR/resources/bin/linux-${ARCH}/uv"
require_path "$UV_BINARY" "uv binary" "downloadUv did not stage the runtime."

# 7. Build Electron app
echo "Building Electron app..."
cd "$ROOT_DIR"
NESSY_TARGET_PLATFORM=linux NESSY_TARGET_ARCH="$ARCH" bun run electron:build

# 8. Package with electron-builder
echo "Packaging app with electron-builder..."
cd "$ELECTRON_DIR"

# Run electron-builder
# Note: electron-builder may build both archs due to config, but we only use the requested one
npx electron-builder --linux --${ARCH}

# 9. Verify the AppImage was built
# electron-builder uses Linux-style arch names: x86_64 for x64, aarch64 for arm64
if [ "$ARCH" = "x64" ]; then
    LINUX_ARCH="x86_64"
else
    LINUX_ARCH="aarch64"
fi

# electron-builder outputs: NessyDesktop-x86_64.AppImage or NessyDesktop-aarch64.AppImage
BUILT_APPIMAGE_NAME="NessyDesktop-${LINUX_ARCH}.AppImage"
BUILT_APPIMAGE_PATH="$ELECTRON_DIR/release/$BUILT_APPIMAGE_NAME"

if [ ! -f "$BUILT_APPIMAGE_PATH" ]; then
    echo "ERROR: Expected AppImage not found at $BUILT_APPIMAGE_PATH"
    echo "Contents of release directory:"
    ls -la "$ELECTRON_DIR/release/"
    exit 1
fi

# Rename to our standard naming convention: NessyDesktop-x64.AppImage, NessyDesktop-arm64.AppImage
APPIMAGE_NAME="NessyDesktop-${ARCH}.AppImage"
APPIMAGE_PATH="$ELECTRON_DIR/release/$APPIMAGE_NAME"
mv "$BUILT_APPIMAGE_PATH" "$APPIMAGE_PATH"
echo "Renamed $BUILT_APPIMAGE_NAME -> $APPIMAGE_NAME"

# 9b. Gate: same assertion the mac and Windows packagers run. Linux ships no
#     codex binary today (electron-builder.yml's linux includes are commented
#     out while Linux support is paused) and nothing here signs anything, so
#     this is the no-op leg — it exists to keep "no codex-app-server smuggled
#     into a Linux artifact" an assertion rather than an assumption, and it
#     turns into a real check the moment the linux includes come back.
#     Both candidate output roots are passed because electron-builder resolves
#     directories.output against the project dir, not this script's guess.
echo "Verifying no unpinned codex binary rode along..."
(cd "$ROOT_DIR" && bun scripts/build/codex-integrity.ts \
    "$ROOT_DIR/release" "$ELECTRON_DIR/release" --forbid-app-server)

echo ""
echo "=== Build Complete ==="
echo "AppImage: $ELECTRON_DIR/release/${APPIMAGE_NAME}"
echo "Size: $(du -h "$ELECTRON_DIR/release/${APPIMAGE_NAME}" | cut -f1)"

# 10. Create manifest.json for upload script
# Read version from package.json
# P2.275: was `cat … | grep … | head -1 | sed …`, whose exit status is sed's, so
# a missing or renamed key wrote `{"version": ""}` into the upload manifest and
# said nothing. `node -p` is one command with one status, and `pipefail` would
# have made the old four-stage form SIGPIPE-fragile on `head -1` besides.
ELECTRON_VERSION=$(node -p "require('$ELECTRON_DIR/package.json').version")
if [ -z "$ELECTRON_VERSION" ]; then
    echo "could not read the version from $ELECTRON_DIR/package.json" >&2
    exit 1
fi
echo "Creating manifest.json (version: $ELECTRON_VERSION)..."
mkdir -p "$ROOT_DIR/.build/upload"
echo "{\"version\": \"$ELECTRON_VERSION\"}" > "$ROOT_DIR/.build/upload/manifest.json"

# 11. Upload to S3 (if --upload flag is set)
if [ "$UPLOAD" = true ]; then
    echo ""
    echo "=== Uploading to S3 ==="

    # Check for S3 credentials
    if [ -z "$S3_VERSIONS_BUCKET_ENDPOINT" ] || [ -z "$S3_VERSIONS_BUCKET_ACCESS_KEY_ID" ] || [ -z "$S3_VERSIONS_BUCKET_SECRET_ACCESS_KEY" ]; then
        cat << EOF
ERROR: Missing S3 credentials. Set these environment variables:
  S3_VERSIONS_BUCKET_ENDPOINT
  S3_VERSIONS_BUCKET_ACCESS_KEY_ID
  S3_VERSIONS_BUCKET_SECRET_ACCESS_KEY

You can add them to .env or export them directly.
EOF
        exit 1
    fi

    # Build upload flags
    UPLOAD_FLAGS="--electron"
    [ "$UPLOAD_LATEST" = true ] && UPLOAD_FLAGS="$UPLOAD_FLAGS --latest"
    [ "$UPLOAD_SCRIPT" = true ] && UPLOAD_FLAGS="$UPLOAD_FLAGS --script"

    cd "$ROOT_DIR"
    bun run scripts/upload.ts $UPLOAD_FLAGS

    echo ""
    echo "=== Upload Complete ==="
fi
