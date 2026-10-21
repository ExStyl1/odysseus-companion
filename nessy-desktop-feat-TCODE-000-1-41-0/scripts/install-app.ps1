# Nessy Desktop Windows installer
# Usage: irm https://nessy-desktop-releases-dev.s3-msk.tinkoff.ru/dev/win/install-app.ps1 | iex

param(
    [switch]$PrintUrl
)

$ErrorActionPreference = "Stop"
$InstallBase = if ($env:NESSY_DESKTOP_INSTALL_BASE) { $env:NESSY_DESKTOP_INSTALL_BASE } else { "https://nessy-desktop-releases-dev.s3-msk.tinkoff.ru/dev/win" }
$DownloadDir = if ($env:NESSY_DESKTOP_DOWNLOAD_DIR) { $env:NESSY_DESKTOP_DOWNLOAD_DIR } else { Join-Path $env:TEMP "nessy-desktop-install" }

if ($env:OS -ne "Windows_NT") {
    throw "This installer is for Windows only."
}

$arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { throw "Nessy Desktop Windows builds are x64 only." }
$version = $env:NESSY_DESKTOP_INSTALL_VERSION

if (-not $version) {
    $manifest = $null
    foreach ($name in @("dev.yml", "latest.yml", "latest-x64-win.yml")) {
        try {
            $manifest = (Invoke-WebRequest -Uri "$($InstallBase.TrimEnd('/'))/$name" -UseBasicParsing).Content
            break
        } catch {
            $manifest = $null
        }
    }
    if ($manifest -match '(?m)^version:\s*(.+)$') {
        $version = $Matches[1].Trim()
    }
}

if (-not $version) {
    throw "Could not resolve Nessy Desktop version from $InstallBase."
}

$filename = "NessyDesktop-$version-win-$arch.exe"
$url = "$($InstallBase.TrimEnd('/'))/$filename"

if ($PrintUrl) {
    Write-Output $url
    exit 0
}

New-Item -ItemType Directory -Force -Path $DownloadDir | Out-Null
$installer = Join-Path $DownloadDir $filename
Write-Host "Downloading $url"
Invoke-WebRequest -Uri $url -OutFile $installer -UseBasicParsing

Get-Process -Name "Nessy Desktop" -ErrorAction SilentlyContinue | Stop-Process -Force
$process = Start-Process -FilePath $installer -PassThru
$process.WaitForExit()
if ($process.ExitCode -ne 0) {
    throw "Installation failed with exit code $($process.ExitCode)."
}

Write-Host "Nessy Desktop installed."
