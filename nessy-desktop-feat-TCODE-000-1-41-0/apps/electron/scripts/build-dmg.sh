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

# Sync secrets from 1Password if CLI is available
if command -v op &> /dev/null; then
    echo "1Password CLI detected, syncing secrets..."
    cd "$ROOT_DIR"
    if bun run sync-secrets 2>/dev/null; then
        echo "Secrets synced from 1Password"
    else
        echo "Warning: Failed to sync secrets from 1Password (continuing with existing .env if present)"
    fi
fi

# Load environment variables from .env
if [ -f "$ROOT_DIR/.env" ]; then
    set -a
    source "$ROOT_DIR/.env"
    set +a
fi

# Parse arguments
ARCH="arm64"
UPLOAD=false
UPLOAD_LATEST=false
UPLOAD_SCRIPT=false

show_help() {
    cat << EOF
Usage: build-dmg.sh [arm64|x64] [--upload] [--latest] [--script]

Arguments:
  arm64|x64    Target architecture (default: arm64)
  --upload     Upload DMG to S3 after building
  --latest     Also update electron/latest (requires --upload)
  --script     Also upload install-app.sh (requires --upload)

Environment variables (from .env or environment):
  APPLE_SIGNING_IDENTITY    - Code signing identity
  APPLE_ID                  - Apple ID for notarization
  APPLE_TEAM_ID             - Apple Team ID
  APPLE_APP_SPECIFIC_PASSWORD - App-specific password
  S3_VERSIONS_BUCKET_*      - S3 credentials (for --upload)
EOF
    exit 0
}

while [[ $# -gt 0 ]]; do
    case $1 in
        arm64|x64)     ARCH="$1"; shift ;;
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

echo "=== Building Nessy Desktop DMG (${ARCH}) using electron-builder ==="
if [ "$UPLOAD" = true ]; then
    echo "Will upload to S3 after build"
fi

# Codex ships whenever this build enables the codex runtime — the SAME flag
# baked into the app (NESSY_FEATURE_CODEX_RUNTIME, see feature-flags.ts +
# electron-build-main.ts). Default ON (owner decision 2026-08-06: coding
# runtimes ship by default; only subscription cards stay flag-gated) —
# NESSY_FEATURE_CODEX_RUNTIME=0 builds without the ~200MB codex-app-server.
CODEX_ENABLED=1
case "$(printf '%s' "${NESSY_FEATURE_CODEX_RUNTIME:-}" | tr '[:upper:]' '[:lower:]')" in
    0|false|no|off) CODEX_ENABLED=0 ;;
esac
echo "Codex runtime bundle: $([ "$CODEX_ENABLED" = "1" ] && echo enabled || echo disabled)"

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
# NESSY_FEATURE_PROVIDER_CLAUDE=1 re-enables it (the subscription card cannot
# work without the runtime). Mirrors isAnthropicBackendEnabled() in
# packages/shared/src/feature-flags.ts and the same gate in build-linux.sh /
# build-win.ps1.
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
rm -rf "$ROOT_DIR/release"

# 2. Install dependencies
echo "Installing dependencies..."
cd "$ROOT_DIR"
bun install --frozen-lockfile

# 3. Download Bun binary with checksum verification
echo "Downloading Bun ${BUN_VERSION} for darwin-${ARCH}..."
mkdir -p "$ELECTRON_DIR/vendor/bun"
BUN_DOWNLOAD="bun-darwin-$([ "$ARCH" = "arm64" ] && echo "aarch64" || echo "x64")"

# Create temp directory to avoid race conditions
TEMP_DIR=$(mktemp -d)
cleanup() {
    rm -rf "$TEMP_DIR" "${BUILDER_CONFIG:-}"
}
trap cleanup EXIT

# Download binary and checksums
BUN_DOWNLOAD_BASE_URL="${BUN_DOWNLOAD_BASE_URL:-https://github.com/oven-sh/bun/releases/download/${BUN_VERSION}}"
curl -fSL "${BUN_DOWNLOAD_BASE_URL}/${BUN_DOWNLOAD}.zip" -o "$TEMP_DIR/${BUN_DOWNLOAD}.zip"
curl -fSL "${BUN_DOWNLOAD_BASE_URL}/SHASUMS256.txt" -o "$TEMP_DIR/SHASUMS256.txt"

# Verify checksum
echo "Verifying checksum..."
cd "$TEMP_DIR"
grep "${BUN_DOWNLOAD}.zip" SHASUMS256.txt | shasum -a 256 -c -
cd - > /dev/null

