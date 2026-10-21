# Build script for Windows NSIS installer
# Usage: powershell -ExecutionPolicy Bypass -File scripts/build-win.ps1

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ElectronDir = Split-Path -Parent $ScriptDir
$RootDir = Split-Path -Parent (Split-Path -Parent $ElectronDir)

# Configuration
$BunVersion = "bun-v1.3.9"  # Pinned version for reproducible builds

Write-Host "=== Building Nessy Desktop Windows Installer using electron-builder ===" -ForegroundColor Cyan

# P6.980 - refuse HERE, before any packaging work, when the update feed is unset.
#
# apps/electron/electron-builder.yml's publish block interpolates both of these
# (${env.NESSY_DESKTOP_UPDATE_URL} / ${env.NESSY_DESKTOP_UPDATE_CHANNEL}), and
# electron-builder expands them at the PACKAGING step - the last one. Measured on
# macOS: the whole .app is built (about two minutes locally) and the run then
# dies with `cannot expand pattern "${env.NESSY_DESKTOP_UPDATE_URL}"`, a message
# that names the variable but not the file, the fix, or the value to use. Same
# publish block, same three platform scripts, same refusal (build-dmg.sh,
# build-linux.sh).
$MissingUpdateVars = @()
if ([string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable("NESSY_DESKTOP_UPDATE_URL"))) {
    $MissingUpdateVars += "NESSY_DESKTOP_UPDATE_URL"
}
if ([string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable("NESSY_DESKTOP_UPDATE_CHANNEL"))) {
    $MissingUpdateVars += "NESSY_DESKTOP_UPDATE_CHANNEL"
}
if ($MissingUpdateVars.Count -gt 0) {
    Write-Host "ERROR: the update feed is not configured: $($MissingUpdateVars -join ', ')" -ForegroundColor Red
    Write-Host ""
    Write-Host "apps/electron/electron-builder.yml's publish block reads both variables, and"
    Write-Host "electron-builder expands them only when it packages - so without this check the"
    Write-Host "build would run for minutes and then die on 'cannot expand pattern'."
    Write-Host ""
    Write-Host "The documented values (apps/electron/README.md, 'Local unsigned macOS release"
    Write-Host "rehearsal' - the same two variables on every platform):"
    Write-Host '  $env:NESSY_DESKTOP_UPDATE_URL = "https://updates.invalid/dev"'
    Write-Host '  $env:NESSY_DESKTOP_UPDATE_CHANNEL = "dev"'
    Write-Host ""
    Write-Host "Release jobs set NESSY_DESKTOP_UPDATE_URL to NESSY_DESKTOP_DEV_UPDATE_URL and"
    Write-Host "NESSY_DESKTOP_UPDATE_CHANNEL to dev (.gitlab-ci.yml)."
    exit 1
}

# The Claude SDK native binary ships by default: the runtime defaults ON
# (owner decision 2026-08-06; only subscription cards stay flag-gated).
# NESSY_FEATURE_CLAUDE_RUNTIME=0 builds without it — unless an explicit
# NESSY_FEATURE_PROVIDER_CLAUDE=1 re-enables it (the Pro/Max subscription card
# cannot work without the runtime). Mirrors isAnthropicBackendEnabled() in
# packages/shared/src/feature-flags.ts.
$ClaudeProviderFlag = [Environment]::GetEnvironmentVariable("NESSY_FEATURE_PROVIDER_CLAUDE")
if ($null -eq $ClaudeProviderFlag) { $ClaudeProviderFlag = "" }
$ClaudeRuntimeFlag = [Environment]::GetEnvironmentVariable("NESSY_FEATURE_CLAUDE_RUNTIME")
if ($null -eq $ClaudeRuntimeFlag) { $ClaudeRuntimeFlag = "" }
$ClaudeRuntimeOn = $ClaudeRuntimeFlag.ToLowerInvariant() -notin @("0", "false", "no", "off")
$ClaudeEnabled = $ClaudeRuntimeOn -or ($ClaudeProviderFlag.ToLowerInvariant() -in @("1", "true", "yes", "on"))
$ClaudeBundleStatus = if ($ClaudeEnabled) { "enabled" } else { "disabled" }
Write-Host "Claude SDK native binary bundle: $ClaudeBundleStatus"

# Debug: System information
Write-Host ""
Write-Host "=== Debug: System Information ===" -ForegroundColor Magenta
Write-Host "OS: $([System.Environment]::OSVersion.VersionString)"
Write-Host "PowerShell: $($PSVersionTable.PSVersion)"
Write-Host "Hostname: $env:COMPUTERNAME"
Write-Host "User: $env:USERNAME"
Write-Host "Temp: $env:TEMP"
Write-Host "Working Dir: $(Get-Location)"

