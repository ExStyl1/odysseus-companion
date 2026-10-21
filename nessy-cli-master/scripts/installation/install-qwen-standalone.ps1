# Nessy CLI Windows hosted PowerShell entrypoint.
# Pairs with install-nessy-standalone.bat: this shim downloads the .bat into TEMP,
# verifies its checksum, and runs it with forwarded arguments.
#
# PowerShell (runs in current session, nessy available immediately):
#   irm https://nessy-cli-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-nessy-standalone.ps1 | iex
#
# cmd.exe (runs in current session, nessy available immediately):
#   curl -fsSL https://nessy-cli-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-nessy-standalone.bat -o %TEMP%\install-nessy.bat && %TEMP%\install-nessy.bat
#
# To pin a specific release, set $env:NESSY_INSTALL_VERSION before invoking,
# e.g. $env:NESSY_INSTALL_VERSION = 'vX.Y.Z'. This is equivalent to passing
# --version vX.Y.Z to install-nessy-standalone.bat directly.
#
# To point this shim at a non-production hosted endpoint (staging buckets,
# private mirrors), set $env:NESSY_INSTALLER_BAT_URL to the alternate .bat URL.
# The override is required to be HTTPS so a misconfigured value can't silently
# downgrade the download channel. The downstream .bat continues to honor
# NESSY_INSTALL_BASE_URL for archive resolution.
#
# By default the matching SHA256SUMS file is read from the same hosted
# directory as the .bat. Set $env:NESSY_INSTALLER_CHECKSUMS_URL to override it
# when testing a custom installer endpoint.

$ErrorActionPreference = 'Stop'

function Download-File {
    param([string]$Url, [string]$OutFile)
    $prevProgressPreference = $global:ProgressPreference
    $global:ProgressPreference = 'SilentlyContinue'
    try {
        if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
            curl.exe --connect-timeout 15 --max-time 300 --retry 2 -sSfLo $OutFile $Url
            if ($LASTEXITCODE -ne 0) {
                throw "curl.exe download failed (exit code $LASTEXITCODE)"
            }
            return
        }
        Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing -MaximumRedirection 10 -TimeoutSec 300
    } finally {
        $global:ProgressPreference = $prevProgressPreference
    }
}

function Get-NessyInstallBase {
    if (-not [string]::IsNullOrEmpty($env:NESSY_INSTALL_ROOT)) {
        return $env:NESSY_INSTALL_ROOT
    }

    if (-not [string]::IsNullOrEmpty($env:LOCALAPPDATA)) {
        return Join-Path $env:LOCALAPPDATA 'nessy-cli'
    }

    return Join-Path (Join-Path $env:USERPROFILE 'AppData\Local') 'nessy-cli'
}

function Get-NessyInstallBinDir {
    if (-not [string]::IsNullOrEmpty($env:NESSY_INSTALL_BIN_DIR)) {
        return $env:NESSY_INSTALL_BIN_DIR
    }

    return Join-Path (Get-NessyInstallBase) 'bin'
}

function Get-CurrentCmdShimStatePath {
    return Join-Path (Get-NessyInstallBase) 'current-cmd-shim.txt'
}

function Save-CurrentCmdPathShim {
    param([string]$ShimPath)

    if ([string]::IsNullOrEmpty($ShimPath)) {
        return
    }

    try {
        $statePath = Get-CurrentCmdShimStatePath
        New-Item -ItemType Directory -Path (Split-Path -Parent $statePath) -Force | Out-Null
        [IO.File]::WriteAllText($statePath, $ShimPath, [Text.UTF8Encoding]::new($false))
    } catch {
        # Best-effort cleanup hint only. The installer still works if this fails.
    }
}

function Update-CurrentSessionPath {
    param([string]$BinDir)

    if ([string]::IsNullOrEmpty($BinDir)) {
        return
    }

    $entries = @($env:Path -split ';' | Where-Object { -not [string]::IsNullOrEmpty($_) })
    foreach ($entry in $entries) {
        if ([string]::Equals($entry, $BinDir, [StringComparison]::OrdinalIgnoreCase)) {
            return
        }
    }

    $env:Path = (@($BinDir) + $entries) -join ';'
}