# Extract and install
unzip -o "$TEMP_DIR/${BUN_DOWNLOAD}.zip" -d "$TEMP_DIR"
cp "$TEMP_DIR/${BUN_DOWNLOAD}/bun" "$ELECTRON_DIR/vendor/bun/"
chmod +x "$ELECTRON_DIR/vendor/bun/bun"

# 4. Copy SDK from root node_modules (monorepo hoisting)
# Note: The SDK is hoisted to root node_modules by the package manager.
# We copy it here because electron-builder only sees apps/electron/.
#
# Since SDK 0.2.113 the SDK split into a thin core + per-platform binary
# package. We bundle:
#   1. The core (`claude-agent-sdk`) — universal sdk.mjs + types.
#   2. The matching arch's binary package, copied to a stable alias path
#      `claude-agent-sdk-binary/` so the electron-builder.yml entry stays
#      arch-agnostic and the runtime resolver finds it regardless of host
#      arch at build time.
SDK_SOURCE="$ROOT_DIR/node_modules/@anthropic-ai/claude-agent-sdk"
require_path "$SDK_SOURCE" "SDK core" "Run 'bun install' from the repository root first."
echo "Copying SDK core..."
mkdir -p "$ELECTRON_DIR/node_modules/@anthropic-ai"
rm -rf "$ELECTRON_DIR/node_modules/@anthropic-ai/claude-agent-sdk"
cp -r "$SDK_SOURCE" "$ELECTRON_DIR/node_modules/@anthropic-ai/"

# 4a. Resolve the target arch's binary package. If the host arch matches the
#     target, bun install already placed it in node_modules/@anthropic-ai/.
#     Otherwise, fetch and unpack the matching tarball directly via npm.
ALIAS_DEST="$ELECTRON_DIR/node_modules/@anthropic-ai/claude-agent-sdk-binary"
rm -rf "$ALIAS_DEST"
mkdir -p "$ALIAS_DEST"
if [ "$CLAUDE_ENABLED" = "1" ]; then
    SDK_BIN_PKG="claude-agent-sdk-darwin-${ARCH}"
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

    # Sanity check: only a floor, and only against a botched copy / wrong
    # tarball. The expected size is whatever this build prints — see the header.
    BIN_SIZE=$(stat -f%z "$ALIAS_DEST/claude" 2>/dev/null || stat -c%s "$ALIAS_DEST/claude")
    if [ "$BIN_SIZE" -lt 50000000 ]; then
        echo "ERROR: claude binary at $ALIAS_DEST/claude is only ${BIN_SIZE} bytes; the SDK's native binary has been 222-307 MB across every version we have shipped (it SHRANK at 0.3.247 -- 222-242 MB across the eight platform packages, under the 247 this sentence used to claim as a floor), so this is a botched copy or the wrong tarball"
        exit 1
    fi
    echo "  Native binary: $((BIN_SIZE / 1024 / 1024)) MiB"
else
    echo "Skipping Claude SDK native binary (Claude stack disabled)."
fi

# 4b. Fetch + SHA-verify the bundled codex-app-server for this build's arch.
#     Ships under resources/bin/codex/darwin-${ARCH}/ (electron-builder `files`).
#     Skipped entirely when the codex runtime is disabled for this build.
if [ "$CODEX_ENABLED" = "1" ]; then
    echo "Fetching codex-app-server for darwin-${ARCH}..."
    node "$ROOT_DIR/scripts/fetch-codex.mjs" --target="darwin-${ARCH}"
    CODEX_BIN="$ELECTRON_DIR/resources/bin/codex/darwin-${ARCH}/codex-app-server"
    require_path "$CODEX_BIN" "codex-app-server (darwin-${ARCH})" "scripts/fetch-codex.mjs failed — check network / manifest pin."
    CODEX_SIZE=$(stat -f%z "$CODEX_BIN" 2>/dev/null || stat -c%s "$CODEX_BIN")
    if [ "$CODEX_SIZE" -lt 20000000 ]; then
        echo "ERROR: codex-app-server at $CODEX_BIN is only ${CODEX_SIZE} bytes (expected ~50-210 MB)"
        exit 1
    fi
    echo "  codex-app-server: $((CODEX_SIZE / 1024 / 1024)) MiB"
    # F1.1216 — codex's own code-mode host, from the same archive. codex looks for
    # it beside its own executable; without it every code_mode_only model has no
    # tools. Like the app-server it keeps OpenAI's signature (mac.signIgnore
    # covers resources/bin/codex/) — re-signing would also drop the JIT
    # entitlements V8 needs — and the codex-integrity gate below requires it.
    require_path "$(dirname "$CODEX_BIN")/codex-code-mode-host" "codex-code-mode-host (darwin-${ARCH})" "scripts/fetch-codex.mjs failed — check network / manifest pin."
