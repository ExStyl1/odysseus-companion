#!/usr/bin/env bash

# Nessy CLI Installation Script
# Installs Nessy CLI from a standalone archive with bundled Node.js.
# Standalone installs are isolated and do not affect user's existing Nessy installations.
# This script intentionally does not install Node.js or change npm config.
#
# Usage:
#   install-nessy-with-source.sh --source [s3|npm|internal|local-build]
#   install-nessy-with-source.sh --method [detect|standalone|npm]

if [ -z "${BASH_VERSION}" ] && [ -z "${__NESSY_INSTALL_REEXEC:-}" ]; then
    if command -v bash >/dev/null 2>&1; then
        if [ -f "${0}" ]; then
            export __NESSY_INSTALL_REEXEC=1
            exec bash -- "${0}" "$@"
        fi

        echo "Error: This script requires bash. Run the installer with: /usr/bin/curl ... | bash"
        exit 1
    fi

    echo "Error: This script requires bash. Please install bash first."
    exit 1
fi

set -eo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() {
    echo -e "${BLUE}INFO:${NC} $1"
}

log_success() {
    echo -e "${GREEN}SUCCESS:${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}WARNING:${NC} $1"
}

log_error() {
    echo -e "${RED}ERROR:${NC} $1"
}

command_exists() {
    command -v "$1" >/dev/null 2>&1
}

TEMP_DIRS=()

cleanup_temp_dirs() {
    local temp_dir
    for temp_dir in "${TEMP_DIRS[@]}"; do
        if [[ -n "${temp_dir}" ]]; then
            rm -rf "${temp_dir}"
        fi
    done
}

register_temp_dir() {
    local temp_dir="$1"
    TEMP_DIRS+=("${temp_dir}")
}

