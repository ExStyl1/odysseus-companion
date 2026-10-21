# Nessy CLI Desktop Windows Installer
# Usage: .\install-app.ps1 [--version <version>]

$RequestedVersion = $null
for ($i = 0; $i -lt $args.Count; $i++) {
    $arg = $args[$i]
    if ($arg -eq "--version" -or $arg -eq "-Version") {
        if ($i + 1 -ge $args.Count) {
            Write-Host "Usage: .\install-app.ps1 [--version <version>]"
            exit 1
        }
        $i++
        $RequestedVersion = $args[$i]
    } elseif ($arg -like "--version=*") {
        $RequestedVersion = $arg.Substring("--version=".Length)
    } elseif ($arg -eq "--help" -or $arg -eq "-h") {
        Write-Host "Usage: .\install-app.ps1 [--version <version>]"
        exit 0
    } elseif (-not $RequestedVersion) {
        $RequestedVersion = $arg
    } else {
        Write-Host "Usage: .\install-app.ps1 [--version <version>]"
        exit 1
    }
}

& {
$ErrorActionPreference = "Stop"

$VERSIONS_URL = "https://s3-msk.tinkoff.ru/nestor-companion/nessy-cli/desktop"
# [nessy-fork] desktop-installer-cyrillic-temp
$DOWNLOAD_DIR = Join-Path $env:ProgramData ("NessyCliInstall-" + [Guid]::NewGuid().ToString("N"))
$APP_NAME = "Nessy CLI Desktop"

# Colors for output
function Write-Info { Write-Host "> $args" -ForegroundColor Blue }
function Write-Success { Write-Host "> $args" -ForegroundColor Green }
function Write-Warn { Write-Host "! $args" -ForegroundColor Yellow }
function Remove-InstallerDirectory {
    param([string]$path)
    try { [System.IO.Directory]::Delete($path, $true) } catch {}
}
function Write-Err {
    Write-Host "x $args" -ForegroundColor Red
    Remove-InstallerDirectory $DOWNLOAD_DIR
    exit 1
}

# Check for Windows
if ($env:OS -ne "Windows_NT") {
    Write-Err "This installer is for Windows only."
}

# Detect architecture
$arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }
$platform = "win32-$arch"

Write-Host ""
Write-Info "Detected platform: $platform (arch: $arch)"

$releasePath = if ($RequestedVersion) { $RequestedVersion } else { "latest" }
$manifestName = if ($RequestedVersion -and $RequestedVersion -match "beta") {
    "beta.yml"
} else {
    "latest.yml"
}

# Create download directory
New-Item -ItemType Directory -Force -Path $DOWNLOAD_DIR | Out-Null

# Fetch YAML manifest from latest or a versioned release directory.
Write-Info "Fetching release info from $releasePath/$manifestName..."
$yamlPath = Join-Path $DOWNLOAD_DIR $manifestName
try {
    Invoke-WebRequest -Uri "$VERSIONS_URL/$releasePath/$manifestName" -OutFile $yamlPath -UseBasicParsing
} catch {
    Write-Err "Failed to fetch release info: $_"
}

$yamlContent = Get-Content $yamlPath -Raw
if (-not $yamlContent) {
    Write-Err "Failed to fetch release info from $manifestName"
}

# Extract version from YAML manifest
$version = $null
if ($yamlContent -match '(?m)^version:\s*(.+)') {
    $version = $Matches[1].Trim()
}

if (-not $version) {
    Write-Err "Failed to extract version from manifest"
}

Write-Info "Version: $version"

# Parse YAML to extract sha512, url (filename), and size for our architecture
# YAML format:
#   files:
#     - url: Nessy-CLI-Desktop-x64.exe
#       sha512: <base64>
#       size: 123456789
#       arch: x64
function Test-YamlEntryMatch {
    param(
        [string]$url,
        [string]$entryArch,
        [string]$targetArch,
        [string]$targetExt
    )

    if (-not $url) {
        return $false
    }
    if ($entryArch -and $entryArch -eq $targetArch) {
        return $true
    }

    return $url -like "*$targetArch*.$targetExt"
}