else
    echo "Skipping codex-app-server bundle (codex runtime disabled)."
fi

# 5. Copy ripgrep (was previously bundled inside the SDK at vendor/ripgrep/;
#    moved out in 0.2.113. Search service still needs the binary directly.)
#    F1.746: @vscode/ripgrep >=1.17 ships the binary only in its per-platform
#    optional package; the root package's bin/rg is an old-layout leftover (and
#    `bun pm trust` has no script to run, docs/agents/traps.md). The binary of
#    THIS build's arch is staged into the Electron copy, which is the path the
#    packaged resolver reads; the root node_modules tree is never written.
RG_SOURCE="$ROOT_DIR/node_modules/@vscode/ripgrep"
require_path "$RG_SOURCE" "@vscode/ripgrep" "Run 'bun install --frozen-lockfile' first."
RG_PLATFORM_SOURCE="$ROOT_DIR/node_modules/@vscode/ripgrep-darwin-${ARCH}/bin/rg"
require_path "$RG_PLATFORM_SOURCE" "platform ripgrep binary" "@vscode/ripgrep optional package is missing for darwin-${ARCH}."
echo "Copying @vscode/ripgrep..."
RG_STAGED="$ELECTRON_DIR/node_modules/@vscode/ripgrep"
mkdir -p "$ELECTRON_DIR/node_modules/@vscode"
rm -rf "$RG_STAGED"
cp -r "$RG_SOURCE" "$ELECTRON_DIR/node_modules/@vscode/"
mkdir -p "$RG_STAGED/bin"
cp "$RG_PLATFORM_SOURCE" "$RG_STAGED/bin/rg"
chmod +x "$RG_STAGED/bin/rg"
require_path "$RG_STAGED/bin/rg" "staged ripgrep binary" "copying the darwin-${ARCH} ripgrep binary failed."

# 6. Stage the network interceptor and its DERIVED import closure (P6.820).
#    NOTE (Phase 1 of SDK uplift): the Claude native binary doesn't accept
#    Bun's --preload, so the Claude code path no longer uses these. They're
#    still needed for the **Pi** subprocess (runs on Bun, accepts --preload).
#    Phase 2 will reintroduce equivalent functionality for Claude via SDK
#    hooks or a local proxy.
#
#    The three names this loop used to spell by hand were three of SEVEN: the
#    closure is walked from the interceptor's own imports by
#    `stageInterceptorSources`, so it cannot go short again in one script and
#    not the others. Called the way `downloadUv` below already is.
echo "Staging interceptor sources (for Pi subprocess)..."
cd "$ROOT_DIR"
NESSY_STAGE_INTERCEPTOR_ROOT_DIR="$ROOT_DIR" \
NESSY_STAGE_INTERCEPTOR_ELECTRON_DIR="$ELECTRON_DIR" \
bun -e 'import { copyInterceptor } from "./scripts/build/common.ts"; copyInterceptor({ rootDir: process.env.NESSY_STAGE_INTERCEPTOR_ROOT_DIR, electronDir: process.env.NESSY_STAGE_INTERCEPTOR_ELECTRON_DIR })'
require_path "$ELECTRON_DIR/packages/shared/src/unified-network-interceptor.ts" "Interceptor" "copyInterceptor did not stage the interceptor."

# 6. Stage uv runtime for document tools.
echo "Staging uv runtime..."
cd "$ROOT_DIR"
NESSY_STAGE_UV_ARCH="$ARCH" \
NESSY_STAGE_UV_ROOT_DIR="$ROOT_DIR" \
NESSY_STAGE_UV_ELECTRON_DIR="$ELECTRON_DIR" \
bun -e 'import { downloadUv } from "./scripts/build/common.ts"; await downloadUv({ platform: "darwin", arch: process.env.NESSY_STAGE_UV_ARCH, upload: false, uploadLatest: false, uploadScript: false, rootDir: process.env.NESSY_STAGE_UV_ROOT_DIR, electronDir: process.env.NESSY_STAGE_UV_ELECTRON_DIR })'
UV_BINARY="$ELECTRON_DIR/resources/bin/darwin-${ARCH}/uv"
require_path "$UV_BINARY" "uv binary" "downloadUv did not stage the runtime."

# 7. Build Electron app
echo "Building Electron app..."
cd "$ROOT_DIR"
NESSY_TARGET_PLATFORM=darwin NESSY_TARGET_ARCH="$ARCH" bun run electron:build

# 8. Package with electron-builder
echo "Packaging app with electron-builder..."
cd "$ELECTRON_DIR"