shell_quote() {
    printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

trap cleanup_temp_dirs EXIT
trap 'cleanup_temp_dirs; exit 130' INT
trap 'cleanup_temp_dirs; exit 143' TERM

print_usage() {
    cat <<EOF
Nessy CLI Installer

Usage: $0 [OPTIONS]

Options:
  -s, --source SOURCE      Record the installation source.
  --method METHOD          Install method: detect, standalone, or npm.
                           Defaults to NESSY_INSTALL_METHOD or detect.
  --archive PATH           Install from a local standalone archive.
  --version VERSION        Nessy CLI version for standalone/npm. Defaults to latest.
  --registry REGISTRY      npm registry to use with --method npm.
                           Defaults to NESSY_NPM_REGISTRY or https://artifactory.tcsbank.ru/artifactory/api/npm/npm-all/
  --no-modify-path         Skip automatic PATH modification.
  --no-default-extension   Skip installing the default Nessy extension pack.
  -h, --help               Show this help message.

Environment:
  NESSY_SKIP_UPDATE_CLEANUP=1
                           Skip update cleanup of old Nessy copies.
  NESSY_SKIP_DEFAULT_EXTENSION=1
                           Skip installing the default Nessy extension pack.

Examples:
  /usr/bin/curl -fsSL https://s3-msk.tinkoff.ru/nestor-companion/nessy-cli/installation/install-nessy.sh | bash
  /usr/bin/curl -fsSL https://s3-msk.tinkoff.ru/nestor-companion/nessy-cli/installation/install-nessy.sh | bash -s -- --source s3
  /usr/bin/curl -fsSL https://s3-msk.tinkoff.ru/nestor-companion/nessy-cli/installation/install-nessy.sh | bash -s -- --method standalone
  ./install-nessy-with-source.sh --archive ./nessy-cli-linux-x64.tar.gz
EOF
}

SOURCE="unknown"
METHOD="${NESSY_INSTALL_METHOD:-}"
ARCHIVE_PATH="${NESSY_INSTALL_ARCHIVE:-}"
VERSION="${NESSY_INSTALL_VERSION:-latest}"
NPM_REGISTRY="${NESSY_NPM_REGISTRY:-https://artifactory.tcsbank.ru/artifactory/api/npm/npm-all/}"
DEFAULT_EXTENSION_SOURCE="@nestor/nessy-cli-extensions"
DEFAULT_EXTENSION_REGISTRY="${NESSY_DEFAULT_EXTENSION_REGISTRY:-https://artifactory.tcsbank.ru/artifactory/api/npm/npm-all}"
SKIP_DEFAULT_EXTENSION="${NESSY_SKIP_DEFAULT_EXTENSION:-0}"
INSTALL_ROOT="${NESSY_INSTALL_ROOT:-${HOME:-}/.local}"
if [[ -n "${NESSY_INSTALL_LIB_DIR:-}" ]]; then
    INSTALL_LIB_DIR="${NESSY_INSTALL_LIB_DIR}"
    INSTALL_LIB_PARENT="$(dirname "${INSTALL_LIB_DIR}")"
else
    INSTALL_LIB_PARENT="${NESSY_INSTALL_LIB_PARENT:-${INSTALL_ROOT}/lib}"
    INSTALL_LIB_DIR="${INSTALL_LIB_PARENT}/nessy-cli"
fi
INSTALL_BIN_DIR="${NESSY_INSTALL_BIN_DIR:-${INSTALL_ROOT}/bin}"
ORIGINAL_PATH="${PATH:-}"
SYSTEM_CURL=""
if [[ -x "/usr/bin/curl" ]]; then
    SYSTEM_CURL="/usr/bin/curl"
elif [[ -x "/bin/curl" ]]; then
    SYSTEM_CURL="/bin/curl"
fi

validate_source() {
    if [[ "${SOURCE}" == "unknown" ]]; then
        return 0
    fi

    if [[ "${SOURCE}" =~ ^[A-Za-z0-9._-]+$ ]]; then
        return 0
    fi

    log_error "--source may only contain letters, numbers, dot, underscore, or dash."
    exit 1
}

validate_https_url() {
    local value="$1"
    local option_name="$2"

    if [[ -z "${value}" ]]; then
        return 0
    fi

    if [[ "${value}" == https://* ]]; then
        return 0
    fi

    log_error "${option_name} must start with https://"
    exit 1
}

validate_version() {
    if [[ "${VERSION}" == "latest" ]]; then
        return 0
    fi

    if [[ "${VERSION}" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9]+)*$ ]]; then
        return 0
    fi

    log_error "--version must be 'latest' or a semver string."
    exit 1
}

validate_install_path() {
    local value="$1"
    local option_name="$2"

    if [[ -z "${value}" ]]; then
        log_error "${option_name} must not be empty."
        exit 1
    fi

    case "${value}" in
        *$'\n'*|*$'\r'*)
            log_error "${option_name} must not contain newlines."
            exit 1
            ;;
    esac

    if [[ "${value}" != /* ]]; then
        log_error "${option_name} must be an absolute path."
        exit 1
    fi
}

validate_options() {
    METHOD="${METHOD:-detect}"

    case "${METHOD}" in
        detect|standalone|npm)
            ;;
        *)
            log_error "--method must be detect, standalone, or npm."
            exit 1
            ;;
    esac

    validate_https_url "${NPM_REGISTRY}" "--registry"
    if [[ "${SKIP_DEFAULT_EXTENSION}" != "1" ]]; then
        validate_https_url "${DEFAULT_EXTENSION_REGISTRY}" "NESSY_DEFAULT_EXTENSION_REGISTRY"
    fi
    validate_version
    validate_install_path "${INSTALL_ROOT}" "NESSY_INSTALL_ROOT"
    validate_install_path "${INSTALL_LIB_PARENT}" "NESSY_INSTALL_LIB_PARENT"
    validate_install_path "${INSTALL_LIB_DIR}" "NESSY_INSTALL_LIB_DIR"
    validate_install_path "${INSTALL_BIN_DIR}" "NESSY_INSTALL_BIN_DIR"
    validate_source
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -s|--source)
            if [[ -z "${2:-}" ]] || [[ "${2:-}" == -* ]]; then
                log_error "--source requires a value"
                exit 1
            fi
            SOURCE="$2"
            shift 2
            ;;
        --method)
            if [[ -z "${2:-}" ]] || [[ "${2:-}" == -* ]]; then
                log_error "--method requires a value"
                exit 1
            fi
            METHOD="$2"
            shift 2
            ;;
        --archive)
            if [[ -z "${2:-}" ]] || [[ "${2:-}" == -* ]]; then
                log_error "--archive requires a value"
                exit 1
            fi
            ARCHIVE_PATH="$2"
            shift 2
            ;;
        --version)
            if [[ -z "${2:-}" ]] || [[ "${2:-}" == -* ]]; then
                log_error "--version requires a value"
                exit 1
            fi
            VERSION="$2"
            shift 2
            ;;
        --registry)
            if [[ -z "${2:-}" ]] || [[ "${2:-}" == -* ]]; then
                log_error "--registry requires a value"
                exit 1
            fi
            NPM_REGISTRY="$2"
            shift 2
            ;;
        --no-modify-path)
            export NESSY_NO_MODIFY_PATH=1
            shift
            ;;
        --no-default-extension)
            SKIP_DEFAULT_EXTENSION=1
            shift
            ;;
        -h|--help)
            print_usage
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            echo ""
            print_usage
            exit 1
            ;;
    esac
done

# Validate all user-supplied options before doing network or filesystem work.
validate_options

print_header() {
    echo "=========================================="
    echo "   Nessy CLI Installation Script"
    echo "=========================================="
    echo ""
    log_info "System: $(uname -s 2>/dev/null || echo unknown) $(uname -r 2>/dev/null || true)"
    log_info "Install method: ${METHOD}"
    if [[ "${METHOD}" != "npm" ]]; then
        if [[ -n "${ARCHIVE_PATH}" ]]; then
            log_info "Standalone archive: ${ARCHIVE_PATH}"
        else
            log_info "Nessy version: ${VERSION}"
        fi
    else
        log_info "Nessy version: ${VERSION}"
    fi
    if [[ "${METHOD}" == "npm" ]]; then
        log_info "npm registry: ${NPM_REGISTRY}"
    fi
    if [[ "${SOURCE}" != "unknown" ]]; then
        log_info "Installation source: ${SOURCE}"
    fi
    echo ""
}

print_node_help() {
    echo ""
    echo "Node.js 20 or newer is required before installing Nessy CLI with npm."
    echo ""
    echo "Install Node.js, then rerun this installer:"
    case "$(uname -s 2>/dev/null || echo unknown)" in
        Darwin)
            echo "  brew install node"
            echo "  # or download from https://nodejs.org/"
            ;;
        Linux)
            echo "  # Use your distribution package manager or:"
            echo "  https://nodejs.org/en/download/package-manager"
            ;;
        *)
            echo "  https://nodejs.org/"
            ;;
    esac
    echo ""
    echo "If you already use a Node version manager, activate Node.js 20+"
    echo "in this shell before rerunning the installer."
}

require_node() {
    if ! command_exists node; then
        log_error "Node.js was not found."
        print_node_help
        return 1
    fi

    local node_version
    node_version=$(node -p "process.versions.node" 2>/dev/null || true)
    local node_major
    node_major=$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || true)

    if [[ -z "${node_major}" ]] || ! [[ "${node_major}" =~ ^[0-9]+$ ]]; then
        log_error "Unable to determine Node.js version."
        print_node_help
        return 1
    fi

    if [[ "${node_major}" -lt 20 ]]; then
        log_error "Node.js ${node_version:-unknown} is installed, but Node.js 20 or newer is required."
        print_node_help
        return 1
    fi

    log_success "Node.js ${node_version} detected."
}

require_npm() {
    if command_exists npm; then
        log_success "npm $(npm -v 2>/dev/null || echo unknown) detected."
        return 0
    fi

    log_error "npm was not found."
    echo ""
    echo "Please install Node.js with npm included, then rerun this installer."
    echo "Download Node.js from https://nodejs.org/ if your package manager"
    echo "installed Node without npm."
    return 1
}

get_npm_global_bin() {
    local prefix
    prefix=$(npm prefix -g 2>/dev/null || true)

    if [[ -z "${prefix}" ]]; then
        return 0
    fi

    case "$(uname -s 2>/dev/null || echo unknown)" in
        MINGW*|MSYS*|CYGWIN*)
            echo "${prefix}"
            ;;
        *)
            echo "${prefix}/bin"
            ;;
    esac
}

get_npm_package_spec() {
    if [[ "${VERSION}" == "latest" ]]; then
        echo "@nestor/nessy-cli@latest"
        return 0
    fi

    echo "@nestor/nessy-cli@${VERSION#v}"
}

is_asdf_nodejs_global_nessy_bin() {
    local bin_path="$1"

    [[ -n "${HOME:-}" ]] || return 1
    [[ "${bin_path}" == "${HOME}/.asdf/installs/nodejs/"*"/bin/nessy" ]]
}

is_asdf_nessy_entry() {
    local bin_path="$1"

    [[ -n "${HOME:-}" ]] || return 1
    [[ "${bin_path}" == "${HOME}/.asdf/shims/nessy" ]] ||
        is_asdf_nodejs_global_nessy_bin "${bin_path}"
}

should_preserve_asdf_shim_for_keep_bin() {
    local keep_bin="$1"
    local candidate="$2"

    [[ -n "${HOME:-}" ]] || return 1
    [[ "${candidate}" == "${HOME}/.asdf/shims/nessy" ]] || return 1
    is_asdf_nodejs_global_nessy_bin "${keep_bin}"
}

get_npm_exposed_bin_dir() {
    local npm_global_bin="$1"

    if is_asdf_nodejs_global_nessy_bin "${npm_global_bin}/nessy"; then
        echo "${HOME}/.asdf/shims"
        return 0
    fi

    echo "${npm_global_bin}"
}

get_bun_global_bin() {
    if ! command_exists bun; then
        return 0
    fi

    bun pm bin -g 2>/dev/null || true
}

prepend_path_once() {
    local path_to_prepend="$1"
    local next_path=""
    local path_entry

    [[ -n "${path_to_prepend}" ]] || return 0

    local saved_ifs="${IFS}"
    IFS=:
    for path_entry in ${PATH:-}; do
        [[ -z "${path_entry}" ]] && continue
        [[ "${path_entry%/}" == "${path_to_prepend%/}" ]] && continue
        if [[ -z "${next_path}" ]]; then
            next_path="${path_entry}"
        else
            next_path="${next_path}:${path_entry}"
        fi
    done
    IFS="${saved_ifs}"

    if [[ -n "${next_path}" ]]; then
        export PATH="${path_to_prepend}:${next_path}"
    else
        export PATH="${path_to_prepend}"
    fi
}

path_contains_dir() {
    local path_list="$1"
    local path_to_find="$2"
    local path_entry

    [[ -n "${path_to_find}" ]] || return 1

    local saved_ifs="${IFS}"
    IFS=:
    for path_entry in ${path_list:-}; do
        [[ -z "${path_entry}" ]] && continue
        if [[ "${path_entry%/}" == "${path_to_find%/}" ]]; then
            IFS="${saved_ifs}"
            return 0
        fi
    done
    IFS="${saved_ifs}"

    return 1
}

print_current_shell_path_command() {
    local install_bin_dir="$1"

    case "${SHELL:-}" in
        */fish)
            echo "  set -l nessy_bin_dir $(shell_quote "${install_bin_dir}")"
            echo "  contains -- \$nessy_bin_dir \$PATH; or set -gx PATH \$nessy_bin_dir \$PATH"
            ;;
        */zsh)
            echo "  path=($(shell_quote "${install_bin_dir}") \$path)"
            echo "  typeset -U path PATH"
            echo "  hash -r"
            ;;
        *)
            echo "  nessy_bin_dir=$(shell_quote "${install_bin_dir}")"
            echo "  case \":\$PATH:\" in *:\"\${nessy_bin_dir}\":*) ;; *) export PATH=\"\${nessy_bin_dir}:\$PATH\" ;; esac"
            echo "  unset nessy_bin_dir"
            ;;
    esac
}

