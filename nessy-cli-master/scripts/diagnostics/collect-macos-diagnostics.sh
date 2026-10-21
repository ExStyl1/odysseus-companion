#!/usr/bin/env bash
#
# Nessy CLI Desktop macOS diagnostics collector.
# Mirrors collect-windows-diagnostics.ps1 but targets macOS (bash).
#
# Usage:
#   ./collect-macos-diagnostics.sh [--output /path/to/report.txt] [--library]
#
#   --output <path>  Write the report to an explicit path (default: a dated file
#                    in the current directory, falling back to $TMPDIR).
#   --library        Do not run the collection; only define functions (for
#                    sourcing from other scripts).
#
# Download and run directly from S3 (no install needed):
#   curl -fsSL https://s3-msk.tinkoff.ru/nestor-companion/diagnostic/collect-macos-diagnostics.sh | bash
#   # to save the report to a specific path:
#   curl -fsSL https://s3-msk.tinkoff.ru/nestor-companion/diagnostic/collect-macos-diagnostics.sh | bash -s -- --output /tmp/diag.txt

set -u

LOG_CUTOFF_SECONDS=$((24 * 3600))
MAX_LOG_FILE_BYTES=$((5 * 1024 * 1024))   # 5 MB per file
MAX_TOTAL_LOG_BYTES=$((25 * 1024 * 1024)) # 25 MB total
TOTAL_LOG_BYTES=0

# nestor backend used by the ACP channel; unreachable/untrusted TLS here
# surfaces as "Nessy ACP request timed out: initialize".
NESTOR_BACKEND_URL="https://code-completion-nestor.tcsbank.ru"

# ---- result state filled by run_cmd -------------------------------------
RC_COMMAND=""
RC_EXIT=""
RC_TIMED_OUT=false
RC_DURATION_MS=0
RC_STDOUT=""
RC_STDERR=""

strip_ansi() {
    # BSD sed (macOS default) rejects these char ranges under a UTF-8 locale,
    # so run under LC_ALL=C and use a literal ESC byte (BSD sed has no \x1b).
    local esc
    esc="$(printf '\033')"
    printf '%s' "$1" | LC_ALL=C sed -E "s/${esc}\[[0-?]*[ -/]*[@-~]//g"
}

