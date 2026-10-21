# Installation Guide for Nessy CLI with Source Tracking

This guide describes the source-tracking installation scripts for Nessy CLI.
The scripts prefer standalone release archives and can fall back to npm when a
standalone archive is not available.

## Overview

The installers are intentionally lightweight:

- They try a standalone archive first by default.
- They do not install Node.js, NVM, or any other Node version manager.
- They do not edit npm config or shell profiles.
- They do not start `nessy` automatically after installation.
- They store source information in `~/.nessy/source.json` or
  `%USERPROFILE%\.nessy\source.json` when `--source` is provided.

Standalone archives include a private Node.js runtime, so users do not need a
local Node.js installation on the standalone path. Node.js 20 or newer and npm
are only required when the installer falls back to npm or when
`--method npm` is used.

## Installation Scripts

- Linux/macOS: `install-nessy-with-source-new.sh`
- Windows: `install-nessy-with-source-new.bat`
- Windows PowerShell: `install-nessy-with-source-new.ps1`

## Release Artifacts

Standalone releases publish these standalone archives:

- `nessy-cli-darwin-arm64.tar.gz`
- `nessy-cli-darwin-x64.tar.gz`
- `nessy-cli-linux-arm64.tar.gz`
- `nessy-cli-linux-x64.tar.gz`
- `nessy-cli-win-x64.zip`
- `SHA256SUMS`

Archive layout:

```text
nessy-cli/
  bin/nessy
  bin/nessy.cmd
  lib/cli.js
  node/
  package.json
  README.md
  LICENSE
  manifest.json
```

## Install Methods

The default method is `detect`:

1. Detect the current platform.
2. Try to download and install the matching standalone archive.
3. Verify the archive with `SHA256SUMS`.
4. Fall back to npm if the standalone archive is not available.

You can force a method:

```bash
bash install-nessy-with-source-new.sh --method standalone
bash install-nessy-with-source-new.sh --method npm
```

```bat
install-nessy-with-source-new.bat --method standalone
install-nessy-with-source-new.bat --method npm
```

## Optional Native Modules

The standalone archives bundle Nessy CLI and a private Node.js runtime. They do
not currently install npm optional native modules such as `node-pty` and
`@teddyzhu/clipboard`. Nessy CLI is designed to degrade when these optional
modules are absent, but terminal pty behavior and clipboard image support may
not be identical to an npm installation.

Use `--method npm` if you specifically need npm to resolve optional native
modules for the current machine.

## macOS Usage

Download and run the installer with the system `curl`:

```bash
/usr/bin/curl -fsSL https://s3-msk.tinkoff.ru/nestor-companion/nessy-cli/installation/install-nessy.sh | bash
```

The absolute path deliberately bypasses other `curl` installations on `PATH`,
such as Anaconda's, which may use a different certificate store.

## Linux Usage

Use the system `curl` from either standard location:

```bash
CURL=/usr/bin/curl
[ -x "$CURL" ] || CURL=/bin/curl
"$CURL" -fsSL https://s3-msk.tinkoff.ru/nestor-companion/nessy-cli/installation/install-nessy.sh | bash
```

This bypasses other `curl` installations on `PATH`, such as Anaconda's.

## Linux/macOS Installer Options

```bash
# Default: standalone archive with npm fallback
bash install-nessy-with-source-new.sh

# Record a source value
bash install-nessy-with-source-new.sh --source s3

# Use npm explicitly
bash install-nessy-with-source-new.sh --method npm --registry https://artifactory.tcsbank.ru/artifactory/api/npm/npm-all/

# Use specific version from S3
bash install-nessy-with-source-new.sh --version 0.12.0-beta.0

# Install an offline archive
# SHA256SUMS must be in the same directory.
bash install-nessy-with-source-new.sh --archive ./nessy-cli-linux-x64.tar.gz
```

Standalone installs to:

- Runtime: `~/.local/lib/nessy-cli`
- Shim: `~/.local/bin/nessy`

Override with `NESSY_INSTALL_ROOT`, `NESSY_INSTALL_LIB_PARENT`,
`NESSY_INSTALL_LIB_DIR`, or `NESSY_INSTALL_BIN_DIR` when needed.

## Windows Usage

From PowerShell:

```powershell
irm https://s3-msk.tinkoff.ru/nestor-companion/installation/v2/install-nessy.ps1 | iex
```