collect_existing_nessy_bins() {
    {
        type -P -a nessy 2>/dev/null || true
        which -a nessy 2>/dev/null || true

        local saved_ifs="${IFS}"
        IFS=:
        local dir
        for dir in ${PATH:-}; do
            [[ -z "${dir}" ]] && continue
            [[ -e "${dir}/nessy" ]] && echo "${dir}/nessy"
        done
        IFS="${saved_ifs}"

        if [[ -n "${HOME:-}" ]]; then
            local candidate
            for candidate in \
                "${HOME}/.opencode/bin/nessy" \
                "${HOME}/.asdf/shims/nessy" \
                "${HOME}/.npm-global/bin/nessy" \
                "${HOME}/.npm-packages/bin/nessy" \
                "${HOME}/.bun/bin/nessy" \
                "${HOME}/Library/Application Support/reflex/bun/bin/nessy" \
                "${HOME}/.cargo/bin/nessy" \
                "${HOME}/.deno/bin/nessy" \
                "${HOME}/.volta/bin/nessy" \
                "${HOME}/.fnm/bin/nessy" \
                "${HOME}/.local/bin/nessy" \
                "${HOME}/Library/pnpm/nessy"; do
                [[ -e "${candidate}" ]] && echo "${candidate}"
            done

            if [[ -d "${HOME}/.asdf/installs/nodejs" ]]; then
                find "${HOME}/.asdf/installs/nodejs" -path '*/bin/nessy' -print 2>/dev/null || true
            fi
        fi

        if [[ "${METHOD}" == "npm" ]]; then
            local npm_global_bin
            npm_global_bin=$(get_npm_global_bin)
            if [[ -n "${npm_global_bin}" && -e "${npm_global_bin}/nessy" ]]; then
                echo "${npm_global_bin}/nessy"
            fi

            local bun_global_bin
            bun_global_bin=$(get_bun_global_bin)
            if [[ -n "${bun_global_bin}" && -e "${bun_global_bin}/nessy" ]]; then
                echo "${bun_global_bin}/nessy"
            fi
        fi

        for candidate in /usr/local/bin/nessy /opt/homebrew/bin/nessy; do
            [[ -e "${candidate}" ]] && echo "${candidate}"
        done

        true
    } 2>/dev/null | awk 'NF && !seen[$0]++'
}

looks_like_nessy_cli_bin() {
    local bin_path="$1"
    local link_target=""

    [[ -e "${bin_path}" || -L "${bin_path}" ]] || return 1

    if [[ -L "${bin_path}" ]]; then
        link_target=$(readlink "${bin_path}" 2>/dev/null || true)
        case "${link_target}" in
            *"@nestor/nessy-cli"*|*"nessy-cli"*)
                return 0
                ;;
        esac
    fi

    if [[ -f "${bin_path}" ]]; then
        grep -Eq '@nestor/nessy-cli|/nessy-cli(/|$)|\\nessy-cli\\|Nessy CLI current-session shim' \
            "${bin_path}" 2>/dev/null && return 0
    fi

    case "${bin_path}" in
        "${HOME:-}/.asdf/shims/nessy"|\
        "${HOME:-}/.bun/bin/nessy"|\
        "${HOME:-}/Library/Application Support/reflex/bun/bin/nessy")
            return 0
            ;;
    esac

    return 1
}

try_remove_nessy_bin() {
    local bin_path="$1"

    [[ -e "${bin_path}" || -L "${bin_path}" ]] || return 0

    if ! looks_like_nessy_cli_bin "${bin_path}"; then
        log_warning "Leaving ${bin_path}; it does not look install-owned."
        return 0
    fi

    if rm -f "${bin_path}"; then
        log_success "Removed stale Nessy executable: ${bin_path}"
        return 0
    fi

    log_warning "Could not remove stale Nessy executable: ${bin_path}"
}

collect_asdf_nessy_nodejs_versions() {
    [[ -n "${HOME:-}" ]] || return 0

    local shim_path="${HOME}/.asdf/shims/nessy"
    [[ -f "${shim_path}" ]] || return 0

    awk '
        $1 == "#" && $2 == "asdf-plugin:" && $3 == "nodejs" && $4 != "" {
            print $4
        }
    ' "${shim_path}" | awk 'NF && !seen[$0]++'
}

cleanup_asdf_nodejs_nessy_packages() {
    command_exists asdf || return 0

    local versions
    versions=$(collect_asdf_nessy_nodejs_versions)
    [[ -n "${versions}" ]] || return 0

    local saved_ifs="${IFS}"
    IFS=$'\n'
    local version
    for version in ${versions}; do
        [[ -n "${version}" ]] || continue
        log_info "Removing old asdf nodejs ${version} global npm package: @nestor/nessy-cli"
        if ASDF_NODEJS_VERSION="${version}" asdf exec npm uninstall -g @nestor/nessy-cli >/dev/null 2>&1; then
            log_success "Removed old asdf nodejs ${version} global npm package @nestor/nessy-cli."
        else
            log_info "No removable asdf nodejs ${version} global package @nestor/nessy-cli was found."
        fi
    done
    IFS="${saved_ifs}"
}

reshim_asdf_nodejs() {
    command_exists asdf || return 0
    asdf reshim nodejs >/dev/null 2>&1 || true
}