# Set up environment for electron-builder
export CSC_IDENTITY_AUTO_DISCOVERY="${CSC_IDENTITY_AUTO_DISCOVERY:-true}"

# Build electron-builder arguments
BUILDER_ARGS="--mac --${ARCH}"
BUILDER_CONFIG="$ELECTRON_DIR/.electron-builder.${ARCH}.yml"
# UA12.22 — an unsigned build stays loadable on arm64 without anything here: electron-builder.yml's
# electronFuses.resetAdHocDarwinSignature re-signs the .app ad-hoc right after the fuse flip, for every path.
ruby -ryaml -e 'config = YAML.load_file(ARGV[0]); config.fetch("mac").fetch("target").each { |target| target["arch"] = [ARGV[2]] }; ((config.fetch("mac")["files"] ||= []) << "resources/bin/codex/darwin-#{ARGV[2]}/**/*") if ARGV[3] == "1"; File.write(ARGV[1], config.to_yaml)' \
    "$ELECTRON_DIR/electron-builder.yml" "$BUILDER_CONFIG" "$ARCH" "$CODEX_ENABLED"

# Add code signing if identity is available
if [ -n "$APPLE_SIGNING_IDENTITY" ]; then
    # Strip "Developer ID Application: " prefix if present (electron-builder adds it automatically)
    CSC_NAME_CLEAN="${APPLE_SIGNING_IDENTITY#Developer ID Application: }"
    echo "Using signing identity: $CSC_NAME_CLEAN"
    export CSC_NAME="$CSC_NAME_CLEAN"
fi

# Add notarization if all credentials are available
if [ -n "$APPLE_ID" ] && [ -n "$APPLE_TEAM_ID" ] && [ -n "$APPLE_APP_SPECIFIC_PASSWORD" ]; then
    echo "Notarization enabled"
    export APPLE_ID="$APPLE_ID"
    export APPLE_TEAM_ID="$APPLE_TEAM_ID"
    export APPLE_APP_SPECIFIC_PASSWORD="$APPLE_APP_SPECIFIC_PASSWORD"

    # Enable notarization in electron-builder by setting env vars
    # The electron-builder.yml has notarize section commented out,
    # but we can enable it via environment
    export NOTARIZE=true
fi

# Run electron-builder
npx electron-builder --config "$BUILDER_CONFIG" $BUILDER_ARGS

# 9. Verify the DMG and updater ZIP were built
ELECTRON_VERSION=$(node -p "require('$ELECTRON_DIR/package.json').version")
OS_NAME="mac"
DMG_NAME="NessyDesktop-${ELECTRON_VERSION}-${OS_NAME}-${ARCH}.dmg"
ZIP_NAME="NessyDesktop-${ELECTRON_VERSION}-${OS_NAME}-${ARCH}.zip"
RELEASE_DIR="$ROOT_DIR/release"
DMG_PATH="$RELEASE_DIR/$DMG_NAME"
ZIP_PATH="$RELEASE_DIR/$ZIP_NAME"

if [ ! -f "$DMG_PATH" ]; then
    echo "ERROR: Expected DMG not found at $DMG_PATH"
    echo "Contents of release directory:"
    ls -la "$RELEASE_DIR/"
    exit 1
fi

if [ ! -f "$ZIP_PATH" ]; then
    echo "ERROR: Expected updater ZIP not found at $ZIP_PATH"
    echo "Contents of release directory:"
    ls -la "$RELEASE_DIR/"
    exit 1
fi

# 9b. Gate: the codex binary INSIDE the packaged (and, when credentials were
#     present, signed + notarized) app must still satisfy the runtime SHA pin.
#     Signed 1.25.0 shipped a binary that could never spawn because signing
#     rewrote the Mach-O after the fetch-time check; an unsigned local build is
#     byte-identical to upstream, so nothing before this ran against the
#     artifact users actually install. See scripts/build/codex-integrity.ts.
echo "Verifying the packaged codex-app-server still matches its manifest pin..."
if [ "$CODEX_ENABLED" = "1" ]; then
    CODEX_GATE_ARGS="--require=darwin-${ARCH}"
else
    CODEX_GATE_ARGS="--forbid-app-server"
fi
(cd "$ROOT_DIR" && bun scripts/build/codex-integrity.ts "$RELEASE_DIR" $CODEX_GATE_ARGS)

echo ""
echo "=== Build Complete ==="
echo "DMG: $DMG_PATH"
echo "ZIP: $ZIP_PATH"
echo "DMG Size: $(du -h "$DMG_PATH" | cut -f1)"
echo "ZIP Size: $(du -h "$ZIP_PATH" | cut -f1)"

# 10. Create manifest.json for upload script
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
