#Requires -Version 5.1
<#
.SYNOPSIS
    Updates the bundled default extension (nessy-default-extension) of the
    Nessy CLI Desktop for a user who does not have a standalone `nessy` CLI
    installed.

.DESCRIPTION
    Runs `nessy extensions update nessy-default-extension` through the Bun
    runtime and cli.js that ship inside the installed Nessy CLI Desktop app,
    so no separate CLI install is required. Mirrors how the diagnostics
    collector (collect-windows-diagnostics.ps1) drives the bundled CLI.

    The script searches every Nessy CLI Desktop installation (registry +
    known Program Files paths), takes the first one whose bundled runtime is
    present, and runs the update through it.

    The CLI runs synchronously via the bundled Bun in the current console, so
    its full output — including the final "already up to date" / "successfully
    updated" message — is shown directly. Wait for it to finish; the "bufferutil
    [1/1]" progress line is a normal dependency-install step, not a hang.

    Requires PowerShell 5.1+ (Windows 10/11 default). No external modules.

.EXAMPLE
    .\update-default-extension.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

function Get-DesktopInstallations {
    $candidates = [Collections.Generic.List[string]]::new()

    # Registry: NSIS per-user installs usually leave InstallLocation empty; the
    # real path is only available via DisplayIcon (e.g. "...\Nessy CLI Desktop.exe,0").
    foreach ($registryPath in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
        Get-ItemProperty $registryPath -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'nessy|craft' } | ForEach-Object {
            if ($_.InstallLocation) { [void]$candidates.Add($_.InstallLocation) }
            if ($_.DisplayIcon) {
                $iconPath = ([string]$_.DisplayIcon).Trim('"') -replace ',\d+$', ''
                if ($iconPath) { [void]$candidates.Add((Split-Path -Parent $iconPath)) }
            }
        }
    }

    # Known install folders — both the space-separated and kebab-case names.
    foreach ($basePath in @($env:LOCALAPPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if (-not $basePath) { continue }
        foreach ($relativePath in @('Programs\Nessy CLI Desktop', 'Nessy CLI Desktop', 'Programs\nessy-cli-desktop', 'nessy-cli-desktop')) {
            $candidate = Join-Path $basePath $relativePath
            if (Test-Path -LiteralPath $candidate -PathType Container) { [void]$candidates.Add($candidate) }
        }
    }

    # Wide sweep: any Program Files subfolder whose name looks like Nessy and
    # actually ships the bundled CLI.
    foreach ($basePath in @((Join-Path $env:LOCALAPPDATA 'Programs'), $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if (-not $basePath -or -not (Test-Path -LiteralPath $basePath -PathType Container)) { continue }
        foreach ($dir in Get-ChildItem -LiteralPath $basePath -Directory -ErrorAction SilentlyContinue) {
            if ($dir.Name -notmatch 'nessy|craft') { continue }
            if (Test-Path -LiteralPath (Join-Path $dir.FullName 'resources\app\vendor\nessy-cli\cli.js') -PathType Leaf) {
                [void]$candidates.Add($dir.FullName)
            }
        }
    }

    $seen = @{}
    foreach ($candidate in $candidates) {
        try {
            $canonicalPath = (Resolve-Path -LiteralPath $candidate -ErrorAction Stop).Path.TrimEnd('\')
            $key = $canonicalPath.ToLowerInvariant()
            if (-not $seen.ContainsKey($key)) { $seen[$key] = $true; $canonicalPath }
        } catch {}
    }
}

function Get-NessyRuntime {
    param([Parameter(Mandatory)][string]$InstallPath)
    $resourcesApp = Join-Path $InstallPath 'resources\app'
    return [pscustomobject]@{
        InstallPath = $InstallPath
        BunPath     = Join-Path $resourcesApp 'vendor\bun\win32-x64\bun.exe'
        CliPath     = Join-Path $resourcesApp 'vendor\nessy-cli\cli.js'
    }
}

function Invoke-BundledUpdate {
    param([Parameter(Mandatory)]$Runtime)
    if (-not (Test-Path -LiteralPath $Runtime.BunPath -PathType Leaf)) {
        Write-Host "Bundled Bun not found: $($Runtime.BunPath)" -ForegroundColor Red
        return 1
    }
    if (-not (Test-Path -LiteralPath $Runtime.CliPath -PathType Leaf)) {
        Write-Host "Bundled CLI not found: $($Runtime.CliPath)" -ForegroundColor Red
        return 1
    }

    $env:NESSY_DEBUG_LOG_FILE = '1'
    $env:NO_COLOR = '1'

    Write-Host ''
    Write-Host "Updating nessy-default-extension via bundled CLI:"
    Write-Host "  Bun:  $($Runtime.BunPath)"
    Write-Host "  CLI:  $($Runtime.CliPath)"
    Write-Host "  Cmd:  bun cli.js --debug extensions update nessy-default-extension"
    Write-Host ''
    Write-Host 'Running... (wait for it to finish; this may take a while).'
    Write-Host ''

    try {
        & $Runtime.BunPath $Runtime.CliPath '--debug' 'extensions' 'update' 'nessy-default-extension'
        return $LASTEXITCODE
    } finally {
        Remove-Item Env:NESSY_DEBUG_LOG_FILE -ErrorAction SilentlyContinue
        Remove-Item Env:NO_COLOR -ErrorAction SilentlyContinue
    }
}

if ($env:OS -ne 'Windows_NT') { throw 'This script supports Windows only.' }

$installations = @(Get-DesktopInstallations)
if ($installations.Count -eq 0) {
    Write-Host 'No Nessy CLI Desktop installation found.' -ForegroundColor Red
    exit 1
}

$runtime = $null
foreach ($installPath in $installations) {
    $candidate = Get-NessyRuntime $installPath
    if (Test-Path -LiteralPath $candidate.BunPath -PathType Leaf) {
        $runtime = $candidate
        break
    }
}

if (-not $runtime) {
    Write-Host 'Found Nessy CLI Desktop installation(s), but none with a bundled Bun runtime.' -ForegroundColor Red
    Write-Host "Looked for: <install>\resources\app\vendor\bun\win32-x64\bun.exe"
    foreach ($installPath in $installations) { Write-Host "  - $installPath" }
    exit 1
}

$exitCode = Invoke-BundledUpdate $runtime
Write-Host ''
if ($exitCode -eq 0) {
    Write-Host "Update completed successfully (exit code 0)." -ForegroundColor Green
} else {
    Write-Host "Update finished with exit code $exitCode." -ForegroundColor Yellow
}
exit $exitCode