cleanup_regenerated_nessy_shims() {
    local keep_bin="$1"

    [[ -n "${HOME:-}" ]] || return 0

    local candidate
    for candidate in "${HOME}/.asdf/shims/nessy"; do
        [[ -n "${keep_bin}" && "${candidate}" == "${keep_bin}" ]] && continue
        should_preserve_asdf_shim_for_keep_bin "${keep_bin}" "${candidate}" && continue
        try_remove_nessy_bin "${candidate}"
    done
}

log_pre_update_nessy_bins() {
    if [[ "${NESSY_SKIP_UPDATE_CLEANUP:-0}" == "1" ]]; then
        log_info "Skipping update cleanup of old Nessy copies."
        return 0
    fi

    if [[ -n "${PRE_UPDATE_NESSYS:-}" ]]; then
        log_info "Existing Nessy executables found before update:"
        local list_ifs="${IFS}"
        IFS=$'\n'
        local existing_bin
        for existing_bin in ${PRE_UPDATE_NESSYS}; do
            [[ -n "${existing_bin}" ]] && log_info "  ${existing_bin}"
        done
        IFS="${list_ifs}"
    fi
}

cleanup_old_nessy_bins_for_update() {
    local keep_bin="${1:-}"
    local remove_npm_global="${2:-0}"

    if [[ "${NESSY_SKIP_UPDATE_CLEANUP:-0}" == "1" ]]; then
        return 0
    fi

    if [[ "${remove_npm_global}" == "1" ]]; then
        if command_exists npm; then
            log_info "Removing old global npm package: @nestor/nessy-cli"
            if npm uninstall -g @nestor/nessy-cli >/dev/null 2>&1; then
                log_success "Removed old global npm package @nestor/nessy-cli."
            else
                log_info "No removable global npm package @nestor/nessy-cli was found."
            fi
        fi
        cleanup_asdf_nodejs_nessy_packages
        reshim_asdf_nodejs
    fi

    [[ -n "${PRE_UPDATE_NESSYS:-}" ]] || return 0
    if [[ -z "${keep_bin}" ]]; then
        log_warning "Skipping stale Nessy executable cleanup because the current Nessy executable path is unknown."
        return 0
    fi

    local saved_ifs="${IFS}"
    IFS=$'\n'
    local bin_path
    for bin_path in ${PRE_UPDATE_NESSYS}; do
        [[ -n "${bin_path}" ]] || continue
        [[ -n "${keep_bin}" && "${bin_path}" == "${keep_bin}" ]] && continue
        should_preserve_asdf_shim_for_keep_bin "${keep_bin}" "${bin_path}" && continue
        try_remove_nessy_bin "${bin_path}"
    done
    IFS="${saved_ifs}"

    cleanup_regenerated_nessy_shims "${keep_bin}"
    if [[ "${remove_npm_global}" == "1" ]]; then
        reshim_asdf_nodejs
    fi
}

create_source_json() {
    if [[ "${SOURCE}" == "unknown" ]]; then
        return 0
    fi

    local nessy_dir="${HOME}/.nessy"
    mkdir -p "${nessy_dir}"

    local escaped_source
    escaped_source=$(printf '%s' "${SOURCE}" | sed 's/\\/\\\\/g; s/"/\\"/g')

    cat > "${nessy_dir}/source.json" <<EOF
{
  "source": "${escaped_source}"
}
EOF

    log_success "Installation source saved to ~/.nessy/source.json"
}

remove_existing_nessy_path_blocks() {
    local rc_file="$1"
    local begin_marker="# Nessy CLI PATH block begin"
    local end_marker="# Nessy CLI PATH block end"
    local legacy_marker="# Added by nessy-cli installer (multi-nessy shadow fix)"
    local legacy_plain_marker="# Added by Nessy CLI installer"

    [[ -f "${rc_file}" ]] || return 0
    grep -qF "${begin_marker}" "${rc_file}" 2>/dev/null ||
        grep -qF "${legacy_marker}" "${rc_file}" 2>/dev/null ||
        grep -qF "${legacy_plain_marker}" "${rc_file}" 2>/dev/null ||
        return 0

    local temp_file
    temp_file=$(mktemp "${rc_file}.nessy-path.XXXXXX") || {
        log_warning "Could not create temp file for ${rc_file}; leaving PATH entries unchanged."
        return 0
    }

    awk -v begin_marker="${begin_marker}" \
        -v end_marker="${end_marker}" \
        -v legacy_marker="${legacy_marker}" \
        -v legacy_plain_marker="${legacy_plain_marker}" '
        function reset_block(   i) {
            for (i = 1; i <= block_count; i++) {
                delete block[i]
            }
            block_count = 0
            in_block = 0
        }
        function flush_block(   i) {
            for (i = 1; i <= block_count; i++) {
                print block[i]
            }
            reset_block()
        }
        index($0, begin_marker) {
            if (in_block) {
                flush_block()
            }
            in_block = 1
            block_count = 1
            block[block_count] = $0
            next
        }
        in_block {
            block_count++
            block[block_count] = $0
            if (index($0, end_marker)) {
                reset_block()
            }
            next
        }
        index($0, legacy_marker) { check_next = 1; next }
        index($0, legacy_plain_marker) { check_next = 1; next }
        check_next == 1 {
            check_next = 0
            if ($0 ~ /^[[:space:]]*export PATH=/ ||
                $0 ~ /^[[:space:]]*case[[:space:]]/ ||
                $0 ~ /^[[:space:]]*if[[:space:]]+not[[:space:]]+contains[[:space:]]/ ||
                $0 ~ /^[[:space:]]*set -gx PATH /) {
                next
            }
        }
        { print }
        END {
            if (in_block) {
                flush_block()
            }
        }
    ' "${rc_file}" > "${temp_file}" && mv "${temp_file}" "${rc_file}" || {
        rm -f "${temp_file}"
        log_warning "Could not rewrite ${rc_file}; leaving PATH entries unchanged."
    }
}

shell_profile_contains_path() {
    local rc_file="$1"
    local install_bin_dir="$2"
    local home_relative=""

    [[ -f "${rc_file}" && -n "${install_bin_dir}" ]] || return 1

    if [[ -n "${HOME:-}" && "${install_bin_dir}" == "${HOME}/"* ]]; then
        home_relative="${install_bin_dir#"${HOME}/"}"
    fi

    awk -v install_bin_dir="${install_bin_dir}" '
        /^[[:space:]]*#/ { next }
        index($0, install_bin_dir) { found = 1; exit }
        END { exit found ? 0 : 1 }
    ' "${rc_file}" || awk -v home_relative="${home_relative}" '
        /^[[:space:]]*#/ { next }
        home_relative != "" &&
            (index($0, "$HOME/" home_relative) ||
             index($0, "${HOME}/" home_relative) ||
             index($0, "~/" home_relative)) {
            found = 1
            exit
        }
        END { exit found ? 0 : 1 }
    ' "${rc_file}"
}

