#!/bin/bash

set -e

VERSIONS_URL="https://s3-msk.tinkoff.ru/nestor-companion/nessy-cli/desktop"
DOWNLOAD_DIR="$HOME/.craft-agent/downloads"
REQUESTED_VERSION=""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m' # No Color

info() { printf "%b\n" "${BLUE}>${NC} $1"; }
success() { printf "%b\n" "${GREEN}>${NC} $1"; }
warn() { printf "%b\n" "${YELLOW}!${NC} $1"; }
error() { printf "%b\n" "${RED}x${NC} $1"; exit 1; }

usage() {
    echo "Usage: $(basename "$0") [--version <version>]"
}

while [ $# -gt 0 ]; do
    case "$1" in
        --version|-v)
            [ -n "${2:-}" ] || { usage; exit 1; }
            REQUESTED_VERSION="$2"
            shift 2
            ;;
        --version=*)
            REQUESTED_VERSION="${1#--version=}"
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            if [ -z "$REQUESTED_VERSION" ]; then
                REQUESTED_VERSION="$1"
                shift
            else
                usage
                exit 1
            fi
            ;;
    esac
done

# Detect OS
OS="$(uname -s)"
case "$OS" in
    Darwin) OS_TYPE="darwin" ;;
    Linux)  OS_TYPE="linux" ;;
    *)      error "Unsupported operating system: $OS" ;;
esac

# Check for required dependencies
# Prefer system curl to avoid Anaconda's curl which may have certificate issues
DOWNLOADER=""
if [ -x "/usr/bin/curl" ]; then
    DOWNLOADER="/usr/bin/curl"
elif [ -x "/bin/curl" ]; then
    DOWNLOADER="/bin/curl"
elif command -v curl >/dev/null 2>&1; then
    DOWNLOADER="curl"
elif command -v wget >/dev/null 2>&1; then
    DOWNLOADER="wget"
else
    error "Either curl or wget is required but neither is installed"
fi

# Download function that works with both curl and wget
# Usage: download_file <url> [output_file] [show_progress]
download_file() {
    local url="$1"
    local output="$2"
    local show_progress="${3:-false}"

    if [[ "$DOWNLOADER" == *curl ]]; then
        if [ -n "$output" ]; then
            if [ "$show_progress" = "true" ]; then
                "$DOWNLOADER" -fL --progress-bar -o "$output" "$url"
            else
                "$DOWNLOADER" -fsSL -o "$output" "$url"
            fi
        else
            "$DOWNLOADER" -fsSL "$url"
        fi
    elif [ "$DOWNLOADER" = "wget" ]; then
        if [ -n "$output" ]; then
            if [ "$show_progress" = "true" ]; then
                wget --show-progress -q -O "$output" "$url"
            else
                wget -q -O "$output" "$url"
            fi
        else
            wget -q -O - "$url"
        fi
    else
        return 1
    fi
}

# Extract filename, sha512, and size from YAML for a specific artifact.
# YAML may include arch fields, or only urls like x64.exe / arm64.zip.
get_entry_from_yaml() {
    local yaml="$1"
    local target_arch="$2"
    local target_ext="$3"
    local arch_token="$target_arch"

    if [ "$target_ext" = "AppImage" ] && [ "$target_arch" = "x64" ]; then
        arch_token="x86_64"
    fi

    local current_url=""
    local current_sha512=""
    local current_size=""
    local current_arch=""

    maybe_print_entry() {
        [ -n "$current_url" ] || return 1
        [ -n "$current_sha512" ] || return 1

        if [ "$current_arch" = "$target_arch" ] || [[ "$current_url" == *"$arch_token"*."$target_ext" ]]; then
            printf '%s|%s|%s\n' "$current_url" "$current_sha512" "$current_size"
            return 0
        fi

        return 1
    }

    while IFS= read -r line; do
        if [[ $line =~ ^[[:space:]]*-[[:space:]]*url:[[:space:]]*(.+) ]]; then
            if maybe_print_entry; then
                return 0
            fi
            current_url="${BASH_REMATCH[1]}"
            current_sha512=""
            current_size=""
            current_arch=""
        fi
        if [[ $line =~ sha512:[[:space:]]*(.+) ]]; then
            current_sha512="${BASH_REMATCH[1]}"
        fi
        if [[ $line =~ size:[[:space:]]*([0-9]+) ]]; then
            current_size="${BASH_REMATCH[1]}"
        fi
        if [[ $line =~ arch:[[:space:]]*(.+) ]]; then
            current_arch="${BASH_REMATCH[1]}"
        fi
    done <<< "$yaml"

    maybe_print_entry
}

