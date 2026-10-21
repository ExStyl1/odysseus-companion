#!/bin/bash

set -euo pipefail

release_dir="${1:-packages/desktop/apps/electron/release}"
expected_team_id="35CMT9F8X3"
expected_bundle_id="ru.tfinance.nessy-cli.desktop"
temp_root=$(mktemp -d)
mounted_volume=""

cleanup() {
    if [ -n "$mounted_volume" ]; then
        hdiutil detach "$mounted_volume" -quiet || true
    fi
    rm -rf "$temp_root"
}
trap cleanup EXIT

signature_field() {
    /usr/bin/codesign -d -vvv "$2" 2>&1 | sed -n "s/^$1=//p" | head -1
}

verify_signed_code() {
    local code_path="$1"
    /usr/bin/codesign --verify --strict --verbose=2 "$code_path"

    local team_id
    team_id=$(signature_field TeamIdentifier "$code_path")
    if [ "$team_id" != "$expected_team_id" ]; then
        echo "Unexpected TeamIdentifier '$team_id': $code_path" >&2
        return 1
    fi
}

verify_app() {
    local app_path="$1"
    local require_stapled_ticket="${2:-true}"
    /usr/bin/codesign --verify --deep --strict --verbose=2 "$app_path"
    if [ "$require_stapled_ticket" = "true" ]; then
        xcrun stapler validate "$app_path"
    fi

    local team_id bundle_id
    team_id=$(signature_field TeamIdentifier "$app_path")
    bundle_id=$(signature_field Identifier "$app_path")
    if [ "$team_id" != "$expected_team_id" ] || [ "$bundle_id" != "$expected_bundle_id" ]; then
        echo "Unexpected app identity: $bundle_id ($team_id)" >&2
        return 1
    fi

    local executable_arch bun_path uv_path
    executable_arch=$(/usr/bin/file -b "$app_path/Contents/MacOS/Nessy CLI Desktop")
    if [[ "$executable_arch" == *"arm64"* ]]; then
        executable_arch="arm64"
    elif [[ "$executable_arch" == *"x86_64"* ]]; then
        executable_arch="x64"
    else
        echo "Unable to determine app architecture: $executable_arch" >&2
        return 1
    fi

    bun_path="$app_path/Contents/Resources/app/vendor/bun/darwin-$executable_arch/bun"
    uv_path="$app_path/Contents/Resources/app/resources/bin/darwin-$executable_arch/uv"
    for runtime_path in "$bun_path" "$uv_path"; do
        if [ ! -x "$runtime_path" ]; then
            echo "Required bundled runtime is missing or not executable: $runtime_path" >&2
            return 1
        fi
        if ! /usr/bin/file -b "$runtime_path" | grep -q "$([ "$executable_arch" = "x64" ] && echo x86_64 || echo arm64)"; then
            echo "Bundled runtime architecture does not match $executable_arch: $runtime_path" >&2
            return 1
        fi
    done

    while IFS= read -r -d '' file_path; do
        if /usr/bin/file -b "$file_path" | grep -q 'Mach-O'; then
            verify_signed_code "$file_path"
        fi
    done < <(find "$app_path" -type f -print0)

    /usr/sbin/spctl --assess --type execute --verbose=2 "$app_path"
}

shopt -s nullglob
zip_paths=("$release_dir"/*.zip)
dmg_paths=("$release_dir"/*.dmg)
if [ "${#zip_paths[@]}" -eq 0 ] || [ "${#dmg_paths[@]}" -eq 0 ]; then
    echo "Expected macOS ZIP and DMG release artifacts in $release_dir" >&2
    exit 1
fi

for zip_path in "${zip_paths[@]}"; do
    extract_dir=$(mktemp -d "$temp_root/zip.XXXXXX")
    /usr/bin/ditto -x -k "$zip_path" "$extract_dir"
    app_paths=("$extract_dir"/*.app)
    if [ "${#app_paths[@]}" -ne 1 ]; then
        echo "Expected one app bundle in $zip_path" >&2
        exit 1
    fi
    verify_app "${app_paths[0]}" true
done

for dmg_path in "${dmg_paths[@]}"; do
    xcrun stapler validate "$dmg_path"
    mount_dir=$(mktemp -d "$temp_root/dmg.XXXXXX")
    hdiutil attach -readonly -nobrowse -mountpoint "$mount_dir" "$dmg_path" -quiet
    mounted_volume="$mount_dir"
    app_paths=("$mount_dir"/*.app)
    if [ "${#app_paths[@]}" -ne 1 ]; then
        echo "Expected one app bundle in $dmg_path" >&2
        exit 1
    fi
    verify_app "${app_paths[0]}" false
    hdiutil detach "$mount_dir" -quiet
    mounted_volume=""
done

echo "Verified macOS release artifacts for Apple Team $expected_team_id"