add_section() {
    local title="$1"
    local content="${2:-}"
    printf '\n%s\n%s\n%s\n' \
        "$(printf '=%.0s' {1..80})" \
        "$title" \
        "$(printf '=%.0s' {1..80})"
    local clean
    clean="$(strip_ansi "$content")"
    # trim trailing blank lines only; keep interior blank lines
    clean="${clean%"${clean##*[![:space:]]}"}"
    printf '%s\n' "$clean"
}

quote_arg() {
    local arg="$1"
    if [[ "$arg" =~ [^A-Za-z0-9_@%+=:,./-] ]]; then
        printf "'%s'" "${arg//\'/\'\\\'\'}"
    else
        printf '%s' "$arg"
    fi
}

run_cmd() {
    local timeout_seconds="$1"
    shift
    local file_path="$1"
    shift
    local args=("$@")
    local working_directory="$(pwd)"
    local out_path err_path timedout_path
    out_path="$(mktemp "${TMPDIR:-/tmp}/.nessy-diag-stdout-XXXXXX")"
    err_path="$(mktemp "${TMPDIR:-/tmp}/.nessy-diag-stderr-XXXXXX")"
    timedout_path="$(mktemp "${TMPDIR:-/tmp}/.nessy-diag-timedout-XXXXXX")"
    rm -f "$timedout_path"   # mktemp creates the file; the marker must not exist until the timer touches it

    local start_sec end_sec
    start_sec="$(date +%s)"

    local cmd_quoted
    cmd_quoted="$(quote_arg "$file_path")"
    local arg
    for arg in "${args[@]}"; do
        cmd_quoted="$cmd_quoted $(quote_arg "$arg")"
    done

    RC_COMMAND="$file_path ${args[*]}"
    RC_COMMAND="${RC_COMMAND%"${RC_COMMAND##*[![:space:]]}"}"

    (
        cd "$working_directory" || exit 1
        eval "exec ${cmd_quoted}" >"$out_path" 2>"$err_path"
    ) &
    local pid=$!

    (
        sleep "$timeout_seconds"
        if kill -0 "$pid" 2>/dev/null; then
            touch "$timedout_path"
            kill -9 "$pid" 2>/dev/null
        fi
    ) &
    local timer=$!

    wait "$pid" 2>/dev/null
    local rc=$?
    kill "$timer" 2>/dev/null
    wait "$timer" 2>/dev/null

    end_sec="$(date +%s)"
    RC_DURATION_MS=$(((end_sec - start_sec) * 1000))
    if [[ -f "$timedout_path" ]]; then
        RC_TIMED_OUT=true
        RC_EXIT=""
    else
        RC_TIMED_OUT=false
        RC_EXIT=$rc
    fi
    RC_STDOUT="$(cat "$out_path" 2>/dev/null)"
    RC_STDERR="$(cat "$err_path" 2>/dev/null)"
    rm -f "$out_path" "$err_path" "$timedout_path"
}

fmt_result() {
    local exit_code="${RC_EXIT:-<not available>}"
    printf 'Command: %s\nExit code: %s\nTimed out: %s\nDuration: %s ms\n--- stdout ---\n%s\n--- stderr ---\n%s\n' \
        "$RC_COMMAND" "$exit_code" "$RC_TIMED_OUT" "$RC_DURATION_MS" "$RC_STDOUT" "$RC_STDERR"
}

get_file_info() {
    local path="$1"
    if [[ ! -f "$path" ]]; then
        printf 'Missing: %s\n' "$path"
        return
    fi
    local size mtime sha version="<n/a>"
    size="$(stat -f%z "$path")"
    mtime="$(stat -f '%Sm' -t '%Y-%m-%dT%H:%M:%SZ' "$path")"
    sha="$(shasum -a 256 "$path" | awk '{print $1}')"
    if [[ "$path" == *.app ]]; then
        local plist="$path/Contents/Info.plist"
        if [[ -f "$plist" ]]; then
            version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist" 2>/dev/null || echo '<unavailable>')"
        fi
    fi
    printf 'Path: %s\nSize: %s bytes\nLast modified: %s\nVersion: %s\nSHA-256: %s\n' \
        "$path" "$size" "$mtime" "$version" "$sha"
}

get_nessy_home() {
    if [[ -n "${NESSY_HOME:-}" ]]; then
        printf '%s' "$NESSY_HOME"
    else
        printf '%s/.nessy' "$HOME"
    fi
}

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

get_desktop_executable() {
    local install_path="$1"
    local preferred="$install_path/Contents/MacOS/Nessy CLI Desktop"
    if [[ -x "$preferred" ]]; then
        printf '%s' "$preferred"
        return
    fi
    local bin
    bin="$(find "$install_path/Contents/MacOS" -maxdepth 1 -type f -perm -111 2>/dev/null | head -n 1)"
    if [[ -n "$bin" ]]; then
        printf '%s' "$bin"
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
        printf '%s|%s|bundled Bun (%s)' "$bun_path" "$cli_path" "${arch:-unknown}"
    else
        printf '|%s|bundled Bun missing' "$cli_path"
    fi
}

run_bundled_cli() {
    local runtime="$1"
    shift
    local timeout_seconds="$1"
    shift
    local bun_path cli_path mode
    bun_path="${runtime%%|*}"
    cli_path="$(printf '%s' "$runtime" | cut -d'|' -f2)"
    mode="$(printf '%s' "$runtime" | cut -d'|' -f3-)"

    if [[ -z "$bun_path" || ! -x "$bun_path" || ! -f "$cli_path" ]]; then
        RC_COMMAND="$cli_path"
        RC_EXIT=""
        RC_TIMED_OUT=false
        RC_DURATION_MS=0
        RC_STDOUT=""
        RC_STDERR="Bundled Nessy CLI or its runtime was not found (mode: $mode)."
        return
    fi
    export NESSY_DEBUG_LOG_FILE=1
    export NO_COLOR=1
    run_cmd "$timeout_seconds" "$bun_path" "$cli_path" "--debug" "$@"
}

get_debug_log_snapshot() {
    local dir="$1"
    if [[ ! -d "$dir" ]]; then
        return
    fi
    local file
    while IFS= read -r -d '' file; do
        printf '%s:%s\n' "$file" "$(stat -f '%m:%z' "$file")"
    done < <(find "$dir" -maxdepth 1 -type f -print0 2>/dev/null)
}

get_changed_debug_logs() {
    local dir="$1"
    shift
    local before=()
    before=("$@")
    if [[ ! -d "$dir" ]]; then
        return
    fi
    local file state line found
    while IFS= read -r -d '' file; do
        state="$(stat -f '%m:%z' "$file")"
        found=""
        for line in "${before[@]}"; do
            [[ "$line" == "$file:$state" ]] && { found=1; break; }
        done
        if [[ -z "$found" ]]; then
            printf '%s\n' "$file"
        fi
    done < <(find "$dir" -maxdepth 1 -type f -print0 2>/dev/null)
}

get_config_files() {
    local paths=()
    [[ -f "$HOME/.nessy/settings.json" ]] && paths+=("$HOME/.nessy/settings.json")
    [[ -f "$(pwd)/.nessy/settings.json" ]] && paths+=("$(pwd)/.nessy/settings.json")
    [[ -f "$(pwd)/.mcp.json" ]] && paths+=("$(pwd)/.mcp.json")
    printf '%s\n' "${paths[@]}" | sort -u | grep -v '^$'
}

add_file_content_to_report() {
    local path="$1"
    local max_bytes="$2"
    if [[ ! -f "$path" ]]; then
        add_section "LOG ERROR: $path" "ERROR: file not found"
        return
    fi
    local remaining=$((MAX_TOTAL_LOG_BYTES - TOTAL_LOG_BYTES))
    if ((remaining <= 0)); then
        add_section "LOG SKIPPED: $path" "Total log size limit reached."
        return
    fi
    local file_size mtime bytes_to_read
    file_size="$(stat -f%z "$path")"
    mtime="$(stat -f '%Sm' -t '%Y-%m-%dT%H:%M:%SZ' "$path")"
    bytes_to_read="$file_size"
    (( bytes_to_read > max_bytes )) && bytes_to_read="$max_bytes"
    (( bytes_to_read > remaining )) && bytes_to_read="$remaining"

    local content metadata="Path: $path
Last modified: $mtime
Original size: $file_size bytes
Included: $bytes_to_read bytes"
    if ((file_size > bytes_to_read)); then
        content="$(tail -c "$bytes_to_read" "$path")"
        metadata="$metadata
TRUNCATED: only the tail of this file is included."
    else
        content="$(cat "$path")"
    fi
    TOTAL_LOG_BYTES=$((TOTAL_LOG_BYTES + bytes_to_read))
    add_section "LOG: $(basename "$path")" "$metadata
--- content ---
$content"
}

get_recent_log_files() {
    local dirs=()
    dirs+=("$(get_nessy_home)/debug")
    dirs+=("$HOME/.craft-agent/logs")
    dirs+=("$HOME/Library/Logs/Nessy CLI Desktop")
    dirs+=("$HOME/Library/Logs/nessy-cli")
    dirs+=("$HOME/Library/Application Support/nessy-cli/logs")
    dirs+=("$HOME/Library/Application Support/Nessy CLI Desktop/logs")
    local cutoff_since d file
    cutoff_since="$(date -v -${LOG_CUTOFF_SECONDS}S +%s)"
    for d in "${dirs[@]}"; do
        [[ -d "$d" ]] || continue
        while IFS= read -r -d '' file; do
            local mtime ext
            mtime="$(stat -f '%m' "$file")"
            ext="${file##*.}"
            if ((mtime >= cutoff_since)) && [[ "$ext" =~ ^(log|txt|json|jsonl)$ ]]; then
                printf '%s\n' "$file"
            fi
        done < <(find "$d" -type f -print0 2>/dev/null)
    done
}

resolve_command_path() {
    local name="$1"
    command -v "$name" 2>/dev/null || true
}

get_system_summary() {
    local os_product os_version os_build arch
    os_product="$(sw_vers -productName 2>/dev/null)"
    os_version="$(sw_vers -productVersion 2>/dev/null)"
    os_build="$(sw_vers -buildVersion 2>/dev/null)"
    arch="$(uname -m)"
    printf 'Generated: %s\nComputer: %s\nUser: %s\nOS: %s %s (%s)\nArchitecture: %s\nShell: bash %s\nCurrent directory: %s\nPATH: %s\nHTTP_PROXY: %s\nHTTPS_PROXY: %s\nNO_PROXY: %s\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        "$(scutil --get ComputerName 2>/dev/null || hostname)" \
        "$USER" \
        "$os_product" "$os_version" "$os_build" \
        "$arch" \
        "${BASH_VERSION:-}" \
        "$(pwd)" \
        "${PATH:-}" \
        "${HTTP_PROXY:-}" \
        "${HTTPS_PROXY:-}" \
        "${NO_PROXY:-}"
}

get_backend_access_check() {
    local url="$NESTOR_BACKEND_URL"
    local curl_bin
    curl_bin="$(command -v curl || true)"
    if [[ -z "$curl_bin" ]]; then
        printf 'curl not found in PATH; cannot probe %s\n' "$url"
        return
    fi

    # Pass 1: normal trust verification. A TLS trust failure (e.g.
    # "self signed certificate in certificate chain") makes curl exit
    # non-zero with an empty HTTP code.
    run_cmd 15 "$curl_bin" -sS -o /dev/null -m 15 -w 'HTTP:%{http_code} TIME:%{time_total}s' "$url"
    local strict_http="$RC_STDOUT"
    local strict_err="$RC_STDERR"
    local strict_exit="$RC_EXIT"

    # Pass 2: -k (skip cert verification). If this succeeds while pass 1
    # failed, the backend is reachable but its TLS cert is not trusted.
    run_cmd 15 "$curl_bin" -sSk -o /dev/null -m 15 -w 'HTTP:%{http_code} TIME:%{time_total}s' "$url"
    local insecure_http="$RC_STDOUT"
    local insecure_exit="$RC_EXIT"

    # Judge by exit code, not stdout: curl still prints "HTTP:000" on error.
    local verdict
    if [[ "$strict_exit" == "0" ]]; then
        verdict="REACHABLE"
    elif [[ "$insecure_exit" == "0" ]]; then
        verdict="UNREACHABLE (TLS trust failure - cert not trusted)"
    else
        verdict="UNREACHABLE (network/access problem or timeout)"
    fi

    printf 'URL: %s\n' "$url"
    printf 'Verdict: %s\n' "$verdict"
    printf 'Strict TLS (verify on): %s (exit %s)\n' "${strict_http:-<no HTTP response>}" "${strict_exit:-<timeout>}"
    printf 'Insecure (-k) probe:    %s (exit %s)\n' "${insecure_http:-<no HTTP response>}" "${insecure_exit:-<timeout>}"
    if [[ -n "$strict_err" ]]; then
        printf 'curl error (strict): %s\n' "$(printf '%s' "$strict_err" | head -n 3)"
    fi
}

get_ca_config() {
    local nessy_home
    nessy_home="$(get_nessy_home)"
    local app="/Applications/Nessy CLI Desktop.app/Contents/Resources/app"

    printf 'NODE_EXTRA_CA_CERTS: %s\n' "${NODE_EXTRA_CA_CERTS:-<unset>}"
    printf 'SSL_CERT_FILE: %s\n' "${SSL_CERT_FILE:-<unset>}"
    printf 'NESSY_USE_BUNDLED_CA: %s\n' "${NESSY_USE_BUNDLED_CA:-<unset>}"

    # CA bundle locations Nessy CLI actually checks (mirrors resolveDesktopCaPaths
    # and ensureExtraCaCert): ~/.nessy/certs + paths inside the desktop .app.
    local dirs
    dirs=(
        "$nessy_home/certs"
        "$app/vendor/nessy-cli/certs"
        "$app/dist/certs"
        "$app/certs"
    )
    local d cert cert_found=false
    for d in "${dirs[@]}"; do
        printf '\nCertificate dir: %s (%s)\n' "$d" "$([ -d "$d" ] && echo present || echo missing)"
        for cert in "$d/tinkoff-bundle.crt" "$d/russian-root-ca.crt"; do
            if [[ -f "$cert" ]]; then
                cert_found=true
                printf '  %s  (%s bytes, modified %s)\n' \
                    "$(basename "$cert")" \
                    "$(stat -f%z "$cert")" \
                    "$(stat -f '%Sm' -t '%Y-%m-%d' "$cert")"
                printf '  subjects/issuers in bundle:\n'
                openssl crl2pkcs7 -nocrl -certfile "$cert" 2>/dev/null \
                    | openssl pkcs7 -print_certs -noout 2>/dev/null \
                    | grep -E 'subject=|issuer=' \
                    | sed 's/^/    /'
            fi
        done
    done

    # Issuer of the nestor backend cert, to compare against the bundle above.
    printf '\nBackend cert issuer (code-completion-nestor.tcsbank.ru):\n'
    local out
    out="$(printf '' | LC_ALL=C openssl s_client -connect code-completion-nestor.tcsbank.ru:443 \
        -servername code-completion-nestor.tcsbank.ru 2>/dev/null \
        | LC_ALL=C openssl x509 -noout -issuer -subject -dates 2>/dev/null)"
    if [[ -n "$out" ]]; then
        printf '%s\n' "$out" | sed 's/^/    /'
    else
        printf '    <could not retrieve backend certificate>\n'
    fi

    if [[ "$cert_found" == false ]]; then
        printf '\nNOTE: no Nessy CLI CA bundle found in any expected location.\n'
    fi
}

invoke_nessy_macos_diagnostics() {
    printf 'NESSY CLI DESKTOP MACOS DIAGNOSTICS\n'
    printf 'WARNING: THIS REPORT MAY CONTAIN TOKENS, PASSWORDS, PRIVATE URLS,\n'
    printf 'ENVIRONMENT VALUES, USER PATHS, AND OTHER SECRETS.\n'
    printf 'SHARE IT ONLY WITH TRUSTED SUPPORT PERSONNEL.\n'

    add_section "SYSTEM" "$(get_system_summary)"

    add_section "BACKEND ACCESS CHECK" "$(get_backend_access_check)"

    add_section "CA CONFIG" "$(get_ca_config)"

    local debug_directory
    debug_directory="$(get_nessy_home)/debug"
    local debug_snapshot=()
    while IFS= read -r line; do
        [[ -n "$line" ]] && debug_snapshot+=("$line")
    done < <(get_debug_log_snapshot "$debug_directory")

    local processes
    processes="$(ps -axo pid,etime,command 2>/dev/null | grep -iE 'nessy|craft' | grep -v grep || true)"
    add_section "RUNNING NESSY PROCESSES" "$processes"

    local command_name command_path
    for command_name in node bun; do
        command_path="$(resolve_command_path "$command_name")"
        if [[ -n "$command_path" ]]; then
            run_cmd 10 "$command_path" "--version"
            add_section "SYSTEM $(printf '%s' "$command_name" | tr '[:lower:]' '[:upper:]')" \
                "Path: $command_path
$(fmt_result)"
        else
            add_section "SYSTEM $(printf '%s' "$command_name" | tr '[:lower:]' '[:upper:]')" \
                "Not installed or not found in PATH. Bundled CLI diagnostics are unaffected."
        fi
    done

    local installations
    installations="$(get_desktop_installations)"
    if [[ -z "$installations" ]]; then
        add_section "DESKTOP INSTALLATIONS" "No Nessy CLI Desktop installations found."
    fi
    local index=0 install_path executable runtime bun_path cli_path mode
    while IFS= read -r install_path; do
        [[ -n "$install_path" ]] || continue
        index=$((index + 1))
        executable="$(get_desktop_executable "$install_path")"
        runtime="$(get_nessy_runtime "$install_path")"
        bun_path="${runtime%%|*}"
        cli_path="$(printf '%s' "$runtime" | cut -d'|' -f2)"
        mode="$(printf '%s' "$runtime" | cut -d'|' -f3-)"

        local desktop_info runtime_info
        if [[ -n "$executable" ]]; then
            desktop_info="$(get_file_info "$executable")"
        else
            desktop_info="Desktop executable not found."
        fi
        if [[ -n "$bun_path" ]]; then
            runtime_info="$(get_file_info "$bun_path")"
        else
            runtime_info="Runtime not found."
        fi

        add_section "DESKTOP INSTALLATION $index" \
            "Install path: $install_path
Runtime mode: $mode
$desktop_info
--- bundled CLI ---
$(get_file_info "$cli_path")
--- bundled runtime ---
$runtime_info"

        run_bundled_cli "$runtime" 20 "--version"
        add_section "BUNDLED CLI $index: VERSION" "$(fmt_result)"
        run_bundled_cli "$runtime" 60 "extensions" "list" "--json"
        add_section "BUNDLED CLI $index: EXTENSIONS" "$(fmt_result)"
        run_bundled_cli "$runtime" 180 "mcp" "reconnect" "--all"
        add_section "BUNDLED CLI $index: MCP STARTUP DEBUG" "$(fmt_result)"
        run_bundled_cli "$runtime" 180 "mcp" "list"
        add_section "BUNDLED CLI $index: MCP CONNECTIONS" "$(fmt_result)"
    done <<< "$installations"

    local config_path
    while IFS= read -r config_path; do
        [[ -n "$config_path" ]] || continue
        add_section "FULL CONFIG: $config_path" "$(cat "$config_path")"
    done <<< "$(get_config_files)"

    local nessy_home dp_work_dir dp_path dp_installed
    nessy_home="$(get_nessy_home)"
    dp_work_dir="$nessy_home/dp_latest"
    dp_path="$dp_work_dir/dp"
    if [[ -x "$dp_path" ]]; then
        dp_installed=true
    else
        dp_installed=false
    fi
    add_section "DP INSTALLATION CHECK" "Installed: $dp_installed
Expected directory: $dp_work_dir
Expected binary: $dp_path"
    if [[ "$dp_installed" == true ]]; then
        add_section "DP BINARY" "$(get_file_info "$dp_path")"
        DP_WORKDIR="$dp_work_dir" run_cmd 30 "$dp_path" "--version"
        add_section "DP VERSION" "$(fmt_result)"
        DP_WORKDIR="$dp_work_dir" run_cmd 60 "$dp_path" "plugin" "list"
        add_section "DP PLUGINS" "$(fmt_result)"
    else
        add_section "DP DIAGNOSTICS" "Skipped because managed dp is not installed."
    fi

    local current_debug_logs
    current_debug_logs="$(get_changed_debug_logs "$debug_directory" "${debug_snapshot[@]}")"
    if [[ -z "$current_debug_logs" ]]; then
        add_section "CURRENT RUN DEBUG LOGS" "No new or updated debug logs found in: $debug_directory"
    else
        local log_file
        while IFS= read -r log_file; do
            [[ -n "$log_file" ]] || continue
            add_file_content_to_report "$log_file" "$MAX_LOG_FILE_BYTES"
        done <<< "$current_debug_logs"
    fi

    local recent_logs
    recent_logs="$(get_recent_log_files | sort -k1,1)"
    if [[ -n "$recent_logs" ]]; then
        local recent_file
        while IFS= read -r recent_file; do
            [[ -n "$recent_file" ]] || continue
            local already=false lf
            while IFS= read -r lf; do
                [[ "$lf" == "$recent_file" ]] && already=true
            done <<< "$current_debug_logs"
            if [[ "$already" == false ]]; then
                add_file_content_to_report "$recent_file" "$MAX_LOG_FILE_BYTES"
            fi
        done <<< "$recent_logs"
    fi
}

main() {
    local output_path="" library_mode=false
    while (($#)); do
        case "$1" in
            --output|-o) output_path="${2:-}"; shift 2 ;;
            --output=*) output_path="${1#*=}"; shift ;;
            --library) library_mode=true; shift ;;
            *) shift ;;
        esac
    done

    if [[ "$library_mode" == true ]]; then
        return 0
    fi

    if [[ -z "$output_path" ]]; then
        local base_directory="$(pwd)"
        if ! touch "$base_directory/.nessy-write-probe-$$" 2>/dev/null; then
            base_directory="${TMPDIR:-/tmp}"
        else
            rm -f "$base_directory/.nessy-write-probe-$$"
        fi
        output_path="$base_directory/nessy-macos-diagnostics-$(date +%Y%m%d-%H%M%S).txt"
    fi

    echo "Collecting Nessy CLI Desktop diagnostics. This may take several minutes." >&2
    invoke_nessy_macos_diagnostics > "$output_path"
    local result_path="$output_path"
    local size
    size="$(stat -f%z "$result_path")"
    echo "Diagnostic report: $result_path" >&2
    echo "Size: $size bytes" >&2
}

if [[ -z "${BASH_SOURCE[0]:-}" ]] || [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    main "$@"
fi