# Detect architecture
case "$(uname -m)" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) error "Unsupported architecture: $(uname -m)" ;;
esac

# Set platform-specific variables
if [ "$OS_TYPE" = "darwin" ]; then
    platform="darwin-${arch}"
    APP_NAME="Nessy CLI Desktop.app"
    INSTALL_DIR="/Applications"
    ext="zip"
else
    # Linux only supports x64 currently
    if [ "$arch" != "x64" ]; then
        error "Linux currently only supports x64 architecture. Your architecture: $arch"
    fi
    platform="linux-${arch}"
    APP_NAME="Nessy-CLI-Desktop-x64.AppImage"
    INSTALL_DIR="$HOME/.local/bin"
    ext="AppImage"
fi

release_path="latest"
manifest_prefix="latest"
if [ -n "$REQUESTED_VERSION" ]; then
    release_path="$REQUESTED_VERSION"
    if [[ "$REQUESTED_VERSION" == *beta* ]]; then
        manifest_prefix="beta"
    fi
fi

if [ "$OS_TYPE" = "darwin" ]; then
    yml_file="${manifest_prefix}-mac.yml"
else
    yml_file="${manifest_prefix}-linux.yml"
fi

echo ""
info "Detected platform: $platform"

mkdir -p "$DOWNLOAD_DIR"
mkdir -p "$INSTALL_DIR"

# Fetch YAML manifest from latest or a versioned release directory.
info "Fetching release info from $release_path/$yml_file..."
manifest_yaml=$(download_file "$VERSIONS_URL/$release_path/$yml_file")

if [ -z "$manifest_yaml" ]; then
    error "Failed to fetch release info from $yml_file"
fi

# [nessy-fork] installer-manifest-grep-only
# Extract version from YAML manifest
version=$(echo "$manifest_yaml" | grep -m1 '^version:' | sed 's/^version:[[:space:]]*//')

if [ -z "$version" ]; then
    error "Failed to extract version from manifest"
fi

info "Version: $version"

entry=$(get_entry_from_yaml "$manifest_yaml" "$arch" "$ext" || true)
IFS='|' read -r filename checksum fileSize <<< "$entry"

