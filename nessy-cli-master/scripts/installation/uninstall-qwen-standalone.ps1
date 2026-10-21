# Nessy CLI standalone uninstaller.
# Removes files owned by install-nessy-standalone.bat/.ps1 and preserves user
# config by default.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -c "irm https://nessy-cli-assets.oss-cn-hangzhou.aliyuncs.com/installation/uninstall-nessy-standalone.ps1 | iex"
#
# Set $env:NESSY_UNINSTALL_PURGE = '1' (or pass -Purge) to also remove the
# installer source marker at %USERPROFILE%\.nessy\source.json. Other Nessy CLI
# config and auth files are preserved.

param(
    [switch]$Purge,
    [switch]$Help
)

$ErrorActionPreference = 'Stop'

if ($Help) {
    Write-Output @"
Nessy CLI standalone uninstaller.

Usage:
  uninstall-nessy-standalone.ps1 [-Purge] [-Help]

Options:
  -Purge   Also remove %USERPROFILE%\.nessy\source.json (same as
           NESSY_UNINSTALL_PURGE=1).
  -Help    Show this message and exit.
"@
    exit 0
}

if ($Purge) {
    $env:NESSY_UNINSTALL_PURGE = '1'
}

function Write-Info {
    param([string]$Message)
    Write-Output "INFO: $Message"
}

function Write-Success {
    param([string]$Message)
    Write-Output "SUCCESS: $Message"
}