ensure_path_in_shell_profile() {
    local install_bin_dir="$1"
    local target_profile=""
    local begin_marker="# Nessy CLI PATH block begin"
    local end_marker="# Nessy CLI PATH block end"

    # Respect NO_MODIFY_PATH environment variable
    if [[ "${NESSY_NO_MODIFY_PATH:-0}" == "1" ]]; then
        log_info "NESSY_NO_MODIFY_PATH=1 set; skipping shell profile modification."
        return 0
    fi

    if [[ -z "${install_bin_dir}" ]]; then
        return 0
    fi

    if [[ -z "${HOME:-}" ]]; then
        log_warning "HOME is not set; cannot determine shell profile location."
        return 0
    fi

    # Determine target profile based on ZDOTDIR and shell type
    if [[ -n "${ZDOTDIR:-}" ]]; then
        # ZDOTDIR is set → use $ZDOTDIR/.zshrc
        target_profile="${ZDOTDIR}/.zshrc"
    else
        case "${SHELL:-}" in
            */zsh)
                target_profile="${HOME}/.zshrc"
                ;;
            */bash)
                if [[ -f "${HOME}/.bashrc" ]]; then
                    target_profile="${HOME}/.bashrc"
                elif [[ -f "${HOME}/.bash_profile" ]]; then
                    target_profile="${HOME}/.bash_profile"
                else
                    target_profile="${HOME}/.bashrc"
                fi
                ;;
            */fish)
                target_profile="${HOME}/.config/fish/config.fish"
                ;;
            *)
                # Default to .zshrc for unknown shells
                target_profile="${HOME}/.zshrc"
                ;;
        esac
    fi

    [[ -z "${target_profile}" ]] && return 0

    # Create parent directory if needed
    local profile_dir
    profile_dir="$(dirname "${target_profile}")"
    if [[ ! -d "${profile_dir}" ]]; then
        mkdir -p "${profile_dir}"
    fi

    remove_existing_nessy_path_blocks "${target_profile}"

    # Check if already present in any user-managed PATH expression.
    if shell_profile_contains_path "${target_profile}" "${install_bin_dir}"; then
        log_info "PATH entry already present in ${target_profile} (skipping)."
        return 0
    fi

    # Append the PATH block with markers
    {
        echo ""
        echo "${begin_marker}"
        if [[ "${target_profile}" == *config.fish ]]; then
            echo "set -l nessy_bin_dir $(shell_quote "${install_bin_dir}")"
            echo "if not contains -- \$nessy_bin_dir \$PATH"
            echo "    set -gx PATH \$nessy_bin_dir \$PATH"
            echo "end"
        else
            echo "nessy_bin_dir=$(shell_quote "${install_bin_dir}")"
            echo "case \":\$PATH:\" in"
            echo "  *:\"\${nessy_bin_dir}\":*) ;;"
            echo "  *) export PATH=\"\${nessy_bin_dir}:\$PATH\" ;;"
            echo "esac"
            if [[ "${target_profile}" == *.zshrc ]]; then
                echo "typeset -U path PATH"
            fi
            echo "unset nessy_bin_dir"
        fi
        echo "${end_marker}"
    } >> "${target_profile}" || {
        log_warning "Could not write PATH update to ${target_profile}."
        return 0
    }

    log_success "Appended PATH prepend to ${target_profile}"
    log_info "Open a new terminal, or run: source ${target_profile}"
}

detect_target() {
    local os
    os=$(uname -s 2>/dev/null || echo unknown)
    local arch
    arch=$(uname -m 2>/dev/null || echo unknown)

    case "${os}" in
        Darwin)
            os="darwin"
            ;;
        Linux)
            os="linux"
            ;;
        *)
            return 1
            ;;
    esac

    case "${arch}" in
        x86_64|amd64)
            arch="x64"
            ;;
        arm64|aarch64)
            arch="arm64"
            ;;
        *)
            return 1
            ;;
    esac

    echo "${os}-${arch}"
}

archive_extension_for_target() {
    case "$1" in
        darwin-*|linux-*)
            echo "tar.gz"
            ;;
        *)
            return 1
            ;;
    esac
}

standalone_base_url() {
    # S3 mirror: https://s3-msk.tinkoff.ru/nestor-companion/nessy-cli/standalone/{version}/
    # VERSION defaults to 'latest'
    echo "https://s3-msk.tinkoff.ru/nestor-companion/nessy-cli/standalone/${VERSION}"
}

installer_script_dir() {
    local script_path="${BASH_SOURCE[0]:-$0}"

    if [[ -z "${script_path}" || ! -f "${script_path}" ]]; then
        return 1
    fi

    cd "$(dirname "${script_path}")" >/dev/null 2>&1 && pwd -P
}

absolute_path() {
    local path_to_resolve="$1"
    local dir
    local base

    dir=$(dirname "${path_to_resolve}")
    base=$(basename "${path_to_resolve}")
    cd "${dir}" >/dev/null 2>&1 && printf '%s/%s\n' "$(pwd -P)" "${base}"
}

standalone_archive_version() {
    local archive_path="$1"
    local manifest=""

    case "${archive_path}" in
        *.zip)
            command_exists unzip || return 1
            manifest=$(unzip -p "${archive_path}" nessy-cli/manifest.json 2>/dev/null || true)
            ;;
        *.tar.gz|*.tgz|*.tar.xz)
            manifest=$(tar -xOf "${archive_path}" nessy-cli/manifest.json 2>/dev/null || true)
            ;;
        *)
            return 1
            ;;
    esac

    [[ -n "${manifest}" ]] || return 1
    printf '%s\n' "${manifest}" |
        sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' |
        sed -n '1p'
}

resolve_local_standalone_archive() {
    local archive_name="$1"
    local script_dir=""
    local candidate=""
    local archive_version=""
    local requested_version="${VERSION#v}"
    local candidates=()

    if script_dir=$(installer_script_dir); then
        candidates+=("${script_dir}/../../dist/standalone/${archive_name}")
    fi
    candidates+=("${PWD}/dist/standalone/${archive_name}")

    for candidate in "${candidates[@]}"; do
        [[ -f "${candidate}" ]] || continue

        candidate=$(absolute_path "${candidate}") || continue

        if [[ "${VERSION}" != "latest" ]]; then
            archive_version=$(standalone_archive_version "${candidate}" || true)
            if [[ "${archive_version#v}" != "${requested_version}" ]]; then
                log_warning "Ignoring local standalone archive ${candidate}; version ${archive_version:-unknown} does not match ${VERSION}." >&2
                continue
            fi
        fi

        printf '%s\n' "${candidate}"
        return 0
    done

    return 1
}

download_file() {
    local url="$1"
    local destination="$2"

    if [[ -n "${SYSTEM_CURL}" ]]; then
        "${SYSTEM_CURL}" -fsSL --retry 2 "${url}" -o "${destination}"
        return $?
    fi

    if command_exists wget; then
        wget -q --tries=3 "${url}" -O "${destination}" || return 1
        return $?
    fi

    log_error "curl or wget is required to download the standalone archive."
    return 1
}

url_exists() {
    local url="$1"

    if [[ -n "${SYSTEM_CURL}" ]]; then
        "${SYSTEM_CURL}" -fsIL --retry 1 "${url}" >/dev/null 2>&1
        return $?
    fi

    if command_exists wget; then
        wget -q --spider "${url}" >/dev/null 2>&1
        return $?
    fi

    return 1
}

sha256_file() {
    local file_path="$1"

    if command_exists sha256sum; then
        sha256sum "${file_path}" | awk '{print $1}'
        return 0
    fi

    if command_exists shasum; then
        shasum -a 256 "${file_path}" | awk '{print $1}'
        return 0
    fi

    return 1
}