# Validate checksum format (SHA512 base64 = 88 characters)
if [ -z "$checksum" ] || [ ${#checksum} -lt 80 ]; then
    error "Architecture $arch not found in $yml_file"
fi

# Use default filename if not found
if [ -z "$filename" ]; then
    filename="Nessy-CLI-Desktop-${arch}.${ext}"
fi

info "Expected sha512: ${checksum:0:20}..."

# Download installer
installer_url="$VERSIONS_URL/$release_path/$filename"
installer_path="$DOWNLOAD_DIR/$filename"

info "Downloading $filename..."
echo ""
if ! download_file "$installer_url" "$installer_path" true; then
    rm -f "$installer_path"
    error "Download failed"
fi
echo ""

# Verify checksum (sha512, base64 encoded)
info "Verifying checksum..."
if [ "$OS_TYPE" = "darwin" ]; then
    # macOS: shasum outputs hex, convert to base64
    actual=$(shasum -a 512 "$installer_path" | cut -d' ' -f1 | xxd -r -p | base64)
else
    # Linux: sha512sum outputs hex, convert to base64
    actual=$(sha512sum "$installer_path" | cut -d' ' -f1 | xxd -r -p | base64 | tr -d '\n')
fi

if [ "$actual" != "$checksum" ]; then
    rm -f "$installer_path"
    error "Checksum verification failed\n  Expected: $checksum\n  Actual:   $actual"
fi

success "Checksum verified!"

# Platform-specific installation
if [ "$OS_TYPE" = "darwin" ]; then
    # macOS installation (from ZIP)
    zip_path="$installer_path"
    EXPECTED_TEAM_ID="__MACOS_EXPECTED_TEAM_ID__"
    EXPECTED_BUNDLE_ID="__MACOS_EXPECTED_BUNDLE_ID__"

    # Quit the app if it's running (use bundle ID for reliability)
    APP_BUNDLE_ID="$EXPECTED_BUNDLE_ID"
    is_app_running() {
        [ "$(osascript -e "application id \"$APP_BUNDLE_ID\" is running" 2>/dev/null || echo false)" = "true" ]
    }

    if is_app_running; then
        info "Quitting Nessy CLI Desktop..."
        osascript -e "tell application id \"$APP_BUNDLE_ID\" to quit" 2>/dev/null || true
        # Wait for app to quit (max 5 seconds) - POSIX compatible loop
        i=0
        while [ $i -lt 10 ]; do
            if ! is_app_running; then
                break
            fi
            sleep 0.5
            i=$((i + 1))
        done
        # Force kill if still running
        if is_app_running; then
            warn "App didn't quit gracefully. Force quitting (unsaved data may be lost)..."
            pkill -9 -f "Nessy CLI Desktop.app" 2>/dev/null || true
            pkill -9 -f "Nessy CLI.app" 2>/dev/null || true
            # Wait longer for macOS to release file handles
            sleep 3
        fi
    fi

    # Extract ZIP to temp directory
    info "Extracting..."
    temp_dir=$(mktemp -d)
    if ! /usr/bin/ditto -x -k "$zip_path" "$temp_dir"; then
        rm -rf "$temp_dir"
        rm -f "$zip_path"
        error "Failed to extract ZIP"
    fi

    # Find the .app in the extracted contents
    app_source=$(find "$temp_dir" -maxdepth 1 -name "*.app" -type d | head -1)

    if [ -z "$app_source" ]; then
        rm -rf "$temp_dir"
        rm -f "$zip_path"
        error "No .app found in ZIP"
    fi

    info "Verifying Developer ID signature..."
    if ! /usr/bin/codesign --verify --deep --strict --verbose=2 "$app_source"; then
        rm -rf "$temp_dir"
        rm -f "$zip_path"
        error "App code signature verification failed"
    fi

    signature_info=$(/usr/bin/codesign -d -vvv "$app_source" 2>&1)
    team_id=$(printf '%s\n' "$signature_info" | sed -n 's/^TeamIdentifier=//p' | head -1)
    bundle_id=$(printf '%s\n' "$signature_info" | sed -n 's/^Identifier=//p' | head -1)
    if [ "$team_id" != "$EXPECTED_TEAM_ID" ] || [ "$bundle_id" != "$EXPECTED_BUNDLE_ID" ]; then
        rm -rf "$temp_dir"
        rm -f "$zip_path"
        error "Unexpected app publisher or bundle identifier"
    fi

    if ! /usr/sbin/spctl --assess --type execute --verbose=2 "$app_source"; then
        rm -rf "$temp_dir"
        rm -f "$zip_path"
        error "App failed Gatekeeper assessment"
    fi

    # Do not remove a working installation until the replacement is trusted.
    if [ -d "$INSTALL_DIR/$APP_NAME" ]; then
        info "Removing previous installation..."
        rm -rf "$INSTALL_DIR/$APP_NAME"
    fi
    if [ -d "$INSTALL_DIR/Nessy CLI.app" ]; then
        info "Removing previous Nessy CLI installation..."
        rm -rf "$INSTALL_DIR/Nessy CLI.app"
    fi

    # Copy app to /Applications
    info "Installing to $INSTALL_DIR..."
    cp -R "$app_source" "$INSTALL_DIR/$APP_NAME"

    # Clean up
    info "Cleaning up..."
    rm -rf "$temp_dir"
    rm -f "$zip_path"

    echo ""
    echo "─────────────────────────────────────────────────────────────────────────"
    echo ""
    success "Installation complete!"
    echo ""
    printf "%b\n" "  Nessy CLI Desktop has been installed to ${BOLD}$INSTALL_DIR/$APP_NAME${NC}"
    echo ""
    printf "%b\n" "  You can launch it from ${BOLD}Applications${NC} or by running:"
    printf "%b\n" "    ${BOLD}open -a 'Nessy CLI Desktop'${NC}"
    echo ""

else
    # Linux installation
    appimage_path="$installer_path"

    # New paths
    APP_DIR="$HOME/.craft-agent/app"
    WRAPPER_PATH="$INSTALL_DIR/nessy-cli"
    APPIMAGE_INSTALL_PATH="$APP_DIR/Nessy-CLI-Desktop-x64.AppImage"

    # Kill the app if it's running
    if pgrep -f "Nessy-CLI.*AppImage" >/dev/null 2>&1; then
        info "Stopping Nessy CLI Desktop..."
        pkill -f "Nessy-CLI.*AppImage" 2>/dev/null || true
        sleep 2
    fi

    # Create directories
    mkdir -p "$APP_DIR"
    mkdir -p "$INSTALL_DIR"

    # Remove existing AppImage
    [ -f "$APPIMAGE_INSTALL_PATH" ] && rm -f "$APPIMAGE_INSTALL_PATH"
    [ -f "$APP_DIR/Nessy-CLI-x64.AppImage" ] && rm -f "$APP_DIR/Nessy-CLI-x64.AppImage"

    # Install AppImage
    info "Installing AppImage to $APP_DIR..."
    mv "$appimage_path" "$APPIMAGE_INSTALL_PATH"
    chmod +x "$APPIMAGE_INSTALL_PATH"

    # Create wrapper script
    info "Creating launcher at $WRAPPER_PATH..."
    cat > "$WRAPPER_PATH" << 'WRAPPER_EOF'
#!/bin/bash
# Nessy CLI Desktop launcher - handles Linux-specific AppImage issues

APPIMAGE_PATH="$HOME/.craft-agent/app/Nessy-CLI-Desktop-x64.AppImage"
ELECTRON_CACHE="$HOME/.config/@nessy-cli"
ELECTRON_CACHE_ALT="$HOME/.cache/@nessy-cli"

# Verify AppImage exists
if [ ! -f "$APPIMAGE_PATH" ]; then
    echo "Error: Nessy CLI Desktop not found at $APPIMAGE_PATH"
    echo "Reinstall by running install-app.sh again"
    exit 1
fi

# Ensure DISPLAY is set (required for X11)
if [ -z "$DISPLAY" ]; then
    export DISPLAY=:0.0
fi

# Clear stale cache referencing AppImage mount paths
# AppImage creates a new /tmp/.mount_Nessy-XXXX each launch, so any cached path is stale
for cache_dir in "$ELECTRON_CACHE" "$ELECTRON_CACHE_ALT"; do
    if [ -d "$cache_dir" ] && grep -rq '/tmp/\.mount_Nessy' "$cache_dir" 2>/dev/null; then
        rm -rf "$cache_dir"
    fi
done

# Set APPIMAGE for auto-update
export APPIMAGE="$APPIMAGE_PATH"

exec "$APPIMAGE_PATH" "$@"
WRAPPER_EOF

    chmod +x "$WRAPPER_PATH"

    # Migrate old installation
    OLD_APPIMAGE="$INSTALL_DIR/Nessy-CLI-x64.AppImage"
    [ -f "$OLD_APPIMAGE" ] && rm -f "$OLD_APPIMAGE"

    echo ""
    echo "─────────────────────────────────────────────────────────────────────────"
    echo ""
    success "Installation complete!"
    echo ""
    printf "%b\n" "  AppImage: ${BOLD}$APPIMAGE_INSTALL_PATH${NC}"
    printf "%b\n" "  Launcher: ${BOLD}$WRAPPER_PATH${NC}"
    echo ""
    printf "%b\n" "  Run with: ${BOLD}nessy-cli${NC}"
    echo ""
    printf "%b\n" "  Add to PATH if needed:"
    printf "%b\n" "    ${BOLD}echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc${NC}"
    echo ""

    # FUSE check
    if ! command -v fusermount >/dev/null 2>&1; then
        warn "FUSE required but not detected."
        printf "%b\n" "  Install: ${BOLD}sudo apt install fuse libfuse2${NC} (Debian/Ubuntu)"
        printf "%b\n" "           ${BOLD}sudo dnf install fuse fuse-libs${NC} (Fedora)"
    fi
fi