function Write-WarningMessage {
    param([string]$Message)
    Write-Output "WARNING: $Message"
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

function Get-NessyInstallDir {
    if (-not [string]::IsNullOrEmpty($env:NESSY_INSTALL_LIB_DIR)) {
        return $env:NESSY_INSTALL_LIB_DIR
    }

    return Join-Path (Get-NessyInstallBase) 'nessy-cli'
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

function Test-PathMatches {
    param([string]$Left, [string]$Right)

    $leftPath = Get-NormalizedPath -PathValue $Left
    $rightPath = Get-NormalizedPath -PathValue $Right
    if ([string]::IsNullOrEmpty($leftPath) -or [string]::IsNullOrEmpty($rightPath)) {
        return $false
    }

    return [string]::Equals($leftPath, $rightPath, [StringComparison]::OrdinalIgnoreCase)
}

function Test-NessyStandaloneInstallDir {
    param([string]$InstallDir)

    if (-not (Test-Path -LiteralPath $InstallDir -PathType Container)) {
        return $false
    }

    $manifestPath = Join-Path $InstallDir 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        return $false
    }

    try {
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    } catch {
        return $false
    }

    if ($manifest.name -ne '@nestor/nessy-cli') {
        return $false
    }

    if ([string]$manifest.target -notmatch '^win-(x64|arm64)$') {
        return $false
    }

    if (-not (Test-Path -LiteralPath (Join-Path $InstallDir 'bin\nessy.cmd') -PathType Leaf)) {
        return $false
    }

    if (-not (Test-Path -LiteralPath (Join-Path $InstallDir 'node\node.exe') -PathType Leaf)) {
        return $false
    }

    return $true
}

function Remove-PathEntry {
    param(
        [string]$BinDir,
        [string]$Scope
    )

    $target = Get-NormalizedPath -PathValue $BinDir
    if ([string]::IsNullOrEmpty($target)) {
        return
    }

    $pathValue = [Environment]::GetEnvironmentVariable('Path', $Scope)
    if ([string]::IsNullOrEmpty($pathValue)) {
        return
    }

    $kept = New-Object System.Collections.Generic.List[string]
    $removed = $false
    foreach ($entry in @($pathValue -split ';')) {
        if ([string]::IsNullOrEmpty($entry)) {
            continue
        }

        if (Test-PathMatches -Left $entry -Right $target) {
            $removed = $true
            continue
        }

        [void]$kept.Add($entry)
    }

    if ($removed) {
        try {
            [Environment]::SetEnvironmentVariable('Path', ($kept -join ';'), $Scope)
            Write-Success "Removed $BinDir from $Scope PATH."
        } catch {
            Write-WarningMessage "Could not remove $BinDir from $Scope PATH: $($_.Exception.Message)"
        }
    }
}

function Remove-PathEntryFromAllScopes {
    param([string]$BinDir)

    $target = Get-NormalizedPath -PathValue $BinDir
    if ([string]::IsNullOrEmpty($target)) {
        return
    }

    Remove-PathEntry -BinDir $target -Scope 'User'
    Remove-PathEntry -BinDir $target -Scope 'Machine'

    $current = New-Object System.Collections.Generic.List[string]
    foreach ($entry in @($env:Path -split ';')) {
        if ([string]::IsNullOrEmpty($entry)) {
            continue
        }
        if (-not (Test-PathMatches -Left $entry -Right $target)) {
            [void]$current.Add($entry)
        }
    }
    $env:Path = $current -join ';'
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

function Remove-CurrentCmdPathShimFile {
    param([string]$ShimPath)

    if ([string]::IsNullOrEmpty($ShimPath)) {
        return
    }

    if (-not (Test-Path -LiteralPath $ShimPath -PathType Leaf)) {
        return
    }

    $existingShim = Get-Content -LiteralPath $ShimPath -Raw -ErrorAction SilentlyContinue
    if ($existingShim -notmatch 'Nessy CLI current-session shim') {
        return
    }

    Remove-Item -LiteralPath $ShimPath -Force -ErrorAction SilentlyContinue
    Write-Success "Removed current cmd.exe nessy shim: $ShimPath"
}

function Remove-RecordedCurrentCmdPathShim {
    $statePath = Get-CurrentCmdShimStatePath
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
        return
    }

    foreach ($shimPath in Get-Content -LiteralPath $statePath -ErrorAction SilentlyContinue) {
        Remove-CurrentCmdPathShimFile -ShimPath $shimPath
    }

    Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
}

function Remove-CurrentCmdPathShim {
    Remove-RecordedCurrentCmdPathShim

    $candidates = [System.Collections.Generic.List[string]]::new()
    foreach ($entry in @($env:Path -split ';')) {
        if (-not [string]::IsNullOrEmpty($entry)) {
            Add-PathCandidate -Candidates $candidates -Directory $entry
        }
    }

    if (-not [string]::IsNullOrEmpty($env:LOCALAPPDATA)) {
        Add-PathCandidate -Candidates $candidates -Directory (Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps')
    }
    if (-not [string]::IsNullOrEmpty($env:APPDATA)) {
        Add-PathCandidate -Candidates $candidates -Directory (Join-Path $env:APPDATA 'npm')
    }
    if (-not [string]::IsNullOrEmpty($env:USERPROFILE)) {
        Add-PathCandidate -Candidates $candidates -Directory (Join-Path $env:USERPROFILE '.bun\bin')
    }

    foreach ($candidate in $candidates) {
        $shimPath = Join-Path $candidate 'nessy.cmd'
        Remove-CurrentCmdPathShimFile -ShimPath $shimPath
    }
}

function Remove-InstallWrapper {
    param([string]$InstallDir, [string]$BinDir)

    $wrapperPath = Join-Path $BinDir 'nessy.cmd'
    if (-not (Test-Path -LiteralPath $wrapperPath -PathType Leaf)) {
        return
    }

    $wrapper = Get-Content -LiteralPath $wrapperPath -Raw -ErrorAction SilentlyContinue
    $targetCommand = Join-Path (Join-Path $InstallDir 'bin') 'nessy.cmd'
    if (
        $wrapper -notmatch [regex]::Escape($targetCommand) -and
        $wrapper -notmatch 'Nessy CLI current-session shim'
    ) {
        Write-WarningMessage "$wrapperPath does not point at this standalone install; skipping."
        return
    }

    Remove-Item -LiteralPath $wrapperPath -Force
    Write-Success "Removed $wrapperPath"
}

function Remove-EmptyDirectory {
    param([string]$Directory)

    if ([string]::IsNullOrEmpty($Directory)) {
        return
    }

    if (-not (Test-Path -LiteralPath $Directory -PathType Container)) {
        return
    }

    try {
        Remove-Item -LiteralPath $Directory -Force -ErrorAction Stop
    } catch {
        return
    }
}

function Remove-SourceMarker {
    if ([string]::IsNullOrEmpty($env:USERPROFILE)) {
        return
    }

    $nessyDir = Join-Path $env:USERPROFILE '.nessy'
    $sourceJson = Join-Path $nessyDir 'source.json'

    if ($env:NESSY_UNINSTALL_PURGE -ne '1') {
        Write-Info "Preserving $nessyDir (set NESSY_UNINSTALL_PURGE=1 to remove source.json)."
        return
    }

    if (Test-Path -LiteralPath $sourceJson -PathType Leaf) {
        Remove-Item -LiteralPath $sourceJson -Force
        Write-Success "Removed $sourceJson"
    }

    Remove-EmptyDirectory -Directory $nessyDir
}

Write-Output "Nessy CLI Standalone Uninstaller"
Write-Output ""

$installBase = Get-NessyInstallBase
$installDir = Get-NessyInstallDir
$installBinDir = Get-NessyInstallBinDir
$installWasManaged = Test-NessyStandaloneInstallDir -InstallDir $installDir

if ($installWasManaged) {
    Remove-CurrentCmdPathShim
    Remove-Item -LiteralPath $installDir -Recurse -Force
    Write-Success "Removed $installDir"
} elseif (Test-Path -LiteralPath $installDir) {
    Write-WarningMessage "$installDir exists but is not a Nessy CLI standalone install; skipping."
} else {
    Write-Info "No standalone runtime found at $installDir."
}

if ($installWasManaged) {
    Remove-InstallWrapper -InstallDir $installDir -BinDir $installBinDir
} else {
    Write-Info "Leaving $(Join-Path $installBinDir 'nessy.cmd') unchanged because no managed standalone runtime was removed."
}

Remove-PathEntryFromAllScopes -BinDir $installBinDir
Remove-SourceMarker
if ([string]::IsNullOrEmpty($env:NESSY_INSTALL_BIN_DIR)) {
    Remove-EmptyDirectory -Directory $installBinDir
}
if ([string]::IsNullOrEmpty($env:NESSY_INSTALL_ROOT)) {
    Remove-EmptyDirectory -Directory $installBase
}

Write-Success "Nessy CLI standalone install removed."
