#!/usr/bin/env bash

# Nessy CLI standalone uninstaller.
# Removes files owned by install-nessy-standalone.sh and preserves user config.

if [ -z "${BASH_VERSION}" ] && [ -z "${__NESSY_UNINSTALL_REEXEC:-}" ]; then
    if command -v bash >/dev/null 2>&1; then
        if [ -f "${0}" ]; then
            export __NESSY_UNINSTALL_REEXEC=1
            exec bash -- "${0}" "$@"
        fi

        echo "Error: This script requires bash. Run the uninstaller with: curl ... | bash"
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
    printf '%bINFO:%b %s\n' "${BLUE}" "${NC}" "$1"
}

log_success() {
    printf '%bSUCCESS:%b %s\n' "${GREEN}" "${NC}" "$1"
}

log_warning() {
    printf '%bWARNING:%b %s\n' "${YELLOW}" "${NC}" "$1"
}

log_error() {
    printf '%bERROR:%b %s\n' "${RED}" "${NC}" "$1" >&2
}

print_usage() {
    cat <<EOF
Nessy CLI Standalone Uninstaller

Usage: $0 [OPTIONS]

Options:
  --purge       Also remove the installer source marker at ~/.nessy/source.json.
                Other Nessy CLI config and auth files are preserved.
  -h, --help    Show this help message.

Environment:
  NESSY_INSTALL_ROOT       Install root. Defaults to ~/.local.
  NESSY_INSTALL_LIB_DIR    Standalone runtime directory.
  NESSY_INSTALL_BIN_DIR    Wrapper directory.
  NESSY_UNINSTALL_PURGE=1  Same as --purge.
EOF
}

PURGE="${NESSY_UNINSTALL_PURGE:-0}"

if [[ -z "${HOME:-}" && -z "${NESSY_INSTALL_ROOT:-}" ]]; then
    log_error "HOME is not set. Set NESSY_INSTALL_ROOT to the standalone install root."
    exit 1
fi

INSTALL_ROOT="${NESSY_INSTALL_ROOT:-${HOME}/.local}"
if [[ -n "${NESSY_INSTALL_LIB_DIR:-}" ]]; then
    INSTALL_LIB_DIR="${NESSY_INSTALL_LIB_DIR}"
    INSTALL_LIB_PARENT="$(dirname "${INSTALL_LIB_DIR}")"
else
    INSTALL_LIB_PARENT="${NESSY_INSTALL_LIB_PARENT:-${INSTALL_ROOT}/lib}"
    INSTALL_LIB_DIR="${INSTALL_LIB_PARENT}/nessy-cli"
fi
INSTALL_BIN_DIR="${NESSY_INSTALL_BIN_DIR:-${INSTALL_ROOT}/bin}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --purge)
            PURGE=1
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
    validate_install_path "${INSTALL_ROOT}" "NESSY_INSTALL_ROOT"
    validate_install_path "${INSTALL_LIB_PARENT}" "NESSY_INSTALL_LIB_PARENT"
    validate_install_path "${INSTALL_LIB_DIR}" "NESSY_INSTALL_LIB_DIR"
    validate_install_path "${INSTALL_BIN_DIR}" "NESSY_INSTALL_BIN_DIR"
}

is_nessy_standalone_install_dir() {
    local install_dir="$1"
    local manifest_path="${install_dir}/manifest.json"

    [[ -d "${install_dir}" ]] || return 1
    [[ -f "${manifest_path}" ]] || return 1
    grep -Eq '"name"[[:space:]]*:[[:space:]]*"@nestor/nessy-cli"' "${manifest_path}" 2>/dev/null || return 1
    grep -Eq '"target"[[:space:]]*:[[:space:]]*"(darwin|linux)-(arm64|x64)"' "${manifest_path}" 2>/dev/null || return 1
    [[ -f "${install_dir}/bin/nessy" && ! -L "${install_dir}/bin/nessy" && -x "${install_dir}/bin/nessy" ]] || return 1
    [[ -f "${install_dir}/node/bin/node" && ! -L "${install_dir}/node/bin/node" && -x "${install_dir}/node/bin/node" ]] || return 1
}