function Get-YamlEntryForArch {
    param([string]$yaml, [string]$targetArch, [string]$targetExt)
    $lines = $yaml -split "`n"
    $currentUrl = $null
    $currentSha512 = $null
    $currentSize = $null
    $currentArch = $null

    foreach ($line in $lines) {
        if ($line -match '^\s*-\s*url:\s*(.+)') {
            if (
                $currentSha512 -and
                (Test-YamlEntryMatch -url $currentUrl -entryArch $currentArch -targetArch $targetArch -targetExt $targetExt)
            ) {
                return @{ url = $currentUrl; sha512 = $currentSha512; size = $currentSize }
            }
            $currentUrl = $Matches[1].Trim()
            $currentSha512 = $null
            $currentSize = $null
            $currentArch = $null
        }
        if ($line -match '^\s*sha512:\s*(.+)') {
            $currentSha512 = $Matches[1].Trim()
        }
        if ($line -match '^\s*size:\s*(\d+)') {
            $currentSize = [long]$Matches[1]
        }
        if ($line -match '^\s*arch:\s*(.+)') {
            $currentArch = $Matches[1].Trim()
        }
    }

    if (
        $currentSha512 -and
        (Test-YamlEntryMatch -url $currentUrl -entryArch $currentArch -targetArch $targetArch -targetExt $targetExt)
    ) {
        return @{ url = $currentUrl; sha512 = $currentSha512; size = $currentSize }
    }

    return $null
}

$entry = Get-YamlEntryForArch -yaml $yamlContent -targetArch $arch -targetExt "exe"

if (-not $entry) {
    Write-Err "Architecture $arch not found in $manifestName"
}

$checksum = $entry.sha512
$filename = $entry.url
$fileSize = $entry.size

# Validate checksum format (SHA-512 base64 = 88 characters)
if (-not $checksum -or $checksum.Length -lt 80) {
    Write-Err "Invalid checksum in manifest"
}

# Use default filename if not found
if (-not $filename) {
    $filename = "Nessy-CLI-Desktop-$arch.exe"
}

$installerUrl = "$VERSIONS_URL/$releasePath/$filename"

Write-Info "Expected sha512: $($checksum.Substring(0, 20))..."

# Download installer with progress
$installerPath = Join-Path $DOWNLOAD_DIR $filename
$fileSizeMB = if ($fileSize -gt 0) { [math]::Round($fileSize / 1MB, 1) } else { 0 }

Write-Info "Downloading $filename ($fileSizeMB MB)..."