# Debug: Check Windows Defender status
Write-Host ""
Write-Host "=== Debug: Windows Defender Status ===" -ForegroundColor Magenta
try {
    $defenderStatus = Get-MpComputerStatus -ErrorAction SilentlyContinue
    if ($defenderStatus) {
        Write-Host "Real-time Protection: $($defenderStatus.RealTimeProtectionEnabled)"
        Write-Host "Antivirus Enabled: $($defenderStatus.AntivirusEnabled)"
        Write-Host "On Access Protection: $($defenderStatus.OnAccessProtectionEnabled)"
        Write-Host "IO AV Protection: $($defenderStatus.IoavProtectionEnabled)"
    } else {
        Write-Host "Could not get Defender status"
    }
} catch {
    Write-Host "Defender status check failed: $_"
}

# Debug: List exclusions
Write-Host ""
Write-Host "=== Debug: Defender Exclusions ===" -ForegroundColor Magenta
try {
    $prefs = Get-MpPreference -ErrorAction SilentlyContinue
    if ($prefs.ExclusionPath) {
        Write-Host "Path Exclusions: $($prefs.ExclusionPath -join ', ')"
    }
    if ($prefs.ExclusionProcess) {
        Write-Host "Process Exclusions: $($prefs.ExclusionProcess -join ', ')"
    }
} catch {
    Write-Host "Could not get exclusions: $_"
}
Write-Host ""

