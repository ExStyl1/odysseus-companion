# Nessy CLI Windows PowerShell installer.
# Downloads and runs the source-tracking batch installer.
#
# Usage:
#   irm https://s3-msk.tinkoff.ru/nestor-companion/installation/v2/install-nessy.ps1 | iex

$ErrorActionPreference = 'Stop'

function Get-NessyInstallBinDir {
    if (-not [string]::IsNullOrEmpty($env:NESSY_INSTALL_BIN_DIR)) {
        return $env:NESSY_INSTALL_BIN_DIR
    }

    if (-not [string]::IsNullOrEmpty($env:LOCALAPPDATA)) {
        return Join-Path $env:LOCALAPPDATA 'nessy-cli\bin'
    }

    return Join-Path (Join-Path $env:USERPROFILE 'AppData\Local') 'nessy-cli\bin'
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

function Test-PathContainsDirectory {
    param([string]$PathValue, [string]$Directory)

    if ([string]::IsNullOrEmpty($Directory)) {
        return $false
    }

    $target = $Directory.Trim().Trim('"')
    foreach ($entry in @($PathValue -split ';')) {
        $normalizedEntry = $entry.Trim().Trim('"')
        if ([string]::Equals($normalizedEntry, $target, [StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }

    return $false
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

function Save-CurrentCmdPathShim {
    param([string]$ShimPath)

    if ([string]::IsNullOrEmpty($ShimPath)) {
        return
    }

    $installBase = Get-NessyInstallBase
    $statePath = Join-Path $installBase 'current-cmd-shim.txt'
    try {
        New-Item -ItemType Directory -Path (Split-Path -Parent $statePath) -Force | Out-Null
        [IO.File]::WriteAllText($statePath, $ShimPath, [Text.UTF8Encoding]::new($false))
    } catch {
        # Best-effort cleanup hint only
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
        foreach ($entry in $pathEntries) {
            $entryNormalized = Get-NormalizedPath -PathValue $entry
            $preferredNormalized = Get-NormalizedPath -PathValue $preferredDirectory
            if ([string]::Equals($entryNormalized, $preferredNormalized, [StringComparison]::OrdinalIgnoreCase)) {
                $normalizedCandidate = Get-NormalizedPath -PathValue $entry
                if (-not [string]::IsNullOrEmpty($normalizedCandidate)) {
                    $alreadyAdded = $false
                    foreach ($existing in $candidates) {
                        if ([string]::Equals($existing, $normalizedCandidate, [StringComparison]::OrdinalIgnoreCase)) {
                            $alreadyAdded = $true
                            break
                        }
                    }
                    if (-not $alreadyAdded) {
                        [void]$candidates.Add($entry.Trim().Trim('"'))
                    }
                }
            }
        }
    }

    $userRoot = Get-NormalizedPath -PathValue $env:USERPROFILE
    foreach ($entry in $pathEntries) {
        $entryNormalized = Get-NormalizedPath -PathValue $entry
        if (-not [string]::IsNullOrEmpty($userRoot) -and -not [string]::IsNullOrEmpty($entryNormalized) -and $entryNormalized.StartsWith($userRoot, [StringComparison]::OrdinalIgnoreCase)) {
            $alreadyAdded = $false
            foreach ($existing in $candidates) {
                if ([string]::Equals($existing, $entryNormalized, [StringComparison]::OrdinalIgnoreCase)) {
                    $alreadyAdded = $true
                    break
                }
            }
            if (-not $alreadyAdded) {
                [void]$candidates.Add($entry.Trim().Trim('"'))
            }
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

        $shim = "@echo off`r`nREM Nessy CLI current-session shim. Generated by install-nessy-with-source-new.ps1.`r`ncall `"$NessyCommand`" %*`r`n"
        $shimTempPath = "$shimPath.new"
        [IO.File]::WriteAllText($shimTempPath, $shim, [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $shimTempPath -Destination $shimPath -Force
        Save-CurrentCmdPathShim -ShimPath $shimPath
        return $shimPath
    }

    return $null
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

function Update-CurrentShell {
    $nessyInstallBinDir = Get-NessyInstallBinDir
    $nessyCommandPath = Join-Path $nessyInstallBinDir 'nessy.cmd'
    if (-not (Test-Path -LiteralPath $nessyCommandPath -PathType Leaf)) {
        Write-Output "WARNING: nessy.cmd not found at $nessyCommandPath"
        Write-Output "Installation may not have completed successfully."
        return
    }

    if ($env:NESSY_NO_MODIFY_PATH -eq '1') {
        Write-Output "Run: $nessyCommandPath"
        Write-Output "INFO: NESSY_NO_MODIFY_PATH=1; skipping current-session PATH refresh."
        return
    }

    $inheritedPath = $env:Path
    Update-CurrentSessionPath -BinDir $nessyInstallBinDir

    Write-Output "Run: nessy"
    $parentProcessName = Get-ParentProcessName
    if ($parentProcessName -ieq 'cmd.exe') {
        if (Test-PathContainsDirectory -PathValue $inheritedPath -Directory $nessyInstallBinDir) {
            Write-Output "nessy is ready to use after this installer command returns."
            return
        }

        $shimPath = Install-CurrentCmdPathShim -NessyCommand $nessyCommandPath -PathValue $inheritedPath
        if (-not [string]::IsNullOrEmpty($shimPath)) {
            Write-Output "INFO: Added nessy.cmd to a directory already on this cmd.exe PATH:"
            Write-Output "INFO:   ${shimPath}"
            Write-Output "nessy is ready to use after this installer command returns."
            return
        }

        Write-Output "WARNING: Windows does not allow this PowerShell child process to update the parent cmd.exe PATH directly."
        Write-Output "Or, for this cmd.exe window, run:"
        Write-Output "  set `"PATH=${nessyInstallBinDir};%PATH%`""
        return
    }

    Write-Output "nessy is ready to use in this PowerShell session."
}

$installerUrl = 'https://s3-msk.tinkoff.ru/nestor-companion/installation/v2/install-nessy.bat'
$installerName = 'install-nessy.bat'
$temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
$installerPath = Join-Path $temporaryDirectory $installerName
$previousProgressPreference = $ProgressPreference
$previousSecurityProtocol = [Net.ServicePointManager]::SecurityProtocol
$exitCode = 1

try {
    New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
    $ProgressPreference = 'SilentlyContinue'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $installerUrl -OutFile $installerPath -UseBasicParsing

    & $installerPath @args
    $exitCode = $LASTEXITCODE
} finally {
    $ProgressPreference = $previousProgressPreference
    [Net.ServicePointManager]::SecurityProtocol = $previousSecurityProtocol
    Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
}

if ($exitCode -ne 0) {
    exit $exitCode
}

Update-CurrentShell