shell_quote() {
    printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

remove_install_wrapper() {
    local wrapper_path="${INSTALL_BIN_DIR}/nessy"
    local nessy_bin="${INSTALL_LIB_DIR}/bin/nessy"

    if [[ ! -e "${wrapper_path}" ]]; then
        return 0
    fi

    if [[ ! -f "${wrapper_path}" || -L "${wrapper_path}" ]]; then
        log_warning "${wrapper_path} exists but is not an install-owned wrapper; skipping."
        return 0
    fi

    # The installer writes the path through shell_quote, so the wrapper may
    # contain the raw path (no special chars) or the single-quoted form
    # (paths with spaces, quotes, or other shell metacharacters).
    local quoted_nessy_bin
    quoted_nessy_bin=$(shell_quote "${nessy_bin}")
    if ! grep -qF "${nessy_bin}" "${wrapper_path}" 2>/dev/null &&
        ! grep -qF "${quoted_nessy_bin}" "${wrapper_path}" 2>/dev/null; then
        log_warning "${wrapper_path} does not point at this standalone install; skipping."
        return 0
    fi

    # Defense in depth: only delete files that look like the installer-generated
    # wrapper (shebang on first line). A user-authored script that happens to
    # mention the install path stays untouched.
    if ! head -n 1 "${wrapper_path}" 2>/dev/null | grep -q '^#!'; then
        log_warning "${wrapper_path} mentions this install but is not a shell wrapper; skipping."
        return 0
    fi

    rm -f "${wrapper_path}"
    log_success "Removed ${wrapper_path}"
}

remove_shell_path_entry() {
    local begin_marker="# Nessy CLI PATH block begin"
    local end_marker="# Nessy CLI PATH block end"
    local legacy_marker="# Added by nessy-cli installer (multi-nessy shadow fix)"
    local rc_files=()
    local rc_file

    [[ -n "${HOME:-}" ]] || return 0
    rc_files+=("${HOME}/.zshrc")
    rc_files+=("${HOME}/.bashrc")
    rc_files+=("${HOME}/.bash_profile")
    rc_files+=("${HOME}/.profile")
    rc_files+=("${HOME}/.config/fish/config.fish")

    for rc_file in "${rc_files[@]}"; do
        [[ -f "${rc_file}" ]] || continue
        grep -qF "${begin_marker}" "${rc_file}" 2>/dev/null ||
            grep -qF "${legacy_marker}" "${rc_file}" 2>/dev/null ||
            continue

        local temp_file
        temp_file=$(mktemp "${rc_file}.nessy-uninstall.XXXXXX") || {
            log_warning "Could not create temp file for ${rc_file}; leaving PATH entry unchanged."
            continue
        }

        awk -v begin_marker="${begin_marker}" \
            -v end_marker="${end_marker}" \
            -v legacy_marker="${legacy_marker}" '
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
            check_next == 1 {
                check_next = 0
                if ($0 ~ /^[[:space:]]*export PATH=/ ||
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
            log_warning "Could not remove Nessy CLI PATH entry from ${rc_file}."
            continue
        }

        log_success "Removed Nessy CLI PATH entry from ${rc_file}"
    done
}

remove_empty_dir() {
    local dir="$1"

    [[ -d "${dir}" ]] || return 0
    rmdir "${dir}" 2>/dev/null || true
}

remove_source_marker() {
    local source_json="${HOME:-}/.nessy/source.json"

    if [[ "${PURGE}" != "1" ]]; then
        log_info "Preserving ${HOME:-~}/.nessy (set NESSY_UNINSTALL_PURGE=1 to remove source.json)."
        return 0
    fi

    [[ -n "${HOME:-}" ]] || return 0
    if [[ -f "${source_json}" ]]; then
        rm -f "${source_json}"
        log_success "Removed ${source_json}"
    fi
    remove_empty_dir "${HOME}/.nessy"
}

validate_options

echo "Nessy CLI Standalone Uninstaller"
echo ""

install_was_managed=0
if is_nessy_standalone_install_dir "${INSTALL_LIB_DIR}"; then
    install_was_managed=1
    rm -rf "${INSTALL_LIB_DIR}"
    log_success "Removed ${INSTALL_LIB_DIR}"
elif [[ -e "${INSTALL_LIB_DIR}" ]]; then
    log_warning "${INSTALL_LIB_DIR} exists but is not a Nessy CLI standalone install; skipping."
else
    log_info "No standalone runtime found at ${INSTALL_LIB_DIR}."
fi

if [[ "${install_was_managed}" == "1" ]]; then
    remove_install_wrapper
else
    log_info "Leaving ${INSTALL_BIN_DIR}/nessy unchanged because no managed standalone runtime was removed."
fi

remove_shell_path_entry
remove_source_marker

log_success "Nessy CLI standalone install removed."