# 0. Kill any lingering processes that might lock files
Write-Host "Killing any lingering node/npm processes..."
$processesToKill = @('node', 'npm', 'electron', 'electron-builder')
foreach ($procName in $processesToKill) {
    Get-Process -Name $procName -ErrorAction SilentlyContinue | ForEach-Object {
        Write-Host "  Killing $($_.ProcessName) (PID: $($_.Id))..." -ForegroundColor Yellow
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
}
# Give processes time to fully terminate
Start-Sleep -Seconds 2

# 1. Clean previous build artifacts (with retry for locked files)
Write-Host "Cleaning previous builds..."
$foldersToClean = @(
    "$ElectronDir\vendor",
    "$ElectronDir\node_modules\@anthropic-ai",
    "$ElectronDir\packages",
    "$ElectronDir\release"
)
foreach ($folder in $foldersToClean) {
    if (Test-Path $folder) {
        $retries = 3
        for ($i = 1; $i -le $retries; $i++) {
            try {
                Remove-Item -Recurse -Force $folder -ErrorAction Stop
                break
            } catch {
                if ($i -eq $retries) { throw }
                Write-Host "  Retrying cleanup of $folder (attempt $i)..." -ForegroundColor Yellow
                Start-Sleep -Seconds 2
            }
        }
    }
}

# 2. Install dependencies
Write-Host "Installing dependencies..."
Push-Location $RootDir
$PreviousElectronSkip = $env:ELECTRON_SKIP_BINARY_DOWNLOAD
try {
    $env:ELECTRON_SKIP_BINARY_DOWNLOAD = "true"
    bun install --frozen-lockfile
} finally {
    $env:ELECTRON_SKIP_BINARY_DOWNLOAD = $PreviousElectronSkip
    Pop-Location
}

# 3. Download Bun binary for Windows
# Use baseline build - works on all x64 CPUs (no AVX2 requirement)
Write-Host "Downloading Bun $BunVersion for Windows x64 (baseline)..."
New-Item -ItemType Directory -Force -Path "$ElectronDir\vendor\bun" | Out-Null

$BunDownload = "bun-windows-x64-baseline"
$TempDir = Join-Path $env:TEMP "bun-download-$(Get-Random)"
New-Item -ItemType Directory -Force -Path $TempDir | Out-Null

try {
    # Download binary and checksums
    $ZipUrl = "https://github.com/oven-sh/bun/releases/download/$BunVersion/$BunDownload.zip"
    $ChecksumUrl = "https://github.com/oven-sh/bun/releases/download/$BunVersion/SHASUMS256.txt"

    Write-Host "Downloading from $ZipUrl..."
    Invoke-WebRequest -Uri $ZipUrl -OutFile "$TempDir\$BunDownload.zip"
    Invoke-WebRequest -Uri $ChecksumUrl -OutFile "$TempDir\SHASUMS256.txt"

    # Verify checksum
    Write-Host "Verifying checksum..."
    $ExpectedHash = (Get-Content "$TempDir\SHASUMS256.txt" | Select-String "$BunDownload.zip").ToString().Split(" ")[0]
    $ActualHash = (Get-FileHash "$TempDir\$BunDownload.zip" -Algorithm SHA256).Hash.ToLower()

    if ($ActualHash -ne $ExpectedHash) {
        throw "Checksum verification failed! Expected: $ExpectedHash, Got: $ActualHash"
    }
    Write-Host "Checksum verified successfully" -ForegroundColor Green

    # Extract and install using robocopy for better file handle management
    Write-Host "Extracting Bun..."
    Expand-Archive -Path "$TempDir\$BunDownload.zip" -DestinationPath $TempDir -Force

    # Unblock in temp first (before copy)
    Unblock-File -Path "$TempDir\$BunDownload\bun.exe" -ErrorAction SilentlyContinue

    # Use robocopy with retries - handles transient file locks better than Copy-Item
    # /R:5 = 5 retries, /W:3 = 3 second wait between retries, /NP = no progress, /NFL /NDL = quiet
    Write-Host "Copying bun.exe with robocopy..."
    $robocopyResult = robocopy "$TempDir\$BunDownload" "$ElectronDir\vendor\bun" "bun.exe" /R:5 /W:3 /NP /NFL /NDL
    # Robocopy exit codes: 0-7 are success, 8+ are errors
    if ($LASTEXITCODE -ge 8) {
        throw "robocopy failed with exit code $LASTEXITCODE"
    }

    $BunExePath = "$ElectronDir\vendor\bun\bun.exe"
    Write-Host "Bun extracted to: $BunExePath" -ForegroundColor Green

    # Give Windows time to release any file handles from the copy
    Write-Host "Waiting for file handles to release..."
    Start-Sleep -Seconds 3
} finally {
    Remove-Item -Recurse -Force $TempDir -ErrorAction SilentlyContinue
}

# 4. Copy SDK from root node_modules (monorepo hoisting).
# Since SDK 0.2.113: thin core + per-platform binary package.
# See apps/electron/scripts/build-dmg.sh for the full rationale.
$SdkSource = "$RootDir\node_modules\@anthropic-ai\claude-agent-sdk"
if (-not (Test-Path $SdkSource)) {
    Write-Host "ERROR: SDK core not found at $SdkSource" -ForegroundColor Red
    Write-Host "Run 'bun install' from the repository root first."
    exit 1
}
Write-Host "Copying SDK core..."
New-Item -ItemType Directory -Force -Path "$ElectronDir\node_modules\@anthropic-ai" | Out-Null
Remove-Item -Recurse -Force "$ElectronDir\node_modules\@anthropic-ai\claude-agent-sdk" -ErrorAction SilentlyContinue
Copy-Item -Recurse -Force $SdkSource "$ElectronDir\node_modules\@anthropic-ai\"

# 4a. Resolve the target arch's binary package (cross-fetch from npm if absent).
# Target arch is hard-coded x64 — Windows arm64 is not currently shipped.
$AliasDest = "$ElectronDir\node_modules\@anthropic-ai\claude-agent-sdk-binary"
Remove-Item -Recurse -Force $AliasDest -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $AliasDest | Out-Null
if ($ClaudeEnabled) {
    $SdkBinPkg = "claude-agent-sdk-win32-x64"
    $SdkBinSource = "$RootDir\node_modules\@anthropic-ai\$SdkBinPkg"
    if (-not (Test-Path $SdkBinSource)) {
        Write-Host "Cross-arch build: $SdkBinPkg not in node_modules — fetching from npm..."
        $SdkVersion = (node -p "require('$RootDir/package.json'.replace(/\\/g, '/')).dependencies['@anthropic-ai/claude-agent-sdk']").Trim('"')
        $PkgTmp = New-Item -ItemType Directory -Path ([System.IO.Path]::Combine($env:TEMP, [System.Guid]::NewGuid().ToString()))
        try {
            Push-Location $PkgTmp
            npm pack "@anthropic-ai/$SdkBinPkg@$SdkVersion" | Out-Null
            $Tarball = Get-ChildItem -Filter "anthropic-ai-*.tgz" | Select-Object -First 1
            tar -xzf $Tarball.Name
            Pop-Location
            New-Item -ItemType Directory -Force -Path $SdkBinSource | Out-Null
            Copy-Item -Recurse -Force "$PkgTmp\package\*" $SdkBinSource
        } finally {
            Remove-Item -Recurse -Force $PkgTmp -ErrorAction SilentlyContinue
        }
    }

    if (-not (Test-Path $SdkBinSource)) {
        Write-Host "ERROR: SDK native binary package ($SdkBinPkg) not found at $SdkBinSource" -ForegroundColor Red
        exit 1
    }

    Write-Host "Staging SDK native binary as claude-agent-sdk-binary alias..."
    Copy-Item -Recurse -Force "$SdkBinSource\*" $AliasDest

    $BinPath = "$AliasDest\claude.exe"
    if (-not (Test-Path $BinPath)) {
        Write-Host "ERROR: Native binary not found at $BinPath" -ForegroundColor Red
        exit 1
    }
    $BinSize = (Get-Item $BinPath).Length
    if ($BinSize -lt 50000000) {
        Write-Host "ERROR: claude.exe is only $BinSize bytes; the SDK's native binary has been 222-307 MB across every version we have shipped (it SHRANK at 0.3.247 -- 222-242 MB across the eight platform packages, under the 247 this sentence used to claim as a floor), so this is a botched copy or the wrong tarball" -ForegroundColor Red
        exit 1
    }
    Write-Host "  Native binary: $([math]::Round($BinSize / 1MB)) MB"
} else {
    Write-Host "Skipping Claude SDK native binary (Claude stack disabled)."
}

# 5. Copy ripgrep (sourced from @vscode/ripgrep since 0.2.113).
# F1.746: @vscode/ripgrep >=1.17 ships the binary only in its per-platform
# optional package; the root package's bin\rg.exe is an old-layout leftover (and
# `bun pm trust` has no script to run, docs/agents/traps.md). The win32-x64
# binary is staged into the Electron copy, which is the path the packaged
# resolver reads; the root node_modules tree is never written. This script
# is parked (.gitlab-ci.yml release-win), so this staging is parse-checked
# only; build-dmg.sh and build-linux.sh carry the same staging, and the
# packaged resolver reads the same path on every platform.
$RgSource = "$RootDir\node_modules\@vscode\ripgrep"
if (-not (Test-Path $RgSource)) {
    Write-Host "ERROR: @vscode/ripgrep not installed" -ForegroundColor Red
    Write-Host "Run 'bun install --frozen-lockfile'."
    exit 1
}
$RgPlatformSource = "$RootDir\node_modules\@vscode\ripgrep-win32-x64\bin\rg.exe"
if (-not (Test-Path $RgPlatformSource)) {
    Write-Host "ERROR: @vscode/ripgrep-win32-x64 (the platform ripgrep binary) is missing" -ForegroundColor Red
    Write-Host "Run 'bun install --frozen-lockfile'."
    exit 1
}
Write-Host "Copying @vscode/ripgrep..."
$RgStaged = "$ElectronDir\node_modules\@vscode\ripgrep"
New-Item -ItemType Directory -Force -Path "$ElectronDir\node_modules\@vscode" | Out-Null
Remove-Item -Recurse -Force $RgStaged -ErrorAction SilentlyContinue
Copy-Item -Recurse -Force $RgSource "$ElectronDir\node_modules\@vscode\"
New-Item -ItemType Directory -Force -Path "$RgStaged\bin" | Out-Null
Copy-Item -Force $RgPlatformSource "$RgStaged\bin\rg.exe"
if (-not (Test-Path "$RgStaged\bin\rg.exe")) {
    Write-Host "ERROR: copying the win32-x64 ripgrep binary failed" -ForegroundColor Red
    exit 1
}

# 6. Stage the network interceptor and its DERIVED import closure (P6.820) —
#    for the Pi subprocess; Claude no longer uses --preload (Phase 2 will move
#    that to SDK hooks or a local proxy). The three names this loop used to
#    spell by hand were three of SEVEN; `stageInterceptorSources` walks the
#    interceptor's own imports, so no script can carry a short list any more.
Write-Host "Staging interceptor sources (for Pi subprocess)..."
$PrevStageInterceptorRootDir = [Environment]::GetEnvironmentVariable("NESSY_STAGE_INTERCEPTOR_ROOT_DIR")
$PrevStageInterceptorElectronDir = [Environment]::GetEnvironmentVariable("NESSY_STAGE_INTERCEPTOR_ELECTRON_DIR")
try {
    $env:NESSY_STAGE_INTERCEPTOR_ROOT_DIR = $RootDir
    $env:NESSY_STAGE_INTERCEPTOR_ELECTRON_DIR = $ElectronDir
    Push-Location $RootDir
    try {
        bun -e 'import { copyInterceptor } from "./scripts/build/common.ts"; copyInterceptor({ rootDir: process.env.NESSY_STAGE_INTERCEPTOR_ROOT_DIR, electronDir: process.env.NESSY_STAGE_INTERCEPTOR_ELECTRON_DIR })'
        if ($LASTEXITCODE -ne 0) { throw "Interceptor staging failed" }
    } finally {
        Pop-Location
    }
} finally {
    if ($null -eq $PrevStageInterceptorRootDir) { Remove-Item Env:NESSY_STAGE_INTERCEPTOR_ROOT_DIR -ErrorAction SilentlyContinue } else { $env:NESSY_STAGE_INTERCEPTOR_ROOT_DIR = $PrevStageInterceptorRootDir }
    if ($null -eq $PrevStageInterceptorElectronDir) { Remove-Item Env:NESSY_STAGE_INTERCEPTOR_ELECTRON_DIR -ErrorAction SilentlyContinue } else { $env:NESSY_STAGE_INTERCEPTOR_ELECTRON_DIR = $PrevStageInterceptorElectronDir }
}

# 6. Build Electron app
Write-Host "Building Electron app..."

# Build main process with OAuth credentials
Write-Host "  Building main process..."
$MainArgs = @(
    "apps/electron/src/main/index.ts",
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--outfile=apps/electron/dist/main.cjs",
    "--external:electron",
    # SDK 0.3.x is pure ESM and calls createRequire(import.meta.url) at module init.
    # esbuild's CJS bundling leaves import.meta.url undefined for inlined ESM, crashing
    # the app on load (ERR_INVALID_ARG_VALUE). Externalize it so Node loads it natively
    # as ESM — the SDK core is staged into the app's node_modules above (step 4).
    # Must stay in sync with package.json build:main and scripts/electron-dev.ts.
    "--external:@anthropic-ai/claude-agent-sdk"
)
# Add OAuth defines if env vars are set
if ($env:GOOGLE_OAUTH_CLIENT_ID) {
    $MainArgs += "--define:process.env.GOOGLE_OAUTH_CLIENT_ID=`"'$env:GOOGLE_OAUTH_CLIENT_ID'`""
}
if ($env:GOOGLE_OAUTH_CLIENT_SECRET) {
    $MainArgs += "--define:process.env.GOOGLE_OAUTH_CLIENT_SECRET=`"'$env:GOOGLE_OAUTH_CLIENT_SECRET'`""
}
# Keep this list in sync with scripts/electron-build-main.ts getBuildDefines().
foreach ($varName in @(
    "NESSY_FEATURE_CODEX_RUNTIME",
    "NESSY_FEATURE_CLAUDE_RUNTIME",
    "NESSY_FEATURE_PROVIDER_NESSY",
    "NESSY_FEATURE_PROVIDER_CLAUDE",
    "NESSY_FEATURE_PROVIDER_CHATGPT",
    "NESSY_FEATURE_PROVIDER_API_KEY",
    "NESSY_FEATURE_PROVIDER_LOCAL"
)) {
    $value = [Environment]::GetEnvironmentVariable($varName)
    if ($null -eq $value) { $value = "" }
    $MainArgs += "--define:process.env.$varName=`"'$value'`""
}
Push-Location $RootDir
try {
    & npx esbuild @MainArgs
    if ($LASTEXITCODE -ne 0) { throw "Main process build failed" }
} finally {
    Pop-Location
}

# Build preload
Write-Host "  Building preload..."
Push-Location $RootDir
try {
    bun run electron:build:preload
    if ($LASTEXITCODE -ne 0) { throw "Preload build failed" }
} finally {
    Pop-Location
}

# Build renderer (frontend)
Write-Host "  Building renderer (frontend)..."
Push-Location $RootDir
try {
    # Clean previous renderer build
    $RendererDir = "$ElectronDir\dist\renderer"
    if (Test-Path $RendererDir) { Remove-Item -Recurse -Force $RendererDir }

    # P6.991 - route through the gated script rather than calling vite directly.
    # `scripts/electron-build-renderer.ts` is the one entry point that REFUSES on a
    # "has been externalized for browser compatibility" warning (P6.981): that warning
    # is the leading indicator of a hard rollup error, and a direct `vite build` here
    # would print it and ship. build-dmg.sh and build-linux.sh both reach the gate
    # through `bun run electron:build`; Windows was the only platform that bypassed it.
    # The script also cleans dist/renderer itself, so the Remove-Item above is a no-op
    # on the second pass rather than a second policy.
    bun run electron:build:renderer
    if ($LASTEXITCODE -ne 0) { throw "Renderer build failed" }

    # Verify renderer was built
    if (-not (Test-Path "$RendererDir\index.html")) {
        throw "Renderer build verification failed: index.html not found"
    }
    Write-Host "  Renderer build verified: $RendererDir" -ForegroundColor Green
} finally {
    Pop-Location
}

# Stage helper servers before copying resources into dist.
Write-Host "  Staging helper servers..."
$PrevTargetPlatform = [Environment]::GetEnvironmentVariable("NESSY_TARGET_PLATFORM")
$PrevTargetArch = [Environment]::GetEnvironmentVariable("NESSY_TARGET_ARCH")
try {
    $env:NESSY_TARGET_PLATFORM = "win32"
    $env:NESSY_TARGET_ARCH = "x64"
    Push-Location $RootDir
    try {
        bun run scripts/stage-electron-servers.ts
        if ($LASTEXITCODE -ne 0) { throw "Helper server staging failed" }
    } finally {
        Pop-Location
    }
} finally {
    if ($null -eq $PrevTargetPlatform) { Remove-Item Env:NESSY_TARGET_PLATFORM -ErrorAction SilentlyContinue } else { $env:NESSY_TARGET_PLATFORM = $PrevTargetPlatform }
    if ($null -eq $PrevTargetArch) { Remove-Item Env:NESSY_TARGET_ARCH -ErrorAction SilentlyContinue } else { $env:NESSY_TARGET_ARCH = $PrevTargetArch }
}

# Copy all resources and bundled assets using the shared script.
# Single source of truth — matches Mac/Linux build (bun run build:copy).
# Copies: resources (icons, DMG bg), docs, tool-icons, themes, permissions, config-defaults.
Write-Host "  Copying resources and bundled assets..."
Push-Location $ElectronDir
try {
    bun scripts/copy-assets.ts
    if ($LASTEXITCODE -ne 0) { throw "Asset copy failed" }
    Write-Host "  Assets copied" -ForegroundColor Green
} finally {
    Pop-Location
}

# Plugin MCPs can declare uvx/python entrypoints. Ship the verified uv runtime
# instead of depending on a machine-level installation or PATH mutation.
Write-Host "Staging uv runtime..."
$PrevStageUvArch = [Environment]::GetEnvironmentVariable("NESSY_STAGE_UV_ARCH")
$PrevStageUvRootDir = [Environment]::GetEnvironmentVariable("NESSY_STAGE_UV_ROOT_DIR")
$PrevStageUvElectronDir = [Environment]::GetEnvironmentVariable("NESSY_STAGE_UV_ELECTRON_DIR")
try {
    $env:NESSY_STAGE_UV_ARCH = "x64"
    $env:NESSY_STAGE_UV_ROOT_DIR = $RootDir
    $env:NESSY_STAGE_UV_ELECTRON_DIR = $ElectronDir
    Push-Location $RootDir
    try {
        bun -e 'import { downloadUv } from "./scripts/build/common.ts"; await downloadUv({ platform: "win32", arch: process.env.NESSY_STAGE_UV_ARCH, upload: false, uploadLatest: false, uploadScript: false, rootDir: process.env.NESSY_STAGE_UV_ROOT_DIR, electronDir: process.env.NESSY_STAGE_UV_ELECTRON_DIR })'
        if ($LASTEXITCODE -ne 0) { throw "uv runtime staging failed" }
    } finally {
        Pop-Location
    }
} finally {
    if ($null -eq $PrevStageUvArch) { Remove-Item Env:NESSY_STAGE_UV_ARCH -ErrorAction SilentlyContinue } else { $env:NESSY_STAGE_UV_ARCH = $PrevStageUvArch }
    if ($null -eq $PrevStageUvRootDir) { Remove-Item Env:NESSY_STAGE_UV_ROOT_DIR -ErrorAction SilentlyContinue } else { $env:NESSY_STAGE_UV_ROOT_DIR = $PrevStageUvRootDir }
    if ($null -eq $PrevStageUvElectronDir) { Remove-Item Env:NESSY_STAGE_UV_ELECTRON_DIR -ErrorAction SilentlyContinue } else { $env:NESSY_STAGE_UV_ELECTRON_DIR = $PrevStageUvElectronDir }
}
$UvBinary = "$ElectronDir\resources\bin\win32-x64\uv.exe"
if (-not (Test-Path $UvBinary)) {
    throw "uv runtime staging failed: missing $UvBinary"
}

# Default ON (owner decision 2026-08-06) — NESSY_FEATURE_CODEX_RUNTIME=0 builds
# without the codex-app-server bundle.
$CodexRuntimeFlag = [Environment]::GetEnvironmentVariable("NESSY_FEATURE_CODEX_RUNTIME")
if ($null -eq $CodexRuntimeFlag) { $CodexRuntimeFlag = "" }
$CodexEnabled = $CodexRuntimeFlag.ToLowerInvariant() -notin @("0", "false", "no", "off")
$CodexBundleStatus = if ($CodexEnabled) { "enabled" } else { "disabled" }
Write-Host "Codex runtime bundle: $CodexBundleStatus"

# Executable plugin MCPs/hooks always require the pinned Windows restricted-token
# sandbox, independently of the optional Codex provider runtime.
Write-Host "Fetching Windows restricted-token sandbox runtime..."
Push-Location $RootDir
try {
    node scripts/fetch-codex.mjs --target=win32-x64 --windows-sandbox
    if ($LASTEXITCODE -ne 0) { throw "Windows sandbox runtime fetch failed" }
} finally {
    Pop-Location
}
$WindowsSandboxDir = "$ElectronDir\resources\bin\codex\win32-x64"
foreach ($SandboxBinary in @("codex.exe", "codex-command-runner.exe", "codex-windows-sandbox-setup.exe")) {
    if (-not (Test-Path "$WindowsSandboxDir\$SandboxBinary")) {
        throw "Windows sandbox runtime is incomplete: missing $SandboxBinary"
    }
}

if ($CodexEnabled) {
    Write-Host "Fetching codex-app-server for win32-x64..."
    Push-Location $RootDir
    try {
        node scripts/fetch-codex.mjs --target=win32-x64
        if ($LASTEXITCODE -ne 0) { throw "codex-app-server fetch failed" }
    } finally {
        Pop-Location
    }

    $CodexBin = "$ElectronDir\resources\bin\codex\win32-x64\codex-app-server.exe"
    if (-not (Test-Path $CodexBin)) {
        throw "codex-app-server (win32-x64) not found at $CodexBin; scripts/fetch-codex.mjs failed"
    }

    $CodexSize = (Get-Item $CodexBin).Length
    if ($CodexSize -lt 20000000) {
        throw "codex-app-server at $CodexBin is only $CodexSize bytes (expected ~50-210 MB)"
    }
    Write-Host "  codex-app-server: $([math]::Floor($CodexSize / 1MB)) MB"
    # F1.1216 — codex's own code-mode host travels with the app-server (codex
    # finds it beside its own executable; code_mode_only models have no tools
    # without it). The codex-integrity gate below requires it too.
    if (-not (Test-Path "$WindowsSandboxDir\codex-code-mode-host.exe")) {
        throw "codex-code-mode-host (win32-x64) not found beside $CodexBin; scripts/fetch-codex.mjs failed"
    }
} else {
    foreach ($CodexRuntimeBinary in @("codex-app-server.exe", "codex-code-mode-host.exe")) {
        $CodexAppServer = "$WindowsSandboxDir\$CodexRuntimeBinary"
        if (Test-Path $CodexAppServer) {
            Remove-Item -Force $CodexAppServer
        }
    }
    Write-Host "Skipping codex-app-server bundle; Windows sandbox runtime remains included."
}

# 7. Package with electron-builder
Write-Host "Packaging app with electron-builder..."

# Debug: Show bun.exe file info
Write-Host ""
Write-Host "=== Debug: bun.exe File Info ===" -ForegroundColor Magenta
$BunExe = "$ElectronDir\vendor\bun\bun.exe"
if (Test-Path $BunExe) {
    $fileInfo = Get-Item $BunExe
    Write-Host "Path: $($fileInfo.FullName)"
    Write-Host "Size: $([math]::Round($fileInfo.Length / 1MB, 2)) MB"
    Write-Host "Created: $($fileInfo.CreationTime)"
    Write-Host "Modified: $($fileInfo.LastWriteTime)"
    Write-Host "Attributes: $($fileInfo.Attributes)"

    # Check Zone.Identifier (Mark of the Web)
    $zoneFile = "$BunExe`:Zone.Identifier"
    if (Test-Path $zoneFile -ErrorAction SilentlyContinue) {
        Write-Host "Zone.Identifier: EXISTS (file may be blocked)" -ForegroundColor Yellow
    } else {
        Write-Host "Zone.Identifier: None (file is unblocked)"
    }

    # Check file hash
    $hash = (Get-FileHash $BunExe -Algorithm SHA256).Hash
    Write-Host "SHA256: $hash"
} else {
    Write-Host "ERROR: bun.exe not found at $BunExe" -ForegroundColor Red
}

# Debug: List vendor directory contents
Write-Host ""
Write-Host "=== Debug: vendor/bun Directory ===" -ForegroundColor Magenta
Get-ChildItem "$ElectronDir\vendor\bun" -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "  $($_.Name) - $($_.Length) bytes"
}

