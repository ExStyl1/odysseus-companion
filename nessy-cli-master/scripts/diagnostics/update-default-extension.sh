#!/usr/bin/env bash
#
# Update the bundled default extension (nessy-default-extension) of Nessy CLI
# Desktop on macOS for a user who does not have a standalone `nessy` CLI
# installed. Runs `nessy extensions update nessy-default-extension` through the
# Bun runtime and cli.js that ship inside the installed Desktop app.
#
# Mirrors update-default-extension.ps1 (Windows).
#
# Usage:
#   ./update-default-extension.sh
#
# Download and run directly from S3 (no install needed):
#   curl -fsSL https://s3-msk.tinkoff.ru/nestor-companion/diagnostic/update-default-extension.sh | bash

set -u

get_desktop_installations() {
    local roots=("/Applications" "$HOME/Applications")
    local found=0
    local root candidate
    for root in "${roots[@]}"; do
        [[ -d "$root" ]] || continue
        while IFS= read -r -d '' candidate; do
            printf '%s\n' "$candidate"
            found=1
        done < <(find "$root" -maxdepth 2 -type d -name 'Nessy CLI Desktop.app' -print0 2>/dev/null)
    done
    if [[ "$found" -eq 0 ]]; then
        while IFS= read -r -d '' candidate; do
            printf '%s\n' "$candidate"
        done < <(mdfind "kMDItemCFBundleIdentifier == 'ru.tbank.nessy-cli'" 2>/dev/null | grep -E '\.app$' || true)
    fi
}

get_nessy_runtime() {
    local install_path="$1"
    local base="$install_path/Contents/Resources/app/vendor/bun"
    local arch other
    case "$(uname -m)" in
        arm64) arch="arm64"; other="x64" ;;
        x86_64) arch="x64"; other="arm64" ;;
        *) arch=""; other="" ;;
    esac
    local candidate bun_path=""
    for candidate in "$arch" "$other"; do
        if [[ -n "$candidate" && -x "$base/darwin-$candidate/bun" ]]; then
            bun_path="$base/darwin-$candidate/bun"
            break
        fi
    done
    local cli_path="$install_path/Contents/Resources/app/vendor/nessy-cli/cli.js"
    if [[ -n "$bun_path" ]]; then
        printf '%s|%s' "$bun_path" "$cli_path"
    else
        printf '|%s' "$cli_path"
    fi
}

main() {
    local installations runtime bun_path cli_path
    installations="$(get_desktop_installations)"
    if [[ -z "$installations" ]]; then
        echo "No Nessy CLI Desktop installation found." >&2
        return 1
    fi

    runtime=""
    local install_path
    while IFS= read -r install_path; do
        [[ -n "$install_path" ]] || continue
        local candidate
        candidate="$(get_nessy_runtime "$install_path")"
        local candidate_bun candidate_cli
        candidate_bun="${candidate%%|*}"
        candidate_cli="$(printf '%s' "$candidate" | cut -d'|' -f2)"
        if [[ -n "$candidate_bun" && -x "$candidate_bun" ]]; then
            runtime="$candidate"
            break
        fi
    done <<< "$installations"

    bun_path="${runtime%%|*}"
    cli_path="$(printf '%s' "$runtime" | cut -d'|' -f2)"

    if [[ -z "$bun_path" || ! -x "$bun_path" ]]; then
        echo "Found Nessy CLI Desktop installation(s), but none with a bundled Bun runtime." >&2
        echo "Looked for: <install>/Contents/Resources/app/vendor/bun/darwin-<arch>/bun" >&2
        return 1
    fi
    if [[ ! -f "$cli_path" ]]; then
        echo "Bundled CLI not found: $cli_path" >&2
        return 1
    fi

    echo ""
    echo "Updating nessy-default-extension via bundled CLI:"
    echo "  Bun:  $bun_path"
    echo "  CLI:  $cli_path"
    echo "  Cmd:  bun cli.js --debug extensions update nessy-default-extension"
    echo ""
    echo "Running... (wait for it to finish; this may take a while)."
    echo ""

    env NESSY_DEBUG_LOG_FILE=1 NO_COLOR=1 "$bun_path" "$cli_path" \
        --debug extensions update nessy-default-extension
    local exit_code=$?

    echo ""
    if [[ "$exit_code" -eq 0 ]]; then
        echo "Update completed successfully (exit code 0)."
    else
        echo "Update finished with exit code $exit_code."
    fi
    return "$exit_code"
}

if [[ -z "${BASH_SOURCE[0]:-}" ]] || [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    main "$@"
fi