The PowerShell entrypoint uses `Invoke-WebRequest` and then runs the batch
installer. The batch installer verifies the standalone archive against the
`SHA256SUMS` from the selected version directory.

Download and run the installer with the system `curl.exe`:

```bat
"%SystemRoot%\System32\curl.exe" -fsSL -o "%TEMP%\install-nessy.bat" https://s3-msk.tinkoff.ru/nestor-companion/nessy-cli/installation/install-nessy.bat && "%TEMP%\install-nessy.bat"
```

The absolute path bypasses other `curl.exe` installations on `PATH`, including
ones installed by Anaconda, and uses the Windows certificate store.

```bat
REM Default: standalone archive with npm fallback
install-nessy-with-source-new.bat

# Record a source value
install-nessy-with-source-new.bat --source s3

REM Use npm explicitly
install-nessy-with-source-new.bat --method npm --registry https://registry.npmjs.org

REM Use the Aliyun standalone mirror
install-nessy-with-source-new.bat --mirror aliyun

REM Install an offline archive
REM SHA256SUMS must be in the same directory.
install-nessy-with-source-new.bat --archive nessy-cli-win-x64.zip
```

Standalone installs to:

- Runtime: `%LOCALAPPDATA%\nessy-cli\nessy-cli`
- Shim: `%LOCALAPPDATA%\nessy-cli\bin\nessy.cmd`

Override with `NESSY_INSTALL_ROOT`, `NESSY_INSTALL_LIB_DIR`, or
`NESSY_INSTALL_BIN_DIR` when needed.

Restart the terminal if `nessy` is not immediately available on PATH.

## Mirrors and Overrides

Options:

- `--method detect|standalone|npm`
- `--archive PATH`
- `--version VERSION`
- `--registry REGISTRY`
- `--source SOURCE`

Environment variables:

- `NESSY_INSTALL_METHOD`
- `NESSY_INSTALL_MIRROR`
- `NESSY_INSTALL_BASE_URL`
- `NESSY_INSTALL_ARCHIVE`
- `NESSY_INSTALL_VERSION`
- `NESSY_NPM_REGISTRY`

Use `--base-url` for private mirrors. The URL must contain
`nessy-cli-<target>` archives and `SHA256SUMS` in the same directory. Custom
base URLs must use `https://`.

For Aliyun OSS/CDN, release publishing must upload byte-identical artifacts to
both the versioned directory, for example `v0.16.0/`, and the `latest/`
directory used by the default installer path.

## Supported Source Values

The source value may only contain letters, numbers, dot, underscore, and dash.
Common values are:

- `s3`
- `npm`
- `internal`
- `local-build`

## Source Tracking

When `--source` or `-s` is provided, the installer writes:

```json
{
  "source": "s3"
}
```

Locations:

- Linux/macOS: `~/.nessy/source.json`
- Windows: `%USERPROFILE%\.nessy\source.json`

The telemetry logger reads this file when available. Missing, invalid, or
unreadable source files are ignored.

## Manual Installation

If source tracking is not needed and Node.js 20 or newer is already available:

```bash
npm install -g @nestor/nessy-cli@latest
```

Homebrew users can also install Nessy CLI with:

```bash
brew install nessy-cli
```

## Troubleshooting

### Standalone Archive Missing

In `detect` mode, the installer falls back to npm. In `standalone` mode, install
fails so that automation can detect the missing artifact.

### Node.js Missing or Too Old

This only blocks npm installation. Install or activate Node.js 20 or newer, then
rerun the installer with `--method npm` or let `detect` fall back again.

### npm Missing

Install a Node.js distribution that includes npm, then rerun the installer.

### Permission Errors During npm Install

The installers do not rewrite npm prefix settings. If global npm installation
fails with a permission error, fix the npm global install location or use a
user-owned Node.js installation, then rerun:

```bash
npm install -g @nestor/nessy-cli@latest --registry https://artifactory.tcsbank.ru/artifactory/api/npm/npm-all/
```

### nessy Is Not on PATH After Installation

Restart the terminal first. For standalone installs, add the shim directory:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

For npm installs, add npm's global binary directory. On Linux/macOS this is
usually:

```bash
export PATH="$(npm prefix -g)/bin:$PATH"
```

On Windows standalone installs, add this directory to PATH:

```bat
%LOCALAPPDATA%\nessy-cli\bin
```