verify_checksum() {
    local archive_path="$1"
    local checksum_source="$2"
    local archive_name="$3"
    local checksum_file="${checksum_source}"
    local temp_checksum=""

    if [[ -z "${checksum_file}" ]]; then
        checksum_file="$(dirname "${archive_path}")/SHA256SUMS"
    elif [[ "${checksum_file}" == http://* || "${checksum_file}" == https://* ]]; then
        temp_checksum="$(mktemp)"
        if ! download_file "${checksum_file}" "${temp_checksum}"; then
            rm -f "${temp_checksum}"
            log_error "Could not download SHA256SUMS for checksum verification."
            return 1
        fi
        checksum_file="${temp_checksum}"
    fi

    if [[ ! -f "${checksum_file}" ]]; then
        rm -f "${temp_checksum}"
        log_error "SHA256SUMS not found; cannot verify archive."
        return 1
    fi

    local expected
    expected=$(awk -v archive_name="${archive_name}" '
        {
            name = $2
            sub(/^\*/, "", name)
            if (name == archive_name) {
                print $1
                exit
            }
        }
    ' "${checksum_file}")
    if [[ -z "${expected}" ]]; then
        rm -f "${temp_checksum}"
        log_error "Checksum entry for ${archive_name} not found."
        return 1
    fi

    local actual
    if ! actual=$(sha256_file "${archive_path}"); then
        rm -f "${temp_checksum}"
        log_error "No SHA-256 utility found; cannot verify archive."
        return 1
    fi

    rm -f "${temp_checksum}"

    if [[ "${expected}" != "${actual}" ]]; then
        log_error "Checksum verification failed for ${archive_name}."
        return 1
    fi

    log_success "Checksum verified for ${archive_name}."
}

validate_archive_entry_path() {
    local entry="$1"

    while [[ "${entry}" == ./* ]]; do
        entry="${entry#./}"
    done

    case "${entry}" in
        ""|/*|..|../*|*/..|*/../*|*\\*)
            log_error "Archive contains unsafe path: ${entry:-<empty>}"
            return 1
            ;;
    esac
}

validate_archive_contents() {
    local archive_path="$1"
    local entries
    local entry

    case "${archive_path}" in
        *.zip)
            if ! command_exists unzip; then
                log_error "unzip is required to inspect ${archive_path}."
                return 1
            fi
            if ! entries=$(unzip -Z1 "${archive_path}"); then
                log_error "Failed to inspect archive entries: ${archive_path}"
                return 1
            fi
            ;;
        *.tar.gz|*.tgz|*.tar.xz)
            if ! entries=$(tar -tf "${archive_path}"); then
                log_error "Failed to inspect archive entries: ${archive_path}"
                return 1
            fi
            ;;
        *)
            log_error "Unsupported archive format: ${archive_path}"
            return 1
            ;;
    esac

    while IFS= read -r entry; do
        validate_archive_entry_path "${entry}" || return 1
    done <<< "${entries}"
}

extract_archive() {
    local archive_path="$1"
    local destination="$2"

    mkdir -p "${destination}" || return 1
    validate_archive_contents "${archive_path}" || return 1

    case "${archive_path}" in
        *.zip)
            if ! command_exists unzip; then
                log_error "unzip is required to extract ${archive_path}."
                return 1
            fi
            unzip -q "${archive_path}" -d "${destination}" || return 1
            ;;
        *.tar.gz|*.tgz)
            tar -xzf "${archive_path}" -C "${destination}" || return 1
            ;;
        *.tar.xz)
            tar -xf "${archive_path}" -C "${destination}" || return 1
            ;;
        *)
            log_error "Unsupported archive format: ${archive_path}"
            return 1
            ;;
    esac

    local symlink_entry
    symlink_entry=$(find "${destination}" -type l -print | sed -n '1p')
    if [[ -n "${symlink_entry}" ]]; then
        log_error "Archive contains symlinks; refusing to install."
        return 1
    fi
}

ensure_managed_install_dir() {
    local install_dir="$1"

    if [[ ! -e "${install_dir}" ]]; then
        return 0
    fi

    if [[ -f "${install_dir}/manifest.json" ]]; then
        return 0
    fi

    log_error "${install_dir} exists but is not a Nessy CLI standalone install."
    log_error "Refusing to overwrite it. Move or remove it manually, then rerun the installer."
    return 1
}

write_unix_wrapper() {
    local wrapper_path="$1"
    local nessy_bin="$2"
    local quoted_nessy_bin
    quoted_nessy_bin=$(shell_quote "${nessy_bin}")

    cat > "${wrapper_path}" <<EOF
#!/usr/bin/env sh
exec ${quoted_nessy_bin} "\$@"
EOF
    chmod +x "${wrapper_path}"
}

install_standalone() {
    # Return 2 only when a standalone archive is unavailable. Return 1 for
    # integrity or install failures.
    local target=""
    local archive_name=""
    local archive_path=""
    local checksum_source=""
    local temp_dir=""

    # Resolve the archive from a local file or from the configured release mirror.
    if [[ -n "${ARCHIVE_PATH}" ]]; then
        archive_path="${ARCHIVE_PATH}"
        archive_name="$(basename "${archive_path}")"
        if [[ ! -f "${archive_path}" ]]; then
            log_error "Standalone archive not found: ${archive_path}"
            return 1
        fi
    else
        if ! target=$(detect_target); then
            log_warning "Standalone archive is not available for this platform."
            return 2
        fi

        local archive_extension
        archive_extension=$(archive_extension_for_target "${target}")
        archive_name="nessy-cli-${target}.${archive_extension}"

        if archive_path=$(resolve_local_standalone_archive "${archive_name}"); then
            log_info "Using local standalone archive: ${archive_path}"
        else
            local base_url
            base_url=$(standalone_base_url)
            local archive_url="${base_url}/${archive_name}"
            checksum_source="${base_url}/SHA256SUMS"

            if [[ "${METHOD}" == "detect" ]] && ! url_exists "${archive_url}"; then
                log_warning "Standalone archive not found: ${archive_name}"
                return 2
            fi

            temp_dir=$(mktemp -d)
            register_temp_dir "${temp_dir}"
            archive_path="${temp_dir}/${archive_name}"

            log_info "Downloading ${archive_url}"
            if ! download_file "${archive_url}" "${archive_path}"; then
                rm -rf "${temp_dir}"
                log_warning "Failed to download standalone archive."
                return 2
            fi
        fi
    fi

    if [[ -z "${temp_dir}" ]]; then
        temp_dir=$(mktemp -d)
        register_temp_dir "${temp_dir}"
    fi

    # Verify integrity before extraction or changing the install directory.
    if ! verify_checksum "${archive_path}" "${checksum_source}" "${archive_name}"; then
        rm -rf "${temp_dir}"
        return 1
    fi

    # Extract into a temporary directory, then validate required entry points.
    local extract_dir="${temp_dir}/extract"
    if ! extract_archive "${archive_path}" "${extract_dir}"; then
        rm -rf "${temp_dir}"
        return 1
    fi

    if [[ ! -f "${extract_dir}/nessy-cli/bin/nessy" || -L "${extract_dir}/nessy-cli/bin/nessy" || ! -x "${extract_dir}/nessy-cli/bin/nessy" ]]; then
        log_error "Archive does not contain nessy-cli/bin/nessy."
        rm -rf "${temp_dir}"
        return 1
    fi

    if [[ ! -f "${extract_dir}/nessy-cli/node/bin/node" || -L "${extract_dir}/nessy-cli/node/bin/node" || ! -x "${extract_dir}/nessy-cli/node/bin/node" ]]; then
        log_error "Archive does not contain executable nessy-cli/node/bin/node."
        rm -rf "${temp_dir}"
        return 1
    fi

    mkdir -p "${INSTALL_LIB_PARENT}" "${INSTALL_BIN_DIR}" || {
        rm -rf "${temp_dir}"
        return 1
    }

    # Stage into .new and keep .old so failed upgrades can roll back.
    local new_install_dir="${INSTALL_LIB_DIR}.new"
    local old_install_dir="${INSTALL_LIB_DIR}.old"
    local wrapper_tmp="${INSTALL_BIN_DIR}/nessy.new"
    if ! ensure_managed_install_dir "${INSTALL_LIB_DIR}" ||
        ! ensure_managed_install_dir "${new_install_dir}" ||
        ! ensure_managed_install_dir "${old_install_dir}"; then
        rm -rf "${temp_dir}"
        return 1
    fi
    rm -rf "${new_install_dir}" "${old_install_dir}" "${wrapper_tmp}"
    mv "${extract_dir}/nessy-cli" "${new_install_dir}"

    if ! write_unix_wrapper "${wrapper_tmp}" "${INSTALL_LIB_DIR}/bin/nessy"; then
        rm -rf "${temp_dir}" "${new_install_dir}" "${wrapper_tmp}"
        log_error "Failed to create nessy wrapper in ${INSTALL_BIN_DIR}."
        return 1
    fi

    if [[ -e "${INSTALL_LIB_DIR}" ]]; then
        mv "${INSTALL_LIB_DIR}" "${old_install_dir}"
    fi

    if ! mv "${new_install_dir}" "${INSTALL_LIB_DIR}"; then
        if [[ -e "${old_install_dir}" ]]; then
            mv "${old_install_dir}" "${INSTALL_LIB_DIR}"
        fi
        rm -rf "${temp_dir}" "${wrapper_tmp}"
        log_error "Failed to install standalone archive to ${INSTALL_LIB_DIR}."
        return 1
    fi

    if ! mv -f "${wrapper_tmp}" "${INSTALL_BIN_DIR}/nessy"; then
        rm -rf "${INSTALL_LIB_DIR}" "${wrapper_tmp}"
        if [[ -e "${old_install_dir}" ]]; then
            mv "${old_install_dir}" "${INSTALL_LIB_DIR}"
        fi
        rm -rf "${temp_dir}"
        log_error "Failed to create nessy wrapper in ${INSTALL_BIN_DIR}."
        return 1
    fi

    rm -rf "${old_install_dir}"
    prepend_path_once "${INSTALL_BIN_DIR}"

    create_source_json
    ensure_path_in_shell_profile "${INSTALL_BIN_DIR}"
    rm -rf "${temp_dir}"

    log_success "Nessy CLI standalone archive installed successfully."
    log_info "Installed to ${INSTALL_LIB_DIR}"

    # Report Node.js versions
    local bundled_node_version system_node_version
    bundled_node_version="$("${INSTALL_LIB_DIR}/node/bin/node" --version 2>/dev/null || echo "unknown")"
    if command_exists node; then
        system_node_version="$(node --version 2>/dev/null || echo "unknown")"
    else
        system_node_version="not installed"
    fi
    log_info "Bundled Node.js: ${bundled_node_version}"
    log_info "System Node.js: ${system_node_version}"

    # Recommend bundled Node.js to avoid watch limit issues
    if [[ "${bundled_node_version}" != "${system_node_version}" && "${system_node_version}" != "not installed" ]]; then
        log_info "Note: Standalone installation uses bundled Node.js to avoid system watch limits."
    fi
}

install_npm() {
    require_node || return 1
    require_npm || return 1

    local package_spec
    package_spec=$(get_npm_package_spec)

    if command_exists nessy; then
        local nessy_version
        nessy_version=$(nessy --version 2>/dev/null || echo "unknown")
        log_info "Existing Nessy CLI detected: ${nessy_version}"
    fi

    log_info "Reinstalling ${package_spec}."
    cleanup_asdf_nodejs_nessy_packages

    log_info "Removing any existing global npm package: @nestor/nessy-cli"
    if npm uninstall -g @nestor/nessy-cli --registry "${NPM_REGISTRY}" >/dev/null 2>&1; then
        log_success "Removed existing global npm package @nestor/nessy-cli."
    else
        log_info "No removable global npm package @nestor/nessy-cli was found."
    fi

    local install_cmd=(
        npm
        install
        -g
        "${package_spec}"
        --force
        --registry
        "${NPM_REGISTRY}"
    )

    log_info "Running: npm install -g ${package_spec} --force --registry ${NPM_REGISTRY}"
    if "${install_cmd[@]}"; then
        reshim_asdf_nodejs
        log_success "Nessy CLI installed successfully."

        # Report Node.js version used for npm install
        local node_version
        node_version="$(node --version 2>/dev/null || echo "unknown")"
        log_info "Node.js used: ${node_version}"

        local npm_global_bin
        npm_global_bin=$(get_npm_global_bin)
        local npm_exposed_bin
        npm_exposed_bin=$(get_npm_exposed_bin_dir "${npm_global_bin}")
        create_source_json
        ensure_path_in_shell_profile "${npm_exposed_bin}"
        # Update PATH in current session.
        prepend_path_once "${npm_exposed_bin}"
        return 0
    fi

    log_error "Failed to install Nessy CLI."
    echo ""
    echo "This installer does not change your npm prefix or shell profile."
    echo "If the failure is a permission error, install Node.js with a user-owned"
    echo "Node version manager or fix your npm global package directory, then run:"
    echo "  npm install -g ${package_spec} --force --registry ${NPM_REGISTRY}"
    return 1
}

# Installs the default Nessy extension pack with the freshly installed CLI.
# Best effort: never fails the installer, warns and returns 0 on any problem.
# The nessy binary is invoked by absolute path so a stale copy on PATH cannot
# be picked up instead of the one that was just installed.
install_default_extension() {
    local nessy_bin="${1:-}"

    if [[ "${SKIP_DEFAULT_EXTENSION}" == "1" ]]; then
        log_info "Skipping default extension install (--no-default-extension)."
        return 0
    fi

    if [[ -z "${nessy_bin}" || ! -x "${nessy_bin}" ]]; then
        log_warning "Skipping default extension install: nessy executable was not found."
        log_warning "You can install it later with:"
        log_warning "  nessy extensions install ${DEFAULT_EXTENSION_SOURCE} --registry=${DEFAULT_EXTENSION_REGISTRY} --auto-update --consent"
        return 0
    fi

    echo ""
    log_info "Installing default extension pack: ${DEFAULT_EXTENSION_SOURCE}"
    local extension_output
    if extension_output=$("${nessy_bin}" extensions install "${DEFAULT_EXTENSION_SOURCE}" \
        --registry="${DEFAULT_EXTENSION_REGISTRY}" \
        --auto-update \
        --consent 2>&1); then
        [[ -n "${extension_output}" ]] && printf '%s\n' "${extension_output}"
        log_success "Default extension pack installed."
        return 0
    fi

    if [[ "${extension_output}" == *'Extension "nessy-default-extension" is already installed. Please uninstall it first.'* ]]; then
        log_info "Default extension pack is already installed."
        return 0
    fi

    [[ -n "${extension_output}" ]] && printf '%s\n' "${extension_output}" >&2
    log_warning "Failed to install the default extension pack ${DEFAULT_EXTENSION_SOURCE}."
    log_warning "Nessy CLI itself is installed and usable. To retry later, run:"
    log_warning "  nessy extensions install ${DEFAULT_EXTENSION_SOURCE} --registry=${DEFAULT_EXTENSION_REGISTRY} --auto-update --consent"
    return 0
}

print_final_instructions() {
    local install_bin_dir="${1:-}"
    local installed_bin=""
    local was_on_original_path=0

    echo ""
    echo "=========================================="
    echo "Installation completed!"
    echo "=========================================="
    echo ""

    if [[ -n "${install_bin_dir}" ]]; then
        if path_contains_dir "${ORIGINAL_PATH}" "${install_bin_dir}"; then
            was_on_original_path=1
        fi
        prepend_path_once "${install_bin_dir}"
        installed_bin="${install_bin_dir}/nessy"
    fi

    if [[ -n "${installed_bin}" && -x "${installed_bin}" ]]; then
        local installed_version
        installed_version=$("${installed_bin}" --version 2>/dev/null || echo "unknown")
        log_success "Nessy CLI is ready to use: ${installed_version}"

        # Verify bundled Node.js is being used
        if [[ -f "${INSTALL_LIB_DIR}/node/bin/node" ]]; then
            log_info "Standalone installation uses bundled Node.js (isolated from system)."
        fi
    elif command_exists nessy; then
        local nessy_version
        nessy_version=$(nessy --version 2>/dev/null || echo "unknown")
        log_warning "Another Nessy CLI installation was found: ${nessy_version}"
        log_warning "The newly installed version may not be on PATH. Run '${install_bin_dir}/nessy' to use it."
    else
        log_warning "Nessy CLI was installed, but nessy is not on PATH in this shell."
        echo ""
        if [[ -n "${install_bin_dir}" ]]; then
            if [[ "${NESSY_NO_MODIFY_PATH:-0}" == "1" ]]; then
                echo "INFO: Shell profile modification was skipped."
            else
                echo "INFO: The installation directory has been added to your shell profile."
                echo "INFO: Open a new terminal for the change to take effect."
            fi
            echo ""
            echo "Or run this in the current shell:"
            print_current_shell_path_command "${install_bin_dir}"
            echo "  nessy"
        else
            echo "INFO: The npm global bin directory has been added to your shell profile."
            echo "INFO: Open a new terminal for the change to take effect."
            echo ""
            echo "Then run: nessy"
        fi
        return 0
    fi

    echo ""
    echo "You can now run: nessy"
    if [[ -n "${install_bin_dir}" && "${was_on_original_path}" -eq 0 ]]; then
        echo ""
        if [[ "${NESSY_NO_MODIFY_PATH:-0}" == "1" ]]; then
            log_info "The installer updated PATH inside its own process only."
        else
            log_info "The installer updated PATH inside its own process and added it to your shell profile."
        fi
        log_info "To use nessy in this current terminal after the installer exits, run:"
        print_current_shell_path_command "${install_bin_dir}"
        # Apply PATH change to current session
        if ! path_contains_dir "${PATH}" "${install_bin_dir}"; then
            export PATH="${install_bin_dir}:${PATH}"
        fi
    fi
    echo ""
    log_info "Run nessy in your project directory to start an interactive session."

    local other_bins
    other_bins=$(
        collect_existing_nessy_bins | while IFS= read -r path; do
            [[ -z "${path}" ]] && continue
            [[ -n "${installed_bin}" && "${path}" == "${installed_bin}" ]] && continue
            if [[ -n "${installed_bin}" ]] &&
                is_asdf_nessy_entry "${installed_bin}" &&
                is_asdf_nessy_entry "${path}"; then
                continue
            fi
            echo "${path}"
        done
    )
    if [[ -n "${other_bins}" ]]; then
        echo ""
        log_warning "Other 'nessy' executables still exist on this system:"
        local saved_ifs="${IFS}"
        IFS=$'\n'
        local path
        for path in ${other_bins}; do
            [[ -n "${path}" ]] && log_warning "  ${path}"
        done
        IFS="${saved_ifs}"
    fi
}

main() {
    if [[ -z "${HOME:-}" ]]; then
        log_error "HOME is not set; cannot determine where to install Nessy CLI."
        exit 1
    fi

    print_header

    case "${METHOD}" in
        standalone)
            PRE_UPDATE_NESSYS=$(collect_existing_nessy_bins)
            export PRE_UPDATE_NESSYS
            log_pre_update_nessy_bins

            install_standalone
            cleanup_old_nessy_bins_for_update "${INSTALL_BIN_DIR}/nessy" "0"
            install_default_extension "${INSTALL_BIN_DIR}/nessy"
            print_final_instructions "${INSTALL_BIN_DIR}"
            ;;
        npm)
            # npm install may clean up old global installations.
            PRE_UPDATE_NESSYS=$(collect_existing_nessy_bins)
            export PRE_UPDATE_NESSYS
            log_pre_update_nessy_bins

            install_npm
            local npm_global_bin
            npm_global_bin=$(get_npm_global_bin)
            local npm_exposed_bin
            npm_exposed_bin=$(get_npm_exposed_bin_dir "${npm_global_bin}")
            cleanup_old_nessy_bins_for_update "${npm_global_bin:+${npm_global_bin}/nessy}" "1"
            install_default_extension "${npm_exposed_bin:+${npm_exposed_bin}/nessy}"
            print_final_instructions "${npm_exposed_bin}"
            ;;
        detect)
            # Detect installs only the standalone bundle. npm is explicit.
            PRE_UPDATE_NESSYS=$(collect_existing_nessy_bins)
            export PRE_UPDATE_NESSYS
            log_pre_update_nessy_bins

            if install_standalone; then
                cleanup_old_nessy_bins_for_update "${INSTALL_BIN_DIR}/nessy" "0"
                install_default_extension "${INSTALL_BIN_DIR}/nessy"
                print_final_instructions "${INSTALL_BIN_DIR}"
            else
                standalone_status=$?
                if [[ "${standalone_status}" -eq 2 ]]; then
                    log_error "Standalone archive is unavailable for ${VERSION}."
                    log_error "Publish the standalone bundle, pass --archive, or rerun with --method npm to use user Node.js/npm explicitly."
                    exit 2
                else
                    log_warning "Standalone install failed. Retry with --method npm to use npm, or --method standalone to debug the standalone failure."
                    exit "${standalone_status}"
                fi
            fi
            ;;
    esac
}

main "$@"