# Debug: Check for processes that might have files open
Write-Host ""
Write-Host "=== Debug: Potentially Relevant Processes ===" -ForegroundColor Magenta
$relevantProcesses = Get-Process | Where-Object {
    $_.ProcessName -match 'node|npm|bun|electron|defender|antimalware|mpcmdrun'
} | Select-Object ProcessName, Id, CPU, WorkingSet64
if ($relevantProcesses) {
    $relevantProcesses | ForEach-Object {
        Write-Host "  $($_.ProcessName) (PID: $($_.Id)) - Memory: $([math]::Round($_.WorkingSet64 / 1MB, 1)) MB"
    }
} else {
    Write-Host "  No relevant processes found"
}
Write-Host ""

# NOTE: bun.exe is now copied via extraResources in electron-builder.yml
# This avoids EBUSY errors from the npm node module collector.
# See electron-builder.yml for details.

# Verify bun.exe is accessible (not locked by another process)
Write-Host "  Verifying $BunExe is accessible..."
$retryCount = 0
$maxRetries = 6
while ($retryCount -lt $maxRetries) {
    try {
        # Try to open the file exclusively to verify no other process has it locked
        $stream = [System.IO.File]::Open($BunExe, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
        $stream.Close()
        $stream.Dispose()
        Write-Host "  File is accessible" -ForegroundColor Green
        break
    } catch {
        $retryCount++
        if ($retryCount -ge $maxRetries) {
            Write-Host "  WARNING: File may be locked after $maxRetries attempts, proceeding anyway..." -ForegroundColor Yellow
        } else {
            Write-Host "  File locked, waiting 5 seconds (attempt $retryCount/$maxRetries)..." -ForegroundColor Yellow
            Start-Sleep -Seconds 5
        }
    }
}

# Force garbage collection to release any managed file handles
[System.GC]::Collect()
[System.GC]::WaitForPendingFinalizers()

# Run electron-builder with retry logic for EBUSY errors
Push-Location $ElectronDir
$maxBuilderRetries = 3
$builderRetry = 0
$builderSuccess = $false

while (-not $builderSuccess -and $builderRetry -lt $maxBuilderRetries) {
    $builderRetry++
    Write-Host "  electron-builder attempt $builderRetry of $maxBuilderRetries..." -ForegroundColor Cyan

    # Clean release directory before each attempt to avoid stale files
    if (Test-Path "$ElectronDir\release") {
        Write-Host "  Cleaning release directory before attempt..."
        Remove-Item -Recurse -Force "$ElectronDir\release" -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
    }

    npx electron-builder --win --x64 2>&1 | Tee-Object -Variable builderOutput

    if ($LASTEXITCODE -eq 0) {
        $builderSuccess = $true
        Write-Host "  electron-builder succeeded on attempt $builderRetry" -ForegroundColor Green
    } else {
        Write-Host "  electron-builder failed with exit code $LASTEXITCODE" -ForegroundColor Yellow

        if ($builderRetry -lt $maxBuilderRetries) {
            Write-Host "  Waiting 10 seconds before retry..." -ForegroundColor Yellow

            # Kill any processes that might be holding file locks
            Get-Process -Name 'node', 'npm' -ErrorAction SilentlyContinue | ForEach-Object {
                Write-Host "    Killing $($_.ProcessName) (PID: $($_.Id))..." -ForegroundColor Yellow
                Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
            }

            Start-Sleep -Seconds 10
        }
    }
}

Pop-Location

if (-not $builderSuccess) {
    throw "electron-builder failed after $maxBuilderRetries attempts"
}

# 8. Verify the installer was built
$InstallerPath = Get-ChildItem -Path "$ElectronDir\release" -Filter "*.exe" | Select-Object -First 1

if (-not $InstallerPath) {
    Write-Host "ERROR: Installer not found in $ElectronDir\release" -ForegroundColor Red
    Write-Host "Contents of release directory:"
    Get-ChildItem "$ElectronDir\release"
    exit 1
}

# 8b. Gate: the codex binaries inside the packaged app must still satisfy the
#     runtime SHA pin (packages/codex-agent-server/src/manifest-verifier.ts).
#     Windows does not code-sign today, so this leg is expected to be a plain
#     pass — it is here because the macOS build shipped a binary that could
#     never spawn once signing rewrote it, and adding Authenticode later would
#     rewrite the PE exactly the same way. Both candidate output roots are
#     passed because electron-builder resolves directories.output against the
#     project dir, not this script's guess.
Write-Host "Verifying the packaged codex binaries still match their manifest pins..."
Push-Location $RootDir
if ($CodexEnabled) {
    bun scripts/build/codex-integrity.ts "$RootDir\release" "$ElectronDir\release" --require=win32-x64
} else {
    bun scripts/build/codex-integrity.ts "$RootDir\release" "$ElectronDir\release" --forbid-app-server
}
$CodexGateExit = $LASTEXITCODE
Pop-Location
if ($CodexGateExit -ne 0) {
    throw "codex integrity gate failed — the packaged codex binary would not spawn"
}

Write-Host ""
Write-Host "=== Build Complete ===" -ForegroundColor Green
Write-Host "Installer: $($InstallerPath.FullName)"
Write-Host "Size: $([math]::Round($InstallerPath.Length / 1MB, 2)) MB"