try {
    # Use WebRequest for download with progress
    $webRequest = [System.Net.HttpWebRequest]::Create($installerUrl)
    $webRequest.Timeout = 600000  # 10 minutes
    $response = $webRequest.GetResponse()
    $responseStream = $response.GetResponseStream()
    $fileStream = [System.IO.File]::Create($installerPath)

    $buffer = New-Object byte[] 65536
    $totalRead = 0
    $lastPercent = -1

    while (($read = $responseStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
        $fileStream.Write($buffer, 0, $read)
        $totalRead += $read

        if ($fileSize -gt 0) {
            $percent = [math]::Floor(($totalRead / $fileSize) * 100)
            if ($percent -ne $lastPercent) {
                $downloadedMB = [math]::Round($totalRead / 1MB, 1)
                $barWidth = 40
                # Cap at 100% for display (actual download may exceed manifest size slightly)
                $displayPercent = [math]::Min($percent, 100)
                $filled = [math]::Min([math]::Floor($displayPercent / (100 / $barWidth)), $barWidth)
                $bar = "[" + ("#" * $filled) + ("-" * ($barWidth - $filled)) + "]"
                Write-Host -NoNewline ("`r  $bar $percent% ($downloadedMB / $fileSizeMB MB)   ")
                $lastPercent = $percent
            }
        }
    }

    $fileStream.Close()
    $responseStream.Close()
    $response.Close()

    Write-Host ""
    Write-Success "Download complete!"
} catch {
    # Clean up partial download on failure
    if ($fileStream) { $fileStream.Close() }
    if ($responseStream) { $responseStream.Close() }
    if ($response) { $response.Close() }
    Write-Err "Download failed: $_"
}

# Verify file was downloaded
if (-not (Test-Path $installerPath)) {
    Write-Err "Download failed: file not found"
}

# Verify checksum (SHA-512, base64 encoded — matches electron-builder YAML manifest)
Write-Info "Verifying checksum..."
$sha512 = [System.Security.Cryptography.SHA512]::Create()
$stream = [System.IO.File]::OpenRead($installerPath)
$hashBytes = $sha512.ComputeHash($stream)
$stream.Close()
$sha512.Dispose()
$actualHash = [Convert]::ToBase64String($hashBytes)

if ($actualHash -ne $checksum) {
    Write-Err "Checksum verification failed`n  Expected: $checksum`n  Actual:   $actualHash"
}

Write-Success "Checksum verified!"

# Close the app if it's running
$process = Get-Process -Name "Nessy CLI Desktop", "Nessy CLI" -ErrorAction SilentlyContinue
if ($process) {
    Write-Info "Closing Nessy CLI Desktop..."
    $process | Stop-Process -Force
    Start-Sleep -Seconds 2
}

# Run the installer
Write-Info "Running installer (follow the installer prompts)..."

try {
    $originalTemp = $env:TEMP
    $originalTmp = $env:TMP
    $env:TEMP = $DOWNLOAD_DIR
    $env:TMP = $DOWNLOAD_DIR
    try {
        $installerProcess = Start-Process -FilePath $installerPath -PassThru
    } finally {
        $env:TEMP = $originalTemp
        $env:TMP = $originalTmp
    }

    $spinner = @('|', '/', '-', '\')
    $i = 0

    while (-not $installerProcess.HasExited) {
        Write-Host -NoNewline ("`r  Installing... " + $spinner[$i % 4] + "   ")
        Start-Sleep -Milliseconds 200
        $i++
    }

    Write-Host -NoNewline "`r                      `r"

    if ($installerProcess.ExitCode -ne 0) {
        Write-Err "Installation failed with exit code: $($installerProcess.ExitCode)"
    }
} catch {
    Write-Err "Installation failed: $_"
}

# Clean up installer
Write-Info "Cleaning up..."
Remove-InstallerDirectory $DOWNLOAD_DIR

# Add command line shortcut
Write-Info "Adding 'nessy-cli' command to PATH..."

$binDir = "$env:LOCALAPPDATA\Nessy CLI\bin"
$cmdFile = "$binDir\nessy-cli.cmd"
$exePath = "$env:LOCALAPPDATA\Programs\Nessy CLI Desktop\Nessy CLI Desktop.exe"

# Create bin directory
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

# Create batch file launcher
$cmdContent = "@echo off`r`nstart `"`" `"$exePath`" %*"
Set-Content -Path $cmdFile -Value $cmdContent -Encoding ASCII

# Add to user PATH if not already there
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$binDir*") {
    $newPath = "$userPath;$binDir"
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    Write-Success "Added to PATH (restart terminal to use 'nessy-cli' command)"
} else {
    Write-Success "Command 'nessy-cli' is ready"
}

Write-Host ""
Write-Host "---------------------------------------------------------------------"
Write-Host ""
Write-Success "Installation complete!"
Write-Host ""
Write-Host "  Nessy CLI Desktop has been installed."
Write-Host ""
Write-Host "  Launch from:"
Write-Host "    - Start Menu or desktop shortcut"
Write-Host "    - Command line: nessy-cli (restart terminal first)"
Write-Host ""
}