function Get-ParentProcessName {
    try {
        $current = Get-CimInstance Win32_Process -Filter "ProcessId = $PID" -ErrorAction Stop
        if ($null -eq $current -or $null -eq $current.ParentProcessId) {
            return $null
        }
        $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($current.ParentProcessId)" -ErrorAction Stop
        if ($null -eq $parent) {
            return $null
        }
        return $parent.Name
    } catch {
        return $null
    }
}

function Get-NormalizedPath {
    param([string]$PathValue)

    if ([string]::IsNullOrEmpty($PathValue)) {
        return $null
    }

    $trimmed = $PathValue.Trim().Trim('"')
    if ([string]::IsNullOrEmpty($trimmed)) {
        return $null
    }

    try {
        return [IO.Path]::GetFullPath($trimmed).TrimEnd('\')
    } catch {
        return $trimmed.TrimEnd('\')
    }
}

function Test-PathContainsDirectory {
    param([string]$PathValue, [string]$Directory)

    $target = Get-NormalizedPath -PathValue $Directory
    if ([string]::IsNullOrEmpty($target)) {
        return $false
    }

    foreach ($entry in @($PathValue -split ';')) {
        $normalizedEntry = Get-NormalizedPath -PathValue $entry
        if ([string]::Equals($normalizedEntry, $target, [StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }

    return $false
}

function Test-WritableDirectory {
    param([string]$Directory)

    if ([string]::IsNullOrEmpty($Directory)) {
        return $false
    }

    if (-not (Test-Path -LiteralPath $Directory -PathType Container)) {
        return $false
    }

    $probe = Join-Path $Directory ('.nessy-write-test-' + [IO.Path]::GetRandomFileName())
    try {
        [IO.File]::WriteAllText($probe, '')
        Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
        return $true
    } catch {
        Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
        return $false
    }
}

function Add-PathCandidate {
    param(
        [System.Collections.Generic.List[string]]$Candidates,
        [string]$Directory
    )

    $normalizedDirectory = Get-NormalizedPath -PathValue $Directory
    if ([string]::IsNullOrEmpty($normalizedDirectory)) {
        return
    }

    foreach ($candidate in $Candidates) {
        $normalizedCandidate = Get-NormalizedPath -PathValue $candidate
        if ([string]::Equals($normalizedCandidate, $normalizedDirectory, [StringComparison]::OrdinalIgnoreCase)) {
            return
        }
    }

    [void]$Candidates.Add($Directory.Trim().Trim('"'))
}

function Test-SystemManagedPathDirectory {
    param([string]$Directory)

    $normalizedDirectory = Get-NormalizedPath -PathValue $Directory
    return (
        -not [string]::IsNullOrEmpty($normalizedDirectory) -and
        $normalizedDirectory -match '\\Microsoft\\WindowsApps$'
    )
}

function Install-CurrentCmdPathShim {
    param([string]$NessyCommand, [string]$PathValue)

    $pathEntries = @($PathValue -split ';' | Where-Object { -not [string]::IsNullOrEmpty($_) })
    $candidates = [System.Collections.Generic.List[string]]::new()
    $preferredDirectories = @()

    if (-not [string]::IsNullOrEmpty($env:APPDATA)) {
        $preferredDirectories += Join-Path $env:APPDATA 'npm'
    }
    if (-not [string]::IsNullOrEmpty($env:USERPROFILE)) {
        $preferredDirectories += Join-Path $env:USERPROFILE '.bun\bin'
    }

    foreach ($preferredDirectory in $preferredDirectories) {
        $preferredNormalized = Get-NormalizedPath -PathValue $preferredDirectory
        foreach ($entry in $pathEntries) {
            $entryNormalized = Get-NormalizedPath -PathValue $entry
            if ([string]::Equals($entryNormalized, $preferredNormalized, [StringComparison]::OrdinalIgnoreCase)) {
                Add-PathCandidate -Candidates $candidates -Directory $entry
            }
        }
    }

    $userRoot = Get-NormalizedPath -PathValue $env:USERPROFILE
    foreach ($entry in $pathEntries) {
        if (Test-SystemManagedPathDirectory -Directory $entry) {
            continue
        }
        $entryNormalized = Get-NormalizedPath -PathValue $entry
        if (
            -not [string]::IsNullOrEmpty($userRoot) -and
            -not [string]::IsNullOrEmpty($entryNormalized) -and
            $entryNormalized.StartsWith($userRoot, [StringComparison]::OrdinalIgnoreCase)
        ) {
            Add-PathCandidate -Candidates $candidates -Directory $entry
        }
    }

    foreach ($candidate in $candidates) {
        if (-not (Test-WritableDirectory -Directory $candidate)) {
            continue
        }

        $shimPath = Join-Path $candidate 'nessy.cmd'
        if (Test-Path -LiteralPath $shimPath -PathType Leaf) {
            $existingShim = Get-Content -LiteralPath $shimPath -Raw -ErrorAction SilentlyContinue
            if ($existingShim -notmatch 'Nessy CLI current-session shim') {
                continue
            }
        }

        $shim = "@echo off`r`nREM Nessy CLI current-session shim. Generated by install-nessy-standalone.ps1.`r`ncall `"$NessyCommand`" %*`r`n"
        # Write to a sibling temp file first, then atomically rename so a partial
        # write (process killed, disk full) cannot leave a half-written shim on
        # PATH.
        $shimTempPath = "$shimPath.new"
        [IO.File]::WriteAllText($shimTempPath, $shim, [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $shimTempPath -Destination $shimPath -Force
        Save-CurrentCmdPathShim -ShimPath $shimPath
        return $shimPath
    }

    return $null
}

function Update-CurrentShell {
    $nessyInstallBinDir = Get-NessyInstallBinDir
    $nessyCommandPath = Join-Path $nessyInstallBinDir 'nessy.cmd'
    if (-not (Test-Path -LiteralPath $nessyCommandPath -PathType Leaf)) {
        return
    }

    if ($env:NESSY_NO_MODIFY_PATH -eq '1') {
        return
    }

    $inheritedPath = $env:Path
    Update-CurrentSessionPath -BinDir $nessyInstallBinDir

    $parentProcessName = Get-ParentProcessName
    if ($parentProcessName -ieq 'cmd.exe') {
        if (Test-PathContainsDirectory -PathValue $inheritedPath -Directory $nessyInstallBinDir) {
            return
        }

        $shimPath = Install-CurrentCmdPathShim -NessyCommand $nessyCommandPath -PathValue $inheritedPath
        if (-not [string]::IsNullOrEmpty($shimPath)) {
            return
        }
        return
    }
}

$nessyDefaultInstallerUrl = 'https://nessy-cli-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-nessy-standalone.bat'
$nessyDefaultChecksumsUrl = 'https://nessy-cli-assets.oss-cn-hangzhou.aliyuncs.com/installation/SHA256SUMS'
if ([string]::IsNullOrEmpty($env:NESSY_INSTALLER_BAT_URL)) {
    $nessyInstallerUrl = $nessyDefaultInstallerUrl
} else {
    if ($env:NESSY_INSTALLER_BAT_URL -notmatch '^https://') {
        Write-Error "NESSY_INSTALLER_BAT_URL must start with https://"
        exit 1
    }
    $nessyInstallerUrl = $env:NESSY_INSTALLER_BAT_URL
}

if ([string]::IsNullOrEmpty($env:NESSY_INSTALLER_CHECKSUMS_URL)) {
    if ($nessyInstallerUrl -eq $nessyDefaultInstallerUrl) {
        $nessyChecksumsUrl = $nessyDefaultChecksumsUrl
    } else {
        $nessyChecksumsUrl = [Uri]::new([Uri]$nessyInstallerUrl, 'SHA256SUMS').AbsoluteUri
    }
} else {
    if ($env:NESSY_INSTALLER_CHECKSUMS_URL -notmatch '^https://') {
        Write-Error "NESSY_INSTALLER_CHECKSUMS_URL must start with https://"
        exit 1
    }
    $nessyChecksumsUrl = $env:NESSY_INSTALLER_CHECKSUMS_URL
}

$nessyInstallerName = [IO.Path]::GetFileName(([Uri]$nessyInstallerUrl).AbsolutePath)
if ([string]::IsNullOrEmpty($nessyInstallerName)) {
    $nessyInstallerName = 'install-nessy-standalone.bat'
}
if ([string]::IsNullOrEmpty($env:TEMP)) {
    Write-Error "TEMP environment variable is not set. Please set TEMP to a writable directory."
    exit 1
}
# Use a cryptographically random staging filename so a same-user attacker cannot
# pre-stage a malicious .bat at a predictable path and race the verify/execute
# window between Get-FileHash and `& $nessyInstallerPath`.
$nessyStagingSuffix = [IO.Path]::GetRandomFileName()
$nessyInstallerPath = Join-Path $env:TEMP "nessy-installer-$nessyStagingSuffix.bat"
$nessyChecksumsPath = Join-Path $env:TEMP "nessy-installation-SHA256SUMS-$nessyStagingSuffix"

try {
    Download-File -Url $nessyInstallerUrl -OutFile $nessyInstallerPath
} catch {
    Write-Error "Failed to download Nessy CLI installer from ${nessyInstallerUrl}: $($_.Exception.Message)"
    exit 1
}

try {
    Download-File -Url $nessyChecksumsUrl -OutFile $nessyChecksumsPath
} catch {
    Remove-Item -LiteralPath $nessyInstallerPath -Force -ErrorAction SilentlyContinue
    Write-Error "Failed to download Nessy CLI installer checksums from ${nessyChecksumsUrl}: $($_.Exception.Message)"
    exit 1
}

$nessyExpectedHash = $null
foreach ($nessyChecksumLine in Get-Content -LiteralPath $nessyChecksumsPath) {
    if ($nessyChecksumLine -match '^([0-9a-fA-F]{64})\s+\*?(.+)$') {
        if ($Matches[2] -eq $nessyInstallerName) {
            $nessyExpectedHash = $Matches[1].ToLowerInvariant()
            break
        }
    }
}
if ([string]::IsNullOrEmpty($nessyExpectedHash)) {
    Remove-Item -LiteralPath $nessyInstallerPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $nessyChecksumsPath -Force -ErrorAction SilentlyContinue
    Write-Error "Checksum entry for ${nessyInstallerName} not found in ${nessyChecksumsUrl}"
    exit 1
}

$nessyActualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $nessyInstallerPath).Hash.ToLowerInvariant()
if ($nessyActualHash -ne $nessyExpectedHash) {
    Remove-Item -LiteralPath $nessyInstallerPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $nessyChecksumsPath -Force -ErrorAction SilentlyContinue
    Write-Error "Checksum mismatch for ${nessyInstallerName}: expected ${nessyExpectedHash}, got ${nessyActualHash}."
    exit 1
}

$nessyInstallerExitCode = 0
$nessyPreviousParentPowerShell = $env:NESSY_INSTALLER_PARENT_POWERSHELL
try {
    $env:NESSY_INSTALLER_PARENT_POWERSHELL = '1'
    & $nessyInstallerPath @args
    $nessyInstallerExitCode = $LASTEXITCODE
} finally {
    if ($null -eq $nessyPreviousParentPowerShell) {
        Remove-Item Env:\NESSY_INSTALLER_PARENT_POWERSHELL -ErrorAction SilentlyContinue
    } else {
        $env:NESSY_INSTALLER_PARENT_POWERSHELL = $nessyPreviousParentPowerShell
    }
    Remove-Item -LiteralPath $nessyInstallerPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $nessyChecksumsPath -Force -ErrorAction SilentlyContinue
}

if ($nessyInstallerExitCode -ne 0) {
    exit $nessyInstallerExitCode
}

Update-CurrentShell
